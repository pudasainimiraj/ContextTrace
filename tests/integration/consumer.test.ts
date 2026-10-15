import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../../shared/api.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import worker from "../../worker/src/index.ts";
import { createJob, enqueueJob, getJob, type JobMessage } from "../../worker/src/queue/jobs.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { fakeMessage, repoFixture, type FakeMessage } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 60;
const db = createDb(env);
const silentQueue = { send: async () => {} };

/** Delivers the messages to the consumer with a no-op runner, one lease owner per batch. */
async function deliver(messages: FakeMessage[]): Promise<void> {
  const owner = `consumer:${crypto.randomUUID()}`;
  for (const message of messages) {
    await consumeJobMessage({ db, queue: silentQueue, run: async () => ({ done: true }) }, message, owner);
  }
}

/** Delivers the messages to the Worker's queue handler the way the runtime would. */
async function deliverToHandler(messages: FakeMessage[]): Promise<void> {
  const batch = { queue: "contexttrace-jobs", messages, ackAll: vi.fn(), retryAll: vi.fn() };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  await worker.queue(batch as unknown as MessageBatch<JobMessage>, env, ctx);
}

async function queuedJob(): Promise<JobRecord> {
  const job = await createJob(db, REPO_ID, "fetch_issues");
  const sent = await enqueueJob(db, silentQueue, job.id);
  if (!sent) throw new Error("enqueue failed");
  return sent;
}

function messageFor(job: JobRecord): JobMessage {
  return { jobId: job.id, repoId: job.repository_id, kind: job.kind, generation: job.generation };
}

function transitionsOf(jobId: number) {
  return db.from("job_transitions").select("from_state, to_state").eq("job_id", jobId).order("id");
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/consumer" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("queue consumer", () => {
  it("runs a delivered job to completion and the state persists in the database", async () => {
    const job = await queuedJob();
    const message = fakeMessage(messageFor(job));

    await deliver([message]);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    const stored = await getJob(db, job.id);
    expect(stored).toMatchObject({ state: "succeeded", attempt: 1, lease_owner: null, lease_until: null });
    expect(stored?.started_at).not.toBeNull();
    expect(stored?.finished_at).not.toBeNull();
    expect((await transitionsOf(job.id)).data).toEqual([
      { from_state: null, to_state: "queued" },
      { from_state: "queued", to_state: "running" },
      { from_state: "running", to_state: "succeeded" },
    ]);
  });

  it("acks a duplicate or stale delivery without touching the finished job", async () => {
    const job = await queuedJob();
    await deliver([fakeMessage(messageFor(job))]);

    const duplicate = fakeMessage(messageFor(job), 2);
    const stale = fakeMessage({ ...messageFor(job), generation: 0 });
    await deliver([duplicate, stale]);

    expect(duplicate.ack).toHaveBeenCalledTimes(1);
    expect(stale.ack).toHaveBeenCalledTimes(1);
    expect(await getJob(db, job.id)).toMatchObject({ state: "succeeded", attempt: 1 });
    expect((await transitionsOf(job.id)).data).toHaveLength(3);
  });

  it("acks a malformed message delivered to the Worker's queue handler", async () => {
    const message = fakeMessage({ hello: "world" });
    await deliverToHandler([message]);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});
