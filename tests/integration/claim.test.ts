import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "../../shared/api.ts";
import { claimJob, createJob, enqueueJob, finishJob, type JobMessage } from "../../worker/src/queue/jobs.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 90;
const db = createDb(env);
const silentQueue = { send: async () => {} };

/** A queued job after one enqueue, so its message carries generation 1. */
async function queuedJob(): Promise<JobRecord> {
  const job = await createJob(db, REPO_ID, "fetch_issues");
  const sent = await enqueueJob(db, silentQueue, job.id);
  if (!sent) throw new Error("enqueue failed");
  return sent;
}

function messageFor(job: JobRecord): JobMessage {
  return { jobId: job.id, repoId: job.repository_id, kind: job.kind, generation: job.generation };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/claims" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("claimJob", () => {
  it("claims a queued job once; a duplicate delivery to another owner does nothing", async () => {
    const msg = messageFor(await queuedJob());

    const first = await claimJob(db, msg, "worker-a");
    expect(first.outcome).toBe("claimed");
    expect(first.job).toMatchObject({ state: "running", lease_owner: "worker-a", attempt: 1 });
    const firstLease = Date.parse(first.job!.lease_until!);
    expect(firstLease).toBeGreaterThan(Date.now() - 60_000);

    const duplicate = await claimJob(db, msg, "worker-b");
    expect(duplicate.outcome).toBe("already_running");
    expect(duplicate.job).toMatchObject({ lease_owner: "worker-a", attempt: 1 });

    // The same owner seeing the same message again is idempotent: the lease is extended.
    const again = await claimJob(db, msg, "worker-a");
    expect(again.outcome).toBe("claimed");
    expect(again.job).toMatchObject({ lease_owner: "worker-a", attempt: 1 });
    expect(Date.parse(again.job!.lease_until!)).toBeGreaterThanOrEqual(firstLease);
  });

  it("ignores a stale generation, a finished job and an unknown job", async () => {
    const job = await queuedJob();
    const msg = messageFor(job);

    expect((await claimJob(db, { ...msg, generation: 0 }, "worker-a")).outcome).toBe("stale");

    await claimJob(db, msg, "worker-a");
    const done = await finishJob(db, job.id, "worker-a", { state: "succeeded" });
    expect(done).toMatchObject({ state: "succeeded", lease_owner: null, lease_until: null });

    expect((await claimJob(db, msg, "worker-a")).outcome).toBe("finished");
    expect((await claimJob(db, { ...msg, jobId: 0 }, "worker-a")).outcome).toBe("missing");
  });

  it("lets another owner take over an expired lease and fences the old owner", async () => {
    const job = await queuedJob();
    const msg = messageFor(job);

    const first = await claimJob(db, msg, "worker-a", 0); // lease expires immediately
    expect(first.outcome).toBe("claimed");

    const takeover = await claimJob(db, msg, "worker-b");
    expect(takeover.outcome).toBe("claimed");
    expect(takeover.job).toMatchObject({ lease_owner: "worker-b", attempt: 2 });

    // The old owner can no longer finish the job.
    expect(await finishJob(db, job.id, "worker-a", { state: "succeeded" })).toBeNull();

    const failed = await finishJob(db, job.id, "worker-b", {
      state: "failed",
      error_code: "boom",
      error_message: "it broke",
    });
    expect(failed).toMatchObject({ state: "failed", error_code: "boom", lease_owner: null, attempt: 2 });
  });
});
