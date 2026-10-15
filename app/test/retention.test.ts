import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiError, RepositoryRecord, ServiceStatus } from "../shared/api.ts";
import { admissionState } from "../worker/admission.ts";
import type { Budget } from "../worker/budget.ts";
import { saveCheckpoint } from "../worker/checkpoints.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { getCoverage } from "../worker/coverage.ts";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient } from "../worker/embeddings.ts";
import worker from "../worker/index.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../worker/jobs.ts";
import { INACCESSIBLE_RETENTION_DAYS, maintain, storageState } from "../worker/maintenance.ts";
import { createDb, getRepository, upsertRepository } from "../worker/repositories.ts";
import { search } from "../worker/search.ts";
import { TRANSFORM_JOB_KIND } from "../worker/transform.ts";
import { scheduleRescans, scheduleSyncs } from "../worker/sync.ts";
import { dropBudget, fakeExecutionContext, fakeGitHubPages, fakeMessage, insertPassages, jsonResponse, repoFixture, seedBudget } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme. Three
// repositories: one searchable that must survive every sweep, one unreachable for longer
// than the retention window, one an operator removes and then registers again.
const BASE = Date.now() * 100;
const REPO = BASE + 14;
const REPO_OLD = BASE + 16;
const REPO_GONE = BASE + 17;
const SCOPE = `test-${REPO}`;
const db = createDb(env);
const scopedEnv = { ...env, BUDGET_SCOPE: SCOPE };
type WorkerRequest = Parameters<typeof worker.fetch>[0];
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`http://localhost${path}`, init) as unknown as WorkerRequest, scopedEnv, fakeExecutionContext());
const admin = { "content-type": "application/json", authorization: `Bearer ${env.ADMIN_TOKEN}` };
let budget: Budget;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

async function counts(repositoryId: number) {
  const count = async (table: string) => (await db.from(table).select("*", { count: "exact", head: true }).eq("repository_id", repositoryId)).count ?? 0;
  return { sources: await count("sources"), documents: await count("documents"), passages: await count("passages"), vectors: await count("passage_embeddings"), checkpoints: await count("stream_checkpoints") };
}

async function seed(repositoryId: number, name: string, texts: string[]): Promise<void> {
  await upsertRepository(db, repoFixture({ id: repositoryId, full_name: name }));
  await insertPassages(db, repositoryId, texts.map((text) => ({ text })));
  const job = await createJob(db, repositoryId, EMBED_JOB_KIND);
  await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, repositoryId, job.id);
  await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);
}

/** Moves a job to a final state and backdates when it finished. */
async function finishedJob(repositoryId: number, kind: string, finishedDaysAgo: number): Promise<number> {
  const job = await createJob(db, repositoryId, kind);
  await db.from("jobs").update({ state: "running" }).eq("id", job.id);
  await db.from("jobs").update({ state: "succeeded" }).eq("id", job.id);
  await db.from("jobs").update({ finished_at: daysAgo(finishedDaysAgo) }).eq("id", job.id);
  return job.id;
}

