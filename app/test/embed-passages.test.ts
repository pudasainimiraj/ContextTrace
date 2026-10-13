import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmbeddingStats } from "../shared/api.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { EMBED_JOB_KIND, embedPassages, pendingPassages } from "../worker/embed.ts";
import {
  createEmbeddingClient,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EMBEDDING_POOLING,
  FakeEmbeddingClient,
  fakeVector,
} from "../worker/embeddings.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../worker/jobs.ts";
import { contentHash } from "../worker/passages.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { JobError } from "../worker/retry.ts";
import { countModelTokens } from "../worker/tokenizer.ts";
import { TRANSFORM_JOB_KIND } from "../worker/transform.ts";
import { fakeMessage, insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 65;
const db = createDb(env);
let fixtureJobId = 0;

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

async function stored(passageId: string) {
  const { data } = await db.from("passage_embeddings").select("*").eq("passage_id", passageId).maybeSingle();
  return data as Record<string, unknown> | null;
}

async function usageRows() {
  const { data } = await db.from("embedding_usage").select("*").eq("repository_id", REPO_ID).order("id");
  return (data ?? []) as Record<string, number | string>[];
}

async function queuedEmbedJobs(): Promise<number> {
  const { count } = await db.from("jobs").select("*", { count: "exact", head: true }).eq("repository_id", REPO_ID).eq("kind", EMBED_JOB_KIND).eq("state", "queued");
  return count ?? 0;
}

/** Creates, enqueues and consumes one job of `kind` with the given context extras. */
async function runJob(kind: string, extras: { embeddings?: FakeEmbeddingClient; run?: () => Promise<{ done: boolean }> }, queue = fakeQueue()) {
  const job = await createJob(db, REPO_ID, kind);
  const sent = (await enqueueJob(db, queue, job.id))!;
  const message = fakeMessage({ jobId: job.id, repoId: REPO_ID, kind, generation: sent.generation });
  await consumeJobMessage({ db, queue, ...extras }, message, "worker-a");
  return { job: (await getJob(db, job.id))!, message, queue };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/embed" }));
  // A real job id for embedded_by_job; cancelled so it never counts as a queued embed job.
  const job = await createJob(db, REPO_ID, EMBED_JOB_KIND);
  await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);
  fixtureJobId = job.id;
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("embedPassages", () => {
  const items = [10, 20, 30, 40, 50, 60, 70].map((n) => ({ text: `passage with ${n} tokens`, tokenCount: n }));

  it("embeds pending passages by length, batch by batch, and pages across runs", async () => {
    const rows = await insertPassages(db, REPO_ID, items);
    const fake = new FakeEmbeddingClient();
    const ctx = { db, embeddings: fake };

    const first = await embedPassages(ctx, REPO_ID, fixtureJobId, { batchSize: 3, maxBatches: 2 });
    expect(first).toMatchObject({ done: false, batches: 2, texts: 6, tokens: 210, billedTokens: 270, inserted: 6, updated: 0, invalid: 0, oversized: 0, empty: 0 });
    expect(fake.calls.map((c) => c.length)).toEqual([3, 3]);
    expect(fake.calls[0]).toEqual(rows.slice(0, 3).map((r) => r.text));

    const second = await embedPassages(ctx, REPO_ID, fixtureJobId, { batchSize: 3, maxBatches: 2 });
    expect(second).toMatchObject({ done: true, batches: 1, texts: 1, inserted: 1 });

    const row = (await stored(rows[0].passage_id))!;
    expect(row).toMatchObject({ model: EMBEDDING_MODEL, pooling: EMBEDDING_POOLING, dims: EMBEDDING_DIMS, content_hash: rows[0].content_hash, token_count: 10, embedded_by_job: fixtureJobId });
    const vector = JSON.parse(row.embedding as string) as number[];
    expect(vector).toHaveLength(EMBEDDING_DIMS);
    expect(vector[0]).toBeCloseTo(fakeVector(rows[0].text)[0], 5);
  });

  it("writes one embedding_usage row per run with tokens, billed tokens and neurons", async () => {
    const usage = await usageRows();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ job_id: fixtureJobId, model: EMBEDDING_MODEL, batches: 2, texts: 6, tokens: 210, billed_tokens: 270 });
    expect(Number(usage[0].neurons_estimated)).toBeCloseTo((270 * 1841) / 1e6, 3);
    expect(Number(usage[0].duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("embeds nothing on a re-run when every passage is current", async () => {
    const fake = new FakeEmbeddingClient();
    expect(await embedPassages({ db, embeddings: fake }, REPO_ID, fixtureJobId)).toMatchObject({ done: true, batches: 0, texts: 0, inserted: 0, updated: 0 });
    expect(fake.calls).toEqual([]);
    expect(await usageRows()).toHaveLength(2);
  });

  it("re-embeds a passage whose content_hash changed and counts it as updated", async () => {
    const passageId = `github:${REPO_ID}:issue:1:body:2`;
    const hash = await contentHash("changed text");
    await db.from("passages").update({ text: "changed text", content_hash: hash }).eq("passage_id", passageId);
    const result = await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO_ID, fixtureJobId);
    expect(result).toMatchObject({ texts: 1, inserted: 0, updated: 1 });
    expect((await stored(passageId))?.content_hash).toBe(hash);
  });

  it("skips oversized and empty passages without calling the model", async () => {
    await insertPassages(db, REPO_ID, [{ text: "x".repeat(10), tokenCount: 600 }, { text: "   ", tokenCount: 2 }], 7);
    const fake = new FakeEmbeddingClient();
    const result = await embedPassages({ db, embeddings: fake }, REPO_ID, fixtureJobId);
    expect(result).toMatchObject({ done: true, oversized: 1, empty: 1, texts: 0, batches: 0 });
    expect(fake.calls).toEqual([]);
  });

  it("fails only the passage whose vector is invalid and stores the rest", async () => {
    const rows = await insertPassages(db, REPO_ID, [{ text: "valid A" }, { text: "nan B" }, { text: "short C" }], 9);
    const fake = new FakeEmbeddingClient({
      vectorFor: (text) => (text === "nan B" ? [Number.NaN] : text === "short C" ? fakeVector(text).slice(0, 383) : undefined),
    });
    const result = await embedPassages({ db, embeddings: fake }, REPO_ID, fixtureJobId);
    expect(result).toMatchObject({ texts: 3, invalid: 2, inserted: 1, oversized: 1, empty: 1 });
    const pending = (await pendingPassages(db, REPO_ID, 100)).map((p) => p.passage_id);
    expect(pending).toContain(rows[1].passage_id);
    expect(pending).toContain(rows[2].passage_id);
    expect(pending).not.toContain(rows[0].passage_id);
  });

  it("the table rejects any other model, pooling or dimension at the SQL level", async () => {
    const base = {
      passage_id: `github:${REPO_ID}:issue:1:body:7`,
      repository_id: REPO_ID,
      model: EMBEDDING_MODEL,
      pooling: EMBEDDING_POOLING,
      dims: EMBEDDING_DIMS,
      content_hash: await contentHash("x".repeat(10)),
      token_count: 600,
      embedding: JSON.stringify(fakeVector("x")),
    };
    expect((await db.from("passage_embeddings").insert({ ...base, model: "@cf/baai/bge-base-en-v1.5" })).error?.code).toBe("23514");
    expect((await db.from("passage_embeddings").insert({ ...base, pooling: "mean" })).error?.code).toBe("23514");
    expect((await db.from("passage_embeddings").insert({ ...base, embedding: JSON.stringify(fakeVector("x").slice(0, 383)) })).error?.code).toBe("22000");
  });

  it("parks a rate-limited batch as retry_pending with the Retry-After delay and resumes", async () => {
    const rows = await insertPassages(db, REPO_ID, [{ text: "retry me" }, { text: "retry me too" }], 12);
    const limited = new FakeEmbeddingClient({
      fail: (_texts, call) => (call === 0 ? new JobError("ai_rate_limited", "later", { transient: true, retryAfterSeconds: 45 }) : undefined),
    });
    const { job, queue } = await runJob(EMBED_JOB_KIND, { embeddings: limited });
    expect(job).toMatchObject({ state: "retry_pending", error_code: "ai_rate_limited", attempt: 1 });
    expect(queue.send.mock.calls.at(-1)?.[1]?.delaySeconds).toBe(45);
    expect(await stored(rows[0].passage_id)).toBeNull();

    await db.from("jobs").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", job.id);
    const message = fakeMessage({ jobId: job.id, repoId: REPO_ID, kind: EMBED_JOB_KIND, generation: (await getJob(db, job.id))!.generation });
    await consumeJobMessage({ db, queue, embeddings: new FakeEmbeddingClient() }, message, "worker-b");
    const finished = (await getJob(db, job.id))!;
    expect(finished).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(Number(finished.result?.inserted)).toBeGreaterThanOrEqual(2);
    expect((await stored(rows[0].passage_id))?.embedded_by_job).toBe(job.id);
  });

  it("fails fast when credentials are missing", async () => {
    const { job, queue } = await runJob(EMBED_JOB_KIND, {});
    expect(job).toMatchObject({ state: "failed", error_code: "ai_not_configured", attempt: 1 });
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("a finished transform_passages run queues one embed_passages job and does not duplicate it", async () => {
    expect(await queuedEmbedJobs()).toBe(0);
    await runJob(TRANSFORM_JOB_KIND, { run: async () => ({ done: true }) });
    expect(await queuedEmbedJobs()).toBe(1);
    await runJob(TRANSFORM_JOB_KIND, { run: async () => ({ done: true }) });
    expect(await queuedEmbedJobs()).toBe(1);
    const { queue } = await runJob(TRANSFORM_JOB_KIND, { run: async () => ({ done: false }) });
    expect(queue.send.mock.calls.map(([m]) => m.kind)).toEqual([TRANSFORM_JOB_KIND, TRANSFORM_JOB_KIND]);
    expect(await queuedEmbedJobs()).toBe(1);
  });

  it("serves embedding stats over the API", async () => {
    const res = await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID}/embeddings/stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as EmbeddingStats;
    expect(stats).toMatchObject({ repository_id: REPO_ID, model: EMBEDDING_MODEL, pooling: "cls", dims: 384, passages: 14, oversized: 1, empty: 1 });
    expect(stats.embedded + stats.pending + stats.oversized + stats.empty).toBe(stats.passages);
    expect(stats.billed_tokens).toBeGreaterThanOrEqual(stats.tokens);
    expect(stats.usd_estimated).toBeCloseTo((stats.billed_tokens * 0.02) / 1e6, 10);
    expect((await exports.default.fetch(`http://localhost/api/repositories/${REPO_ID + 1}/embeddings/stats`)).status).toBe(404);
  });
});

const LIVE_REPO_ID = Date.now() * 100 + 75;
const liveReady = Boolean(env.SUPABASE_SECRET_KEY && env.CLOUDFLARE_ACCOUNT_ID && env.WORKERS_AI_API_TOKEN);

describe.skipIf(!liveReady)("embed_passages live", () => {
  beforeAll(async () => {
    await upsertRepository(db, repoFixture({ id: LIVE_REPO_ID, full_name: "alice/embed-live" }));
  });
  afterAll(async () => {
    await db.from("repositories").delete().eq("id", LIVE_REPO_ID);
  });

  it("embeds real passages through Workers AI and stores 384-dimension vectors", async () => {
    const sentences = [
      "p-limit runs multiple promise-returning and async functions with limited concurrency.",
      "The scheduler drifted after the daylight saving change, so we moved to ticks.",
      "Issue 12 asks whether the queue can be paused and resumed.",
      "A review comment suggests renaming the variable for clarity.",
      "The translator is lossless for every expression in the corpus.",
    ];
    const rows = await insertPassages(db, LIVE_REPO_ID, sentences.map((text) => ({ text, tokenCount: countModelTokens(text) })));
    const queue = fakeQueue();
    const job = await createJob(db, LIVE_REPO_ID, EMBED_JOB_KIND);
    const sent = (await enqueueJob(db, queue, job.id))!;
    const message = fakeMessage({ jobId: job.id, repoId: LIVE_REPO_ID, kind: EMBED_JOB_KIND, generation: sent.generation });
    await consumeJobMessage({ db, queue, embeddings: createEmbeddingClient(env) }, message, "worker-live");

    const finished = (await getJob(db, job.id))!;
    expect(finished.state).toBe("succeeded");
    expect(finished.result).toMatchObject({ batches: 1, texts: 5, inserted: 5, invalid: 0 });
    expect(Number(finished.result?.billedTokens)).toBeGreaterThanOrEqual(Number(finished.result?.tokens));
    const row = (await stored(rows[0].passage_id))!;
    const vector = JSON.parse(row.embedding as string) as number[];
    expect(vector).toHaveLength(EMBEDDING_DIMS);
    expect(vector.every(Number.isFinite)).toBe(true);

    const again = await embedPassages({ db, embeddings: createEmbeddingClient(env) }, LIVE_REPO_ID, job.id);
    expect(again).toMatchObject({ texts: 0, inserted: 0, updated: 0, done: true });
  });

  it("accepts a full batch of EMBEDDING_BATCH_SIZE texts", async () => {
    const client = createEmbeddingClient(env)!;
    const texts = Array.from({ length: EMBEDDING_BATCH_SIZE }, (_, i) => `short text number ${i}`);
    const { vectors, tokens } = await client.embed(texts);
    expect(vectors).toHaveLength(EMBEDDING_BATCH_SIZE);
    expect(vectors.every((v) => v.length === EMBEDDING_DIMS)).toBe(true);
    console.log(`batch of ${EMBEDDING_BATCH_SIZE} metered at ${tokens} tokens`);
  });
});
