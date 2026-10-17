import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../../shared/api.ts";
import { claimJob, createJob, enqueueJob, finishJob, getJob, type JobMessage, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { reconcileJobs } from "../../worker/src/cron/reconcile.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { MAX_ATTEMPTS } from "../../worker/src/queue/retry.ts";
import { repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme. Every
// sweep is limited to this repository so parallel test files are never touched.
const REPO_ID = Date.now() * 100 + 30;
const db = createDb(env);

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

async function queuedJob(queue: JobQueue): Promise<JobRecord> {
  const job = await createJob(db, REPO_ID, "fetch_issues");
  const sent = await enqueueJob(db, queue, job.id);
  if (!sent) throw new Error("enqueue failed");
  return sent;
}

function messageFor(job: JobRecord, generation = job.generation): JobMessage {
  return { jobId: job.id, repoId: job.repository_id, kind: job.kind, generation };
}

/** A job parked as retry_pending that became due `dueAgoMs` ago. */
async function parkedJob(queue: JobQueue, dueAgoMs: number): Promise<JobRecord> {
  const job = await queuedJob(queue);
  await claimJob(db, messageFor(job), "worker-a");
  const parked = await finishJob(db, job.id, "worker-a", {
    state: "retry_pending",
    error_code: "rate_limited",
    error_message: "GitHub 403",
    next_attempt_at: new Date(Date.now() - dueAgoMs).toISOString(),
  });
  if (!parked) throw new Error("park failed");
  return parked;
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/reconcile" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("reconcileJobs", () => {
  it("re-enqueues a job whose lease expired and records why", async () => {
    const queue = fakeQueue();
    const job = await queuedJob(queue);
    expect((await claimJob(db, messageFor(job), "worker-a", 0)).outcome).toBe("claimed"); // lease expires at once
    queue.send.mockClear();

    const result = await reconcileJobs(db, queue, { repositoryId: REPO_ID });
    expect(result).toEqual({ requeued: [job.id], failed: [] });

    expect(await getJob(db, job.id)).toMatchObject({
      state: "retry_pending",
      generation: 2,
      attempt: 1,
      error_code: "lease_expired",
      lease_owner: null,
    });
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0][0]).toEqual(messageFor(job, 2));

    // The fresh message is claimable at once and starts a new attempt.
    const retry = await claimJob(db, messageFor(job, 2), "worker-b");
    expect(retry.outcome).toBe("claimed");
    expect(retry.job).toMatchObject({ attempt: 2, lease_owner: "worker-b" });

    const { data: log } = await db.from("job_transitions").select("to_state, note").eq("job_id", job.id).order("id");
    expect(log).toEqual([
      { to_state: "queued", note: null },
      { to_state: "running", note: null },
      { to_state: "retry_pending", note: "lease expired without a result" },
      { to_state: "running", note: null },
    ]);
  });

  it("fails an expired job that has used up its attempts", async () => {
    const queue = fakeQueue();
    const job = await queuedJob(queue);
    await claimJob(db, messageFor(job), "worker-a", 0);
    await db.from("jobs").update({ attempt: MAX_ATTEMPTS }).eq("id", job.id);
    queue.send.mockClear();

    const result = await reconcileJobs(db, queue, { repositoryId: REPO_ID });
    expect(result.failed).toEqual([job.id]);
    expect(result.requeued).not.toContain(job.id);
    expect(await getJob(db, job.id)).toMatchObject({ state: "failed", error_code: "lease_expired", generation: 1 });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("re-enqueues a retry whose delayed message never came back, within the grace period it waits", async () => {
    const queue = fakeQueue();
    const lost = await parkedJob(queue, 3 * 60_000); // due three minutes ago
    const recent = await parkedJob(queue, 10_000); // due ten seconds ago
    const fresh = await queuedJob(queue); // its message is in flight
    queue.send.mockClear();

    const result = await reconcileJobs(db, queue, { repositoryId: REPO_ID });
    expect(result.requeued).toEqual([lost.id]);

    expect((await getJob(db, lost.id))?.generation).toBe(2);
    expect((await getJob(db, recent.id))?.generation).toBe(1);
    expect((await getJob(db, fresh.id))?.generation).toBe(1);
    expect(queue.send.mock.calls.map(([message]) => message.jobId)).toEqual([lost.id]);
  });
});
