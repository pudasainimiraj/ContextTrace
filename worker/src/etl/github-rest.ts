import { type Budget, githubResource } from "../queue/budget.ts";
import { messageOf, rateLimitWait } from "../api/github-api.ts";
import { JobError } from "../queue/retry.ts";

export const GITHUB_API_ROOT = "https://api.github.com";

/**
 * The extractor fetches only GitHub's REST API, and only under the job's own repository. A
 * cursor is a URL read back from the database, so it is checked before every request.
 */
export function assertGitHubApiUrl(url: string, repo?: { owner: string; name: string; id?: number }): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JobError("invalid_cursor", "Fetch target is not a URL", { transient: false });
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com" || parsed.username || parsed.password) {
    throw new JobError("invalid_cursor", "Fetch target is not GitHub's API", { transient: false });
  }
  if (repo) {
    const byName = parsed.pathname.startsWith(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/`);
    // GitHub's pagination Link headers name the repository by id: /repositories/{id}/issues?page=2
    const byId = repo.id !== undefined && parsed.pathname.startsWith(`/repositories/${repo.id}/`);
    if (!byName && !byId) throw new JobError("invalid_cursor", "Fetch target is outside the job's repository", { transient: false });
  }
}

export type GitHubPage<T> = {
  items: T[];
  nextUrl: string | null; // from the Link header
  bytes: number; // response body size
  remaining: number | null; // X-RateLimit-Remaining
  resetAt: number | null; // X-RateLimit-Reset, epoch seconds
};

export type GitHubOptions = { token?: string; fetch?: typeof globalThis.fetch; budget?: Budget };

/**
 * Fetches one page of a GitHub list endpoint. Rate limits (primary and secondary),
 * 5xx and network failures raise transient JobErrors carrying Retry-After or the
 * rate-reset wait; 404 and other 4xx raise permanent ones.
 */
export async function githubGetPage<T>(url: string, opts: GitHubOptions = {}): Promise<GitHubPage<T>> {
  assertGitHubApiUrl(url);
  const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "contexttrace-worker",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  // The request is reserved before it is made; a refusal parks the job until the hour resets.
  if (opts.budget) await opts.budget.take(githubResource(opts.token), 1);

  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    throw new JobError("network", err instanceof Error ? err.message : String(err), { transient: true });
  }

  const text = await res.text();
  const body = parseJson(text);
  const message = messageOf(body) || `GitHub responded ${res.status}`;

  if (res.status === 403 || res.status === 429) {
    const wait = rateLimitWait(res, message);
    if (wait !== null) {
      throw new JobError("rate_limited", "GitHub rate limit reached", { transient: true, retryAfterSeconds: wait });
    }
    throw new JobError("forbidden", message, { transient: false });
  }
  if (res.status === 404) throw new JobError("not_found", message, { transient: false });
  if (!res.ok) throw new JobError("upstream_error", message, { transient: res.status >= 500 });
  if (!Array.isArray(body)) throw new JobError("unexpected_response", "Expected a JSON array", { transient: false });

  return {
    items: body as T[],
    nextUrl: parseNextLink(res.headers.get("Link")),
    bytes: new TextEncoder().encode(text).length,
    remaining: integerHeader(res, "X-RateLimit-Remaining"),
    resetAt: integerHeader(res, "X-RateLimit-Reset"),
  };
}

function integerHeader(res: Response, name: string): number | null {
  const value = res.headers.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/** The rel="next" target of a Link header, as in fetch_github.py. */
export function parseNextLink(link: string | null): string | null {
  const match = /<([^>]+)>[^,]*rel="next"/.exec(link ?? "");
  return match ? match[1] : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
