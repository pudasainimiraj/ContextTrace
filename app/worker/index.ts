import type { ApiError, ServiceStatus, SourceType } from "../shared/api.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Budget, budgetExhausted as budgetExhaustedError, databaseSize, GLOBAL_SCOPE, retryAfterHeader } from "./budget.ts";
import { consumeJobMessage } from "./consumer.ts";
import { getCoverage } from "./coverage.ts";
import { lookupPublicRepository, type RepoLookup } from "./github-api.ts";
import { parseRepositoryInput } from "./github-url.ts";
import { createJob, enqueueJob, type JobMessage, type JobQueue, meteredQueue } from "./jobs.ts";
import { listPassages } from "./documents.ts";
import { embeddingStats } from "./embed.ts";
import { createEmbeddingClient } from "./embeddings.ts";
import { startExtraction } from "./pipeline.ts";
import { reconcileJobs } from "./reconcile.ts";
import { MAX_QUERY_CHARS, SEARCH_LIMIT_MAX, search } from "./search.ts";
import { scheduleRescans, scheduleSyncs } from "./sync.ts";
import { listSources } from "./sources.ts";
import { createDb, type EgressMeter, getRepository, reinstateRepository, upsertRepository } from "./repositories.ts";
import { TRANSFORM_VERSION } from "./transform.ts";

/** Everything a handler needs: a metered database client, the budget ledger and the metered queue. */
type App = { db: SupabaseClient; budget: Budget; queue: JobQueue; meter: EgressMeter; env: Env };

function createApp(env: Env): App {
  const meter: EgressMeter = { bytes: 0 };
  const db = createDb(env, meter);
  const budget = new Budget(db, env.BUDGET_SCOPE || GLOBAL_SCOPE);
  return { db, budget, queue: meteredQueue(env.JOBS_QUEUE, budget), meter, env };
}

