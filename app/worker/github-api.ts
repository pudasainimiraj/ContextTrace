import { type Budget, budgetExhausted, githubResource } from "./budget.ts";

/**
 * Public-repository validation against the GitHub REST API.
 *
 * Mirrors the conventions in fetch_github.py: the same Accept / API-version /
 * User-Agent headers, an optional bearer token, and the same rate-limit detection
 * order (Retry-After, then X-RateLimit-Remaining == 0, then 429 / "rate limit").
 *
 * Renamed repositories: GitHub answers with a redirect that fetch follows, so the
 * body carries the NEW full_name and the SAME numeric id. The caller keys on id.
 */
export type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
};

export type RepoLookup =
  | { kind: "ok"; repo: GitHubRepo }
  | { kind: "not_found" } // 404: nonexistent, or private when unauthenticated
  | { kind: "private" } // 200 with private: true (only visible with a token)
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "budget_exhausted"; retryAfterSeconds: number } // our own GitHub request budget for the hour
  | { kind: "upstream_error"; status: number; message: string };

export type LookupOptions = {
  fetch?: typeof globalThis.fetch;
  token?: string;
  budget?: Budget;
};

const API_ROOT = "https://api.github.com";
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export async function lookupPublicRepository(
  { owner, name }: { owner: string; name: string },
  opts: LookupOptions = {},
): Promise<RepoLookup> {
  // Resolve the global lazily so test stubs installed after import are honoured.
  const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "contexttrace-worker",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.budget) {
    const reservation = await opts.budget.reserve(githubResource(opts.token), 1);
    if (!reservation.allowed) {
      return { kind: "budget_exhausted", retryAfterSeconds: budgetExhausted(githubResource(opts.token), reservation).retryAfterSeconds ?? 60 };
    }
  }

  let res: Response;
  try {
    const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    res = await fetchImpl(url, { headers });
  } catch (err) {
    return { kind: "upstream_error", status: 0, message: errorMessage(err) };
  }

  const body = await readJson(res);
  const message = messageOf(body) || `GitHub responded ${res.status}`;

  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 403 || res.status === 429) {
    const wait = rateLimitWait(res, message);
    if (wait !== null) return { kind: "rate_limited", retryAfterSeconds: wait };
    return { kind: "upstream_error", status: res.status, message };
  }
  if (!res.ok) return { kind: "upstream_error", status: res.status, message };
  if (!isGitHubRepo(body)) {
    return { kind: "upstream_error", status: res.status, message: "Unexpected response from GitHub" };
  }
  if (body.private) return { kind: "private" };
  return { kind: "ok", repo: body };
}

export function rateLimitWait(res: Response, message: string): number | null {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);
  if (res.headers.get("X-RateLimit-Remaining") === "0") {
    const reset = Number(res.headers.get("X-RateLimit-Reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(0, reset - Math.floor(Date.now() / 1000)) + 1;
    }
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  if (res.status === 429 || /rate limit/i.test(message)) return DEFAULT_RETRY_AFTER_SECONDS;
  return null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export function messageOf(body: unknown): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

function isGitHubRepo(v: unknown): v is GitHubRepo {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const owner = r.owner as Record<string, unknown> | null | undefined;
  return (
    typeof r.id === "number" &&
    typeof r.name === "string" &&
    typeof r.full_name === "string" &&
    typeof r.private === "boolean" &&
    typeof owner === "object" &&
    owner !== null &&
    typeof owner.login === "string"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
