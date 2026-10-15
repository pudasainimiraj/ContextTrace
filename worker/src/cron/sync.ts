import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "../queue/retry.ts";
import type { Budget } from "../queue/budget.ts";
import { BACKFILL_DELAY_SECONDS, fetchKind, rescanKind } from "../etl/extract.ts";
import { ensureQueuedJob, type JobQueue } from "../queue/jobs.ts";
import { storageState } from "./maintenance.ts";

/** How old a stream's last completed run may be before the cron syncs it again. Hourly: a sync and its chain cost queue operations. */
export const SYNC_INTERVAL_SECONDS = 60 * 60;
/** Below this share of the day's queue budget the schedulers queue nothing more. */
export const QUEUE_BUDGET_RESERVE_PCT = 20;
/** How old a stream's last rescan (or its backfill) may be before it is walked again for deletions. */
export const RESCAN_INTERVAL_SECONDS = 7 * 24 * 3600;
/** Streams queued per cron tick; the rest are picked up by the next tick. */
export const SYNC_BATCH_LIMIT = 50;

export type DueStream = { repository_id: number; stream: string };
export type SyncOptions = { intervalSeconds?: number; limit?: number; repositoryId?: number; budget?: Budget };
export type SyncSchedule = { due: number; queued: (DueStream & { job_id: number })[]; deferred?: boolean };

/** True when less than QUEUE_BUDGET_RESERVE_PCT of the day's queue operations remain. */
export async function queueBudgetLow(budget: Budget | undefined): Promise<boolean> {
  if (!budget) return false;
  const queue = (await budget.summary()).find((b) => b.resource === "queue_ops");
  return queue !== undefined && queue.remaining_pct < QUEUE_BUDGET_RESERVE_PCT;
}

/** Streams of searchable repositories whose last completed run is older than the interval. */
export async function dueStreams(db: SupabaseClient, options: SyncOptions = {}): Promise<DueStream[]> {
  const { data, error } = await db.rpc("streams_due_for_sync", {
    p_interval_seconds: options.intervalSeconds ?? SYNC_INTERVAL_SECONDS,
    p_limit: options.limit ?? SYNC_BATCH_LIMIT,
    p_repository_id: options.repositoryId ?? null,
  });
  if (error) throw dbError("streams_due_for_sync", error);
  return (data ?? []) as DueStream[];
}

/**
 * Cron entry point for incremental sync. Every due stream gets a fetch_<stream> job unless one
 * is already waiting. The job runs as an ascending listing since the stream's high-water mark
 * minus the overlap; the consumer chains the transform and the embedding after it, so a changed
 * source becomes searchable again without anyone re-indexing by hand.
 */
export async function scheduleSyncs(db: SupabaseClient, queue: JobQueue, options: SyncOptions = {}): Promise<SyncSchedule> {
  if (await queueBudgetLow(options.budget)) return { due: 0, queued: [], deferred: true };
  if (options.budget && (await storageState(options.budget)).level === "critical") return { due: 0, queued: [], deferred: true };
  const due = await dueStreams(db, options);
  const queued: SyncSchedule["queued"] = [];
  for (const stream of due) {
    const job = await ensureQueuedJob(db, queue, stream.repository_id, fetchKind(stream.stream));
    if (job) queued.push({ ...stream, job_id: job.id });
  }
  return { due: due.length, queued };
}

/** Completed streams whose last rescan (or backfill) is older than the interval. */
export async function dueRescans(db: SupabaseClient, options: SyncOptions = {}): Promise<DueStream[]> {
  const { data, error } = await db.rpc("streams_due_for_rescan", {
    p_interval_seconds: options.intervalSeconds ?? RESCAN_INTERVAL_SECONDS,
    p_limit: options.limit ?? SYNC_BATCH_LIMIT,
    p_repository_id: options.repositoryId ?? null,
  });
  if (error) throw dbError("streams_due_for_rescan", error);
  return (data ?? []) as DueStream[];
}

/**
 * Cron entry point for deletion sweeps: a low-priority rescan_<stream> job for every completed
 * stream that has not been walked for RESCAN_INTERVAL_SECONDS. GitHub never lists what was
 * deleted, so this is how removed comments and issues leave the index.
 */
export async function scheduleRescans(db: SupabaseClient, queue: JobQueue, options: SyncOptions = {}): Promise<SyncSchedule> {
  if (await queueBudgetLow(options.budget)) return { due: 0, queued: [], deferred: true };
  if (options.budget && (await storageState(options.budget)).level !== "ok") return { due: 0, queued: [], deferred: true };
  const due = await dueRescans(db, options);
  const queued: SyncSchedule["queued"] = [];
  for (const stream of due) {
    const job = await ensureQueuedJob(db, queue, stream.repository_id, rescanKind(stream.stream), { delaySeconds: BACKFILL_DELAY_SECONDS });
    if (job) queued.push({ ...stream, job_id: job.id });
  }
  return { due: due.length, queued };
}