/** Settles the bytes Supabase sent during this invocation against the egress budget, after the response. */
function settleEgress(app: App, ctx: ExecutionContext): void {
  if (app.meter.bytes > 0) ctx.waitUntil(app.budget.settle("db_egress_bytes", app.meter.bytes).catch((err) => console.error("egress settle failed", err)));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const app = createApp(env);
    try {
      return await route(request, app);
    } finally {
      settleEgress(app, ctx);
    }
  },

  /** Cron: resend lost job messages, queue the syncs and rescans that are due, measure storage. */
  async scheduled(_controller, env, ctx): Promise<void> {
    const app = createApp(env);
    try {
      const reconciled = await reconcileJobs(app.db, app.queue);
      const syncs = await scheduleSyncs(app.db, app.queue);
      const rescans = await scheduleRescans(app.db, app.queue);
      const storageBytes = await databaseSize(app.db);
      await app.budget.gauge("storage_bytes", storageBytes);
      console.log("cron", { reconciled, syncs, rescans, storageBytes });
    } finally {
      settleEgress(app, ctx);
    }
  },

  /** Queue consumer: one lease owner per batch, one claim per message. */
  async queue(batch, env, ctx): Promise<void> {
    const app = createApp(env);
    const jobCtx = {
      db: app.db,
      queue: app.queue,
      budget: app.budget,
      token: env.GITHUB_TOKEN || undefined,
      embeddings: createEmbeddingClient(env),
    };
    const owner = `consumer:${crypto.randomUUID()}`;
    try {
      for (const message of batch.messages) {
        await consumeJobMessage(jobCtx, message, owner);
      }
    } finally {
      settleEgress(app, ctx);
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

async function route(request: Request, app: App): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (method === "GET" && pathname === "/api/health") return json({ ok: true });
  if (method === "GET" && pathname === "/api/status") return getServiceStatus(app);
  if (method === "POST" && pathname === "/api/repositories") return submitRepository(request, app);
  if (method === "POST" && pathname === "/api/search") return searchRepository(request, app);

  const byId = /^\/api\/repositories\/(\d+)$/.exec(pathname);
  if (method === "GET" && byId) return getRepositoryById(app, Number(byId[1]));

  const jobsOf = /^\/api\/repositories\/(\d+)\/jobs$/.exec(pathname);
  if (method === "POST" && jobsOf) return createRepositoryJob(request, app, Number(jobsOf[1]));

  const sourcesOf = /^\/api\/repositories\/(\d+)\/sources$/.exec(pathname);
  if (method === "GET" && sourcesOf) return listRepositorySources(app, Number(sourcesOf[1]), new URL(request.url));

  const passagesOf = /^\/api\/repositories\/(\d+)\/passages$/.exec(pathname);
  if (method === "GET" && passagesOf) return listRepositoryPassages(app, Number(passagesOf[1]), new URL(request.url));

  const statsOf = /^\/api\/repositories\/(\d+)\/embeddings\/stats$/.exec(pathname);
  if (method === "GET" && statsOf) return getEmbeddingStats(app, Number(statsOf[1]));

  const coverageOf = /^\/api\/repositories\/(\d+)\/coverage$/.exec(pathname);
  if (method === "GET" && coverageOf) return getRepositoryCoverage(app, Number(coverageOf[1]));

  return error(404, "not_found", "No such route");
}

/** GET /api/status -> whether the service is pausing itself at a budget cap, and why. */
async function getServiceStatus(app: App): Promise<Response> {
  const budgets = await app.budget.summary();
  const exhausted = budgets.filter((b) => b.paused);
  const body: ServiceStatus = {
    paused: exhausted.length > 0,
    reasons: exhausted.map((b) => `${b.resource}: ${b.used} of ${b.limit} used${b.resets_at ? `, resets at ${b.resets_at}` : ""}`),
    budgets,
    generated_at: new Date().toISOString(),
  };
  return json(body, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/repositories  body: { url } -> 201 new | 200 already registered */
async function submitRepository(request: Request, app: App): Promise<Response> {
  const { db, env, budget } = app;
  const body = await readJson(request);
  if (body === undefined) return error(400, "invalid_input", "Request body must be JSON");
  const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  const parsed = parseRepositoryInput(url);
  if (!parsed.ok) return error(400, "invalid_input", parsed.error);

  // A registration is reserved before the lookup, so a refused one costs no GitHub request;
  // a lookup that does not register anything gives the reservation back.
  const admission = await budget.reserve("registrations", 1);
  if (!admission.allowed) {
    return error(429, "budget_exhausted", "Today's registration budget is used up; try again after the reset", {
      "Retry-After": retryAfterHeader(budgetExhaustedError("registrations", admission)),
    });
  }
  const lookup = await lookupPublicRepository(parsed, { token: env.GITHUB_TOKEN || undefined, budget });
  if (lookup.kind !== "ok") {
    await budget.settle("registrations", -1);
    return lookupError(lookup);
  }

  const upserted = await upsertRepository(db, lookup.repo);
  const { created } = upserted;
  let { row } = upserted;
  if (!created) await budget.settle("registrations", -1);
  // A newly registered repository starts its extraction streams at once. One that GitHub had
  // stopped serving is public again: clear the mark and catch up through the same streams.
  if (created) await startExtraction(db, app.queue, row.id);
  if (row.status === "inaccessible") {
    row = await reinstateRepository(db, row.id, TRANSFORM_VERSION);
    await startExtraction(db, app.queue, row.id);
  }
  return created
    ? json(row, { status: 201, headers: { Location: `/api/repositories/${row.id}` } })
    : json(row);
}

const SOURCE_TYPES: SourceType[] = ["issue", "pull_request", "issue_comment", "review_comment"];

/** GET /api/repositories/:id/sources?type=&number=&limit=  -> stored records with provenance */
async function listRepositorySources({ db }: App, repositoryId: number, url: URL): Promise<Response> {
  const type = url.searchParams.get("type");
  if (type !== null && !SOURCE_TYPES.includes(type as SourceType)) {
    return error(400, "invalid_input", `type must be one of ${SOURCE_TYPES.join(", ")}`);
  }
  const number = url.searchParams.get("number");
  if (number !== null && !/^\d+$/.test(number)) return error(400, "invalid_input", "number must be an integer");
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) return error(400, "invalid_input", "limit must be an integer");

  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const sources = await listSources(db, repositoryId, {
    type: (type as SourceType | null) ?? undefined,
    number: number === null ? undefined : Number(number),
    limit: limit === null ? undefined : Number(limit),
  });
  return json(sources);
}

/** POST /api/repositories/:id/jobs  body: { kind } -> 202 with the queued job */
async function createRepositoryJob(request: Request, { db, queue }: App, repositoryId: number): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return error(400, "invalid_input", "Request body must be JSON");
  const kind = typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(kind)) {
    return error(400, "invalid_input", "kind must be a snake_case identifier");
  }
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const created = await createJob(db, repositoryId, kind);
  const job = await enqueueJob(db, queue, created.id);
  if (!job) throw new Error(`job ${created.id} could not be enqueued`);
  return json(job, { status: 202 });
}

