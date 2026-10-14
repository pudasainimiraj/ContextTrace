import type { SupabaseClient } from "@supabase/supabase-js";
import { BACKFILL_DELAY_SECONDS, fetchKind, rescanKind } from "./extract.ts";
import { ensureQueuedJob, type JobQueue } from "./jobs.ts";

/** How old a stream's last completed run may be before the cron syncs it again. */
export const SYNC_INTERVAL_SECONDS = 15 * 60;
/** How old a stream's last rescan (or its backfill) may be before it is walked again for deletions. */
export const RESCAN_INTERVAL_SECONDS = 7 * 24 * 3600;
/** Streams queued per cron tick; the rest are picked up by the next tick. */
export const SYNC_BATCH_LIMIT = 50;

export type DueStream = { repository_id: number; stream: string };
export type SyncOptions = { intervalSeconds?: number; limit?: number; repositoryId?: number };
export type SyncSchedule = { due: number; queued: (DueStream & { job_id: number })[] };

/** Streams of searchable repositories whose last completed run is older than the interval. */
export async function dueStreams(db: SupabaseClient, options: SyncOptions = {}): Promise<DueStream[]> {
  const { data, error } = await db.rpc("streams_due_for_sync", {
    p_interval_seconds: options.intervalSeconds ?? SYNC_INTERVAL_SECONDS,
    p_limit: options.limit ?? SYNC_BATCH_LIMIT,
    p_repository_id: options.repositoryId ?? null,
  });
  if (error) throw new Error(`streams_due_for_sync failed: ${error.message}`);
  return (data ?? []) as DueStream[];
}

/**
 * Cron entry point for incremental sync. Every due stream gets a fetch_<stream> job unless one
 * is already waiting. The job runs as an ascending listing since the stream's high-water mark
 * minus the overlap; the consumer chains the transform and the embedding after it, so a changed
 * source becomes searchable again without anyone re-indexing by hand.
 */
export async function scheduleSyncs(db: SupabaseClient, queue: JobQueue, options: SyncOptions = {}): Promise<SyncSchedule> {
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
  if (error) throw new Error(`streams_due_for_rescan failed: ${error.message}`);
  return (data ?? []) as DueStream[];
}

/**
 * Cron entry point for deletion sweeps: a low-priority rescan_<stream> job for every completed
 * stream that has not been walked for RESCAN_INTERVAL_SECONDS. GitHub never lists what was
 * deleted, so this is how removed comments and issues leave the index.
 */
export async function scheduleRescans(db: SupabaseClient, queue: JobQueue, options: SyncOptions = {}): Promise<SyncSchedule> {
  const due = await dueRescans(db, options);
  const queued: SyncSchedule["queued"] = [];
  for (const stream of due) {
    const job = await ensureQueuedJob(db, queue, stream.repository_id, rescanKind(stream.stream), { delaySeconds: BACKFILL_DELAY_SECONDS });
    if (job) queued.push({ ...stream, job_id: job.id });
  }
  return { due: due.length, queued };
}
