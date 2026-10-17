// The one vocabulary of the interface: every state has one label, one tone, one icon and one
// sentence, used the same way on the home list, the repository header, the indexing panel and
// the search results. Nothing here is a backend word; those stay in the operator details.

import type { ActiveJob, BudgetState, EvidenceCard, LastRun, RepositoryStatus, SearchResponse, ServiceStatus, StreamCoverage } from "../../../shared/api.ts";
import { absoluteUtc, addDays, formatCount, longDate, relativeTime } from "./time.ts";

export type Tone = "neutral" | "green" | "amber" | "red" | "muted";
export type StatusView = { label: string; tone: Tone; meaning: string; pulse: boolean; hollow: boolean };

/** The per-stream item cap (ADR-0008) and how long an unreachable repository is kept (ADR-0010). */
export const ITEM_CAP = 5000;
export const RETENTION_DAYS = 30;
export const SYNC_INTERVAL_MS = 60 * 60 * 1000;
export const RESCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEASE_RECOVERY_MINUTES = 5;

export const STREAM_NAMES: Record<string, string> = {
  issues: "issues and pull requests",
  issue_comments: "issue comments",
  review_comments: "review comments",
};

function streamName(stream: string): string {
  return STREAM_NAMES[stream] ?? stream.replace(/_/g, " ");
}

type StatusContext = {
  activeJobs?: number; // undefined: not known yet (treated as "may be running")
  lastError?: string | null;
  statusChangedAt?: string | null;
  capped?: boolean;
  pending?: number;
};

/** The repository state as the interface shows it. A registered repository with nothing running has stalled. */
export function repositoryStatus(status: RepositoryStatus, ctx: StatusContext = {}): StatusView {
  const since = ctx.statusChangedAt ? ` on ${longDate(ctx.statusChangedAt)}` : "";
  switch (status) {
    case "registered":
      if (ctx.activeJobs === 0) {
        const reason = ctx.lastError ? errorInWords(ctx.lastError) : "no indexing step is queued or running";
        return { label: "Indexing stopped", tone: "red", pulse: false, hollow: false, meaning: `${capitalize(reason)}. Indexing did not start, or it stopped. Register the repository again to restart it.` };
      }
      return { label: "Queued for indexing", tone: "neutral", pulse: true, hollow: true, meaning: "Nothing is searchable yet. The newest discussions arrive within about a minute." };
    case "searchable_partial":
      return { label: "Searchable, still indexing", tone: "amber", pulse: true, hollow: false, meaning: "The newest discussions are searchable. Older history is being added." };
    case "searchable": {
      const meaning = ctx.capped
        ? `Every fetched discussion is indexed; history beyond the ${formatCount(ITEM_CAP)}-item limit is not included. Synced every hour.`
        : (ctx.pending ?? 0) > 0
          ? `Every fetched discussion is indexed; ${formatCount(ctx.pending ?? 0)} passages are waiting for a vector. Synced every hour.`
          : "Every fetched discussion is indexed. Synced every hour.";
      return { label: "Fully indexed", tone: "green", pulse: false, hollow: false, meaning };
    }
    case "inaccessible": {
      const until = ctx.statusChangedAt ? ` until ${longDate(addDays(ctx.statusChangedAt, RETENTION_DAYS))}` : ` for ${RETENTION_DAYS} days`;
      return { label: "Unreachable on GitHub", tone: "red", pulse: false, hollow: false, meaning: `GitHub stopped serving this repository${since}. The index stays searchable${until}; results may be stale.` };
    }
    case "removed":
      return { label: "Index removed", tone: "muted", pulse: false, hollow: true, meaning: `The data was removed${since}. Register the repository again to rebuild the index.` };
  }
}

const ERROR_WORDS: Record<string, string> = {
  not_found: "GitHub answered 404: the repository, or its issues, are not available",
  forbidden: "GitHub refused access",
  rate_limited: "the GitHub rate limit",
  budget_exhausted: "a free-tier allowance is used up",
  network: "a network problem",
  upstream_error: "GitHub had a problem",
  db_unavailable: "the database was unavailable",
  statement_timeout: "the database timed out",
  unknown_kind: "an unknown step",
  repository_missing: "the repository row is missing",
};

