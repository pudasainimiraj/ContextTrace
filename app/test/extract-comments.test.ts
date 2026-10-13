import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCheckpoint } from "../worker/checkpoints.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { type GitHubIssueComment, toGitHubTimestamp } from "../worker/extract.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { listSources } from "../worker/sources.ts";
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
    expect(Object.fromEntries(request.searchParams)).toMatchObject({ sort: "updated", direction: "asc", per_page: "100" });

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
    expect(checkpoint?.cursor).toBeNull();
    expect(checkpoint?.last_item_at && Date.parse(checkpoint.last_item_at)).toBe(Date.parse(at(3)));
    expect(await getCheckpoint(db, REPO_ID, "issues")).toBeNull();
  });

  it("resumes from the comment stream's own high-water mark", async () => {
    const github = fakeGitHubPages([[issueComment(4, 8)]]);
    const { job } = await runJobOfKind("fetch_issue_comments", github);
    expect(job).toMatchObject({ state: "succeeded", result: { records: 1 } });
    expect(github.requests[0].searchParams.get("since")).toBe(at(3));
    expect(await listSources(db, REPO_ID, { number: 8 })).toHaveLength(2);
  });
});
