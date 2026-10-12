import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../shared/api.ts";
import { claimJob, enqueueJob, finishJob, type JobMessage, type JobQueue } from "./jobs.ts";
import { backoffSeconds, classifyError, MAX_ATTEMPTS } from "./retry.ts";

/** The work a job performs. No-op until the fetch pipeline lands. */
export type JobRunner = (job: JobRecord) => Promise<void>;
const runJob: JobRunner = async () => {};

/**
 * Handles one delivered queue message.
 *
 * - A refused claim means a duplicate, a stale message or a job that already ended:
 *   the message is acked without work. A retry_pending job that is not yet due asks
 *   the queue to redeliver when its backoff ends.
 * - A claimed job runs and is finished by its lease holder.
 * - A transient error parks the job as retry_pending with exponential backoff and
 *   re-enqueues it with a matching delay. A permanent error, or a transient one past
 *   MAX_ATTEMPTS, fails the job. The message is acked in every case.
 */
export async function consumeJobMessage(
  db: SupabaseClient,
  message: Message<unknown>,
  owner: string,
  queue: JobQueue,
  run: JobRunner = runJob,
): Promise<void> {
  if (!isJobMessage(message.body)) {
    console.warn("ignoring malformed job message", message.id);
    message.ack();
    return;
  }

  const claim = await claimJob(db, message.body, owner);
  if (claim.outcome === "not_due") {
    const waitMs = Date.parse(claim.job.next_attempt_at ?? "") - Date.now();
    message.retry({ delaySeconds: Math.max(1, Math.ceil(waitMs / 1000)) });
    return;
  }
  if (claim.outcome !== "claimed") {
    message.ack();
    return;
  }

  const job = claim.job;
  try {
    await run(job);
    await finishJob(db, job.id, owner, { state: "succeeded" });
  } catch (err) {
    const failure = classifyError(err);
    if (failure.transient && job.attempt < MAX_ATTEMPTS) {
      const delaySeconds = backoffSeconds(job.attempt, failure.retryAfterSeconds);
      const parked = await finishJob(db, job.id, owner, {
        state: "retry_pending",
        error_code: failure.code,
        error_message: failure.message,
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      });
      if (parked) await enqueueJob(db, queue, job.id, { delaySeconds });
    } else {
      await finishJob(db, job.id, owner, { state: "failed", error_code: failure.code, error_message: failure.message });
    }
  }
  message.ack();
}

export function isJobMessage(body: unknown): body is JobMessage {
  if (typeof body !== "object" || body === null) return false;
  const m = body as Record<string, unknown>;
  return (
    typeof m.jobId === "number" &&
    typeof m.repoId === "number" &&
    typeof m.kind === "string" &&
    typeof m.generation === "number"
  );
}
