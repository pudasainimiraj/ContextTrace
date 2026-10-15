import type { ApiError, ServiceStatus, SourceType } from "../shared/api.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "./admin.ts";
import { admissionState, findByFullName } from "./admission.ts";
import { Budget, budgetExhausted as budgetExhaustedError, GLOBAL_SCOPE, retryAfterHeader } from "./budget.ts";
import { consumeJobMessage } from "./consumer.ts";
import { getCoverage } from "./coverage.ts";
import { lookupPublicRepository, type RepoLookup } from "./github-api.ts";
import { parseRepositoryInput } from "./github-url.ts";
import { createJob, enqueueJob, type JobMessage, type JobQueue, meteredQueue } from "./jobs.ts";
import { maintain, removeRepository, storageState } from "./maintenance.ts";
import { listPassages } from "./documents.ts";
import { embeddingStats } from "./embed.ts";
import { createEmbeddingClient } from "./embeddings.ts";
import { startExtraction } from "./pipeline.ts";
import { reconcileJobs } from "./reconcile.ts";
import { clientKey, rateLimitResponse } from "./ratelimit.ts";
import { search } from "./search.ts";
import { scheduleRescans, scheduleSyncs } from "./sync.ts";
import { listSources } from "./sources.ts";
import { createDb, type EgressMeter, getRepository, reinstateRepository, upsertRepository } from "./repositories.ts";
import { TRANSFORM_VERSION } from "./transform.ts";
import { verifyTurnstile } from "./turnstile.ts";
import { validateJob, validateRegistration, validateSearch } from "./validate.ts";

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
    } catch (err) {
      // Nothing about the failure reaches the client; the log has it.
      console.error("unhandled request error", err);
      return error(500, "internal_error", "Something went wrong on our side; the problem has been logged");
    } finally {
      settleEgress(app, ctx);
    }
  },

  /** Cron: resend lost job messages, queue the syncs and rescans that are due, measure storage. */
  async scheduled(_controller, env, ctx): Promise<void> {
    const app = createApp(env);
    try {
      const reconciled = await reconcileJobs(app.db, app.queue);
      const syncs = await scheduleSyncs(app.db, app.queue, { budget: app.budget });
      const rescans = await scheduleRescans(app.db, app.queue, { budget: app.budget });
      const maintenance = await maintain(app.db, app.budget);
      console.log("cron", { reconciled, syncs, rescans, maintenance });
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
  const { env } = app;

  if (method === "GET" && pathname === "/api/health") return json({ ok: true });

  // Expensive endpoints are limited per address; reads more loosely; admin routes by token.
  if (method === "POST" && pathname === "/api/search") {
    return (await rateLimitResponse(env.SEARCH_LIMITER, request, "search")) ?? searchRepository(request, app);
  }
  if (method === "POST" && pathname === "/api/repositories") {
    return (await rateLimitResponse(env.REGISTER_LIMITER, request, "register")) ?? submitRepository(request, app);
  }
  const jobsOf = /^\/api\/repositories\/(\d+)\/jobs$/.exec(pathname);
  if (method === "POST" && jobsOf) {
    return (await requireAdmin(request, env.ADMIN_TOKEN)) ?? createRepositoryJob(request, app, Number(jobsOf[1]));
  }
  const byIdDelete = /^\/api\/repositories\/(\d+)$/.exec(pathname);
  if (method === "DELETE" && byIdDelete) {
    return (await requireAdmin(request, env.ADMIN_TOKEN)) ?? deleteRepository(app, Number(byIdDelete[1]));
  }
  if (method === "GET") {
    const limited = await rateLimitResponse(env.READ_LIMITER, request, "read");
    if (limited) return limited;
  }

  if (method === "GET" && pathname === "/api/status") return getServiceStatus(app);

  const byId = /^\/api\/repositories\/(\d+)$/.exec(pathname);
  if (method === "GET" && byId) return getRepositoryById(app, Number(byId[1]));

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
  const [budgets, admissions, storage] = await Promise.all([app.budget.summary(), admissionState(app.db, app.budget), storageState(app.budget)]);
  const exhausted = budgets.filter((b) => b.paused);
  const body: ServiceStatus = {
    paused: exhausted.length > 0,
    reasons: exhausted.map((b) => `${b.resource}: ${b.used} of ${b.limit} used${b.resets_at ? `, resets at ${b.resets_at}` : ""}`),
    budgets,
    admissions,
    protections: { turnstile: Boolean(app.env.TURNSTILE_SECRET_KEY), rate_limits: Boolean(app.env.SEARCH_LIMITER), admin: Boolean(app.env.ADMIN_TOKEN) },
    storage,
    generated_at: new Date().toISOString(),
  };
  return json(body);
}

/** POST /api/repositories  body: { url } -> 201 new | 200 already registered */
async function submitRepository(request: Request, app: App): Promise<Response> {
  const { db, env, budget } = app;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const input = validateRegistration(body);
  if (!input.ok) return error(400, "invalid_input", input.message);
  const { url, turnstileToken } = input.value;
  const parsed = parseRepositoryInput(url);
  if (!parsed.ok) return error(400, "invalid_input", parsed.error);

  // Turnstile, when configured: the token is checked before anything else is spent.
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) return error(403, "verification_failed", "Complete the Turnstile check and send its token as turnstileToken");
    let verified;
    try {
      verified = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, clientKey(request));
    } catch (err) {
      console.error("turnstile verification unavailable", err);
      return error(503, "verification_unavailable", "The verification service could not be reached; try again shortly", { "Retry-After": "30" });
    }
    if (!verified.success) {
      return error(403, "verification_failed", `Turnstile rejected the token (${verified.errorCodes.join(", ") || "no reason given"}); reload and try again`);
    }
  }

  // When admissions are closed (storage warning, repository cap) only a repository that is
  // already registered gets through, and it is served as a resubmission.
  const admissions = await admissionState(db, budget);
  if (!admissions.open && !(await findByFullName(db, `${parsed.owner}/${parsed.name}`))) {
    return error(503, "admissions_paused", admissions.reason ?? "New repositories are not accepted right now", { "Retry-After": "3600" });
  }
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
  if (row.status === "inaccessible" || row.status === "removed") {
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
  if (body instanceof Response) return body;
  const input = validateJob(body);
  if (!input.ok) return error(400, "invalid_input", input.message);
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const created = await createJob(db, repositoryId, input.value.kind);
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
  if (body instanceof Response) return body;
  const input = validateSearch(body);
  if (!input.ok) return error(400, "invalid_input", input.message);
  const { repositoryId, query, limit } = input.value;

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

/** GET /api/repositories/:id/coverage -> counts, stream progress, high-water marks and sync times */
async function getRepositoryCoverage({ db }: App, repositoryId: number): Promise<Response> {
  const repository = await getRepository(db, repositoryId);
  if (!repository) return error(404, "not_found", "Repository is not registered");
  return json(await getCoverage(db, repository));
}

/** DELETE /api/repositories/:id (admin) -> removes everything the repository holds; the row stays as a tombstone */
async function deleteRepository({ db }: App, repositoryId: number): Promise<Response> {
  const repository = await getRepository(db, repositoryId);
  if (!repository) return error(404, "not_found", "Repository is not registered");
  const removal = await removeRepository(db, repositoryId, "removed by an operator");
  return json({ repository_id: repositoryId, status: "removed", removed: removal });
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

/** Request bodies are small JSON documents; anything larger is refused before it is parsed. */
export const MAX_BODY_BYTES = 8192;

/**
 * The parsed JSON body, or the error response to send instead: 415 for a body that is not
 * declared as JSON, 413 past MAX_BODY_BYTES, 400 when it does not parse.
 */
async function readJson(request: Request): Promise<unknown | Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return error(415, "unsupported_media_type", "Request body must be application/json");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return error(413, "payload_too_large", `Request body must be at most ${MAX_BODY_BYTES} bytes`);
  let text: string;
  try {
    text = await request.text();
  } catch {
    return error(400, "invalid_input", "Request body could not be read");
  }
  if (text.length > MAX_BODY_BYTES) return error(413, "payload_too_large", `Request body must be at most ${MAX_BODY_BYTES} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return error(400, "invalid_input", "Request body must be JSON");
  }
}

/** Every API response: JSON, never cached, never sniffed. */
const API_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, { ...init, headers: { ...API_HEADERS, ...(init?.headers as Record<string, string> | undefined) } });
}

function error(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  const body: ApiError = { error: code, message };
  return Response.json(body, { status, headers: { ...API_HEADERS, ...headers } });
}
