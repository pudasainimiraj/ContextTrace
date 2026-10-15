import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CoverageReport } from "../shared/api.ts";
import { saveCheckpoint } from "../worker/checkpoints.ts";
import { getCoverage, streamCoverage } from "../worker/coverage.ts";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient } from "../worker/embeddings.ts";
import { createJob } from "../worker/jobs.ts";
import { createDb, getRepository, upsertRepository } from "../worker/repositories.ts";
import { upsertSources } from "../worker/sources.ts";
import { insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO = Date.now() * 100 + 12;
const db = createDb(env);
const T0 = "2026-03-01T10:00:00+00:00";
const T1 = "2026-03-01T10:05:00+00:00";
const T2 = "2026-03-01T10:10:00+00:00";

async function coverage(): Promise<CoverageReport> {
  return getCoverage(db, (await getRepository(db, REPO))!);
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/coverage" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
});

describe("streamCoverage", () => {
  it("derives the phase from the checkpoint", () => {
    expect(streamCoverage("issues", undefined)).toMatchObject({ phase: "pending", complete: false, source_types: ["issue", "pull_request"], items_fetched: 0 });
    const base = { repository_id: REPO, stream: "issues", cursor: null, sync_cursor: null, last_item_at: null, head_done_at: null, backfill_done_at: null, last_synced_at: null, rescan_started_at: null, last_rescan_at: null, capped_at: null, pages_fetched: 1, items_fetched: 9, job_id: null, updated_at: T0 };
    expect(streamCoverage("issues", base)).toMatchObject({ phase: "head", complete: false });
    expect(streamCoverage("issues", { ...base, head_done_at: T0, cursor: "https://api.github.com/x?page=3" })).toMatchObject({ phase: "backfill", backfill_pending: true });
    expect(streamCoverage("issues", { ...base, head_done_at: T0, backfill_done_at: T1, sync_cursor: "https://api.github.com/x?page=2" })).toMatchObject({ phase: "complete", complete: true, backfill_pending: false, sync_in_progress: true });
    expect(streamCoverage("issues", { ...base, head_done_at: T0, backfill_done_at: T1, cursor: "https://api.github.com/x?page=2", rescan_started_at: T1 })).toMatchObject({ phase: "rescan", complete: true, backfill_pending: false, rescan_in_progress: true });
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("repository coverage", () => {
  it("reports an empty, pending repository with every type and stream present", async () => {
    const report = await coverage();
    expect(report).toMatchObject({
      repository_id: REPO,
      status: "registered",
      partial: true,
      last_error: null,
      sources: { issue: 0, pull_request: 0, issue_comment: 0, review_comment: 0 },
      documents: 0,
      passages: 0,
      embedded: 0,
      pending: 0,
      completed_source_types: [],
      last_successful_sync_at: null,
      jobs: { queued: 0, running: 0, retry_pending: 0, failed: 0 },
    });
    expect(report.streams.map((s) => [s.stream, s.phase])).toEqual([
      ["issues", "pending"],
      ["issue_comments", "pending"],
      ["review_comments", "pending"],
    ]);
  });

  it("counts stored records, searchable passages, stream progress and jobs", async () => {
    await insertPassages(db, REPO, [{ text: "The first passage." }, { text: "The second passage, longer than the first." }]);
    await upsertSources(db, [
      { repository_id: REPO, type: "issue_comment", github_id: 5001, number: 1, node_id: null, title: null, author: "ann", body: "c", state: null, html_url: "https://github.com/o/r/issues/1#issuecomment-5001", api_url: "https://api.github.com/repos/o/r/issues/comments/5001", path: null, line: null, in_reply_to_id: null, created_at: T0, updated_at: T0, closed_at: null, fetched_by_job: null },
      { repository_id: REPO, type: "pull_request", github_id: 2, number: 2, node_id: null, title: "PR", author: "ann", body: "p", state: "open", html_url: "https://github.com/o/r/pull/2", api_url: "https://api.github.com/repos/o/r/pulls/2", path: null, line: null, in_reply_to_id: null, created_at: T0, updated_at: T1, closed_at: null, fetched_by_job: null },
    ]);
    const job = await createJob(db, REPO, EMBED_JOB_KIND);
    expect(await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, job.id, { batchSize: 1, maxBatches: 1 })).toMatchObject({ inserted: 1 });
    await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id); // only lent its id to embedded_by_job
    await createJob(db, REPO, "fetch_issues"); // queued, never run
    await saveCheckpoint(db, { repository_id: REPO, stream: "issues", cursor: null, last_item_at: T1, head_done_at: T0, backfill_done_at: T1, last_synced_at: T2, pages_fetched: 3, items_fetched: 2 });
    await saveCheckpoint(db, { repository_id: REPO, stream: "issue_comments", cursor: "https://api.github.com/x?page=3", last_item_at: T0, head_done_at: T0, last_synced_at: T0, pages_fetched: 2, items_fetched: 1 });

    const report = await coverage();
    expect(report).toMatchObject({
      status: "searchable_partial",
      partial: true,
      sources: { issue: 1, pull_request: 1, issue_comment: 1, review_comment: 0 },
      documents: 1,
      passages: 2,
      embedded: 1,
      pending: 1,
      completed_source_types: ["issue", "pull_request"],
      last_successful_sync_at: null, // review comments have not run yet
      jobs: { queued: 1, running: 0, retry_pending: 0, failed: 0 },
    });
    expect(report.streams).toEqual([
      { stream: "issues", source_types: ["issue", "pull_request"], phase: "complete", complete: true, high_water_mark: T1, last_synced_at: T2, backfill_done_at: T1, backfill_pending: false, sync_in_progress: false, rescan_in_progress: false, last_rescan_at: null, capped: false, capped_at: null, pages_fetched: 3, items_fetched: 2 },
      { stream: "issue_comments", source_types: ["issue_comment"], phase: "backfill", complete: false, high_water_mark: T0, last_synced_at: T0, backfill_done_at: null, backfill_pending: true, sync_in_progress: false, rescan_in_progress: false, last_rescan_at: null, capped: false, capped_at: null, pages_fetched: 2, items_fetched: 1 },
      { stream: "review_comments", source_types: ["review_comment"], phase: "pending", complete: false, high_water_mark: null, last_synced_at: null, backfill_done_at: null, backfill_pending: false, sync_in_progress: false, rescan_in_progress: false, last_rescan_at: null, capped: false, capped_at: null, pages_fetched: 0, items_fetched: 0 },
    ]);
  });

  it("reports the oldest of the streams' last syncs once every stream has one, and serves it over the API", async () => {
    await saveCheckpoint(db, { repository_id: REPO, stream: "issue_comments", cursor: null, backfill_done_at: T2, last_synced_at: T1 });
    await saveCheckpoint(db, { repository_id: REPO, stream: "review_comments", cursor: null, head_done_at: T2, backfill_done_at: T2, last_synced_at: T2 });
    const res = await exports.default.fetch(`http://localhost/api/repositories/${REPO}/coverage`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as CoverageReport;
    expect(report).toMatchObject({
      completed_source_types: ["issue", "pull_request", "issue_comment", "review_comment"],
      last_successful_sync_at: T1, // issues T2, issue comments T1, review comments T2
    });
    expect(report.streams.map((s) => s.phase)).toEqual(["complete", "complete", "complete"]);
    expect((await exports.default.fetch(`http://localhost/api/repositories/${REPO + 1}/coverage`)).status).toBe(404);
  });
});
