import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../shared/api.ts";

/** Compact queue message. Everything else is read from the job row on delivery. */
export type JobMessage = {
  jobId: number;
  repoId: number;
  kind: string;
  generation: number;
};

/** The part of a Cloudflare Queue producer binding that enqueueJob uses. */
export type JobQueue = { send(message: JobMessage, options?: { delaySeconds?: number }): Promise<unknown> };

export async function createJob(db: SupabaseClient, repositoryId: number, kind: string): Promise<JobRecord> {
  const { data, error } = await db.from("jobs").insert({ repository_id: repositoryId, kind }).select().single();
  if (error) throw new Error(`insert jobs failed: ${error.message}`);
  return data as JobRecord;
}

/**
 * Bumps the job's generation and sends one message that carries it, optionally delayed.
 * Only a queued or retry_pending job can be enqueued; returns null otherwise. A consumer
 * compares the message generation with the row, so a message from an earlier enqueue
 * is recognised as stale.
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
  await queue.send(message, options.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined);
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
