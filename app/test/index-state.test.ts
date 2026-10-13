import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import { createJob } from "../worker/jobs.ts";
import { contentHash } from "../worker/passages.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { searchSemantic } from "../worker/search.ts";
import { JobError } from "../worker/retry.ts";
import { insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 95;
const db = createDb(env);
let jobId = 0;

async function states(): Promise<Record<string, string>> {
  const { data } = await db.from("passages").select("passage_id, index_state").eq("repository_id", REPO_ID).order("passage_id");
  return Object.fromEntries(((data ?? []) as { passage_id: string; index_state: string }[]).map((r) => [r.passage_id, r.index_state]));
}

const TEXTS = ["first passage", "second passage", "third passage", "fourth passage", "fifth passage", "sixth passage"];

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/index-state" }));
  jobId = (await createJob(db, REPO_ID, EMBED_JOB_KIND)).id;
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("two-phase index state", () => {
  it("new passages are pending_index and invisible to search until their vector is stored", async () => {
    const rows = await insertPassages(db, REPO_ID, TEXTS.map((text) => ({ text })));
    expect(Object.values(await states())).toEqual(Array(TEXTS.length).fill("pending_index"));
    expect(await searchSemantic(db, REPO_ID, fakeVector(TEXTS[0]))).toEqual([]);

    // The model fails on the second batch: the first batch is stored and active, the rest stays pending.
    const failing = new FakeEmbeddingClient({
      fail: (_texts, call) => (call === 1 ? new JobError("ai_upstream", "boom", { transient: true }) : undefined),
    });
    await expect(embedPassages({ db, embeddings: failing }, REPO_ID, jobId, { batchSize: 3, maxBatches: 2 })).rejects.toMatchObject({ code: "ai_upstream" });

    const after = await states();
    expect(Object.values(after).filter((s) => s === "active")).toHaveLength(3);
    expect(Object.values(after).filter((s) => s === "pending_index")).toHaveLength(3);
    const hits = await searchSemantic(db, REPO_ID, fakeVector(TEXTS[0]), 10);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => after[h.passage_id] === "active")).toBe(true);
    expect(rows.map((r) => r.passage_id).filter((id) => after[id] === "pending_index").some((id) => hits.find((h) => h.passage_id === id))).toBe(false);
  });

  it("a retried run stores the rest and activates every passage", async () => {
    const result = await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO_ID, jobId);
    expect(result).toMatchObject({ texts: 3, inserted: 3 });
    expect(Object.values(await states())).toEqual(Array(TEXTS.length).fill("active"));
    expect(await searchSemantic(db, REPO_ID, fakeVector(TEXTS[5]), 10)).toHaveLength(TEXTS.length);
  });

  it("a passage whose text changes goes back to pending_index and leaves search until re-embedded", async () => {
    const passageId = `github:${REPO_ID}:issue:1:body:2`;
    await db.from("passages").update({ text: "third passage, edited", content_hash: await contentHash("third passage, edited"), index_state: "pending_index" }).eq("passage_id", passageId);
    const before = await searchSemantic(db, REPO_ID, fakeVector(TEXTS[2]), 10);
    expect(before.map((h) => h.passage_id)).not.toContain(passageId);

    const result = await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO_ID, jobId);
    expect(result).toMatchObject({ texts: 1, updated: 1 });
    expect((await states())[passageId]).toBe("active");
    const after = await searchSemantic(db, REPO_ID, fakeVector("third passage, edited"), 1);
    expect(after[0]).toMatchObject({ passage_id: passageId });
    expect(after[0].score).toBeCloseTo(1, 4);
  });

  it("an invalid vector keeps its passage pending while the batch's other passages activate", async () => {
    const rows = await insertPassages(db, REPO_ID, [{ text: "seventh passage" }, { text: "eighth passage" }], TEXTS.length);
    const fake = new FakeEmbeddingClient({ vectorFor: (text) => (text === "eighth passage" ? [Number.NaN] : undefined) });
    const result = await embedPassages({ db, embeddings: fake }, REPO_ID, jobId);
    expect(result).toMatchObject({ texts: 2, inserted: 1, invalid: 1 });
    const now = await states();
    expect(now[rows[0].passage_id]).toBe("active");
    expect(now[rows[1].passage_id]).toBe("pending_index");
  });
});
