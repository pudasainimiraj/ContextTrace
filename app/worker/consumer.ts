import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../shared/api.ts";
import { claimJob, finishJob, type JobMessage } from "./jobs.ts";

/**
 * Handles one delivered queue message. A claim that is refused means the message is a
 * duplicate, is stale, or names a job that already ended, so it is acked without work.
 * A claimed job runs, is finished by its lease holder, and is acked. An error marks
 * the job failed and acks the message; retry classification arrives in CT-11.
 */
export async function consumeJobMessage(
  db: SupabaseClient,
  message: Message<unknown>,
  owner: string,
): Promise<void> {
  if (!isJobMessage(message.body)) {
    console.warn("ignoring malformed job message", message.id);
    message.ack();
    return;
  }

  const claim = await claimJob(db, message.body, owner);
  if (claim.outcome !== "claimed") {
    message.ack();
    return;
  }

  try {
    await runJob(claim.job);
    await finishJob(db, claim.job.id, owner, { state: "succeeded" });
  } catch (err) {
    const error_message = err instanceof Error ? err.message : String(err);
    await finishJob(db, claim.job.id, owner, { state: "failed", error_code: "unhandled", error_message });
  }
  message.ack();
}

/** No-op until the fetch pipeline lands; proves the queue, lease and state plumbing. */
async function runJob(_job: JobRecord): Promise<void> {}

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
