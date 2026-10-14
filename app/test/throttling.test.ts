import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCheckpoint } from "../worker/checkpoints.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { type GitHubIssue, overlapSince, RATE_LIMIT_RESERVE, toGitHubTimestamp } from "../worker/extract.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { listSources } from "../worker/sources.ts";
import { type FakeGitHub, fakeGitHubPages, fakeMessage, jsonResponse, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the
// id scheme. The stubbed repository is alice/throttle.
const REPO_ID = Date.now() * 100 + 25;
const db = createDb(env);
const API = "https://api.github.com/repos/alice/throttle";

function at(minutes: number): string {
  return toGitHubTimestamp(new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString());
}

function issue(n: number, opts: { title?: string; updated_at?: string } = {}): GitHubIssue {
  return {
    id: 1000 + n,
    node_id: `I_${n}`,
    number: n,
    title: opts.title ?? `Issue ${n}`,
    state: "open",
    body: null,
    html_url: `https://github.com/alice/throttle/issues/${n}`,
    url: `${API}/issues/${n}`,
    user: { login: "bob" },
    created_at: at(0),
    updated_at: opts.updated_at ?? at(n),
    closed_at: null,
  };
}

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

/** Creates and enqueues a fetch_issues job, or re-delivers an existing job, then consumes it. */
async function runJob(github: FakeGitHub, existing?: { id: number; queue: ReturnType<typeof fakeQueue> }) {
  const queue = existing?.queue ?? fakeQueue();
  const id = existing?.id ?? (await createJob(db, REPO_ID, "fetch_issues")).id;
  if (!existing) await enqueueJob(db, queue, id);
  const current = (await getJob(db, id))!;
  const message = fakeMessage({ jobId: id, repoId: REPO_ID, kind: current.kind, generation: current.generation });
  await consumeJobMessage({ db, queue, fetch: github.fetch }, message, "worker-a");
  return { job: (await getJob(db, id))!, message, queue };
}

function delayOfLastSend(queue: ReturnType<typeof fakeQueue>): number {
  return queue.send.mock.calls.at(-1)?.[1]?.delaySeconds ?? 0;
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/throttle" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("throttling", () => {
  it("stops paging when the rate limit is nearly exhausted and resumes from the cursor after the reset", async () => {
    let reset = 0;
    const pages = [1, 2, 3, 4].map((p) => [issue(p * 2 - 1), issue(p * 2)]);
    const github = fakeGitHubPages(pages, undefined, (page): Record<string, string> =>
      page === 3 ? { "X-RateLimit-Remaining": String(RATE_LIMIT_RESERVE - 1), "X-RateLimit-Reset": String(reset) } : {},
    );

    // The head pass takes its two pages and hands page 3 onwards to a backfill job.
    const head = await runJob(github);
    expect(head.job).toMatchObject({ state: "succeeded", result: { phase: "head", pages: 2, records: 4 } });
    const backfillId = head.queue.send.mock.calls.find(([m]) => m.kind === "backfill_issues")![0].jobId;

    // The reset lies 30 s ahead of the backfill run, beyond the first attempt's 30 s backoff floor.
    reset = Math.floor(Date.now() / 1000) + 30;
    const first = await runJob(github, { id: backfillId, queue: head.queue });
    expect(first.job).toMatchObject({ state: "retry_pending", error_code: "rate_limited", attempt: 1 });
    expect(github.requests).toHaveLength(3);
    expect(await listSources(db, REPO_ID)).toHaveLength(6);
    expect((await getCheckpoint(db, REPO_ID, "issues"))?.cursor).toContain("page=4");
    const wait = Date.parse(first.job.next_attempt_at!) / 1000 - reset;
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(wait).toBeLessThanOrEqual(3);
    expect(delayOfLastSend(first.queue)).toBeGreaterThanOrEqual(30);

    // Once due, the same job resumes from page 4 and finishes the listing.
    await db.from("jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", first.job.id);
    const second = await runJob(github, { id: first.job.id, queue: first.queue });
    expect(second.job).toMatchObject({ state: "succeeded", attempt: 2, result: { phase: "backfill", pages: 1, records: 2 } });
    expect(github.requests.map((u) => u.searchParams.get("page") ?? "1")).toEqual(["1", "2", "3", "4"]);
    expect(await listSources(db, REPO_ID)).toHaveLength(8);
    expect(await getCheckpoint(db, REPO_ID, "issues")).toMatchObject({ cursor: null, backfill_done_at: expect.any(String) });
  });

  it("honours Retry-After on a 429 and the rate-reset time on a 403", async () => {
    const retryAfter = fakeGitHubPages([], () => jsonResponse(429, { message: "slow down" }, { "Retry-After": "120" }));
    const a = await runJob(retryAfter);
    expect(a.job).toMatchObject({ state: "retry_pending", error_code: "rate_limited" });
    expect(delayOfLastSend(a.queue)).toBe(120);

    const reset = Math.floor(Date.now() / 1000) + 90;
    const primary = fakeGitHubPages([], () =>
      jsonResponse(403, { message: "API rate limit exceeded" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) }),
    );
    const b = await runJob(primary);
    expect(b.job).toMatchObject({ state: "retry_pending", error_code: "rate_limited" });
    expect(delayOfLastSend(b.queue)).toBeGreaterThanOrEqual(90);
    expect(delayOfLastSend(b.queue)).toBeLessThanOrEqual(93);
  });

  it("waits the default on a secondary limit without headers and fails a plain 403", async () => {
    const secondary = fakeGitHubPages([], () =>
      jsonResponse(403, { message: "You have exceeded a secondary rate limit. Please wait." }),
    );
    const a = await runJob(secondary);
    expect(a.job).toMatchObject({ state: "retry_pending", error_code: "rate_limited" });
    expect(delayOfLastSend(a.queue)).toBe(60);

    const forbidden = fakeGitHubPages([], () => jsonResponse(403, { message: "Resource not accessible" }));
    const b = await runJob(forbidden);
    expect(b.job).toMatchObject({ state: "failed", error_code: "forbidden" });
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("overlapping pages", () => {
  it("keeps the newest copy when an item repeats within or across pages, and never regresses on a later run", async () => {
    const edited = issue(10, { title: "edited while paging", updated_at: at(12) });
    const github = fakeGitHubPages([
      [issue(9), issue(10), issue(10, { title: "older duplicate", updated_at: at(9) })], // same item twice in one page
      [edited, issue(11)], // issue 10 was updated after page 1 was served and shows up again
    ]);
    const first = await runJob(github);
    expect(first.job).toMatchObject({
      state: "succeeded",
      result: { pages: 2, records: 5, inserted: 3, updated: 1, unchanged: 0 },
    });
    expect((await listSources(db, REPO_ID, { number: 10 }))[0]?.title).toBe("edited while paging");
    const mark = (await getCheckpoint(db, REPO_ID, "issues"))?.last_item_at;
    expect(mark && Date.parse(mark)).toBe(Date.parse(at(12)));

    // The next run asks since the high-water mark minus the overlap. The boundary item comes
    // back unchanged (seen, not re-fetched); a stale copy of another item is skipped.
    const again = fakeGitHubPages([[edited, issue(9, { title: "stale copy", updated_at: at(8) })]]);
    const second = await runJob(again);
    expect(again.requests[0].searchParams.get("since")).toBe(overlapSince(at(12)));
    expect(second.job).toMatchObject({ state: "succeeded", result: { inserted: 0, updated: 0, unchanged: 2 } });
    expect((await listSources(db, REPO_ID, { number: 10 }))[0]?.title).toBe("edited while paging");
    expect((await listSources(db, REPO_ID, { number: 9 }))[0]?.title).toBe("Issue 9");
  });
});
