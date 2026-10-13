import type { ApiError } from "../shared/api.ts";
import { consumeJobMessage } from "./consumer.ts";
import { lookupPublicRepository, type RepoLookup } from "./github-api.ts";
import { parseRepositoryInput } from "./github-url.ts";
import { createJob, enqueueJob, type JobMessage } from "./jobs.ts";
import { reconcileJobs } from "./reconcile.ts";
import { createDb, getRepository, upsertRepository } from "./repositories.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === "GET" && pathname === "/api/health") return json({ ok: true });
    if (method === "POST" && pathname === "/api/repositories") return submitRepository(request, env);

    const byId = /^\/api\/repositories\/(\d+)$/.exec(pathname);
    if (method === "GET" && byId) return getRepositoryById(env, Number(byId[1]));

    const jobsOf = /^\/api\/repositories\/(\d+)\/jobs$/.exec(pathname);
    if (method === "POST" && jobsOf) return createRepositoryJob(request, env, Number(jobsOf[1]));

    return error(404, "not_found", "No such route");
  },

  /** Cron: resend messages for jobs whose lease expired or whose retry message was lost. */
  async scheduled(_controller, env): Promise<void> {
    const result = await reconcileJobs(createDb(env), env.JOBS_QUEUE);
    console.log("reconciled jobs", result);
  },

  /** Queue consumer: one lease owner per batch, one claim per message. */
  async queue(batch, env): Promise<void> {
    const ctx = { db: createDb(env), queue: env.JOBS_QUEUE, token: env.GITHUB_TOKEN || undefined };
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

  const { row, created } = await upsertRepository(createDb(env), lookup.repo);
  return created
    ? json(row, { status: 201, headers: { Location: `/api/repositories/${row.id}` } })
    : json(row);
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
