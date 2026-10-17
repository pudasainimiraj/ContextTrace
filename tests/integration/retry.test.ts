import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../../shared/api.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import { createJob, enqueueJob, getJob, type JobMessage, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { backoffSeconds, classifyError, JobError, jobErrorFromLookup, MAX_ATTEMPTS } from "../../worker/src/queue/retry.ts";
import { fakeMessage, repoFixture } from "./helpers.ts";

describe("retry classification", () => {
  it("backs off exponentially from 30s, caps at 15 minutes and never goes below Retry-After", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => backoffSeconds(attempt))).toEqual([30, 60, 120, 240, 480, 900]);
    expect(backoffSeconds(1, 7)).toBe(30);
    expect(backoffSeconds(1, 120)).toBe(120);
  });

  it("treats rate limits, 5xx and network failures as transient and the rest as permanent", () => {
    expect(jobErrorFromLookup({ kind: "rate_limited", retryAfterSeconds: 9 })).toMatchObject({
      code: "rate_limited",
      transient: true,
      retryAfterSeconds: 9,
    });
    expect(jobErrorFromLookup({ kind: "upstream_error", status: 502, message: "bad gateway" }).transient).toBe(true);
    expect(jobErrorFromLookup({ kind: "upstream_error", status: 0, message: "boom" }).transient).toBe(true);
    expect(jobErrorFromLookup({ kind: "upstream_error", status: 400, message: "bad" }).transient).toBe(false);
    expect(jobErrorFromLookup({ kind: "not_found" }).transient).toBe(false);
    expect(jobErrorFromLookup({ kind: "private" }).transient).toBe(false);

    expect(classifyError(new TypeError("fetch failed"))).toMatchObject({ code: "network", transient: true });
    expect(classifyError(new Error("schema mismatch"))).toMatchObject({ code: "unhandled", transient: false });
    expect(classifyError("boom")).toMatchObject({ code: "unhandled", message: "boom", transient: false });
  });
});

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 20;
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

const transientFailure = async () => {
  throw new JobError("rate_limited", "GitHub 403", { transient: true, retryAfterSeconds: 7 });
};
const permanentFailure = async () => {
  throw new Error("schema mismatch");
};
const success = async () => ({ done: true });

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/retries" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("consumer retries", () => {
  it("parks a transient failure as retry_pending, re-enqueues with backoff and retries once due", async () => {
    const queue = fakeQueue();
    const job = await queuedJob(queue);
    queue.send.mockClear();

    const first = fakeMessage(messageFor(job));
    await consumeJobMessage({ db, queue, run: transientFailure }, first, "worker-a");
    expect(first.ack).toHaveBeenCalledTimes(1);

    const parked = await getJob(db, job.id);
    expect(parked).toMatchObject({
      state: "retry_pending",
      attempt: 1,
      generation: 2,
      error_code: "rate_limited",
      error_message: "GitHub 403",
      lease_owner: null,
    });
    const waitMs = Date.parse(parked!.next_attempt_at!) - Date.now();
    expect(waitMs).toBeGreaterThan(20_000);
    expect(waitMs).toBeLessThanOrEqual(30_000);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0]).toEqual([messageFor(job, 2), { delaySeconds: 30 }]);

    // The delayed message arrives before the backoff has passed: redeliver later, do nothing.
    const early = fakeMessage(messageFor(job, 2));
    await consumeJobMessage({ db, queue, run: success }, early, "worker-b");
    expect(early.ack).not.toHaveBeenCalled();
    expect(early.retry).toHaveBeenCalledTimes(1);
    const delay = early.retry.mock.calls[0][0]?.delaySeconds ?? 0;
    expect(delay).toBeGreaterThanOrEqual(1);
    expect(delay).toBeLessThanOrEqual(30);
    expect((await getJob(db, job.id))?.state).toBe("retry_pending");

    // Once the backoff has passed the retry runs as attempt 2 and starts clean.
    await db.from("jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", job.id);
    const due = fakeMessage(messageFor(job, 2));
    await consumeJobMessage({ db, queue, run: success }, due, "worker-b");
    expect(due.ack).toHaveBeenCalledTimes(1);
    expect(await getJob(db, job.id)).toMatchObject({
      state: "succeeded",
      attempt: 2,
      error_code: null,
      error_message: null,
      next_attempt_at: null,
    });
    const { data: log } = await db.from("job_transitions").select("to_state, note").eq("job_id", job.id).order("id");
    expect(log).toEqual([
      { to_state: "queued", note: null },
      { to_state: "running", note: null },
      { to_state: "retry_pending", note: "GitHub 403" },
      { to_state: "running", note: null },
      { to_state: "succeeded", note: null },
    ]);
  });

  it("fails a permanent error without re-enqueueing", async () => {
    const queue = fakeQueue();
    const job = await queuedJob(queue);
    queue.send.mockClear();

    const message = fakeMessage(messageFor(job));
    await consumeJobMessage({ db, queue, run: permanentFailure }, message, "worker-a");

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(await getJob(db, job.id)).toMatchObject({ state: "failed", attempt: 1, error_code: "unhandled" });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("gives up after the attempt limit", async () => {
    const queue = fakeQueue();
    const job = await queuedJob(queue);
    queue.send.mockClear();
    await db.from("jobs").update({ attempt: MAX_ATTEMPTS - 1 }).eq("id", job.id);

    const message = fakeMessage(messageFor(job));
    await consumeJobMessage({ db, queue, run: transientFailure }, message, "worker-a");

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(await getJob(db, job.id)).toMatchObject({ state: "failed", attempt: MAX_ATTEMPTS, error_code: "rate_limited" });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
