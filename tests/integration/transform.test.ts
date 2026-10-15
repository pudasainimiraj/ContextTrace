import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PassageRecord } from "../../shared/api.ts";
import { MAX_PASSAGE_TOKENS } from "../../worker/src/etl/chunk.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import { getDocumentByNumber, listPassages } from "../../worker/src/etl/documents.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { contentHash } from "../../worker/src/etl/passages.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { type SourceDraft, upsertSources } from "../../worker/src/etl/sources.ts";
import { countModelTokens, TOKENIZER_NAME } from "../../worker/src/etl/tokenizer.ts";
import { TRANSFORM_JOB_KIND, transformRepository } from "../../worker/src/etl/transform.ts";
import { fakeGitHubPages, fakeMessage, jsonResponse, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 55;
const db = createDb(env);
const WEB = "https://github.com/alice/transform";
const API = "https://api.github.com/repos/alice/transform";
const DOC = (type: string, number: number) => `github:${REPO_ID}:${type}:${number}`;

function at(minutes: number): string {
  return new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();
}

function sourceRow(partial: Partial<SourceDraft> & Pick<SourceDraft, "type" | "github_id" | "number" | "created_at">): SourceDraft {
  const kind = partial.type === "pull_request" ? "pull" : "issues";
  return {
    repository_id: REPO_ID,
    node_id: null,
    title: null,
    author: "ann",
    body: "text",
    state: null,
    html_url: `${WEB}/${kind}/${partial.number}`,
    api_url: `${API}/issues/${partial.number}`,
    path: null,
    line: null,
    in_reply_to_id: null,
    updated_at: partial.created_at,
    closed_at: null,
    fetched_by_job: null,
    ...partial,
  };
}

const LONG_BODY = Array.from({ length: 70 }, (_, i) => `Sentence number ${i + 1} explains the scheduler decision in some detail.`).join(" ");

const SOURCES: SourceDraft[] = [
  sourceRow({ type: "issue", github_id: 1001, number: 1, title: "Scheduler rewrite", body: "Tracking issue.\n\nWe will **replace** the cron scheduler.", created_at: at(0) }),
  sourceRow({ type: "issue_comment", github_id: 5001, number: 1, body: "First comment with `code`.", created_at: at(1), html_url: `${WEB}/issues/1#issuecomment-5001` }),
  sourceRow({ type: "issue_comment", github_id: 5002, number: 1, body: LONG_BODY, created_at: at(2), html_url: `${WEB}/issues/1#issuecomment-5002` }),
  sourceRow({ type: "pull_request", github_id: 1002, number: 2, title: "Add ticks", body: "Implements ticks.", created_at: at(0) }),
  sourceRow({ type: "review_comment", github_id: 7001, number: 2, body: "Rename this.", path: "src/a.ts", line: 12, created_at: at(3), html_url: `${WEB}/pull/2#discussion_r7001` }),
  sourceRow({ type: "issue", github_id: 1003, number: 3, title: "Empty", body: "<!-- template only -->", created_at: at(0) }),
  sourceRow({ type: "issue_comment", github_id: 5099, number: 99, body: "Orphan comment.", created_at: at(4) }),
];

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

async function transformJobs(): Promise<{ id: number; state: string }[]> {
  const { data } = await db.from("jobs").select("id, state").eq("repository_id", REPO_ID).eq("kind", TRANSFORM_JOB_KIND).order("id");
  return (data ?? []) as { id: number; state: string }[];
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/transform" }));
  await upsertSources(db, SOURCES);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("transformRepository", () => {
  it("transforms dirty threads into documents and passages with stable ids and hashes", async () => {
    const result = await transformRepository(db, REPO_ID);
    expect(result).toMatchObject({ done: true, documents: 3, units: 6, skippedUnits: 1, updated: 0, unchanged: 0, removed: 0 });
    expect(result.inserted).toBe(result.passages);
    expect(result.syncBytes).toBeGreaterThan(0);

    const thread1 = await listPassages(db, REPO_ID, { number: 1 });
    expect(thread1[0]).toMatchObject({
      passage_id: `${DOC("issue", 1)}:body:0`,
      locator: "Opening body",
      text: "Tracking issue.\n\nWe will replace the cron scheduler.",
      source_type: "issue",
      source_github_id: 1001,
    });
    const first = thread1.find((p) => p.source_github_id === 5001)!;
    expect(first).toMatchObject({
      passage_id: `${DOC("issue", 1)}:issue_comment:5001:0`,
      locator: "Comment 1 of 2",
      tokenizer: TOKENIZER_NAME,
      source_url: `${WEB}/issues/1#issuecomment-5001`,
      transform_version: "1",
    });
    expect(first.token_count).toBe(countModelTokens(first.text));
    expect(first.content_hash).toBe(await contentHash(first.text));
    const long = thread1.filter((p) => p.source_github_id === 5002);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((p) => p.token_count <= MAX_PASSAGE_TOKENS && p.chunk_count === long.length)).toBe(true);

    const review = (await listPassages(db, REPO_ID, { number: 2 })).find((p) => p.source_type === "review_comment")!;
    expect(review).toMatchObject({
      passage_id: `${DOC("pull_request", 2)}:review_comment:7001:0`,
      locator: "Review comment 1 of 1 on src/a.ts:12",
    });

    expect(await getDocumentByNumber(db, REPO_ID, 3)).toMatchObject({ document_id: DOC("issue", 3), title: "Empty" });
    expect(await listPassages(db, REPO_ID, { number: 3 })).toEqual([]);
    expect(await getDocumentByNumber(db, REPO_ID, 99)).toBeNull();
  });

  it("does nothing when no thread is dirty", async () => {
    expect(await transformRepository(db, REPO_ID)).toMatchObject({ done: true, documents: 0, passages: 0, inserted: 0 });
  });

  it("does not dirty a thread when a re-fetch returns the same content", async () => {
    const before = (await listPassages(db, REPO_ID, { number: 1 })).find((p) => p.source_github_id === 5001)!;
    expect(await upsertSources(db, SOURCES)).toEqual({ inserted: 0, updated: 0, unchanged: SOURCES.length }); // seen again, unchanged
    const result = await transformRepository(db, REPO_ID);
    expect(result).toMatchObject({ done: true, documents: 0, passages: 0, inserted: 0, updated: 0, removed: 0 });
    const after = (await listPassages(db, REPO_ID, { number: 1 })).find((p) => p.source_github_id === 5001)!;
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("rewrites only the passages whose text changed and removes parts that no longer exist", async () => {
    const partsBefore = (await listPassages(db, REPO_ID, { number: 1 })).filter((p) => p.source_github_id === 5002).length;
    await upsertSources(db, [sourceRow({ type: "issue_comment", github_id: 5002, number: 1, body: "Short now.", created_at: at(2), updated_at: at(5), html_url: `${WEB}/issues/1#issuecomment-5002` })]);
    const result = await transformRepository(db, REPO_ID);
    expect(result).toMatchObject({ done: true, documents: 1, inserted: 0, updated: 1, unchanged: 2, removed: partsBefore - 1 });
    const parts = (await listPassages(db, REPO_ID, { number: 1 })).filter((p) => p.source_github_id === 5002);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ chunk_count: 1, locator: "Comment 2 of 2", text: "Short now." });
  });

  it("re-transforms every thread when the transform version changes", async () => {
    const result = await transformRepository(db, REPO_ID, { transformVersion: "test-2" });
    expect(result).toMatchObject({ done: true, documents: 3, inserted: 0, removed: 0 });
    expect(result.updated).toBe(result.passages);
    expect((await getDocumentByNumber(db, REPO_ID, 2))?.transform_version).toBe("test-2");
    expect(await transformRepository(db, REPO_ID, { transformVersion: "test-2" })).toMatchObject({ documents: 0 });
  });

  it("pages through dirty threads and continues until none remain", async () => {
    const first = await transformRepository(db, REPO_ID, { transformVersion: "test-3", limit: 2 });
    expect(first).toMatchObject({ done: false, documents: 2 });
    const second = await transformRepository(db, REPO_ID, { transformVersion: "test-3", limit: 2 });
    expect(second).toMatchObject({ done: true, documents: 1 });
    expect(await transformRepository(db, REPO_ID, { transformVersion: "test-3", limit: 2 })).toMatchObject({ done: true, documents: 0 });
  });

  it("waits for a thread's opening before transforming its comments", async () => {
    expect(await getDocumentByNumber(db, REPO_ID, 99)).toBeNull();
    await upsertSources(db, [sourceRow({ type: "issue", github_id: 1099, number: 99, title: "Late opening", body: "Finally.", created_at: at(0) })]);
    const result = await transformRepository(db, REPO_ID, { transformVersion: "test-3" });
    expect(result).toMatchObject({ done: true, documents: 1, inserted: 2 });
    expect((await listPassages(db, REPO_ID, { number: 99 })).map((p) => p.locator)).toEqual(["Opening body", "Comment 1 of 1"]);
  });

  it("is queued once after an extraction stream finishes, and not again while it waits", async () => {
    expect(await transformJobs()).toEqual([]);
    const queue = fakeQueue();
    const issuePage = [
      {
        id: 1500,
        node_id: "I_1500",
        number: 500,
        title: "From the stream",
        state: "open",
        body: "Fetched through the extractor.",
        html_url: `${WEB}/issues/500`,
        url: `${API}/issues/500`,
        user: { login: "bob" },
        created_at: at(6),
        updated_at: at(6),
        closed_at: null,
      },
    ];
    const streams: Array<[string, unknown[][]]> = [
      ["fetch_issues", [issuePage]],
      ["fetch_issue_comments", [[]]],
    ];
    for (const [kind, pages] of streams) {
      const job = await createJob(db, REPO_ID, kind);
      const sent = (await enqueueJob(db, queue, job.id))!;
      const message = fakeMessage({ jobId: job.id, repoId: REPO_ID, kind, generation: sent.generation });
      const github = fakeGitHubPages(pages, (url) => (url.pathname.endsWith("/issues") || url.pathname.endsWith("/issues/comments") ? undefined : jsonResponse(200, [])));
      await consumeJobMessage({ db, queue, fetch: github.fetch }, message, "worker-a");
      expect((await getJob(db, job.id))?.state).toBe("succeeded");
    }
    const jobs = await transformJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("queued");
    expect(queue.send.mock.calls.filter(([m]) => m.kind === TRANSFORM_JOB_KIND)).toHaveLength(1);
  });

  it("runs as a job through the consumer and records its counts in jobs.result", async () => {
    const [queued] = await transformJobs();
    const queue = fakeQueue();
    const job = (await getJob(db, queued.id))!;
    const message = fakeMessage({ jobId: job.id, repoId: REPO_ID, kind: TRANSFORM_JOB_KIND, generation: job.generation });
    await consumeJobMessage({ db, queue }, message, "worker-b");
    const finished = (await getJob(db, job.id))!;
    expect(finished.state).toBe("succeeded");
    // Every thread is dirty again under the default version, plus the one the stream fetched.
    expect(finished.result).toMatchObject({ documents: 5, removed: 0 });
    expect(finished.result?.durationMs).toBeGreaterThanOrEqual(0);
    expect((await listPassages(db, REPO_ID, { number: 500 }))[0]).toMatchObject({ passage_id: `${DOC("issue", 500)}:body:0`, transform_version: "1" });
    expect(queue.send.mock.calls.filter(([m]) => m.kind === TRANSFORM_JOB_KIND)).toHaveLength(0);
  });

  it("serves passages over GET /api/repositories/:id/passages", async () => {
    const res = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/passages?number=1&limit=10`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as PassageRecord[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.document_id === DOC("issue", 1))).toBe(true);
    expect(rows[0].passage_id).toBe(`${DOC("issue", 1)}:body:0`);

    const all = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/passages`);
    expect(((await all.json()) as PassageRecord[]).length).toBeGreaterThan(rows.length);
    expect((await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/passages?number=x`)).status).toBe(400);
    expect((await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID + 1}/passages`)).status).toBe(404);
  });
});
