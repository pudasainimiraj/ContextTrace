import { EMBED_JOB_KIND } from "./embed.ts";
import { STREAM_KINDS } from "./extract.ts";
import { MAX_QUERY_CHARS, SEARCH_LIMIT_MAX } from "./search.ts";
import { TRANSFORM_JOB_KIND } from "./transform.ts";
import { MAX_TURNSTILE_TOKEN_CHARS } from "./turnstile.ts";

export type Valid<T> = { ok: true; value: T } | { ok: false; message: string };

/** A repository URL is short; the parser decides whether it names a GitHub repository. */
export const MAX_URL_CHARS = 512;
/** The job kinds an admin may trigger by hand; anything else is refused before a row exists. */
export const JOB_KINDS: readonly string[] = [...Object.keys(STREAM_KINDS), TRANSFORM_JOB_KIND, EMBED_JOB_KIND];

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function validateRegistration(body: unknown): Valid<{ url: unknown; turnstileToken: string | null }> {
  const o = asObject(body);
  if (!o) return { ok: false, message: "Request body must be a JSON object" };
  if (typeof o.url === "string" && o.url.length > MAX_URL_CHARS) return { ok: false, message: `url must be at most ${MAX_URL_CHARS} characters` };
  const token = o.turnstileToken;
  if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.length > MAX_TURNSTILE_TOKEN_CHARS)) {
    return { ok: false, message: `turnstileToken must be a string of at most ${MAX_TURNSTILE_TOKEN_CHARS} characters` };
  }
  return { ok: true, value: { url: o.url, turnstileToken: typeof token === "string" ? token : null } };
}

export function validateSearch(body: unknown): Valid<{ repositoryId: number; query: string; limit?: number }> {
  const o = asObject(body);
  if (!o) return { ok: false, message: "Request body must be a JSON object" };
  const { repositoryId, query, limit } = o;
  if (!isPositiveInt(repositoryId)) return { ok: false, message: "repositoryId must be a positive integer" };
  if (typeof query !== "string" || query.trim() === "") return { ok: false, message: "query must be a non-empty string" };
  if (query.length > MAX_QUERY_CHARS) return { ok: false, message: `query must be at most ${MAX_QUERY_CHARS} characters` };
  if (limit !== undefined && (!isPositiveInt(limit) || limit > SEARCH_LIMIT_MAX)) {
    return { ok: false, message: `limit must be an integer from 1 to ${SEARCH_LIMIT_MAX}` };
  }
  return { ok: true, value: { repositoryId, query, limit } };
}

export function validateJob(body: unknown): Valid<{ kind: string }> {
  const o = asObject(body);
  if (!o) return { ok: false, message: "Request body must be a JSON object" };
  if (typeof o.kind !== "string" || !JOB_KINDS.includes(o.kind)) return { ok: false, message: `kind must be one of ${JOB_KINDS.join(", ")}` };
  return { ok: true, value: { kind: o.kind } };
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
