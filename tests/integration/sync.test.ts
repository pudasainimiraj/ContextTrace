import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobMessage } from "../../worker/src/queue/jobs.ts";
import { getCheckpoint, saveCheckpoint } from "../../worker/src/etl/checkpoints.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import { listPassages } from "../../worker/src/etl/documents.ts";
import { EMBED_JOB_KIND, embedPassages } from "../../worker/src/etl/embed.ts";
import { FakeEmbeddingClient } from "../../worker/src/etl/embeddings.ts";
import { type GitHubIssue, overlapSince, SYNC_OVERLAP_SECONDS, toGitHubTimestamp } from "../../worker/src/etl/extract.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { createDb, getRepository, upsertRepository } from "../../worker/src/api/repositories.ts";
import { search } from "../../worker/src/api/search.ts";
import { listSources, type SourceDraft, upsertSources } from "../../worker/src/etl/sources.ts";
import { scheduleSyncs } from "../../worker/src/cron/sync.ts";
import { transformRepository } from "../../worker/src/etl/transform.ts";
import { fakeGitHubPages, fakeMessage, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the id
// scheme. Three repositories: one searchable with a stream due for sync, one still
// registered and one inaccessible, which the cron must leave alone.
const REPO = Date.now() * 100 + 22;
const REPO_NEW = REPO + 1;
const REPO_DOWN = REPO + 2;
const db = createDb(env);
const API = "https://api.github.com/repos/alice/sync";
const WEB = "https://github.com/alice/sync";
const HWM = "2026-02-01T12:00:00Z";
const INTERVAL = 15 * 60;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function issue(n: number, body: string, updated_at: string): GitHubIssue {
  return {
    id: 1000 + n,
    node_id: `I_${n}`,
    number: n,
    title: `Issue ${n}`,
    state: "open",
    body,
    html_url: `${WEB}/issues/${n}`,
    url: `${API}/issues/${n}`,
    user: { login: "bob" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at,
    closed_at: null,
  };
}

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

/** Delivers every message the queue received, including the ones its runs send, in order. */
async function drain(queue: ReturnType<typeof fakeQueue>, github: ReturnType<typeof fakeGitHubPages>): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < queue.send.mock.calls.length; i++) {
    const body = queue.send.mock.calls[i][0] as JobMessage;
    await consumeJobMessage({ db, queue, fetch: github.fetch, embeddings: new FakeEmbeddingClient() }, fakeMessage(body), "worker-a");
    ran.push(body.kind);
  }
  return ran;
}

