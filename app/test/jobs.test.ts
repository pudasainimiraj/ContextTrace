import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { repoFixture } from "./helpers.ts";

// Runs against the real Supabase project. The repository id sits far above GitHub's
// range; deleting it afterwards cascades to its jobs, transitions and checkpoints.
// The tens digit keeps this file's ids apart from the other live test files.
const REPO_ID = Date.now() * 100 + 70;
const db = createDb(env);

type Job = {
  id: number;
  repository_id: number;
  kind: string;
  state: string;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

async function createJob(kind: string): Promise<Job> {
  const { data, error } = await db.from("jobs").insert({ repository_id: REPO_ID, kind }).select().single();
  expect(error).toBeNull();
  return data as Job;
}

function updateJob(id: number, patch: Partial<Job>) {
  return db.from("jobs").update(patch).eq("id", id).select().single();
}

function transitionsOf(jobId: number) {
  return db.from("job_transitions").select("from_state, to_state, note").eq("job_id", jobId).order("id");
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/jobs" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("jobs", () => {
  it("moves a job through queued, running and succeeded and logs each transition", async () => {
    const job = await createJob("fetch_issues");
    expect(job).toMatchObject({ state: "queued", attempt: 0, started_at: null, finished_at: null });

    const running = (await updateJob(job.id, { state: "running" })).data as Job;
    expect(running).toMatchObject({ state: "running", attempt: 1, finished_at: null });
    expect(running.started_at).not.toBeNull();

    const done = (await updateJob(job.id, { state: "succeeded" })).data as Job;
    expect(done.state).toBe("succeeded");
    expect(done.finished_at).not.toBeNull();
    expect(Date.parse(done.updated_at)).toBeGreaterThanOrEqual(Date.parse(job.updated_at));

    expect((await transitionsOf(job.id)).data).toEqual([
      { from_state: null, to_state: "queued", note: null },
      { from_state: "queued", to_state: "running", note: null },
      { from_state: "running", to_state: "succeeded", note: null },
    ]);
  });

  it("records the error on failure, clears it on retry and rejects invalid transitions", async () => {
    const job = await createJob("fetch_discussions");

    // queued -> succeeded skips running
    expect((await updateJob(job.id, { state: "succeeded" })).error?.code).toBe("23514");

    await updateJob(job.id, { state: "running" });

    // failed without an error message
    expect((await updateJob(job.id, { state: "failed" })).error?.code).toBe("23514");

    const failed = (
      await updateJob(job.id, { state: "failed", error_code: "rate_limited", error_message: "GitHub 403" })
    ).data as Job;
    expect(failed).toMatchObject({ state: "failed", error_code: "rate_limited", error_message: "GitHub 403" });
    expect(failed.finished_at).not.toBeNull();

    const retried = (await updateJob(job.id, { state: "queued" })).data as Job;
    expect(retried).toMatchObject({
      state: "queued",
      attempt: 1,
      error_code: null,
      error_message: null,
      started_at: null,
      finished_at: null,
    });

    expect((await transitionsOf(job.id)).data).toEqual([
      { from_state: null, to_state: "queued", note: null },
      { from_state: "queued", to_state: "running", note: null },
      { from_state: "running", to_state: "failed", note: "GitHub 403" },
      { from_state: "failed", to_state: "queued", note: null },
    ]);
  });

  it("rejects a new job that does not start queued", async () => {
    const { error } = await db.from("jobs").insert({ repository_id: REPO_ID, kind: "x", state: "running" });
    expect(error?.code).toBe("23514");
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("stream_checkpoints", () => {
  it("keeps one checkpoint per repository and stream and refreshes updated_at", async () => {
    const first = await db
      .from("stream_checkpoints")
      .upsert({ repository_id: REPO_ID, stream: "issues", cursor: "Y3Vyc29yOjE=" })
      .select()
      .single();
    expect(first.error).toBeNull();

    const second = await db
      .from("stream_checkpoints")
      .upsert({ repository_id: REPO_ID, stream: "issues", cursor: "Y3Vyc29yOjI=", last_item_at: "2026-10-01T00:00:00Z" })
      .select()
      .single();
    expect(second.data).toMatchObject({ cursor: "Y3Vyc29yOjI=" });
    expect(Date.parse(second.data.updated_at)).toBeGreaterThanOrEqual(Date.parse(first.data.updated_at));

    const { count } = await db
      .from("stream_checkpoints")
      .select("*", { count: "exact", head: true })
      .eq("repository_id", REPO_ID);
    expect(count).toBe(1);
  });
});