beforeAll(async () => {
  await seed(REPO, "alice/retention", ["A passage that must survive every sweep.", "Another surviving passage about zebras."]);
  for (const stream of ["issues", "issue_comments", "review_comments"]) {
    await saveCheckpoint(db, { repository_id: REPO, stream, cursor: null, head_done_at: daysAgo(1), backfill_done_at: daysAgo(1), last_item_at: daysAgo(1), last_synced_at: daysAgo(1) });
  }
  await db.from("repositories").update({ status: "searchable" }).eq("id", REPO);
  await seed(REPO_OLD, "alice/retention-old", ["An old passage of a repository that vanished."]);
  await db.from("repositories").update({ status: "inaccessible", last_error: "not_found: Not Found", status_changed_at: daysAgo(INACCESSIBLE_RETENTION_DAYS + 1) }).eq("id", REPO_OLD);
  await seed(REPO_GONE, "alice/retention-gone", ["A passage the operator removes."]);
  await saveCheckpoint(db, { repository_id: REPO_GONE, stream: "issues", cursor: null, head_done_at: daysAgo(1), backfill_done_at: daysAgo(1) });
  await createJob(db, REPO_GONE, "fetch_issues"); // left queued
  budget = await seedBudget(db, SCOPE);
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [REPO, REPO_OLD, REPO_GONE]);
  await dropBudget(db, SCOPE);
});
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(!env.SUPABASE_SECRET_KEY)("retention", () => {
  it("purges finished jobs older than the window, keeping the newest per kind, with their transitions", async () => {
    const old1 = await finishedJob(REPO, TRANSFORM_JOB_KIND, 20);
    const old2 = await finishedJob(REPO, TRANSFORM_JOB_KIND, 15);
    const recent = await finishedJob(REPO, TRANSFORM_JOB_KIND, 1);
    const onlyEmbed = await finishedJob(REPO, "rescan_issues", 40); // the newest of its kind, however old
    const transitionsBefore = (await db.from("job_transitions").select("*", { count: "exact", head: true }).eq("job_id", old1)).count ?? 0;
    expect(transitionsBefore).toBeGreaterThan(0);

    const result = await maintain(db, budget, { repositoryId: REPO });
    expect(result.jobs_purged).toBe(2);
    expect(result.repositories_removed).toEqual([]);
    expect(await getJob(db, old1)).toBeNull();
    expect(await getJob(db, old2)).toBeNull();
    expect((await getJob(db, recent))?.state).toBe("succeeded");
    expect((await getJob(db, onlyEmbed))?.state).toBe("succeeded");
    expect((await db.from("job_transitions").select("*", { count: "exact", head: true }).eq("job_id", old1)).count).toBe(0);
    expect(result.storage.level).toBe("ok");
    expect(result.storage.used).toBeGreaterThan(1_000_000); // the gauge was measured
  });

  it("purges old embedding usage rows", async () => {
    const row = { repository_id: REPO, model: "@cf/baai/bge-small-en-v1.5", batches: 1, texts: 1, tokens: 10, billed_tokens: 10, neurons_estimated: 0.0184, duration_ms: 1 };
    const { data } = await db.from("embedding_usage").insert([row, row]).select("id");
    const ids = (data as { id: number }[]).map((r) => r.id);
    await db.from("embedding_usage").update({ created_at: daysAgo(100) }).eq("id", ids[0]);
    const result = await maintain(db, budget, { repositoryId: REPO });
    expect(result.usage_purged).toBe(1);
    expect((await db.from("embedding_usage").select("id").in("id", ids)).data).toEqual([{ id: ids[1] }]);
  });

  it("removes a repository unreachable for longer than the window, keeps a tombstone, and never touches a searchable one", async () => {
    expect(await counts(REPO_OLD)).toMatchObject({ sources: 1, passages: 1, vectors: 1 });
    const result = await maintain(db, budget, { repositoryId: REPO_OLD });
    expect(result.repositories_removed).toEqual([REPO_OLD]);
    expect(await counts(REPO_OLD)).toEqual({ sources: 0, documents: 0, passages: 0, vectors: 0, checkpoints: 0 });
    const tombstone = (await getRepository(db, REPO_OLD))!;
    expect(tombstone.status).toBe("removed");
    expect(tombstone.last_error).toMatch(/removed after 30 days unreachable/);

    const response = await search({ db, embeddings: new FakeEmbeddingClient(), budget }, { repository: tombstone, query: "vanished" });
    expect(response).toMatchObject({ mode: "none", results: [] });
    expect(response.index).toMatchObject({ status: "removed", partial: true });
    expect(response.index.warning).toMatch(/index was removed/);
    expect((await getCoverage(db, tombstone)).status).toBe("removed");

    // Searchable repositories survive every sweep, and a fresh inaccessible one is not due.
    expect((await maintain(db, budget, { repositoryId: REPO })).repositories_removed).toEqual([]);
    expect(await counts(REPO)).toMatchObject({ sources: 1, passages: 2, vectors: 2, checkpoints: 3 });
    await db.from("repositories").update({ status: "inaccessible", status_changed_at: new Date().toISOString() }).eq("id", REPO_GONE);
    expect((await maintain(db, budget, { repositoryId: REPO_GONE })).repositories_removed).toEqual([]);
    await db.from("repositories").update({ status: "searchable" }).eq("id", REPO_GONE);
  });

  it("lets an operator remove a repository through the API, and a resubmission registers it afresh", async () => {
    expect((await call(`/api/repositories/${REPO_GONE}`, { method: "DELETE" })).status).toBe(401);
    expect((await call(`/api/repositories/${REPO_GONE + 50}`, { method: "DELETE", headers: admin })).status).toBe(404);
    const res = await call(`/api/repositories/${REPO_GONE}`, { method: "DELETE", headers: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repository_id: REPO_GONE, status: "removed", removed: { sources: 1, documents: 1, passages: 1, vectors: 1, jobs_cancelled: 1 } });
    expect(await counts(REPO_GONE)).toEqual({ sources: 0, documents: 0, passages: 0, vectors: 0, checkpoints: 0 });
    const { data: open } = await db.from("jobs").select("id").eq("repository_id", REPO_GONE).in("state", ["queued", "retry_pending", "running"]);
    expect(open).toEqual([]);

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.hostname === "api.github.com") return Promise.resolve(jsonResponse(url.pathname === "/repos/alice/retention-gone" ? 200 : 404, url.pathname === "/repos/alice/retention-gone" ? repoFixture({ id: REPO_GONE, full_name: "alice/retention-gone" }) : []));
      return realFetch(input, init);
    });
    const { data: last } = await db.from("jobs").select("id").eq("repository_id", REPO_GONE).order("id", { ascending: false }).limit(1);
    const lastId = (last?.[0] as { id: number } | undefined)?.id ?? 0;
    const again = await call("/api/repositories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://github.com/alice/retention-gone" }) });
    expect(again.status).toBe(200);
    expect((await again.json()) as RepositoryRecord).toMatchObject({ id: REPO_GONE, status: "registered", last_error: null });
    // One head pass per stream was queued; the local queue may already be running them.
    const { count } = await db.from("jobs").select("id", { count: "exact", head: true }).eq("repository_id", REPO_GONE).like("kind", "fetch_%").gt("id", lastId);
    expect(count).toBe(3);
  });

  it("pauses backfills, rescans and admissions at the storage warning, syncs too at critical, and deletes nothing", async () => {
    await budget.gauge("storage_bytes", 320_000_000);
    expect((await storageState(budget)).level).toBe("warning");
    expect((await admissionState(db, budget)).open).toBe(false);
    const queue = fakeQueue();
    expect(await scheduleRescans(db, queue, { budget, repositoryId: REPO, intervalSeconds: 0 })).toEqual({ due: 0, queued: [], deferred: true });

    await saveCheckpoint(db, { repository_id: REPO, stream: "issue_comments", cursor: "https://api.github.com/repos/alice/retention/issues/comments?page=2", backfill_done_at: null });
    const github = fakeGitHubPages([[]]);
    const ctx = { db, queue, fetch: github.fetch, budget };
    const backfill = await createJob(db, REPO, "backfill_issue_comments");
    const sentBackfill = (await enqueueJob(db, queue, backfill.id))!;
    await consumeJobMessage(ctx, fakeMessage({ jobId: backfill.id, repoId: REPO, kind: "backfill_issue_comments", generation: sentBackfill.generation }), "w");
    const parked = (await getJob(db, backfill.id))!;
    expect(parked).toMatchObject({ state: "retry_pending", error_code: "budget_exhausted", attempt: 0 });
    expect(parked.error_message).toMatch(/^Storage is at 80% of its budget; backfilling waits for space/);
    expect(github.requests).toHaveLength(0);

    const sync = await createJob(db, REPO, "fetch_issues");
    const sentSync = (await enqueueJob(db, queue, sync.id))!;
    await consumeJobMessage(ctx, fakeMessage({ jobId: sync.id, repoId: REPO, kind: "fetch_issues", generation: sentSync.generation }), "w");
    expect((await getJob(db, sync.id))?.state).toBe("succeeded"); // syncs still run at the warning level

    await budget.gauge("storage_bytes", 380_000_000);
    expect((await storageState(budget)).level).toBe("critical");
    expect(await scheduleSyncs(db, queue, { budget, repositoryId: REPO, intervalSeconds: 0 })).toEqual({ due: 0, queued: [], deferred: true });
    const sync2 = await createJob(db, REPO, "fetch_issues");
    const sentSync2 = (await enqueueJob(db, queue, sync2.id))!;
    await consumeJobMessage(ctx, fakeMessage({ jobId: sync2.id, repoId: REPO, kind: "fetch_issues", generation: sentSync2.generation }), "w");
    expect((await getJob(db, sync2.id))).toMatchObject({ state: "retry_pending", error_code: "budget_exhausted" });
    const status = (await (await call("/api/status")).json()) as ServiceStatus;
    expect(status.storage).toMatchObject({ level: "critical", used: 380_000_000 });
    expect(status.admissions.open).toBe(false);

    await budget.gauge("storage_bytes", 0);
    expect((await admissionState(db, budget)).open).toBe(true);
    expect(await counts(REPO)).toMatchObject({ sources: 1, passages: 2, vectors: 2 }); // nothing searchable was deleted
    for (const id of [backfill.id, sync2.id]) await db.from("jobs").update({ state: "cancelled" }).eq("id", id);
    const denied = await call(`/api/repositories/${REPO}`, { method: "DELETE", headers: { authorization: "Bearer wrong" } });
    expect(((await denied.json()) as ApiError).error).toBe("forbidden");
  });
});
