import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchResponse, ServiceStatus } from "../shared/api.ts";
import { type Budget, milliNeuronsFor } from "../worker/budget.ts";
import { getCheckpoint, saveCheckpoint } from "../worker/checkpoints.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { listPassages } from "../worker/documents.ts";
import { EMBED_JOB_KIND, embedPassages, pendingPassages } from "../worker/embed.ts";
import { EMBEDDING_DIMS, FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import worker from "../worker/index.ts";
import { claimJob, createJob, enqueueJob, finishJob, getJob, type JobQueue } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { dbError, JobError } from "../worker/retry.ts";
import { listSources } from "../worker/sources.ts";
import { TRANSFORM_JOB_KIND } from "../worker/transform.ts";
import { dropBudget, exhaustBudget, expectNoSecrets, fakeExecutionContext, fakeGitHubPages, fakeMessage, insertPassages, jsonResponse, repoFixture, seedBudget } from "./helpers.ts";

// Failure drills against the real Supabase project with GitHub, Workers AI and, where a
// drill needs it, Supabase itself stubbed. See jobs.test.ts for the id scheme.
const REPO = Date.now() * 100 + 18;
const SCOPE = `test-${REPO}`;
const db = createDb(env);
const scopedEnv = { ...env, BUDGET_SCOPE: SCOPE };
const API = "https://api.github.com/repos/alice/reliability";
const TEXTS = ["Drill passage one about zebras.", "Drill passage two, a bit longer than one.", "Drill passage three is the longest of all five passages.", "Four.", "Passage five about budgets."];
let budget: Budget;
type WorkerRequest = Parameters<typeof worker.fetch>[0];
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
const hrefOf = (input: FetchInput) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

function issue(n: number) {
  return { id: 1000 + n, node_id: `I_${n}`, number: n, title: `Issue ${n}`, state: "open", body: `Body ${n}`, html_url: `https://github.com/alice/reliability/issues/${n}`, url: `${API}/issues/${n}`, user: { login: "bob" }, created_at: "2026-01-01T00:00:00Z", updated_at: `2026-01-01T00:${String(n).padStart(2, "0")}:00Z`, closed_at: null };
}

async function deliver(jobId: number, ctx: Parameters<typeof consumeJobMessage>[0], owner = "w") {
  const job = (await getJob(db, jobId))!;
  await consumeJobMessage(ctx, fakeMessage({ jobId, repoId: REPO, kind: job.kind, generation: job.generation }), owner);
  return (await getJob(db, jobId))!;
}

async function queued(kind: string, queue = fakeQueue()) {
  const job = await createJob(db, REPO, kind);
  await enqueueJob(db, queue, job.id);
  return job.id;
}

async function makeDue(jobId: number) {
  await db.from("jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", jobId);
}

async function used(resource: string): Promise<number> {
  return (await budget.summary()).find((b) => b.resource === resource)!.used;
}

async function vectorCount(): Promise<number> {
  return (await db.from("passage_embeddings").select("*", { count: "exact", head: true }).eq("repository_id", REPO)).count ?? 0;
}

/** Stubs api.cloudflare.com with deterministic vectors and, optionally, Supabase paths with scripted failures. */
function stubNetwork(failures: { path: RegExp; onCall: number; status: number; body: unknown }[] = []) {
  const realFetch = globalThis.fetch;
  const seen = new Map<string, number>();
  vi.stubGlobal("fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(hrefOf(input));
    if (url.hostname === "api.cloudflare.com") {
      const { text } = JSON.parse(String(init?.body)) as { text: string[] };
      return jsonResponse(200, { success: true, result: { shape: [text.length, EMBEDDING_DIMS], data: text.map((t) => fakeVector(t)), pooling: "cls" } });
    }
    for (const f of failures) {
      if (f.path.test(url.pathname)) {
        const n = (seen.get(f.path.source) ?? 0) + 1;
        seen.set(f.path.source, n);
        if (n === f.onCall) return jsonResponse(f.status, f.body);
      }
    }
    return realFetch(input, init);
  });
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/reliability" }));
  await insertPassages(db, REPO, TEXTS.map((text) => ({ text })));
  budget = await seedBudget(db, SCOPE);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
  await dropBudget(db, SCOPE);
});
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!env.SUPABASE_SECRET_KEY)("zero quota", () => {
  it("serves keyword results with the pause message through the route, and the next window brings semantic search back", async () => {
    const job = await createJob(db, REPO, EMBED_JOB_KIND);
    await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, job.id);
    stubNetwork();
    await exhaustBudget(budget, "ai_neurons_milli");
    // The query is a stored text: fake vectors of different texts are unrelated, so only an exact text is a semantic match.
    const post = () => worker.fetch(new Request("http://localhost/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId: REPO, query: TEXTS[0] }) }) as unknown as WorkerRequest, scopedEnv, fakeExecutionContext());
    const paused = await post();
    expect(paused.status).toBe(200);
    const text = await paused.text();
    expectNoSecrets(text);
    const body = JSON.parse(text) as SearchResponse;
    expect(body).toMatchObject({ mode: "keyword", semantic_error: "budget_exhausted" });
    expect(body.message).toMatch(/^Semantic search is paused until .* \(inference budget reached\)/);
    expect(body.results.map((r) => r.excerpt)).toEqual([TEXTS[0]]);
    const status = (await (await worker.fetch(new Request("http://localhost/api/status") as unknown as WorkerRequest, scopedEnv, fakeExecutionContext())).json()) as ServiceStatus;
    expect(status.paused).toBe(true);
    expect(status.reasons[0]).toMatch(/^ai_neurons_milli: /);

    await db.from("usage_budgets").update({ window_start: new Date(Date.now() - 86_400_000).toISOString() }).eq("scope", SCOPE).eq("resource", "ai_neurons_milli");
    const resumed = (await (await post()).json()) as SearchResponse;
    expect(resumed).toMatchObject({ mode: "semantic", confidence: "high", semantic_error: null });
    expect(await used("ai_neurons_milli")).toBeGreaterThan(0);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("API 429", () => {
  it(
    "GitHub: page 1 is stored, the job parks for Retry-After, resumes from the cursor and re-reads page 1 as unchanged",
    async () => {
      await saveCheckpoint(db, { repository_id: REPO, stream: "issues", cursor: `${API}/issues?sort=updated&direction=desc&per_page=100&state=all`, head_done_at: new Date().toISOString(), backfill_done_at: null });
      let page2Blocked = true;
      const github = fakeGitHubPages([[issue(11), issue(12), issue(13)], [issue(14), issue(15), issue(16)], [issue(17), issue(18), issue(19)]], (url) => {
        if (url.searchParams.get("page") === "2" && page2Blocked) {
          page2Blocked = false;
          return jsonResponse(429, { message: "slow down" }, { "Retry-After": "120" });
        }
        return undefined;
      });
      const queue = fakeQueue();
      const ctx = { db, queue, fetch: github.fetch, budget };
      const jobId = await queued("backfill_issues", queue);
      const parked = await deliver(jobId, ctx);
      expect(parked).toMatchObject({ state: "retry_pending", error_code: "rate_limited", attempt: 1 });
      expect(Date.parse(parked.next_attempt_at!) - Date.now()).toBeGreaterThanOrEqual(115_000);
      expect((await listSources(db, REPO, { type: "issue" })).map((s) => s.number)).toEqual([1, 11, 12, 13]); // 1 is the fixture thread
      expect(github.requests).toHaveLength(2);
      expect(await used("github_requests_anon")).toBe(2); // both attempted requests count

      await makeDue(jobId);
      const done = await deliver(jobId, ctx);
      expect(done).toMatchObject({ state: "succeeded", attempt: 2, result: { pages: 3, inserted: 6, unchanged: 3 } });
      expect((await listSources(db, REPO, { type: "issue" })).map((s) => s.number)).toEqual([1, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
      expect((await getCheckpoint(db, REPO, "issues"))?.backfill_done_at).not.toBeNull();
      expect(await used("github_requests_anon")).toBe(5);
    },
    60_000,
  );

  it("Workers AI: batch 1 is stored, the failed batch's reservation is refunded, the job parks", async () => {
    await db.from("passage_embeddings").delete().eq("repository_id", REPO);
    await db.from("passages").update({ index_state: "pending_index" }).eq("repository_id", REPO);
    const before = await used("ai_neurons_milli");
    const pending = [...(await pendingPassages(db, REPO, 10))].sort((a, b) => a.token_count - b.token_count);
    const batch1 = milliNeuronsFor(2 * Math.max(pending[0].token_count, pending[1].token_count));
    const client = new FakeEmbeddingClient({ fail: (_texts, call) => (call === 1 ? new JobError("ai_rate_limited", "429", { transient: true, retryAfterSeconds: 45 }) : undefined) });
    const queue = fakeQueue();
    const jobId = await queued(EMBED_JOB_KIND, queue);
    const job = (await getJob(db, jobId))!;
    await consumeJobMessage({ db, queue, embeddings: client, budget, run: async (j, c) => { const { done, ...result } = await embedPassages(c, j.repository_id, j.id, { batchSize: 2 }); return { done, result }; } }, fakeMessage({ jobId, repoId: REPO, kind: EMBED_JOB_KIND, generation: job.generation }), "w");
    expect(await getJob(db, jobId)).toMatchObject({ state: "retry_pending", error_code: "ai_rate_limited" });
    expect(await vectorCount()).toBe(2);
    expect(await used("ai_neurons_milli")).toBe(before + batch1);
    await db.from("jobs").update({ state: "cancelled" }).eq("id", jobId);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("leases and duplicates", () => {
  it("a takeover after an expired lease finishes the run without storing anything twice, and fences the old owner", async () => {
    const queue = fakeQueue();
    const jobId = await queued(EMBED_JOB_KIND, queue);
    const job = (await getJob(db, jobId))!;
    const message = { jobId, repoId: REPO, kind: EMBED_JOB_KIND, generation: job.generation };
    expect((await claimJob(db, message, "owner-a")).outcome).toBe("claimed");
    expect(await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, jobId, { batchSize: 1, maxBatches: 1 })).toMatchObject({ inserted: 1 });
    await db.from("jobs").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("id", jobId);

    await consumeJobMessage({ db, queue, embeddings: new FakeEmbeddingClient(), budget }, fakeMessage(message), "owner-b");
    expect(await getJob(db, jobId)).toMatchObject({ state: "succeeded", lease_owner: null });
    expect(await vectorCount()).toBe(TEXTS.length); // 2 stored by the AI drill, 1 by owner a, 2 by owner b: every passage once
    expect(await finishJob(db, jobId, "owner-a", { state: "succeeded" })).toBeNull();
  });

  it("a duplicate delivery of a finished job is acked without a request", async () => {
    await saveCheckpoint(db, { repository_id: REPO, stream: "issue_comments", cursor: `${API}/issues/comments?page=1`, head_done_at: new Date().toISOString(), backfill_done_at: null });
    const github = fakeGitHubPages([[]]);
    const queue = fakeQueue();
    const ctx = { db, queue, fetch: github.fetch, budget };
    const jobId = await queued("backfill_issue_comments", queue);
    const first = await deliver(jobId, ctx);
    expect(first.state).toBe("succeeded");
    expect(github.requests).toHaveLength(1);
    const again = await deliver(jobId, ctx, "another-worker");
    expect(again).toMatchObject({ state: "succeeded", attempt: 1, result: first.result });
    expect(github.requests).toHaveLength(1);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("database partial failure", () => {
  it("classifies the database being unavailable as transient and refused data as permanent", () => {
    expect(dbError("upsert_sources", { message: "service unavailable", code: "PGRST001" }).transient).toBe(true);
    expect(dbError("x", { message: "canceling statement due to statement timeout", code: "57014" }).transient).toBe(true);
    expect(dbError("x", { message: "could not serialize access", code: "40001" }).transient).toBe(true);
    expect(dbError("x", { message: "fetch failed" }).transient).toBe(true);
    expect(dbError("x", { message: "new row violates check constraint", code: "23514" }).transient).toBe(false);
    expect(dbError("x", { message: "invalid input syntax", code: "22000" }).transient).toBe(false);
    expect(dbError("x", { message: "boom", code: "23514" })).toMatchObject({ code: "db_error", data: { code: "23514" } });
  });

  it(
    "a failing write mid-extraction parks the job; the retry re-reads the stored page as unchanged and stores nothing twice",
    async () => {
      await saveCheckpoint(db, { repository_id: REPO, stream: "review_comments", cursor: `${API}/pulls/comments?page=1`, head_done_at: new Date().toISOString(), backfill_done_at: null });
      const comment = (k: number) => ({ id: 7000 + k, node_id: `RC_${k}`, url: `${API}/pulls/comments/${7000 + k}`, html_url: `https://github.com/alice/reliability/pull/1#discussion_r${7000 + k}`, pull_request_url: `${API}/pulls/1`, path: "a.ts", line: 1, original_line: 1, user: { login: "d" }, body: `r${k}`, created_at: "2026-01-01T00:00:00Z", updated_at: `2026-01-01T01:${String(k).padStart(2, "0")}:00Z` });
      const github = fakeGitHubPages([[comment(1), comment(2)], [comment(3)]]);
      stubNetwork([{ path: /\/rest\/v1\/rpc\/upsert_sources$/, onCall: 2, status: 503, body: { message: "service unavailable", code: "PGRST001" } }]);
      const queue = fakeQueue();
      const ctx = { db, queue, fetch: github.fetch, budget };
      const jobId = await queued("backfill_review_comments", queue);
      const parked = await deliver(jobId, ctx);
      expect(parked).toMatchObject({ state: "retry_pending", error_code: "db_error" });
      expect(parked.error_message).toMatch(/upsert_sources failed: service unavailable \(PGRST001\)/);
      expect((await listSources(db, REPO, { type: "review_comment" })).map((s) => s.github_id)).toEqual([7001, 7002]);

      vi.unstubAllGlobals();
      await makeDue(jobId);
      const done = await deliver(jobId, ctx);
      expect(done).toMatchObject({ state: "succeeded", attempt: 2, result: { pages: 2, inserted: 1, unchanged: 2 } });
      expect((await listSources(db, REPO, { type: "review_comment" })).map((s) => s.github_id)).toEqual([7001, 7002, 7003]);
    },
    60_000,
  );

  it("a failing transform write leaves the thread dirty and the passages untouched; the next run completes it", async () => {
    const before = await listPassages(db, REPO, { number: 1 });
    stubNetwork([{ path: /\/rest\/v1\/rpc\/sync_passages$/, onCall: 1, status: 503, body: { message: "service unavailable", code: "PGRST001" } }]);
    const queue = fakeQueue();
    const jobId = await queued(TRANSFORM_JOB_KIND, queue);
    const parked = await deliver(jobId, { db, queue, budget });
    expect(parked).toMatchObject({ state: "retry_pending", error_code: "db_error" });
    expect(await listPassages(db, REPO, { number: 1 })).toEqual(before);
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual([TRANSFORM_JOB_KIND, TRANSFORM_JOB_KIND]); // the retry only; no embed was chained

    vi.unstubAllGlobals();
    await makeDue(jobId);
    const done = await deliver(jobId, { db, queue, budget });
    expect(done.state).toBe("succeeded");
    expect(Number(done.result?.documents)).toBeGreaterThanOrEqual(1); // the fixture thread, plus threads the extraction drills left dirty
    expect((await listPassages(db, REPO, { number: 1 })).every((p) => p.transform_version !== "fixture")).toBe(true);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("model errors", () => {
  it("fails the job permanently on malformed output, stores nothing, and refunds the reservation", async () => {
    await db.from("passage_embeddings").delete().eq("repository_id", REPO);
    await db.from("passages").update({ index_state: "pending_index" }).eq("repository_id", REPO);
    const before = await used("ai_neurons_milli");
    const broken = new FakeEmbeddingClient({ fail: () => new JobError("ai_invalid_output", "Expected 5 vectors from Workers AI", { transient: false }) });
    const queue = fakeQueue();
    const jobId = await queued(EMBED_JOB_KIND, queue);
    const failed = await deliver(jobId, { db, queue, embeddings: broken, budget });
    expect(failed).toMatchObject({ state: "failed", error_code: "ai_invalid_output" });
    expect(await vectorCount()).toBe(0);
    expect(await used("ai_neurons_milli")).toBe(before);
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual([EMBED_JOB_KIND]); // no retry, nothing chained
  });
});
