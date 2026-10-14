import type { ApiError, SourceType } from "../shared/api.ts";
import { consumeJobMessage } from "./consumer.ts";
import { getCoverage } from "./coverage.ts";
import { lookupPublicRepository, type RepoLookup } from "./github-api.ts";
import { parseRepositoryInput } from "./github-url.ts";
import { createJob, enqueueJob, type JobMessage } from "./jobs.ts";
import { listPassages } from "./documents.ts";
import { embeddingStats } from "./embed.ts";
import { createEmbeddingClient } from "./embeddings.ts";
import { startExtraction } from "./pipeline.ts";
import { reconcileJobs } from "./reconcile.ts";
import { MAX_QUERY_CHARS, SEARCH_LIMIT_MAX, search } from "./search.ts";
import { scheduleSyncs } from "./sync.ts";
import { listSources } from "./sources.ts";
import { createDb, getRepository, upsertRepository } from "./repositories.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === "GET" && pathname === "/api/health") return json({ ok: true });
    if (method === "POST" && pathname === "/api/repositories") return submitRepository(request, env);
    if (method === "POST" && pathname === "/api/search") return searchRepository(request, env);

    const byId = /^\/api\/repositories\/(\d+)$/.exec(pathname);
    if (method === "GET" && byId) return getRepositoryById(env, Number(byId[1]));

    const jobsOf = /^\/api\/repositories\/(\d+)\/jobs$/.exec(pathname);
    if (method === "POST" && jobsOf) return createRepositoryJob(request, env, Number(jobsOf[1]));

    const sourcesOf = /^\/api\/repositories\/(\d+)\/sources$/.exec(pathname);
    if (method === "GET" && sourcesOf) return listRepositorySources(env, Number(sourcesOf[1]), new URL(request.url));

    const passagesOf = /^\/api\/repositories\/(\d+)\/passages$/.exec(pathname);
    if (method === "GET" && passagesOf) return listRepositoryPassages(env, Number(passagesOf[1]), new URL(request.url));

    const statsOf = /^\/api\/repositories\/(\d+)\/embeddings\/stats$/.exec(pathname);
    if (method === "GET" && statsOf) return getEmbeddingStats(env, Number(statsOf[1]));

    const coverageOf = /^\/api\/repositories\/(\d+)\/coverage$/.exec(pathname);
    if (method === "GET" && coverageOf) return getRepositoryCoverage(env, Number(coverageOf[1]));

    return error(404, "not_found", "No such route");
  },

  /** Cron: resend lost job messages, then queue incremental syncs for streams that are due. */
  async scheduled(_controller, env): Promise<void> {
    const db = createDb(env);
    const reconciled = await reconcileJobs(db, env.JOBS_QUEUE);
    const syncs = await scheduleSyncs(db, env.JOBS_QUEUE);
    console.log("cron", { reconciled, syncs });
  },

  /** Queue consumer: one lease owner per batch, one claim per message. */
  async queue(batch, env): Promise<void> {
    const ctx = {
      db: createDb(env),
      queue: env.JOBS_QUEUE,
      token: env.GITHUB_TOKEN || undefined,
      embeddings: createEmbeddingClient(env),
    };
    const owner = `consumer:${crypto.randomUUID()}`;
    for (const message of batch.messages) {
      await consumeJobMessage(ctx, message, owner);
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;

/** POST /api/repositories  body: { url } -> 201 new | 200 already registered */
async function submitRepository(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return error(400, "invalid_input", "Request body must be JSON");
  const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  const parsed = parseRepositoryInput(url);
  if (!parsed.ok) return error(400, "invalid_input", parsed.error);

  const lookup = await lookupPublicRepository(parsed, { token: env.GITHUB_TOKEN || undefined });
  if (lookup.kind !== "ok") return lookupError(lookup);

  const db = createDb(env);
  const { row, created } = await upsertRepository(db, lookup.repo);
  // A newly registered repository starts its extraction streams at once.
  if (created) await startExtraction(db, env.JOBS_QUEUE, row.id);
  return created
    ? json(row, { status: 201, headers: { Location: `/api/repositories/${row.id}` } })
    : json(row);
}

const SOURCE_TYPES: SourceType[] = ["issue", "pull_request", "issue_comment", "review_comment"];

/** GET /api/repositories/:id/sources?type=&number=&limit=  -> stored records with provenance */
async function listRepositorySources(env: Env, repositoryId: number, url: URL): Promise<Response> {
  const type = url.searchParams.get("type");
  if (type !== null && !SOURCE_TYPES.includes(type as SourceType)) {
    return error(400, "invalid_input", `type must be one of ${SOURCE_TYPES.join(", ")}`);
  }
  const number = url.searchParams.get("number");
  if (number !== null && !/^\d+$/.test(number)) return error(400, "invalid_input", "number must be an integer");
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) return error(400, "invalid_input", "limit must be an integer");

  const db = createDb(env);
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const sources = await listSources(db, repositoryId, {
    type: (type as SourceType | null) ?? undefined,
    number: number === null ? undefined : Number(number),
    limit: limit === null ? undefined : Number(limit),
  });
  return json(sources);
}

/** POST /api/repositories/:id/jobs  body: { kind } -> 202 with the queued job */
async function createRepositoryJob(request: Request, env: Env, repositoryId: number): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return error(400, "invalid_input", "Request body must be JSON");
  const kind = typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(kind)) {
    return error(400, "invalid_input", "kind must be a snake_case identifier");
  }
  const db = createDb(env);
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const created = await createJob(db, repositoryId, kind);
  const job = await enqueueJob(db, env.JOBS_QUEUE, created.id);
  if (!job) throw new Error(`job ${created.id} could not be enqueued`);
  return json(job, { status: 202 });
}

/** GET /api/repositories/:id/passages?number=&limit=  -> transformed passages, newest thread order */
async function listRepositoryPassages(env: Env, repositoryId: number, url: URL): Promise<Response> {
  const number = url.searchParams.get("number");
  if (number !== null && !/^\d+$/.test(number)) return error(400, "invalid_input", "number must be an integer");
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) return error(400, "invalid_input", "limit must be an integer");

  const db = createDb(env);
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  const passages = await listPassages(db, repositoryId, {
    number: number === null ? undefined : Number(number),
    limit: limit === null ? undefined : Number(limit),
  });
  return json(passages);
}

/** GET /api/repositories/:id/embeddings/stats -> coverage and metering for the repository */
async function getEmbeddingStats(env: Env, repositoryId: number): Promise<Response> {
  const db = createDb(env);
  if (!(await getRepository(db, repositoryId))) return error(404, "not_found", "Repository is not registered");
  return json(await embeddingStats(db, repositoryId));
}

/** POST /api/search  body: { repositoryId, query, limit? } -> evidence cards, query embedded on the server */
async function searchRepository(request: Request, env: Env): Promise<Response> {
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

  const db = createDb(env);
  const repository = await getRepository(db, repositoryId);
  if (!repository) return error(404, "not_found", "Repository is not registered");
  return json(await search({ db, embeddings: createEmbeddingClient(env) }, { repository, query, limit }));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** GET /api/repositories/:id/coverage -> counts, stream progress, high-water marks and sync times */
async function getRepositoryCoverage(env: Env, repositoryId: number): Promise<Response> {
  const db = createDb(env);
  const repository = await getRepository(db, repositoryId);
  if (!repository) return error(404, "not_found", "Repository is not registered");
  return json(await getCoverage(db, repository));
}

/** GET /api/repositories/:id */
async function getRepositoryById(env: Env, id: number): Promise<Response> {
  const row = await getRepository(createDb(env), id);
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
