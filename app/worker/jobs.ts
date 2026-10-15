import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../shared/api.ts";
import { type Budget, isBudgetExhausted, QUEUE_OPS_PER_MESSAGE } from "./budget.ts";

/** Compact queue message. Everything else is read from the job row on delivery. */
export type JobMessage = {
  jobId: number;
  repoId: number;
  kind: string;
  generation: number;
};

/** Longest delay a message is sent with: half the free plan's 24-hour retention. Longer waits rely on the reconcile cron. */
export const MAX_MESSAGE_DELAY_SECONDS = 12 * 3600;

/** The part of a Cloudflare Queue producer binding that enqueueJob uses. */
export type JobQueue = { send(message: JobMessage, options?: { delaySeconds?: number }): Promise<unknown> };

/** A queue whose sends reserve queue operations first; a refused reservation throws budget_exhausted before anything is sent. */
export function meteredQueue(queue: JobQueue, budget: Budget): JobQueue {
  return {
    async send(message, options) {
      await budget.take("queue_ops", QUEUE_OPS_PER_MESSAGE);
      return queue.send(message, options);
    },
  };
}

export async function createJob(db: SupabaseClient, repositoryId: number, kind: string): Promise<JobRecord> {
  const { data, error } = await db.from("jobs").insert({ repository_id: repositoryId, kind }).select().single();
  if (error) throw new Error(`insert jobs failed: ${error.message}`);
  return data as JobRecord;
}

/**
 * Bumps the job's generation and sends one message that carries it, optionally delayed.
 * Only a queued or retry_pending job can be enqueued; returns null otherwise. A consumer
 * compares the message generation with the row, so a message from an earlier enqueue
 * is recognised as stale. When the queue budget refuses the send, the row stays queued
 * without a message and the reconcile cron sends it once the budget's window has reset.
 */
export async function enqueueJob(
  db: SupabaseClient,
  queue: JobQueue,
  jobId: number,
  options: { delaySeconds?: number } = {},
): Promise<JobRecord | null> {
  const { data, error } = await db.rpc("enqueue_job", { p_job_id: jobId }).maybeSingle();
  if (error) throw new Error(`enqueue_job failed: ${error.message}`);
  if (!data) return null;
  const job = data as JobRecord;
  const message: JobMessage = { jobId: job.id, repoId: job.repository_id, kind: job.kind, generation: job.generation };
  const delaySeconds = Math.min(options.delaySeconds ?? 0, MAX_MESSAGE_DELAY_SECONDS);
  try {
    await queue.send(message, delaySeconds ? { delaySeconds } : undefined);
  } catch (err) {
    if (!isBudgetExhausted(err)) throw err;
    console.warn(`job ${job.id} stays queued without a message: ${err.message}`);
  }
  return job;
}

export async function getJob(db: SupabaseClient, id: number): Promise<JobRecord | null> {
  const { data, error } = await db.from("jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`select jobs failed: ${error.message}`);
  return data as JobRecord | null;
}

export type Claim =
  | { outcome: "claimed"; job: JobRecord }
  | { outcome: "already_running" | "not_due" | "stale" | "finished"; job: JobRecord }
  | { outcome: "missing"; job: null };

/**
 * Atomically leases the job named by a delivered message. The same owner seeing the
 * same message again is "claimed" again (the lease is extended), so a redelivery is
 * safe to process. Another owner gets "already_running" while the lease is active and
 * takes the job over once it has expired. A retry_pending job whose backoff has not
 * passed is "not_due". A message whose generation no longer matches the row is
 * "stale"; a job that already ended is "finished".
 */
export async function claimJob(
  db: SupabaseClient,
  message: JobMessage,
  owner: string,
  leaseSeconds = 300,
): Promise<Claim> {
  const { data, error } = await db
    .rpc("claim_job", {
      p_job_id: message.jobId,
      p_generation: message.generation,
      p_owner: owner,
      p_lease_seconds: leaseSeconds,
    })
    .maybeSingle();
  if (error) throw new Error(`claim_job failed: ${error.message}`);
  if (data) return { outcome: "claimed", job: data as JobRecord };

  const job = await getJob(db, message.jobId);
  if (!job) return { outcome: "missing", job: null };
  if (job.generation !== message.generation) return { outcome: "stale", job };
  if (job.state === "retry_pending") return { outcome: "not_due", job };
  if (job.state === "queued" || job.state === "running") return { outcome: "already_running", job };
  return { outcome: "finished", job };
}

export type JobResult =
  | { state: "succeeded"; result?: Record<string, unknown> }
  | { state: "failed"; error_code: string; error_message: string }
  | { state: "retry_pending"; error_code: string; error_message: string; next_attempt_at: string };

/**
 * Settles a running attempt, but only for the owner that holds its lease. Returns null when
 * the lease belongs to someone else or the job is no longer running, so a worker that
 * lost its lease cannot overwrite the takeover's result.
 */
export async function finishJob(
  db: SupabaseClient,
  jobId: number,
  owner: string,
  result: JobResult,
): Promise<JobRecord | null> {
  const { data, error } = await db
    .from("jobs")
    .update(result)
    .eq("id", jobId)
    .eq("state", "running")
    .eq("lease_owner", owner)
    .select()
    .maybeSingle();
  if (error) throw new Error(`finish job failed: ${error.message}`);
  return data as JobRecord | null;
}

/**
 * Creates and enqueues a job of `kind` unless one is already queued or waiting to retry
 * for the repository; returns null in that case. A running job does not block: it may have
 * chosen its work before the latest data landed, and a duplicate run that finds nothing to
 * do is cheap.
 */
export async function ensureQueuedJob(
  db: SupabaseClient,
  queue: JobQueue,
  repositoryId: number,
  kind: string,
  options: { delaySeconds?: number } = {},
): Promise<JobRecord | null> {
  const { data, error } = await db
    .from("jobs")
    .select("id")
    .eq("repository_id", repositoryId)
    .eq("kind", kind)
    .in("state", ["queued", "retry_pending"])
    .limit(1);
  if (error) throw new Error(`select jobs failed: ${error.message}`);
  if (data && data.length > 0) return null;
  const job = await createJob(db, repositoryId, kind);
  return enqueueJob(db, queue, job.id, options);
}
