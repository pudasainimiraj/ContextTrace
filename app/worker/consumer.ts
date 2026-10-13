import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../shared/api.ts";
import { extractStream, STREAMS } from "./extract.ts";
import { claimJob, createJob, enqueueJob, ensureQueuedJob, finishJob, type JobMessage, type JobQueue } from "./jobs.ts";
import { nextJobKind } from "./pipeline.ts";
import { getRepository } from "./repositories.ts";
import { backoffSeconds, classifyError, JobError, MAX_ATTEMPTS } from "./retry.ts";
import { TRANSFORM_JOB_KIND, transformRepository } from "./transform.ts";

export type JobContext = { db: SupabaseClient; token?: string; fetch?: typeof globalThis.fetch };

/** What one run achieved; `done: false` asks for a continuation job of the same kind. */
export type RunResult = { done: boolean; result?: Record<string, unknown> };
export type JobRunner = (job: JobRecord, ctx: JobContext) => Promise<RunResult>;

export type ConsumerContext = JobContext & { queue: JobQueue; run?: JobRunner };

/** Job kinds that are not extraction streams. */
const RUNNERS: Record<string, JobRunner> = {
  [TRANSFORM_JOB_KIND]: async (job, ctx) => {
    const { done, ...result } = await transformRepository(ctx.db, job.repository_id);
    return { done, result };
  },
};

/** Dispatches a job to the runner or the stream extractor for its kind. */
export const runJob: JobRunner = async (job, ctx) => {
  const runner = RUNNERS[job.kind];
  if (runner) return runner(job, ctx);
  const spec = STREAMS[job.kind];
  if (!spec) throw new JobError("unknown_kind", `No extractor for job kind "${job.kind}"`, { transient: false });
  const repository = await getRepository(ctx.db, job.repository_id);
  if (!repository) {
    throw new JobError("repository_missing", `Repository ${job.repository_id} is not registered`, { transient: false });
  }
  const { done, ...result } = await extractStream(ctx, spec, repository, job.id);
  return { done, result };
};

/**
 * Handles one delivered queue message.
 *
 * - A refused claim means a duplicate, a stale message or a job that already ended:
 *   the message is acked without work. A retry_pending job that is not yet due asks
 *   the queue to redeliver when its backoff ends.
 * - A claimed job runs and is finished by its lease holder with its result. A run that
 *   stopped at its page budget gets a continuation job of the same kind; a finished run
 *   queues the job kind that follows it, unless one is already waiting.
 * - A transient error parks the job as retry_pending with exponential backoff and
 *   re-enqueues it with a matching delay. A permanent error, or a transient one past
 *   MAX_ATTEMPTS, fails the job. The message is acked in every case.
 */
export async function consumeJobMessage(
  ctx: ConsumerContext,
  message: Message<unknown>,
  owner: string,
): Promise<void> {
  if (!isJobMessage(message.body)) {
    console.warn("ignoring malformed job message", message.id);
    message.ack();
    return;
  }

  const claim = await claimJob(ctx.db, message.body, owner);
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
  const run = ctx.run ?? runJob;
  try {
    const startedAt = Date.now();
    const outcome = await run(job, ctx);
    // Wall time of the run as the Worker sees it (the clock only advances across I/O).
    const result = { ...outcome.result, durationMs: Date.now() - startedAt };
    await finishJob(ctx.db, job.id, owner, { state: "succeeded", result });
    if (!outcome.done) {
      const next = await createJob(ctx.db, job.repository_id, job.kind);
      await enqueueJob(ctx.db, ctx.queue, next.id);
    } else {
      await queueFollowUp(ctx, job);
    }
  } catch (err) {
    const failure = classifyError(err);
    if (failure.transient && job.attempt < MAX_ATTEMPTS) {
      const delaySeconds = backoffSeconds(job.attempt, failure.retryAfterSeconds);
      const parked = await finishJob(ctx.db, job.id, owner, {
        state: "retry_pending",
        error_code: failure.code,
        error_message: failure.message,
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      });
      if (parked) await enqueueJob(ctx.db, ctx.queue, job.id, { delaySeconds });
    } else {
      await finishJob(ctx.db, job.id, owner, {
        state: "failed",
        error_code: failure.code,
        error_message: failure.message,
      });
    }
  }
  message.ack();
}

/** Queues the job kind that follows a finished job; a failure here never undoes the finished run. */
async function queueFollowUp(ctx: ConsumerContext, job: JobRecord): Promise<void> {
  const next = nextJobKind(job.kind);
  if (!next) return;
  try {
    await ensureQueuedJob(ctx.db, ctx.queue, job.repository_id, next);
  } catch (err) {
    console.error(`could not queue ${next} after job ${job.id}`, err);
  }
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
