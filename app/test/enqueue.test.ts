import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJob, enqueueJob, type JobMessage } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 80;
const db = createDb(env);

function fakeQueue() {
  return { send: vi.fn<(message: JobMessage) => Promise<void>>(async () => {}) };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/enqueue" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("enqueueJob", () => {
  it("sends one compact message per enqueue with an increasing generation", async () => {
    const queue = fakeQueue();
    const job = await createJob(db, REPO_ID, "fetch_issues");
    expect(job.generation).toBe(0);

    const first = await enqueueJob(db, queue, job.id);
    expect(first?.generation).toBe(1);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0][0]).toEqual({ jobId: job.id, repoId: REPO_ID, kind: "fetch_issues", generation: 1 });

    const second = await enqueueJob(db, queue, job.id);
    expect(second?.generation).toBe(2);
    expect(queue.send.mock.calls[1][0]).toEqual({ jobId: job.id, repoId: REPO_ID, kind: "fetch_issues", generation: 2 });
  });

  it("does not enqueue a job that is no longer queued", async () => {
    const queue = fakeQueue();
    const job = await createJob(db, REPO_ID, "fetch_issues");
    await db.from("jobs").update({ state: "running" }).eq("id", job.id);

    expect(await enqueueJob(db, queue, job.id)).toBeNull();
    expect(queue.send).not.toHaveBeenCalled();
  });
});
