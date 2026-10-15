import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiError, ServiceStatus } from "../shared/api.ts";
import { admissionState } from "../worker/admission.ts";
import type { Budget } from "../worker/budget.ts";
import { getCheckpoint, saveCheckpoint } from "../worker/checkpoints.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { getCoverage } from "../worker/coverage.ts";
import { EMBED_JOB_KIND } from "../worker/embed.ts";
import { FakeEmbeddingClient } from "../worker/embeddings.ts";
import { extractStream, type GitHubIssue, ISSUES_STREAM } from "../worker/extract.ts";
import worker from "../worker/index.ts";
import { createJob, enqueueJob, getJob, type JobQueue, MAX_MESSAGE_DELAY_SECONDS } from "../worker/jobs.ts";
import { createDb, getRepository, upsertRepository } from "../worker/repositories.ts";
import { search } from "../worker/search.ts";
import { scheduleSyncs } from "../worker/sync.ts";
import { TRANSFORM_JOB_KIND, TRANSFORM_VERSION } from "../worker/transform.ts";
import { dropBudget, exhaustBudget, fakeExecutionContext, fakeGitHubPages, fakeMessage, insertPassages, jsonResponse, repoFixture, seedBudget } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the id
// scheme. The ledger rows live under this file's own scope.
const REPO = Date.now() * 100 + 8;
const SCOPE = `test-${REPO}`;
const db = createDb(env);
const scopedEnv = { ...env, BUDGET_SCOPE: SCOPE };
const TEXTS = ["Pause test passage about zebras.", "Another passage about budgets."];
const API = "https://api.github.com/repos/o/r";
let budget: Budget;

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

