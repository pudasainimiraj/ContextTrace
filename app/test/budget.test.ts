import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiError, ServiceStatus } from "../shared/api.ts";
import { type Budget, milliNeuronsFor, QUERY_RESERVE_MILLI_NEURONS, QUEUE_OPS_PER_MESSAGE } from "../worker/budget.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { EMBED_JOB_KIND, embedPassages, pendingPassages } from "../worker/embed.ts";
import { type EmbeddingClient, FakeEmbeddingClient } from "../worker/embeddings.ts";
import { lookupPublicRepository } from "../worker/github-api.ts";
import { githubGetPage } from "../worker/github-rest.ts";
import worker from "../worker/index.ts";
import { createJob, enqueueJob, getJob, type JobQueue, meteredQueue } from "../worker/jobs.ts";
import { reconcileJobs } from "../worker/reconcile.ts";
import { createDb, getRepository, upsertRepository } from "../worker/repositories.ts";
import { JobError } from "../worker/retry.ts";
import { search } from "../worker/search.ts";
import { dropBudget, fakeExecutionContext, fakeMessage, insertPassages, jsonResponse, repoFixture, seedBudget } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme. The ledger
// rows live under this file's own scope, so the global budgets are never touched.
const REPO = Date.now() * 100 + 7;
const SCOPE = `test-${REPO}`;
const db = createDb(env);
const TEXTS = ["Short one.", "A somewhat longer second passage about queues.", "The third passage is the longest of the three by a clear margin."];
const scopedEnv = { ...env, BUDGET_SCOPE: SCOPE };
let budget: Budget;