async function seedCheckpoints(repositoryId: number): Promise<void> {
  await saveCheckpoint(db, { repository_id: repositoryId, stream: "issues", cursor: null, last_item_at: HWM, head_done_at: HWM, backfill_done_at: HWM, last_synced_at: minutesAgo(20) });
  await saveCheckpoint(db, { repository_id: repositoryId, stream: "issue_comments", cursor: null, last_item_at: HWM, head_done_at: HWM, backfill_done_at: HWM, last_synced_at: minutesAgo(1) });
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/sync" }));
  await upsertRepository(db, repoFixture({ id: REPO_NEW, full_name: "alice/sync-new" }));
  await upsertRepository(db, repoFixture({ id: REPO_DOWN, full_name: "alice/sync-down" }));
  await db.from("repositories").update({ status: "searchable" }).eq("id", REPO);
  await db.from("repositories").update({ status: "inaccessible" }).eq("id", REPO_DOWN);
  for (const id of [REPO, REPO_NEW, REPO_DOWN]) await seedCheckpoints(id);

  const github = fakeGitHubPages([[issue(1, "Original body.", HWM)]]);
  const job = await createJob(db, REPO, "fetch_issues");
  const sent = (await enqueueJob(db, fakeQueue(), job.id))!;
  await consumeJobMessage({ db, queue: fakeQueue(), fetch: github.fetch }, fakeMessage({ jobId: job.id, repoId: REPO, kind: "fetch_issues", generation: sent.generation }), "seed");
  expect(await getJob(db, job.id)).toMatchObject({ state: "succeeded", result: { inserted: 1 } });
  expect(await transformRepository(db, REPO)).toMatchObject({ documents: 1, inserted: 1 });
  const embed = await createJob(db, REPO, EMBED_JOB_KIND);
  expect(await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, embed.id)).toMatchObject({ inserted: 1 });
  // That seed run completed a sync; make the stream due again.
  await saveCheckpoint(db, { repository_id: REPO, stream: "issues", last_synced_at: minutesAgo(20) });
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [REPO, REPO_NEW, REPO_DOWN]);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("scheduleSyncs", () => {
  it("queues one sync per due stream of a searchable repository, and nothing twice", async () => {
    const queue = fakeQueue();
    const first = await scheduleSyncs(db, queue, { intervalSeconds: INTERVAL, repositoryId: REPO });
    expect(first.due).toBe(1);
    expect(first.queued).toEqual([{ repository_id: REPO, stream: "issues", job_id: expect.any(Number) }]);
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual(["fetch_issues"]);

    const again = await scheduleSyncs(db, queue, { intervalSeconds: INTERVAL, repositoryId: REPO });
    expect(again).toEqual({ due: 0, queued: [] });
    // A shorter interval makes the fresh stream due as well.
    const soon = await scheduleSyncs(db, queue, { intervalSeconds: 30, repositoryId: REPO });
    expect(soon.queued.map((q) => q.stream)).toEqual(["issue_comments"]);
    await db.from("jobs").update({ state: "cancelled" }).eq("id", soon.queued[0].job_id);
  });

  it("leaves repositories alone that are not searchable yet or no longer accessible", async () => {
    const queue = fakeQueue();
    expect(await scheduleSyncs(db, queue, { intervalSeconds: INTERVAL, repositoryId: REPO_NEW })).toEqual({ due: 0, queued: [] });
    expect(await scheduleSyncs(db, queue, { intervalSeconds: INTERVAL, repositoryId: REPO_DOWN })).toEqual({ due: 0, queued: [] });
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("incremental sync", () => {
  it("lists since the high-water mark minus the overlap and leaves unchanged threads alone", async () => {
    const { data } = await db.from("jobs").select("id").eq("repository_id", REPO).eq("kind", "fetch_issues").eq("state", "queued").single();
    const jobId = (data as { id: number }).id;
    const before = (await listPassages(db, REPO, { number: 1 }))[0];
    const sourceBefore = (await listSources(db, REPO, { number: 1 }))[0];

    const github = fakeGitHubPages([[issue(1, "Original body.", HWM), issue(2, "A second issue.", "2026-02-01T12:30:00Z")]]);
    const queue = fakeQueue();
    const job = (await getJob(db, jobId))!;
    await consumeJobMessage({ db, queue, fetch: github.fetch }, fakeMessage({ jobId, repoId: REPO, kind: job.kind, generation: job.generation }), "worker-a");
    expect(await getJob(db, jobId)).toMatchObject({ state: "succeeded", result: { phase: "sync", pages: 1, records: 2, inserted: 1, updated: 0, unchanged: 1 } });

    const request = github.requests[0];
    expect(request.searchParams.get("since")).toBe(overlapSince(HWM));
    expect(Date.parse(HWM) - Date.parse(request.searchParams.get("since")!)).toBe(SYNC_OVERLAP_SECONDS * 1000);
    expect(request.searchParams.get("direction")).toBe("asc");
    const checkpoint = await getCheckpoint(db, REPO, "issues");
    expect(checkpoint?.last_item_at && toGitHubTimestamp(checkpoint.last_item_at)).toBe("2026-02-01T12:30:00Z");
    expect(Date.now() - Date.parse(checkpoint!.last_synced_at!)).toBeLessThan(60_000);

    // The unchanged issue was seen but not re-fetched, so its thread is not dirty.
    const sourceAfter = (await listSources(db, REPO, { number: 1 }))[0];
    expect(sourceAfter.fetched_at).toBe(sourceBefore.fetched_at);
    expect(Date.parse(sourceAfter.seen_at)).toBeGreaterThan(Date.parse(sourceBefore.seen_at));
    expect(await transformRepository(db, REPO)).toMatchObject({ documents: 1, inserted: 1 }); // issue 2 only
    expect((await listPassages(db, REPO, { number: 1 }))[0].updated_at).toBe(before.updated_at);
  });

  it("re-transforms, re-embeds and serves a changed source after the next scheduled sync", async () => {
    const edited = "Edited body about zebra migration patterns.";
    const github = fakeGitHubPages([[issue(1, edited, "2026-02-01T13:00:00Z")]], (url) =>
      url.pathname.endsWith("/issues") ? undefined : new Response("[]", { headers: { "content-type": "application/json" } }),
    );
    await saveCheckpoint(db, { repository_id: REPO, stream: "issues", last_synced_at: minutesAgo(20) });
    // The previous test's sync queued a transform into a queue nobody drained; clear it so the
    // chain below is queued afresh.
    await db.from("jobs").update({ state: "cancelled" }).eq("repository_id", REPO).eq("state", "queued");
    const queue = fakeQueue();
    const schedule = await scheduleSyncs(db, queue, { intervalSeconds: INTERVAL, repositoryId: REPO });
    expect(schedule.queued.map((q) => q.stream)).toEqual(["issues"]);

    // The sync chains the transform, which chains the embedding; nothing else is needed.
    const ran = await drain(queue, github);
    expect(ran).toEqual(["fetch_issues", "transform_passages", "embed_passages"]);
    const sync = (await getJob(db, schedule.queued[0].job_id))!;
    expect(sync.result).toMatchObject({ phase: "sync", inserted: 0, updated: 1, unchanged: 0 });

    const passages = await listPassages(db, REPO, { number: 1 });
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ passage_id: `github:${REPO}:issue:1:body:0`, text: edited, index_state: "active" });
    const repository = (await getRepository(db, REPO))!;
    const found = await search({ db, embeddings: new FakeEmbeddingClient() }, { repository, query: edited });
    expect(found).toMatchObject({ mode: "semantic", confidence: "high" });
    expect(found.results[0]).toMatchObject({ passage_id: `github:${REPO}:issue:1:body:0`, excerpt: edited });
    const stale = await search({ db, embeddings: new FakeEmbeddingClient() }, { repository, query: "Original body." });
    expect(stale.results.map((r) => r.excerpt)).not.toContain("Original body.");
  });

  it("moves fetched_at only when the content changed, and never backwards in time", async () => {
    const [stored] = await listSources(db, REPO, { number: 2 });
    const draft: SourceDraft = {
      repository_id: REPO,
      type: "issue",
      github_id: stored.github_id,
      number: 2,
      node_id: stored.node_id,
      title: stored.title,
      author: stored.author,
      body: stored.body,
      state: stored.state,
      html_url: stored.html_url,
      api_url: stored.api_url,
      path: null,
      line: null,
      in_reply_to_id: null,
      created_at: stored.created_at,
      updated_at: stored.updated_at,
      closed_at: null,
      fetched_by_job: null,
    };
    expect(await upsertSources(db, [draft])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const seen = (await listSources(db, REPO, { number: 2 }))[0];
    expect(seen.fetched_at).toBe(stored.fetched_at);
    expect(Date.parse(seen.seen_at)).toBeGreaterThan(Date.parse(stored.seen_at));

    // Only updated_at moved (a comment was added): recorded, but not a content change.
    const later = "2026-02-01T14:00:00+00:00";
    expect(await upsertSources(db, [{ ...draft, updated_at: later }])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const dated = (await listSources(db, REPO, { number: 2 }))[0];
    expect(dated.fetched_at).toBe(stored.fetched_at);
    expect(Date.parse(dated.updated_at)).toBe(Date.parse(later));

    // An older copy is ignored entirely, seen_at included.
    expect(await upsertSources(db, [{ ...draft, body: "older text", updated_at: "2026-02-01T09:00:00Z" }])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const kept = (await listSources(db, REPO, { number: 2 }))[0];
    expect(kept.body).toBe(stored.body);
    expect(kept.seen_at).toBe(dated.seen_at);

    // A content change moves fetched_at and the fetching job.
    expect(await upsertSources(db, [{ ...draft, body: "new text", updated_at: later }])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const changed = (await listSources(db, REPO, { number: 2 }))[0];
    expect(Date.parse(changed.fetched_at)).toBeGreaterThan(Date.parse(stored.fetched_at));
    expect(changed.body).toBe("new text");
  });
});
