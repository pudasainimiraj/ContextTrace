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
export type JobQueue = { send(message: JobMessage): Promise<unknown> };

export async function createJob(db: SupabaseClient, repositoryId: number, kind: string): Promise<JobRecord> {
  const { data, error } = await db.from("jobs").insert({ repository_id: repositoryId, kind }).select().single();
  if (error) throw new Error(`insert jobs failed: ${error.message}`);
  return data as JobRecord;
}

/**
 * Bumps the job's generation and sends one message that carries it. Only a queued job
 * can be enqueued; returns null otherwise. A consumer compares the message generation
 * with the row, so a message from an earlier enqueue is recognised as stale.
 */
export async function enqueueJob(
  db: SupabaseClient,
  queue: JobQueue,
  jobId: number,
): Promise<JobRecord | null> {
  const { data, error } = await db.rpc("enqueue_job", { p_job_id: jobId }).maybeSingle();
  if (error) throw new Error(`enqueue_job failed: ${error.message}`);
  if (!data) return null;
  const job = data as JobRecord;
  await queue.send({ jobId: job.id, repoId: job.repository_id, kind: job.kind, generation: job.generation });
  return job;
}