/** Next UTC boundary of the given unit after now. */
function nextBoundary(unit: "hour" | "day"): number {
  const d = new Date();
  return unit === "hour"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

async function usedOf(resource: string): Promise<number> {
  return (await budget.summary()).find((b) => b.resource === resource)!.used;
}

/** Fills a resource up to its limit. */
async function exhaust(resource: Parameters<Budget["settle"]>[0]): Promise<void> {
  const state = (await budget.summary()).find((b) => b.resource === resource)!;
  await budget.settle(resource, state.limit - state.used);
}

async function resetVectors(): Promise<void> {
  await db.from("passage_embeddings").delete().eq("repository_id", REPO);
  await db.from("passages").update({ index_state: "pending_index" }).eq("repository_id", REPO);
}

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/budget" }));
  await insertPassages(db, REPO, TEXTS.map((text) => ({ text })));
  budget = await seedBudget(db, SCOPE, { searches: 10, registrations: 10 });
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
  await dropBudget(db, SCOPE);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("reservations", () => {
  it("accumulate within the limit, refuse the one that would cross it, and leave the row unchanged", async () => {
    expect(await budget.reserve("searches", 4)).toMatchObject({ allowed: true, used: 4, limit: 10 });
    expect(await budget.reserve("searches", 6)).toMatchObject({ allowed: true, used: 10, limit: 10 });
    const refused = await budget.reserve("searches", 1);
    expect(refused).toMatchObject({ allowed: false, used: 10, limit: 10 });
    expect(Date.parse(refused.resetsAt!)).toBe(nextBoundary("day"));
    const err = await budget.take("searches", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err as JobError).toMatchObject({ code: "budget_exhausted", transient: true, data: { resource: "searches", used: 10, limit: 10 } });
    expect((err as JobError).retryAfterSeconds).toBeGreaterThanOrEqual(60);
    expect((err as JobError).retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    expect(await usedOf("searches")).toBe(10);
  });

  it("reset a window that has passed and report when the current one ends", async () => {
    await db.from("usage_budgets").update({ window_start: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq("scope", SCOPE).eq("resource", "searches");
    expect((await budget.summary()).find((b) => b.resource === "searches")).toMatchObject({ used: 0, paused: false });
    const fresh = await budget.reserve("searches", 1);
    expect(fresh).toMatchObject({ allowed: true, used: 1 });
    expect(Date.parse(fresh.resetsAt!)).toBe(nextBoundary("day"));
    const hourly = await budget.reserve("github_requests_anon", 1);
    expect(Date.parse(hourly.resetsAt!)).toBe(nextBoundary("hour"));
  });

  it("settle up and down, never below zero, and record gauges", async () => {
    expect(await budget.settle("searches", -100)).toBe(0);
    expect(await budget.settle("searches", 5)).toBe(5);
    await budget.gauge("storage_bytes", 123);
    expect((await budget.summary()).find((b) => b.resource === "storage_bytes")).toMatchObject({ used: 123, paused: false, resets_at: null });
    await budget.gauge("storage_bytes", 400_000_000);
    expect((await budget.summary()).find((b) => b.resource === "storage_bytes")).toMatchObject({ paused: true, remaining_pct: 0 });
    expect((await budget.summary()).map((b) => b.resource)).toEqual([
      "ai_neurons_milli", "db_egress_bytes", "github_requests_anon", "github_requests_auth", "queue_ops", "registrations", "searches", "storage_bytes",
    ]);
    await budget.gauge("storage_bytes", 0);
  });

  it("let exactly the limit through under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => budget.reserve("registrations", 1)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await usedOf("registrations")).toBe(10);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("metered calls", () => {
  it("reserve one GitHub request per page and per lookup, by token presence, before the request", async () => {
    const page = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(200, [], { "X-RateLimit-Remaining": "50" }));
    await githubGetPage("https://api.github.com/repos/alice/budget/issues", { fetch: page, budget });
    expect(await usedOf("github_requests_anon")).toBe(2); // one from the window test above
    await githubGetPage("https://api.github.com/repos/alice/budget/issues", { fetch: page, budget, token: "t" });
    expect(await usedOf("github_requests_auth")).toBe(1);

    await exhaust("github_requests_anon");
    await expect(githubGetPage("https://api.github.com/repos/alice/budget/issues", { fetch: page, budget })).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(page).toHaveBeenCalledTimes(2);

    const lookup = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(200, repoFixture({ id: 1, full_name: "alice/budget" })));
    expect(await lookupPublicRepository({ owner: "alice", name: "budget" }, { fetch: lookup, budget })).toMatchObject({ kind: "budget_exhausted" });
    expect(lookup).not.toHaveBeenCalled();
    expect(await lookupPublicRepository({ owner: "alice", name: "budget" }, { fetch: lookup, budget, token: "t" })).toMatchObject({ kind: "ok" });
    expect(await usedOf("github_requests_auth")).toBe(2);
  });

  it("reserve the embedding estimate per batch and settle to the metered token count", async () => {
    const pending = await pendingPassages(db, REPO, 10);
    const sorted = [...pending].sort((a, b) => a.token_count - b.token_count);
    const estimate = milliNeuronsFor(2 * Math.max(sorted[0].token_count, sorted[1].token_count)) + milliNeuronsFor(sorted[2].token_count);
    const job = await createJob(db, REPO, EMBED_JOB_KIND);
    expect(await embedPassages({ db, embeddings: new FakeEmbeddingClient(), budget }, REPO, job.id, { batchSize: 2 })).toMatchObject({ inserted: 3, batches: 2 });
    expect(await usedOf("ai_neurons_milli")).toBe(estimate);

    // A client that reports Workers AI's own count settles each batch to it.
    await resetVectors();
    const fake = new FakeEmbeddingClient();
    const metered: EmbeddingClient = { embed: async (texts) => ({ ...(await fake.embed(texts)), tokens: 7 }) };
    expect(await embedPassages({ db, embeddings: metered, budget }, REPO, job.id, { batchSize: 2 })).toMatchObject({ batches: 2, billedTokens: 14 });
    expect(await usedOf("ai_neurons_milli")).toBe(estimate + 2 * milliNeuronsFor(7));
  });

  it("park the embed job until the window resets when the inference budget is spent, storing nothing", async () => {
    await resetVectors();
    await exhaust("ai_neurons_milli");
    const queue = fakeQueue();
    const job = await createJob(db, REPO, EMBED_JOB_KIND);
    const sent = (await enqueueJob(db, queue, job.id))!;
    await consumeJobMessage({ db, queue, embeddings: new FakeEmbeddingClient(), budget }, fakeMessage({ jobId: job.id, repoId: REPO, kind: EMBED_JOB_KIND, generation: sent.generation }), "w");
    const parked = (await getJob(db, job.id))!;
    expect(parked).toMatchObject({ state: "retry_pending", error_code: "budget_exhausted" });
    expect(Math.abs(Date.parse(parked.next_attempt_at!) - nextBoundary("day"))).toBeLessThan(90_000);
    expect(queue.send.mock.calls.at(-1)?.[1]?.delaySeconds).toBeGreaterThanOrEqual(60);
    const { count } = await db.from("passage_embeddings").select("*", { count: "exact", head: true }).eq("repository_id", REPO);
    expect(count).toBe(0);
    await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);
  });

  it("keep a job queued without a message when the queue budget is spent; the cron sends it once there is room", async () => {
    const raw = fakeQueue();
    const queue = meteredQueue(raw, budget);
    await exhaust("queue_ops");
    const job = await createJob(db, REPO, "fetch_issues");
    const kept = await enqueueJob(db, queue, job.id);
    expect(kept).toMatchObject({ id: job.id, state: "queued", generation: 1 });
    expect(raw.send).not.toHaveBeenCalled();

    await budget.settle("queue_ops", -QUEUE_OPS_PER_MESSAGE);
    const reconciled = await reconcileJobs(db, queue, { repositoryId: REPO, graceSeconds: 0 });
    expect(reconciled.requeued).toContain(job.id);
    expect(raw.send).toHaveBeenCalledTimes(1);
    expect((await getJob(db, job.id))?.generation).toBe(2);
    expect(await usedOf("queue_ops")).toBe(8000);
    await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);
  });

  it("reserve the query embedding for a search and fall back to keywords when it is refused", async () => {
    await budget.settle("ai_neurons_milli", -QUERY_RESERVE_MILLI_NEURONS);
    const before = await usedOf("ai_neurons_milli");
    const repository = (await getRepository(db, REPO))!;
    const served = await search({ db, embeddings: new FakeEmbeddingClient(), budget }, { repository, query: "queues" });
    expect(served.semantic_error).toBeNull();
    expect(await usedOf("ai_neurons_milli")).toBe(before + QUERY_RESERVE_MILLI_NEURONS);

    const refused = await search({ db, embeddings: new FakeEmbeddingClient(), budget }, { repository, query: "queues" });
    expect(refused).toMatchObject({ mode: "keyword", semantic_error: "budget_exhausted" });
    expect(refused.results.map((r) => r.excerpt)).toEqual([TEXTS[1]]);
    expect(refused.message).toMatch(/unavailable \(budget_exhausted\)/);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("service status and admission", () => {
  it("reports every budget and the pause state, without secrets", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/status"), scopedEnv, fakeExecutionContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServiceStatus;
    expect(body.budgets).toHaveLength(8);
    expect(body.paused).toBe(true);
    expect(body.reasons.join(" ")).toMatch(/ai_neurons_milli: 8000000 of 8000000 used, resets at/);
    const text = JSON.stringify(body);
    for (const secret of [env.SUPABASE_SECRET_KEY, env.WORKERS_AI_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, env.ADMIN_TOKEN]) {
      if (secret) expect(text).not.toContain(secret);
    }
  });

  it("refuses searches and registrations with 429 and Retry-After once their day's budget is spent", async () => {
    await exhaust("searches");
    const refused = await worker.fetch(
      new Request("http://localhost/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId: REPO, query: "queues" }) }),
      scopedEnv,
      fakeExecutionContext(),
    );
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThanOrEqual(60);
    expect(((await refused.json()) as ApiError).error).toBe("budget_exhausted");

    await exhaust("registrations");
    // Only api.github.com is stubbed; Supabase traffic keeps flowing.
    const realFetch = globalThis.fetch;
    const github = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(href).hostname === "api.github.com" ? github(input, init) : realFetch(input, init);
    });
    try {
      const denied = await worker.fetch(
        new Request("http://localhost/api/repositories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://github.com/alice/budget" }) }),
        scopedEnv,
        fakeExecutionContext(),
      );
      expect(denied.status).toBe(429);
      expect(github).not.toHaveBeenCalled(); // refused before any GitHub request
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
