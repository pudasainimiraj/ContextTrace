import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "../queue/retry.ts";
import type { ActiveJob, BudgetState, CoverageReport, LastRun, RepositoryRecord, RepositorySummary, SourceType, StreamCoverage, StreamPhase } from "../../../shared/api.ts";
import type { StreamCheckpoint } from "../etl/checkpoints.ts";
import { STREAM_SOURCE_TYPES } from "../etl/extract.ts";

const SOURCE_TYPES: SourceType[] = ["issue", "pull_request", "issue_comment", "review_comment"];
const JOB_STATES = ["queued", "running", "retry_pending", "failed"] as const;
const STREAM_COUNT = Object.keys(STREAM_SOURCE_TYPES).length;

/** One active job as repository_coverage and repository_summaries build it; the shape the API shows. */
type ActiveJobRow = Partial<ActiveJob> & { kind: string; state: ActiveJob["state"] };
/** One succeeded job per kind, with the result the run recorded. */
type LastRunRow = { kind: string; finished_at: string; result: Record<string, unknown> | null };

type CoverageRow = {
  sources?: Record<string, number>;
  documents?: number;
  passages?: number;
  embedded?: number;
  pending?: number;
  jobs?: Record<string, number>;
  active_jobs?: ActiveJobRow[];
  last_runs?: LastRunRow[];
  streams?: StreamCheckpoint[];
};

/** Coverage counts, per-stream progress, high-water marks and sync times for one repository. */
export async function getCoverage(db: SupabaseClient, repository: RepositoryRecord): Promise<CoverageReport> {
  const { data, error } = await db.rpc("repository_coverage", { p_repository_id: repository.id });
  if (error) throw dbError("repository_coverage", error);
  const row = (data ?? {}) as CoverageRow;
  const checkpoints = new Map((row.streams ?? []).map((c) => [c.stream, c]));
  const streams = Object.keys(STREAM_SOURCE_TYPES).map((stream) => streamCoverage(stream, checkpoints.get(stream)));
  const syncs = streams.map((s) => s.last_synced_at);
  return {
    repository_id: repository.id,
    status: repository.status,
    partial: repository.status !== "searchable",
    last_error: repository.last_error,
    sources: Object.fromEntries(SOURCE_TYPES.map((type) => [type, row.sources?.[type] ?? 0])) as Record<SourceType, number>,
    documents: row.documents ?? 0,
    passages: row.passages ?? 0,
    embedded: row.embedded ?? 0,
    pending: row.pending ?? 0,
    streams,
    completed_source_types: streams.filter((s) => s.complete).flatMap((s) => s.source_types),
    // Conservative: the oldest of the streams' last completed runs, once every stream has one.
    last_successful_sync_at: syncs.every((t): t is string => t !== null) ? syncs.reduce((a, b) => (a < b ? a : b)) : null,
    jobs: Object.fromEntries(JOB_STATES.map((state) => [state, row.jobs?.[state] ?? 0])) as CoverageReport["jobs"],
    active_jobs: activeJobs(row.active_jobs),
    last_runs: lastRuns(row.last_runs),
    paused_until: null, // the handler fills this in from the budget ledger
  };
}

export function streamCoverage(stream: string, checkpoint: StreamCheckpoint | undefined): StreamCoverage {
  const phase: StreamPhase = !checkpoint
    ? "pending"
    : !checkpoint.head_done_at
      ? "head"
      : !checkpoint.backfill_done_at
        ? "backfill"
        : checkpoint.rescan_started_at
          ? "rescan"
          : "complete";
  return {
    stream,
    source_types: STREAM_SOURCE_TYPES[stream] ?? [],
    phase,
    complete: Boolean(checkpoint?.backfill_done_at),
    high_water_mark: checkpoint?.last_item_at ?? null,
    last_synced_at: checkpoint?.last_synced_at ?? null,
    backfill_done_at: checkpoint?.backfill_done_at ?? null,
    backfill_pending: Boolean(checkpoint?.cursor) && !checkpoint?.backfill_done_at,
    sync_in_progress: Boolean(checkpoint?.sync_cursor),
    rescan_in_progress: Boolean(checkpoint?.rescan_started_at),
    last_rescan_at: checkpoint?.last_rescan_at ?? null,
    capped: Boolean(checkpoint?.capped_at),
    capped_at: checkpoint?.capped_at ?? null,
    pages_fetched: checkpoint?.pages_fetched ?? 0,
    items_fetched: checkpoint?.items_fetched ?? 0,
  };
}

/** The active job rows as the API shows them: every field present, the error message never among them. */
function activeJobs(rows: ActiveJobRow[] | undefined): ActiveJob[] {
  return (rows ?? []).map((r) => ({
    kind: r.kind,
    state: r.state,
    error_code: r.error_code ?? null,
    next_attempt_at: r.next_attempt_at ?? null,
    started_at: r.started_at ?? null,
    attempt: r.attempt ?? 0,
    lease_until: r.lease_until ?? null,
  }));
}

/** The newest succeeded run per kind, with the counts its result recorded (absent ones are null). */
function lastRuns(rows: LastRunRow[] | undefined): LastRun[] {
  return (rows ?? []).map((r) => {
    const result = r.result ?? {};
    const num = (key: string): number | null => (typeof result[key] === "number" ? (result[key] as number) : null);
    return { kind: r.kind, finished_at: r.finished_at, pages: num("pages"), records: num("records"), inserted: num("inserted"), duration_ms: num("durationMs") };
  });
}

/** The latest reset time among exhausted budgets, or null when none is exhausted. */
export function pausedUntil(budgets: BudgetState[]): string | null {
  const times = budgets.filter((b) => b.paused && b.resets_at !== null).map((b) => b.resets_at as string);
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

type SummaryRow = {
  id: number;
  full_name: string;
  status: RepositoryRecord["status"];
  status_changed_at: string;
  last_error: string | null;
  passages: number;
  embedded: number;
  pending: number;
  streams_synced: number;
  oldest_sync_at: string | null;
  active_jobs: ActiveJobRow[];
};

/** Every repository that is not removed, in list order: working ones first, then by last sync, newest first; unreachable ones last. */
export async function listRepositorySummaries(db: SupabaseClient): Promise<RepositorySummary[]> {
  const { data, error } = await db.rpc("repository_summaries");
  if (error) throw dbError("repository_summaries", error);
  const rows = (data ?? []) as SummaryRow[];
  return rows
    .map((r) => ({
      id: r.id,
      full_name: r.full_name,
      status: r.status,
      status_changed_at: r.status_changed_at,
      last_error: r.last_error,
      passages: r.passages,
      embedded: r.embedded,
      pending: r.pending,
      // The same rule as the coverage report: every stream has completed a run, and the oldest of those counts.
      last_successful_sync_at: r.streams_synced >= STREAM_COUNT ? r.oldest_sync_at : null,
      active_jobs: activeJobs(r.active_jobs),
    }))
    .sort(bySummaryOrder);
}

/** Repositories with work in flight first, unreachable ones last, the rest by their last sync (or status change), newest first. */
export function bySummaryOrder(a: RepositorySummary, b: RepositorySummary): number {
  const rank = (s: RepositorySummary) => (s.active_jobs.length > 0 ? 0 : s.status === "inaccessible" ? 2 : 1);
  const time = (s: RepositorySummary) => Date.parse(s.last_successful_sync_at ?? s.status_changed_at);
  return rank(a) - rank(b) || time(b) - time(a) || a.id - b.id;
}