/** The fixture issue exactly as insertPassages stored it, so a sync sees it unchanged. */
const FIXTURE_ISSUE: GitHubIssue = {
  id: 1,
  node_id: null as unknown as string,
  number: 1,
  title: "Fixture thread",
  state: "open",
  body: "fixture",
  html_url: "https://github.com/o/r/issues/1",
  url: `${API}/issues/1`,
  user: { login: "ann" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
};

function issue(n: number): GitHubIssue {
  return { ...FIXTURE_ISSUE, id: 1000 + n, node_id: `I_${n}`, number: n, title: `Issue ${n}`, body: `Body ${n}`, html_url: `https://github.com/o/r/issues/${n}`, url: `${API}/issues/${n}`, updated_at: `2026-02-01T00:${String(n).padStart(2, "0")}:00Z` };
}

async function runJob(kind: string, ctx: Parameters<typeof consumeJobMessage>[0], jobId?: number) {
  const id = jobId ?? (await createJob(db, REPO, kind)).id;
  const job = jobId ? (await getJob(db, id))! : (await enqueueJob(db, ctx.queue, id))!;
  await consumeJobMessage(ctx, fakeMessage({ jobId: id, repoId: REPO, kind, generation: job.generation }), "w");
  return (await getJob(db, id))!;
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/pause" }));
  await insertPassages(db, REPO, TEXTS.map((text) => ({ text })));
  // The fixture thread counts as transformed by the current version, so nothing is dirty.
  await db.from("documents").update({ transform_version: TRANSFORM_VERSION, sources_fetched_at: new Date().toISOString() }).eq("repository_id", REPO);
  budget = await seedBudget(db, SCOPE, { queue_ops: 100 });
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
  await dropBudget(db, SCOPE);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("budget pauses", () => {
  it("park the job until the window resets without spending an attempt, then let it run", async () => {
    await exhaustBudget(budget, "ai_neurons_milli");
    const queue = fakeQueue();
    const ctx = { db, queue, embeddings: new FakeEmbeddingClient(), budget };
    const parked = await runJob(EMBED_JOB_KIND, ctx);
    expect(parked).toMatchObject({ state: "retry_pending", error_code: "budget_exhausted", attempt: 0 });
    expect(parked.error_message).toMatch(/ai_neurons_milli is exhausted/);
    const delay = queue.send.mock.calls.at(-1)?.[1]?.delaySeconds ?? 0;
    expect(delay).toBeGreaterThanOrEqual(60);
    expect(delay).toBeLessThanOrEqual(MAX_MESSAGE_DELAY_SECONDS);

    // The next window: the budget resets, the parked job becomes due and is redelivered.
    await db.from("usage_budgets").update({ window_start: new Date(Date.now() - 86_400_000).toISOString() }).eq("scope", SCOPE).eq("resource", "ai_neurons_milli");
    await db.from("jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", parked.id);
    const done = await runJob(EMBED_JOB_KIND, ctx, parked.id);
    expect(done).toMatchObject({ state: "succeeded", attempt: 1, result: { inserted: 2 } });
  });

  it("send a message with at most a 12-hour delay", async () => {
    const queue = fakeQueue();
    const job = await createJob(db, REPO, "fetch_issues");
    await enqueueJob(db, queue, job.id, { delaySeconds: 100_000 });
    expect(queue.send.mock.calls[0][1]).toEqual({ delaySeconds: MAX_MESSAGE_DELAY_SECONDS });
    await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);
  });

  it("queue nothing after a run that changed nothing", async () => {
    const queue = fakeQueue();
    const transform = await runJob(TRANSFORM_JOB_KIND, { db, queue, budget });
    expect(transform).toMatchObject({ state: "succeeded", result: { documents: 0 } });
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual([TRANSFORM_JOB_KIND]); // no embed

    await saveCheckpoint(db, { repository_id: REPO, stream: "issues", cursor: null, last_item_at: "2026-01-01T00:00:00Z", head_done_at: "2026-01-01T00:00:00Z", backfill_done_at: "2026-01-01T00:00:00Z", last_synced_at: new Date(Date.now() - 7200_000).toISOString() });
    const github = fakeGitHubPages([[FIXTURE_ISSUE]]);
    const sync = await runJob("fetch_issues", { db, queue, fetch: github.fetch, budget });
    expect(sync).toMatchObject({ state: "succeeded", result: { phase: "sync", unchanged: 1, inserted: 0, updated: 0 } });
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual([TRANSFORM_JOB_KIND, "fetch_issues"]); // no transform after the sync
  });

  it("defer the schedulers while less than a fifth of the day's queue budget remains", async () => {
    await budget.settle("queue_ops", 85 - (await budget.summary()).find((b) => b.resource === "queue_ops")!.used);
    const queue = fakeQueue();
    expect(await scheduleSyncs(db, queue, { budget, repositoryId: REPO, intervalSeconds: 0 })).toEqual({ due: 0, queued: [], deferred: true });
    expect(queue.send).not.toHaveBeenCalled();
    await budget.settle("queue_ops", -10);
    const resumed = await scheduleSyncs(db, queue, { budget, repositoryId: REPO, intervalSeconds: 0 });
    expect(resumed.deferred).toBeUndefined();
    expect(resumed.queued.map((q) => q.stream)).toEqual(["issues"]);
    await db.from("jobs").update({ state: "cancelled" }).eq("id", resumed.queued[0].job_id);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("search during a pause", () => {
  it("says when semantic search resumes and keeps the keyword results", async () => {
    await exhaustBudget(budget, "ai_neurons_milli");
    const repository = (await getRepository(db, REPO))!;
    const response = await search({ db, embeddings: new FakeEmbeddingClient(), budget }, { repository, query: "zebras" });
    expect(response).toMatchObject({ mode: "keyword", confidence: "low", semantic_error: "budget_exhausted" });
    expect(response.message).toMatch(/^Semantic search is paused until \d{4}-\d{2}-\d{2}T00:00:00\+00:00 \(inference budget reached\)\. Showing passages that contain your search words/);
    expect(response.results.map((r) => r.excerpt)).toEqual([TEXTS[0]]);
    const nothing = await search({ db, embeddings: new FakeEmbeddingClient(), budget }, { repository, query: "giraffes" });
    expect(nothing.message).toMatch(/^Semantic search is paused until .* and no passage contains your search words\.$/);
    await budget.settle("ai_neurons_milli", -8_000_000);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("admissions", () => {
  it("close at the storage warning and at the repository cap", async () => {
    expect(await admissionState(db, budget)).toEqual({ open: true, reason: null });
    await budget.gauge("storage_bytes", 320_000_000);
    expect((await admissionState(db, budget)).reason).toMatch(/^Storage is at 80% of its budget/);
    await budget.gauge("storage_bytes", 0);
    expect((await admissionState(db, budget, { maxRepositories: 1 })).reason).toMatch(/maximum of 1 repositories/);
    expect(await admissionState(db, budget, { maxRepositories: 100_000 })).toEqual({ open: true, reason: null });
  });

  it("refuse a new repository with 503 while closed, but serve a resubmission", async () => {
    await budget.gauge("storage_bytes", 320_000_000);
    const realFetch = globalThis.fetch;
    const github = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(200, repoFixture({ id: REPO, full_name: "alice/pause" })));
    vi.stubGlobal("fetch", (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(href).hostname === "api.github.com" ? github(input, init) : realFetch(input, init);
    });
    try {
      const post = (url: string) =>
        worker.fetch(new Request("http://localhost/api/repositories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }), scopedEnv, fakeExecutionContext());
      const refused = await post("https://github.com/alice/nobody");
      expect(refused.status).toBe(503);
      expect(refused.headers.get("Retry-After")).toBe("3600");
      expect((await refused.json()) as ApiError).toMatchObject({ error: "admissions_paused" });
      expect(github).not.toHaveBeenCalled();

      const again = await post("https://github.com/alice/pause");
      expect(again.status).toBe(200);
      expect(github).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await budget.gauge("storage_bytes", 0);
    }
  });

  it("appear in the service status", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/status"), scopedEnv, fakeExecutionContext());
    expect(((await res.json()) as ServiceStatus).admissions).toEqual({ open: true, reason: null });
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("coverage caps", () => {
  it("stop a stream at the cap, count it complete and capped, and warn in search", async () => {
    await db.from("stream_checkpoints").delete().eq("repository_id", REPO).eq("stream", "issues");
    const github = fakeGitHubPages([[issue(11), issue(12), issue(13)], [issue(14), issue(15), issue(16)], [issue(17), issue(18), issue(19)]]);
    const repository = (await getRepository(db, REPO))!;
    const job = await createJob(db, REPO, "fetch_issues");
    const head = await extractStream({ db, fetch: github.fetch, maxItemsPerStream: 5 }, ISSUES_STREAM, repository, job.id);
    expect(head).toMatchObject({ done: true, phase: "head", capped: true, pages: 2, records: 6, followUpKind: null });
    expect(github.requests).toHaveLength(2);
    const checkpoint = (await getCheckpoint(db, REPO, "issues"))!;
    expect(checkpoint).toMatchObject({ cursor: null, capped_at: expect.any(String), backfill_done_at: expect.any(String), head_done_at: expect.any(String), items_fetched: 6 });

    const coverage = await getCoverage(db, repository);
    expect(coverage.streams.find((s) => s.stream === "issues")).toMatchObject({ phase: "complete", complete: true, capped: true });
    expect(coverage.completed_source_types).toContain("issue");

    const response = await search({ db, embeddings: new FakeEmbeddingClient(), budget }, { repository, query: "zebras" });
    expect(response.index.capped_streams).toEqual(["issues"]);
    expect(response.index.warning).toMatch(/Coverage is capped at 5,000 items per stream \(issues\); older discussions are not indexed\.$/);

    // Syncs are never capped: they read only what changed.
    const sync = await extractStream({ db, fetch: fakeGitHubPages([[issue(20)]]).fetch, maxItemsPerStream: 5 }, ISSUES_STREAM, repository, job.id);
    expect(sync).toMatchObject({ done: true, phase: "sync", records: 1 });
    expect(sync.capped).toBeUndefined();
    await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);
  });
});
