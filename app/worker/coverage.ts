import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "./retry.ts";
import type { CoverageReport, RepositoryRecord, SourceType, StreamCoverage, StreamPhase } from "../shared/api.ts";
import type { StreamCheckpoint } from "./checkpoints.ts";
import { STREAM_SOURCE_TYPES } from "./extract.ts";

const SOURCE_TYPES: SourceType[] = ["issue", "pull_request", "issue_comment", "review_comment"];
const JOB_STATES = ["queued", "running", "retry_pending", "failed"] as const;

type CoverageRow = {
  sources?: Record<string, number>;
  documents?: number;
  passages?: number;
  embedded?: number;
  pending?: number;
  jobs?: Record<string, number>;
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
