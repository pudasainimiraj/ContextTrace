import type { ApiError } from "../shared/api.ts";
import { lookupPublicRepository, type RepoLookup } from "./github-api.ts";
import { parseRepositoryInput } from "./github-url.ts";
import { createDb, getRepository, upsertRepository } from "./repositories.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === "GET" && pathname === "/api/health") return json({ ok: true });
    if (method === "POST" && pathname === "/api/repositories") return submitRepository(request, env);

    const byId = /^\/api\/repositories\/(\d+)$/.exec(pathname);
    if (method === "GET" && byId) return getRepositoryById(env, Number(byId[1]));

    return error(404, "not_found", "No such route");
  },
} satisfies ExportedHandler<Env>;

/** POST /api/repositories  body: { url } -> 201 new | 200 already registered */
async function submitRepository(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid_input", "Request body must be JSON");
  }
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

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function error(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  const body: ApiError = { error: code, message };
  return Response.json(body, { status, headers });
}