/** GET /api/repositories/:id/passages?number=&limit=  -> transformed passages, newest thread order */
async function listRepositoryPassages({ db }: App, repositoryId: number, url: URL): Promise<Response> {
  const number = url.searchParams.get("number");
  if (number !== null && !/^\d+$/.test(number)) return error(400, "invalid_input", "number must be an integer");
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) return error(400, "invalid_input", "limit must be an integer");

  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const passages = await listPassages(db, repositoryId, {
    number: number === null ? undefined : Number(number),
    limit: limit === null ? undefined : Number(limit),
  });
  return json(passages);
}

/** GET /api/repositories/:id/embeddings/stats -> coverage and metering for the repository */
async function getEmbeddingStats({ db }: App, repositoryId: number): Promise<Response> {
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  return json(await embeddingStats(db, repositoryId));
}

/** POST /api/search  body: { repositoryId, query, limit? } -> evidence cards, query embedded on the server */
async function searchRepository(request: Request, { db, env, budget }: App): Promise<Response> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return error(400, "invalid_input", "Request body must be a JSON object");
  }
  const { repositoryId, query, limit } = body as { repositoryId?: unknown; query?: unknown; limit?: unknown };
  if (!isPositiveInt(repositoryId)) return error(400, "invalid_input", "repositoryId must be a positive integer");
  if (typeof query !== "string" || query.trim() === "") return error(400, "invalid_input", "query must be a non-empty string");
  if (query.length > MAX_QUERY_CHARS) return error(400, "invalid_input", `query must be at most ${MAX_QUERY_CHARS} characters`);
  if (limit !== undefined && (!isPositiveInt(limit) || limit > SEARCH_LIMIT_MAX)) {
    return error(400, "invalid_input", `limit must be an integer from 1 to ${SEARCH_LIMIT_MAX}`);
  }

  const repository = await getRepository(db, repositoryId);
  if (!repository) return error(404, "not_found", "Repository is not registered");
  const admission = await budget.reserve("searches", 1);
  if (!admission.allowed) {
    return error(429, "budget_exhausted", "Today's search budget is used up; try again after the reset", {
      "Retry-After": retryAfterHeader(budgetExhaustedError("searches", admission)),
    });
  }
  return json(await search({ db, embeddings: createEmbeddingClient(env), budget }, { repository, query, limit }));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** GET /api/repositories/:id/coverage -> counts, stream progress, high-water marks and sync times */
async function getRepositoryCoverage({ db }: App, repositoryId: number): Promise<Response> {
  const repository = await getRepository(db, repositoryId);
  if (!repository) return error(404, "not_found", "Repository is not registered");
  return json(await getCoverage(db, repository));
}

/** GET /api/repositories/:id */
async function getRepositoryById({ db }: App, id: number): Promise<Response> {
  const row = await getRepository(db, id);
  return row ? json(row) : error(404, "not_found", "Repository is not registered");
}

function lookupError(lookup: Exclude<RepoLookup, { kind: "ok" }>): Response {
  switch (lookup.kind) {
    case "not_found":
      return error(404, "repository_not_found", "Repository not found or not public");
    case "private":
      return error(422, "repository_not_public", "Only public repositories can be registered");
    case "rate_limited":
      return error(
        503,
        "rate_limited",
        `GitHub rate limit reached; retry in ${lookup.retryAfterSeconds}s`,
        { "Retry-After": String(lookup.retryAfterSeconds) },
      );
    case "budget_exhausted":
      return error(
        503,
        "service_paused",
        `GitHub request budget for this hour is used up; retry in ${lookup.retryAfterSeconds}s`,
        { "Retry-After": String(lookup.retryAfterSeconds) },
      );
    case "upstream_error":
      return error(502, "upstream_error", `GitHub request failed: ${lookup.message}`);
  }
}

/** Parsed JSON body, or undefined when the body is not valid JSON. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function error(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  const body: ApiError = { error: code, message };
  return Response.json(body, { status, headers });
}
