import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCheckpoint } from "../../worker/src/etl/checkpoints.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import { type GitHubIssueComment, type GitHubReviewComment, overlapSince, toGitHubTimestamp } from "../../worker/src/etl/extract.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { listSources } from "../../worker/src/etl/sources.ts";
import { type FakeGitHub, fakeGitHubPages, fakeMessage, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the
// id scheme. The stubbed repository is alice/comments.
const REPO_ID = Date.now() * 100 + 35;
const db = createDb(env);
const API = "https://api.github.com/repos/alice/comments";
const WEB = "https://github.com/alice/comments";

function at(minutes: number): string {
  return toGitHubTimestamp(new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString());
}

/** A conversation comment on issue or pull request `number`. */
function issueComment(k: number, number: number, opts: { pr?: boolean } = {}): GitHubIssueComment {
  const id = 5000 + k;
  return {
    id,
    node_id: `IC_${k}`,
    url: `${API}/issues/comments/${id}`,
    html_url: `${WEB}/${opts.pr ? "pull" : "issues"}/${number}#issuecomment-${id}`,
    issue_url: `${API}/issues/${number}`,
    user: { login: "carol" },
    body: `comment ${k}`,
    created_at: at(0),
    updated_at: at(k),
  };
}

/** An inline review comment on pull request `number`. */
function reviewComment(
  k: number,
  number: number,
  opts: { path?: string; line?: number | null; original_line?: number | null; replyTo?: number } = {},
): GitHubReviewComment {
  const id = 7000 + k;
  return {
    id,
    node_id: `RC_${k}`,
    url: `${API}/pulls/comments/${id}`,
    html_url: `${WEB}/pull/${number}#discussion_r${id}`,
    pull_request_url: `${API}/pulls/${number}`,
    path: opts.path ?? "src/a.ts",
    line: opts.line === undefined ? 12 : opts.line,
    original_line: opts.original_line === undefined ? 12 : opts.original_line,
    in_reply_to_id: opts.replyTo,
    user: { login: "dave" },
    body: `review ${k}`,
    created_at: at(0),
    updated_at: at(k),
  };
}

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

async function runJobOfKind(kind: string, github: FakeGitHub) {
  const queue = fakeQueue();
  const job = await createJob(db, REPO_ID, kind);
  const sent = (await enqueueJob(db, queue, job.id))!;
  const message = fakeMessage({ jobId: job.id, repoId: REPO_ID, kind, generation: sent.generation });
  await consumeJobMessage({ db, queue, fetch: github.fetch }, message, "worker-a");
  return { job: (await getJob(db, job.id))!, queue };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/comments" }));
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("fetch_issue_comments", () => {
  it("stores issue and pull request conversation comments with their permalinks", async () => {
    const github = fakeGitHubPages([[issueComment(1, 5), issueComment(2, 8, { pr: true }), issueComment(3, 5)]]);
    const { job } = await runJobOfKind("fetch_issue_comments", github);
    expect(job).toMatchObject({ state: "succeeded", result: { pages: 1, records: 3 } });

    const request = github.requests[0];
    expect(request.pathname).toBe("/repos/alice/comments/issues/comments");
    expect(Object.fromEntries(request.searchParams)).toMatchObject({ sort: "updated", direction: "desc", per_page: "100" });

    const comments = await listSources(db, REPO_ID, { type: "issue_comment" });
    expect(comments.map((c) => [c.github_id, c.number])).toEqual([
      [5001, 5],
      [5002, 8],
      [5003, 5],
    ]);
    // An ordinary comment on a pull request is an issue comment whose permalink is the PR.
    expect(comments[1]).toMatchObject({
      type: "issue_comment",
      number: 8,
      title: null,
      state: null,
      author: "carol",
      body: "comment 2",
      html_url: `${WEB}/pull/8#issuecomment-5002`,
      api_url: `${API}/issues/comments/5002`,
      fetched_by_job: job.id,
    });

    // The stream has its own checkpoint; the issues stream is untouched.
    const checkpoint = await getCheckpoint(db, REPO_ID, "issue_comments");
    expect(checkpoint).toMatchObject({ cursor: null, head_done_at: expect.any(String), backfill_done_at: expect.any(String) });
    expect(checkpoint?.last_item_at && Date.parse(checkpoint.last_item_at)).toBe(Date.parse(at(3)));
    expect(await getCheckpoint(db, REPO_ID, "issues")).toBeNull();
  });

  it("resumes from the comment stream's own high-water mark", async () => {
    const github = fakeGitHubPages([[issueComment(4, 8)]]);
    const { job } = await runJobOfKind("fetch_issue_comments", github);
    expect(job).toMatchObject({ state: "succeeded", result: { phase: "sync", records: 1 } });
    expect(github.requests[0].searchParams.get("since")).toBe(overlapSince(at(3)));
    expect(github.requests[0].searchParams.get("direction")).toBe("asc");
    expect(await listSources(db, REPO_ID, { number: 8 })).toHaveLength(2);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("fetch_review_comments", () => {
  it("stores inline review comments with their diff position and reply link under an independent checkpoint", async () => {
    const github = fakeGitHubPages([
      [
        reviewComment(1, 8),
        reviewComment(2, 8, { replyTo: 7001 }),
        reviewComment(3, 9, { path: "README.md", line: null, original_line: 3 }),
      ],
    ]);
    const { job } = await runJobOfKind("fetch_review_comments", github);
    expect(job).toMatchObject({ state: "succeeded", result: { pages: 1, records: 3 } });
    expect(github.requests[0].pathname).toBe("/repos/alice/comments/pulls/comments");
    expect(github.requests[0].searchParams.has("since")).toBe(false);

    const reviews = await listSources(db, REPO_ID, { type: "review_comment" });
    expect(reviews.map((r) => [r.github_id, r.number])).toEqual([
      [7001, 8],
      [7002, 8],
      [7003, 9],
    ]);
    expect(reviews[0]).toMatchObject({
      type: "review_comment",
      path: "src/a.ts",
      line: 12,
      in_reply_to_id: null,
      author: "dave",
      body: "review 1",
      html_url: `${WEB}/pull/8#discussion_r7001`,
      api_url: `${API}/pulls/comments/7001`,
      fetched_by_job: job.id,
    });
    expect(reviews[1].in_reply_to_id).toBe(7001);
    // An outdated comment keeps its original diff line.
    expect(reviews[2]).toMatchObject({ path: "README.md", line: 3 });

    // Its checkpoint is separate from the issue-comment stream's.
    const own = await getCheckpoint(db, REPO_ID, "review_comments");
    expect(own?.cursor).toBeNull();
    expect(own?.last_item_at && Date.parse(own.last_item_at)).toBe(Date.parse(at(3)));
    const other = await getCheckpoint(db, REPO_ID, "issue_comments");
    expect(other?.last_item_at && Date.parse(other.last_item_at)).toBe(Date.parse(at(4)));

    // Everything on pull request 8, across both comment types.
    const onPr8 = await listSources(db, REPO_ID, { number: 8 });
    expect(onPr8.map((s) => s.type)).toEqual(["issue_comment", "issue_comment", "review_comment", "review_comment"]);
  });
});
