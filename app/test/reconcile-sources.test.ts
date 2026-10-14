import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCheckpoint, saveCheckpoint } from "../worker/checkpoints.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { getDocumentByNumber, listPassages } from "../worker/documents.ts";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import { BACKFILL_DELAY_SECONDS, type GitHubIssue, type GitHubIssueComment } from "../worker/extract.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../worker/jobs.ts";
import { createDb, getRepository, upsertRepository } from "../worker/repositories.ts";
import { searchSemantic } from "../worker/search.ts";
import { listSources, type SourceDraft, upsertSources } from "../worker/sources.ts";
import { scheduleRescans } from "../worker/sync.ts";
import { transformRepository } from "../worker/transform.ts";
import { fakeGitHubPages, fakeMessage, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the id scheme.
const REPO = Date.now() * 100 + 32;
const db = createDb(env);
const API = "https://api.github.com/repos/alice/retire";
const WEB = "https://github.com/alice/retire";
const DOC = (type: string, number: number) => `github:${REPO}:${type}:${number}`;
const at = (minutes: number) => new Date(Date.UTC(2026, 1, 1) + minutes * 60_000).toISOString();
const DONE = at(100);
const LONG = Array.from({ length: 70 }, (_, i) => `Sentence number ${i + 1} describes the retirement plan in some detail.`).join(" ");

function row(partial: Partial<SourceDraft> & Pick<SourceDraft, "type" | "github_id" | "number" | "created_at">): SourceDraft {
  const comment = partial.type === "issue_comment";
  return {
    repository_id: REPO,
    node_id: `${comment ? "IC" : "I"}_${partial.github_id}`,
    title: null,
    author: "ann",
    body: "text",
    state: null,
    html_url: `${WEB}/issues/${partial.number}`,
    api_url: comment ? `${API}/issues/comments/${partial.github_id}` : `${API}/issues/${partial.number}`,
    path: null,
    line: null,
    in_reply_to_id: null,
    updated_at: partial.created_at,
    closed_at: null,
    fetched_by_job: null,
    ...partial,
  };
}

const SOURCES: SourceDraft[] = [
  row({ type: "issue", github_id: 1001, number: 1, title: "Thread one", body: "Opening of thread one.", state: "open", created_at: at(0) }),
  row({ type: "issue_comment", github_id: 5001, number: 1, body: "Short first comment.", created_at: at(1), html_url: `${WEB}/issues/1#issuecomment-5001` }),
  row({ type: "issue_comment", github_id: 5002, number: 1, body: LONG, created_at: at(2), html_url: `${WEB}/issues/1#issuecomment-5002` }),
  row({ type: "issue_comment", github_id: 5003, number: 1, body: "Third comment about zebras.", created_at: at(3), html_url: `${WEB}/issues/1#issuecomment-5003` }),
  row({ type: "issue", github_id: 1002, number: 2, title: "Thread two", body: "Opening of thread two.", state: "open", created_at: at(0) }),
  row({ type: "issue_comment", github_id: 5004, number: 2, body: "Comment on thread two.", created_at: at(4), html_url: `${WEB}/issues/2#issuecomment-5004` }),
];

/** GitHub's view of a stored comment. */
function ghComment(source: SourceDraft): GitHubIssueComment {
  return {
    id: source.github_id,
    node_id: source.node_id!,
    url: source.api_url,
    html_url: source.html_url,
    issue_url: `${API}/issues/${source.number}`,
    user: { login: source.author ?? "ann" },
    body: source.body,
    created_at: source.created_at,
    updated_at: source.updated_at,
  };
}

function ghIssue(source: SourceDraft): GitHubIssue {
  return {
    id: source.github_id,
    node_id: source.node_id!,
    number: source.number,
    title: source.title ?? "",
    state: source.state ?? "open",
    body: source.body,
    html_url: source.html_url,
    url: source.api_url,
    user: { login: source.author ?? "ann" },
    created_at: source.created_at,
    updated_at: source.updated_at,
    closed_at: null,
  };
}

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

async function runKind(kind: string, github: ReturnType<typeof fakeGitHubPages>, queue = fakeQueue(), jobId?: number) {
  const id = jobId ?? (await createJob(db, REPO, kind)).id;
  const sent = jobId ? (await getJob(db, id))! : (await enqueueJob(db, queue, id))!;
  await consumeJobMessage({ db, queue, fetch: github.fetch }, fakeMessage({ jobId: id, repoId: REPO, kind, generation: sent.generation }), "worker-a");
  return { job: (await getJob(db, id))!, queue };
}

async function vectorRows(passageIds: string[]) {
  const { data } = await db.from("passage_embeddings").select("passage_id, content_hash").in("passage_id", passageIds);
  return (data ?? []) as { passage_id: string; content_hash: string }[];
}

async function embedAll() {
  const job = await createJob(db, REPO, EMBED_JOB_KIND);
  return embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, job.id);
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/retire" }));
  await db.from("repositories").update({ status: "searchable" }).eq("id", REPO);
  for (const stream of ["issues", "issue_comments", "review_comments"]) {
    await saveCheckpoint(db, { repository_id: REPO, stream, cursor: null, last_item_at: DONE, head_done_at: DONE, backfill_done_at: DONE, last_synced_at: new Date().toISOString() });
  }
  await upsertSources(db, SOURCES);
  expect(await transformRepository(db, REPO)).toMatchObject({ documents: 2 });
  const embedded = await embedAll();
  expect(embedded.inserted).toBeGreaterThanOrEqual(6);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("changed passages", () => {
  it("replaces the vector of a changed passage and retires the vectors of parts that no longer exist", async () => {
    const parts = (await listPassages(db, REPO, { number: 1 })).filter((p) => p.source_github_id === 5002);
    expect(parts.length).toBeGreaterThan(1);
    const kept = `${DOC("issue", 1)}:issue_comment:5002:0`;
    const gone = parts.map((p) => p.passage_id).filter((id) => id !== kept);
    const oldHash = parts.find((p) => p.passage_id === kept)!.content_hash;

    await upsertSources(db, [row({ type: "issue_comment", github_id: 5002, number: 1, body: "Short now.", created_at: at(2), updated_at: at(50), html_url: `${WEB}/issues/1#issuecomment-5002` })]);
    expect(await transformRepository(db, REPO)).toMatchObject({ documents: 1, updated: 1, removed: gone.length });

    // The removed parts took their vectors with them; the kept part waits for a new one.
    expect(await vectorRows(gone)).toEqual([]);
    const [stale] = await vectorRows([kept]);
    expect(stale.content_hash).toBe(oldHash);
    const passage = (await listPassages(db, REPO, { number: 1 })).find((p) => p.passage_id === kept)!;
    expect(passage).toMatchObject({ text: "Short now.", index_state: "pending_index" });
    expect(passage.content_hash).not.toBe(oldHash);
    expect((await searchSemantic(db, REPO, fakeVector("Short now."), 10)).map((m) => m.passage_id)).not.toContain(kept);

    expect(await embedAll()).toMatchObject({ texts: 1, updated: 1, inserted: 0 });
    const [fresh] = await vectorRows([kept]);
    expect(fresh.content_hash).toBe(passage.content_hash);
    expect(await vectorRows([kept, ...gone])).toHaveLength(1);
    const [top] = await searchSemantic(db, REPO, fakeVector("Short now."), 1);
    expect(top.passage_id).toBe(kept);
    expect(top.score).toBeCloseTo(1, 4);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("rescans", () => {
  it("retires a comment GitHub no longer lists, with its passage and vector, and relabels the thread", async () => {
    const before = (await getCheckpoint(db, REPO, "issue_comments"))!;
    const deletedId = `${DOC("issue", 1)}:issue_comment:5002:0`;
    expect(await vectorRows([deletedId])).toHaveLength(1);

    // GitHub now lists comments 5001, 5003 and 5004 only.
    const github = fakeGitHubPages([[5001, 5003, 5004].map((id) => ghComment(SOURCES.find((s) => s.github_id === id)!))]);
    const { job, queue } = await runKind("rescan_issue_comments", github);
    expect(job).toMatchObject({
      state: "succeeded",
      result: { phase: "rescan", pages: 1, records: 3, inserted: 0, updated: 0, unchanged: 3, retired: { sources_removed: 1, documents_removed: 0, documents_dirtied: 1 } },
    });
    expect(github.requests[0].pathname).toBe("/repos/alice/retire/issues/comments");
    expect(github.requests[0].searchParams.get("direction")).toBe("desc");
    expect(github.requests[0].searchParams.has("since")).toBe(false);
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual(["rescan_issue_comments", "transform_passages"]);

    expect((await listSources(db, REPO, { type: "issue_comment" })).map((s) => s.github_id)).toEqual([5001, 5003, 5004]);
    expect((await listPassages(db, REPO, { number: 1 })).some((p) => p.source_github_id === 5002)).toBe(false);
    expect(await vectorRows([deletedId])).toEqual([]);

    const after = (await getCheckpoint(db, REPO, "issue_comments"))!;
    expect(after).toMatchObject({ cursor: null, rescan_started_at: null, last_rescan_at: expect.any(String), backfill_done_at: before.backfill_done_at, last_item_at: before.last_item_at });
    expect(Date.now() - Date.parse(after.last_rescan_at!)).toBeLessThan(60_000);

    // The thread lost a unit, so it is re-transformed and the siblings are relabelled.
    expect((await getDocumentByNumber(db, REPO, 1))?.sources_fetched_at).toBeNull();
    expect(await transformRepository(db, REPO)).toMatchObject({ documents: 1 });
    const locators = (await listPassages(db, REPO, { number: 1 })).map((p) => [p.source_github_id, p.locator]);
    expect(locators).toEqual([
      [1001, "Opening body"],
      [5001, "Comment 1 of 2"],
      [5003, "Comment 2 of 2"],
    ]);
  });

  it("drops a thread whose opening vanished, with its passages and vectors", async () => {
    const thread2 = (await listPassages(db, REPO, { number: 2 })).map((p) => p.passage_id);
    expect(thread2.length).toBeGreaterThan(0);
    const github = fakeGitHubPages([[ghIssue(SOURCES[0])]]); // issue 2 is gone from GitHub
    const { job } = await runKind("rescan_issues", github);
    expect(job).toMatchObject({ state: "succeeded", result: { phase: "rescan", records: 1, retired: { sources_removed: 1, documents_removed: 1, documents_dirtied: 0 } } });
    expect(await getDocumentByNumber(db, REPO, 2)).toBeNull();
    expect(await listPassages(db, REPO, { number: 2 })).toEqual([]);
    expect(await vectorRows(thread2)).toEqual([]);
    // Its orphan comment stays in its own stream until that stream is rescanned, and is never transformed.
    expect((await listSources(db, REPO, { number: 2 })).map((s) => s.github_id)).toEqual([5004]);
    expect(await transformRepository(db, REPO)).toMatchObject({ documents: 0 });
    expect((await getCheckpoint(db, REPO, "issues"))?.last_item_at).toBe((await getCheckpoint(db, REPO, "issue_comments"))?.last_item_at);
  });

  it("continues a long rescan from its cursor with a delay, retires only at the end, and blocks the backfill meanwhile", async () => {
    const comments = [5001, 5003, 5004].map((id) => ghComment(SOURCES.find((s) => s.github_id === id)!));
    const github = fakeGitHubPages([[comments[0]], [comments[1]], [comments[2]], []]);
    // Earlier runs queued transforms into queues nobody drained; clear them so the chain shows.
    await db.from("jobs").update({ state: "cancelled" }).eq("repository_id", REPO).eq("state", "queued");
    const first = await runKind("rescan_issue_comments", github);
    expect(first.job).toMatchObject({ state: "succeeded", result: { phase: "rescan", pages: 3, records: 3 } });
    expect(first.job.result).not.toHaveProperty("retired");
    const paused = (await getCheckpoint(db, REPO, "issue_comments"))!;
    expect(paused.cursor).toContain("page=4");
    expect(paused.rescan_started_at).not.toBeNull();
    const sends = first.queue.send.mock.calls.map(([m, o]) => [m.kind, o?.delaySeconds ?? 0]);
    expect(sends).toEqual([
      ["rescan_issue_comments", 0],
      ["rescan_issue_comments", BACKFILL_DELAY_SECONDS],
      ["transform_passages", 0],
    ]);

    // A backfill job delivered now finds the cursor owned by the rescan and does nothing.
    const idle = await runKind("backfill_issue_comments", github);
    expect(idle.job).toMatchObject({ state: "succeeded", result: { phase: "backfill", pages: 0 } });

    const continuation = first.queue.send.mock.calls[1][0];
    const second = await runKind("rescan_issue_comments", github, first.queue, continuation.jobId);
    expect(second.job).toMatchObject({ state: "succeeded", result: { phase: "rescan", pages: 1, records: 0, retired: { sources_removed: 0, documents_removed: 0, documents_dirtied: 0 } } });
    expect(await getCheckpoint(db, REPO, "issue_comments")).toMatchObject({ cursor: null, rescan_started_at: null });
    expect((await listSources(db, REPO, { type: "issue_comment" })).map((s) => s.github_id)).toEqual([5001, 5003, 5004]);
  });

  it("is scheduled by the cron once the last rescan is old enough, once per stream", async () => {
    const weekAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    await saveCheckpoint(db, { repository_id: REPO, stream: "issues", last_rescan_at: weekAgo });
    for (const stream of ["issue_comments", "review_comments"]) {
      await saveCheckpoint(db, { repository_id: REPO, stream, last_rescan_at: new Date().toISOString() });
    }
    const queue = fakeQueue();
    const first = await scheduleRescans(db, queue, { intervalSeconds: 7 * 24 * 3600, repositoryId: REPO });
    expect(first.due).toBe(1);
    expect(first.queued).toEqual([{ repository_id: REPO, stream: "issues", job_id: expect.any(Number) }]);
    expect(queue.send.mock.calls.map(([m, o]) => [m.kind, o?.delaySeconds])).toEqual([["rescan_issues", BACKFILL_DELAY_SECONDS]]);
    expect(await scheduleRescans(db, queue, { intervalSeconds: 7 * 24 * 3600, repositoryId: REPO })).toEqual({ due: 0, queued: [] });
    await db.from("jobs").update({ state: "cancelled" }).eq("id", first.queued[0].job_id);
    expect((await getRepository(db, REPO))?.status).toBe("searchable");
  });
});
