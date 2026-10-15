import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCheckpoint } from "../../worker/src/etl/checkpoints.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import { BACKFILL_DELAY_SECONDS, BACKFILL_PAGES_PER_RUN, type GitHubIssue, HEAD_PAGES_PER_RUN, overlapSince, toGitHubTimestamp } from "../../worker/src/etl/extract.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { createDb, getRepository, upsertRepository } from "../../worker/src/api/repositories.ts";
import { listSources } from "../../worker/src/etl/sources.ts";
import type { SourceRecord } from "../../shared/api.ts";
import { type FakeGitHub, fakeGitHubPages, fakeMessage, jsonResponse, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the
// id scheme. The stubbed repository is alice/extract.
const REPO_ID = Date.now() * 100 + 40;
const db = createDb(env);
const API = "https://api.github.com/repos/alice/extract";

/** updated_at grows with the issue number, one minute apart. */
function updatedAt(n: number, offsetMinutes = 0): string {
  return toGitHubTimestamp(new Date(Date.UTC(2026, 0, 1) + (n + offsetMinutes) * 60_000).toISOString());
}

function issue(n: number, opts: { pr?: boolean; title?: string; updated_at?: string } = {}): GitHubIssue {
  return {
    id: 1000 + n,
    node_id: `I_${n}`,
    number: n,
    title: opts.title ?? `Issue ${n}`,
    state: n % 2 ? "open" : "closed",
    body: `body ${n}`,
    html_url: `https://github.com/alice/extract/${opts.pr ? "pull" : "issues"}/${n}`,
    url: `${API}/issues/${n}`,
    user: { login: "bob" },
    created_at: updatedAt(0),
    updated_at: opts.updated_at ?? updatedAt(n),
    closed_at: null,
    pull_request: opts.pr ? { url: `${API}/pulls/${n}`, html_url: `https://github.com/alice/extract/pull/${n}` } : undefined,
  };
}

const fakeGitHub = fakeGitHubPages;

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

/** Creates, enqueues and consumes one job of `kind`; returns the finished row. */
async function runJobOfKind(kind: string, github: FakeGitHub, queue = fakeQueue(), jobId?: number) {
  const id = jobId ?? (await createJob(db, REPO_ID, kind)).id;
  const sent = jobId ? (await getJob(db, jobId))! : (await enqueueJob(db, queue, id))!;
  const message = fakeMessage({ jobId: id, repoId: REPO_ID, kind, generation: sent.generation });
  await consumeJobMessage({ db, queue, fetch: github.fetch }, message, "worker-a");
  return { job: (await getJob(db, id))!, message, queue };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/extract" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("fetch_issues", () => {
  const pages = Array.from({ length: 7 }, (_, p) => [1, 2, 3].map((k) => issue(p * 3 + k, { pr: (p * 3 + k) % 4 === 0 })));

  it("fetches the newest pages first, hands the rest to a delayed backfill that continues from its cursor", async () => {
    const github = fakeGitHub(pages);
    const head = await runJobOfKind("fetch_issues", github);

    expect(head.message.ack).toHaveBeenCalledTimes(1);
    expect(head.job).toMatchObject({ state: "succeeded", result: { phase: "head", pages: HEAD_PAGES_PER_RUN, records: 6 } });
    expect((head.job.result as { bytes: number }).bytes).toBeGreaterThan(0);

    const firstRequest = github.requests[0];
    expect(firstRequest.pathname).toBe("/repos/alice/extract/issues");
    expect(Object.fromEntries(firstRequest.searchParams)).toMatchObject({
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: "100",
    });
    expect(firstRequest.searchParams.has("since")).toBe(false);

    // The head is complete: the high-water mark comes from what it saw, the cursor marks
    // page 3 for the backfill, and the transform plus a delayed backfill job were queued.
    const afterHead = await getCheckpoint(db, REPO_ID, "issues");
    expect(afterHead).toMatchObject({ head_done_at: expect.any(String), backfill_done_at: null, last_synced_at: expect.any(String), pages_fetched: 2, items_fetched: 6 });
    expect(afterHead?.cursor).toContain("page=3");
    expect(afterHead?.last_item_at && Date.parse(afterHead.last_item_at)).toBe(Date.parse(updatedAt(6)));
    const sends = () => head.queue.send.mock.calls.map(([m, o]) => [m.kind, o?.delaySeconds ?? 0]);
    expect(sends()).toEqual([
      ["fetch_issues", 0],
      ["transform_passages", 0],
      ["backfill_issues", BACKFILL_DELAY_SECONDS],
    ]);
    const backfill = head.queue.send.mock.calls[2][0];
    expect(backfill).toMatchObject({ repoId: REPO_ID, kind: "backfill_issues", generation: 1 });

    // The backfill takes its page budget and yields with a delayed continuation of itself;
    // the transform it would queue is still waiting, so nothing else is sent.
    const first = await runJobOfKind("backfill_issues", github, head.queue, backfill.jobId);
    expect(first.job).toMatchObject({ state: "succeeded", result: { phase: "backfill", pages: BACKFILL_PAGES_PER_RUN, records: 9 } });
    expect(github.requests.slice(2).map((u) => u.searchParams.get("page"))).toEqual(["3", "4", "5"]);
    expect((await getCheckpoint(db, REPO_ID, "issues"))?.cursor).toContain("page=6");
    expect(sends().slice(3)).toEqual([["backfill_issues", BACKFILL_DELAY_SECONDS]]);
    const continuation = head.queue.send.mock.calls[3][0];
    expect(continuation.jobId).not.toBe(first.job.id);

    const second = await runJobOfKind("backfill_issues", github, head.queue, continuation.jobId);
    expect(second.job).toMatchObject({ state: "succeeded", result: { phase: "backfill", pages: 2, records: 6 } });
    expect(github.requests.at(-2)?.searchParams.get("page")).toBe("6");
    expect(head.queue.send).toHaveBeenCalledTimes(4); // no continuation, and the transform is still queued

    // The listing is complete; the backfill never moved the high-water mark.
    const done = await getCheckpoint(db, REPO_ID, "issues");
    expect(done).toMatchObject({ cursor: null, backfill_done_at: expect.any(String), pages_fetched: 7, items_fetched: 21 });
    expect(done?.last_item_at && Date.parse(done.last_item_at)).toBe(Date.parse(updatedAt(6)));

    const sources = await listSources(db, REPO_ID);
    expect(sources).toHaveLength(21);
    expect(sources.filter((s) => s.type === "pull_request").map((s) => s.number)).toEqual([4, 8, 12, 16, 20]);
    expect(sources.find((s) => s.number === 4)).toMatchObject({
      type: "pull_request",
      github_id: 1004,
      title: "Issue 4",
      author: "bob",
      state: "closed",
      html_url: "https://github.com/alice/extract/pull/4",
      api_url: `${API}/pulls/4`,
      fetched_by_job: head.job.id,
    });
    expect(sources.find((s) => s.number === 21)?.fetched_by_job).toBe(second.job.id);
  });

  it("keeps the provenance of every stored record and serves it over the API", async () => {
    const sources = await listSources(db, REPO_ID);
    expect(sources).toHaveLength(21);
    for (const s of sources) {
      expect(s.html_url).toMatch(/^https:\/\/github\.com\/alice\/extract\/(issues|pull)\/\d+$/);
      expect(s.api_url).toMatch(/^https:\/\/api\.github\.com\/repos\/alice\/extract\/(issues|pulls)\/\d+$/);
      expect(s.fetched_by_job).not.toBeNull();
      expect(Date.now() - Date.parse(s.fetched_at)).toBeLessThan(5 * 60_000);
      expect(Date.parse(s.updated_at)).toBeGreaterThanOrEqual(Date.parse(s.created_at));
    }

    const res = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/sources?type=pull_request`);
    expect(res.status).toBe(200);
    const served = (await res.json()) as SourceRecord[];
    expect(served.map((s) => s.number)).toEqual([4, 8, 12, 16, 20]);
    expect(served[0]).toEqual(sources.find((s) => s.number === 4));

    const one = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/sources?number=7&limit=10`);
    expect(((await one.json()) as SourceRecord[]).map((s) => [s.type, s.number])).toEqual([["issue", 7]]);

    const badType = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/sources?type=commit`);
    expect(badType.status).toBe(400);
    const unknownRepo = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID + 1}/sources`);
    expect(unknownRepo.status).toBe(404);
  });

  it("syncs ascending since the high-water mark and never overwrites newer stored data with a stale page", async () => {
    const github = fakeGitHub([
      [
        issue(5, { title: "Issue 5 renamed", updated_at: updatedAt(21, 1) }),
        issue(7, { title: "stale copy", updated_at: updatedAt(7, -1) }),
      ],
    ]);
    const { job, queue } = await runJobOfKind("fetch_issues", github);

    expect(job).toMatchObject({ state: "succeeded", result: { phase: "sync", pages: 1, records: 2 } });
    expect(github.requests[0].searchParams.get("since")).toBe(overlapSince(updatedAt(6)));
    expect(github.requests[0].searchParams.get("direction")).toBe("asc");
    // No continuation and no backfill; the transform queued by the earlier runs is still waiting.
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual(["fetch_issues"]);

    const sources = await listSources(db, REPO_ID);
    expect(sources.find((s) => s.number === 5)?.title).toBe("Issue 5 renamed");
    expect(sources.find((s) => s.number === 7)?.title).toBe("Issue 7");
    const checkpoint = await getCheckpoint(db, REPO_ID, "issues");
    expect(checkpoint?.last_item_at && Date.parse(checkpoint.last_item_at)).toBe(Date.parse(updatedAt(21, 1)));
    expect(checkpoint).toMatchObject({ sync_cursor: null, last_synced_at: expect.any(String) });
  });

  it("fails permanently when the repository is gone, and marks the repository inaccessible", async () => {
    const github = fakeGitHub([], () => jsonResponse(404, { message: "Not Found" }));
    const { job, queue } = await runJobOfKind("fetch_issues", github);
    expect(job).toMatchObject({ state: "failed", error_code: "not_found" });
    expect(queue.send).toHaveBeenCalledTimes(1); // only the original enqueue
    expect(await getRepository(db, REPO_ID)).toMatchObject({ status: "inaccessible", last_error: "not_found: Not Found" });
    await db.from("repositories").update({ status: "registered", last_error: null }).eq("id", REPO_ID);
  });

  it("parks the job until the rate limit resets", async () => {
    const reset = Math.floor(Date.now() / 1000) + 42;
    const github = fakeGitHub([], () =>
      jsonResponse(403, { message: "API rate limit exceeded" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) }),
    );
    const { job, queue } = await runJobOfKind("fetch_issues", github);
    expect(job).toMatchObject({ state: "retry_pending", error_code: "rate_limited" });
    const delay = queue.send.mock.calls[1][1]?.delaySeconds ?? 0;
    expect(delay).toBeGreaterThanOrEqual(42);
    expect(delay).toBeLessThanOrEqual(45);
  });

  it("treats a 5xx as transient", async () => {
    const github = fakeGitHub([], () => jsonResponse(502, { message: "bad gateway" }));
    const { job } = await runJobOfKind("fetch_issues", github);
    expect(job).toMatchObject({ state: "retry_pending", error_code: "upstream_error" });
  });
});