/** An error code (or "code: message") in plain words. */
export function errorInWords(codeOrMessage: string | null): string {
  if (!codeOrMessage) return "an unknown problem";
  const code = codeOrMessage.split(":")[0].trim();
  return ERROR_WORDS[code] ?? code.replace(/_/g, " ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One sentence per stream. The cap is a badge next to it, see `cappedBadge`. */
export function streamSentence(s: StreamCoverage): string {
  const items = streamName(s.stream);
  switch (s.phase) {
    case "pending":
      return "Waiting to start";
    case "head":
      return `Fetching the newest ${items}`;
    case "backfill":
      return `Fetching older history, page ${formatCount(s.pages_fetched)} · ${formatCount(s.items_fetched)} so far`;
    case "rescan":
      return `Checking for deleted ${items}`;
    case "complete":
      return s.sync_in_progress ? `Checking for new ${items}` : `Complete, ${formatCount(s.items_fetched)} fetched`;
  }
}

export function cappedBadge(s: StreamCoverage): string | null {
  return s.capped ? `Stopped at the ${formatCount(ITEM_CAP)}-item limit; older items are not indexed` : null;
}

const KIND_RE = /^(fetch|backfill|rescan)_(.+)$/;

/** The job kind as a verb phrase. A fetch is "the newest" before the head pass is done and "new" after it. */
export function jobVerb(kind: string, streams?: StreamCoverage[]): string {
  const m = KIND_RE.exec(kind);
  if (m) {
    const name = streamName(m[2]);
    if (m[1] === "backfill") return `Fetching older ${name}`;
    if (m[1] === "rescan") return `Checking for deleted ${name}`;
    if (!streams) return `Fetching ${name}`; // the list does not know whether the head pass is done
    const stream = streams.find((s) => s.stream === m[2]);
    const headDone = stream !== undefined && stream.phase !== "pending" && stream.phase !== "head";
    return headDone ? `Checking for new ${name}` : `Fetching the newest ${name}`;
  }
  if (kind === "transform_passages") return "Splitting threads into passages";
  if (kind === "embed_passages") return "Making passages searchable";
  return capitalize(kind.replace(/_/g, " "));
}

/** What one active job is doing, in a sentence for "Happening now". */
export function jobSentence(job: ActiveJob, streams?: StreamCoverage[], now = Date.now()): string {
  const verb = jobVerb(job.kind, streams);
  switch (job.state) {
    case "queued":
      return `${verb} is queued`;
    case "running":
      return job.lease_until && Date.parse(job.lease_until) < now ? `${verb} stalled; it recovers within ${LEASE_RECOVERY_MINUTES} minutes` : `${verb} is running`;
    case "retry_pending": {
      const at = job.next_attempt_at ? ` ${relativeTime(job.next_attempt_at, now)}` : "";
      if (job.error_code === "budget_exhausted") return `${verb} is paused${job.next_attempt_at ? ` until ${absoluteUtc(job.next_attempt_at)}` : ""}: a free-tier allowance is used up`;
      return `${verb} will retry${at} (${errorInWords(job.error_code)})`;
    }
  }
}

/** "Fetching older issue comments: 3 pages, 287 items, 12 s ago". */
export function lastRunSentence(run: LastRun, streams?: StreamCoverage[], now = Date.now()): string {
  const parts: string[] = [];
  if (run.pages !== null) parts.push(`${formatCount(run.pages)} page${run.pages === 1 ? "" : "s"}`);
  const items = run.records ?? run.inserted;
  if (items !== null) parts.push(`${formatCount(items)} ${run.kind === "embed_passages" || run.kind === "transform_passages" ? "passages" : "items"}`);
  parts.push(relativeTime(run.finished_at, now));
  return `${jobVerb(run.kind, streams)}: ${parts.join(", ")}`;
}

export type Chip = { label: string; tone: Tone; warn: boolean };

/** The chip above the results. The sentence under it is the API's own message. */
export function confidenceChip(r: SearchResponse): Chip {
  // When meaning-based search could not run, a warning mark replaces the dot; the API message says why.
  const warn = r.semantic_error !== null;
  if (r.mode === "none" || r.confidence === "none") return { label: "No supporting discussion", tone: "muted", warn };
  if (r.confidence === "high") return { label: "Strong matches", tone: "green", warn: false };
  if (r.mode === "keyword") return { label: "Keyword matches", tone: "amber", warn };
  return { label: "Weak matches", tone: "amber", warn };
}

/** Where a stream stands, as a dot: done (filled), running (filled, pulsing) or waiting (hollow). */
export function streamDot(s: StreamCoverage): "done" | "running" | "waiting" {
  if (s.phase === "pending") return "waiting";
  if (s.phase === "complete" && !s.sync_in_progress) return "done";
  return "running";
}

export type Strength = { label: "Strong" | "Fair" | "Weak" | "Keyword"; tone: Tone };

/** Per card. The raw score goes in a title attribute; the thresholds are ADR-0006's. */
export function matchStrength(card: EvidenceCard): Strength {
  if (card.match === "keyword") return { label: "Keyword", tone: "neutral" };
  if (card.score >= 0.8) return { label: "Strong", tone: "green" };
  if (card.score >= 0.7) return { label: "Fair", tone: "amber" };
  return { label: "Weak", tone: "muted" };
}

/** Share of fetched passages that are searchable, 0 to 100; null when nothing is fetched yet. */
export function searchablePercent(embedded: number, pending: number): number | null {
  const total = embedded + pending;
  return total === 0 ? null : Math.round((embedded / total) * 100);
}

/** The latest reset among exhausted budgets, or null. */
export function latestReset(budgets: BudgetState[]): string | null {
  const times = budgets.filter((b) => b.paused && b.resets_at !== null).map((b) => b.resets_at as string);
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

/** Four words for the header: what the service is doing about its free tier right now. */
export function stripView(status: ServiceStatus | null): { label: string; tone: Tone } {
  if (!status) return { label: "Checking the service status", tone: "muted" };
  if (status.paused) {
    const until = latestReset(status.budgets);
    return { label: until ? `Paused until ${absoluteUtc(until)}` : "Paused at a free-tier budget", tone: "amber" };
  }
  if (!status.admissions.open) return { label: "Not accepting new repositories", tone: "amber" };
  if (status.deferred.length > 0) return { label: `Indexing deferred: ${status.deferred[0].startsWith("queue") ? "queue budget low" : "storage at its limit"}`, tone: "amber" };
  return { label: "All systems normal", tone: "green" };
}
