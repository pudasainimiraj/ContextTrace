import type { RepoLookup } from "./github-api.ts";

/** An error a job step raises; `transient` decides whether the job is retried. */
export class JobError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly retryAfterSeconds?: number;
  readonly data?: Record<string, unknown>; // structured detail, e.g. the exhausted budget

  constructor(code: string, message: string, options: { transient: boolean; retryAfterSeconds?: number; data?: Record<string, unknown> }) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.transient = options.transient;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.data = options.data;
  }
}

export type Failure = { code: string; message: string; transient: boolean; retryAfterSeconds?: number };

/** What supabase-js hands back when a call fails. */
export type DbFailure = { message: string; code?: string | null; details?: string | null; hint?: string | null };

/**
 * A failed database call as a JobError. The database being unavailable (connection, timeout,
 * PostgREST or gateway trouble, serialisation conflicts) is transient and the job retries;
 * data the database refuses (constraint violations, bad input) is permanent.
 */
export function dbError(call: string, failure: DbFailure): JobError {
  const code = failure.code ?? "";
  const transient =
    code === "" ||
    code.startsWith("PGRST") ||
    /^(08|40|53|57)/.test(code) ||
    /^5\d\d$/.test(code) ||
    /timeout|unavailable|too many|connection/i.test(failure.message);
  return new JobError("db_error", `${call} failed: ${failure.message}${code ? ` (${code})` : ""}`, { transient, data: { code } });
}

/** Retry classification. Only a JobError marked transient or a network failure is retried. */
export function classifyError(err: unknown): Failure {
  if (err instanceof JobError) {
    return { code: err.code, message: err.message, transient: err.transient, retryAfterSeconds: err.retryAfterSeconds };
  }
  // workerd raises a TypeError when fetch cannot reach the host.
  if (err instanceof TypeError && /fetch|network|socket/i.test(err.message)) {
    return { code: "network", message: err.message, transient: true };
  }
  return { code: "unhandled", message: err instanceof Error ? err.message : String(err), transient: false };
}

/** Maps a refused GitHub lookup to a JobError: rate limits and 5xx are transient. */
export function jobErrorFromLookup(lookup: Exclude<RepoLookup, { kind: "ok" }>): JobError {
  switch (lookup.kind) {
    case "rate_limited":
      return new JobError("rate_limited", "GitHub rate limit reached", {
        transient: true,
        retryAfterSeconds: lookup.retryAfterSeconds,
      });
    case "upstream_error":
      return new JobError("upstream_error", lookup.message, {
        transient: lookup.status === 0 || lookup.status >= 500,
      });
    case "budget_exhausted":
      return new JobError("budget_exhausted", "GitHub request budget for this hour is used up", {
        transient: true,
        retryAfterSeconds: lookup.retryAfterSeconds,
      });
    case "not_found":
      return new JobError("repository_not_found", "Repository not found or not public", { transient: false });
    case "private":
      return new JobError("repository_not_public", "Only public repositories can be processed", { transient: false });
  }
}

/** A job is abandoned as failed after this many attempts. */
export const MAX_ATTEMPTS = 5;

const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 900;

/** Exponential backoff, 30s doubling per attempt up to 15 minutes, never below Retry-After. */
export function backoffSeconds(attempt: number, retryAfterSeconds = 0): number {
  const exponential = Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempt - 1));
  return Math.max(retryAfterSeconds, exponential);
}
