import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../../../shared/api.ts";
import { enqueueJob, type JobQueue } from "../queue/jobs.ts";
import { MAX_ATTEMPTS, dbError } from "../queue/retry.ts";

/** How long a due retry or a queued job may wait for its message before it is resent. */
export const RECONCILE_GRACE_SECONDS = 120;

export type Reconciliation = { requeued: number[]; failed: number[] };

/**
 * Cron safety net for messages that never came back: a lease that expired because the
 * consumer died or its message expired, a retry whose delayed message was lost, or a
 * queued job whose message was never sent. Each such job gets a fresh message with a
 * new generation; an old message that still exists is stale and is acked on delivery.
 * A lease that expired after MAX_ATTEMPTS fails the job instead.
 */
export async function reconcileJobs(
  db: SupabaseClient,
  queue: JobQueue,
  options: { repositoryId?: number; graceSeconds?: number } = {},
): Promise<Reconciliation> {
  const { data, error } = await db.rpc("reconcile_jobs", {
    p_max_attempts: MAX_ATTEMPTS,
    p_grace_seconds: options.graceSeconds ?? RECONCILE_GRACE_SECONDS,
    p_repository_id: options.repositoryId ?? null,
  });
  if (error) throw dbError("reconcile_jobs", error);

  const result: Reconciliation = { requeued: [], failed: [] };
  for (const job of (data ?? []) as JobRecord[]) {
    if (job.state === "failed") {
      result.failed.push(job.id);
    } else if (await enqueueJob(db, queue, job.id)) {
      result.requeued.push(job.id);
    }
  }
  return result;
}
