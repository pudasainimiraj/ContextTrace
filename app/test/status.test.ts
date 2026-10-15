import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryRecord } from "../shared/api.ts";
import { saveCheckpoint } from "../worker/checkpoints.ts";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient } from "../worker/embeddings.ts";
import { createJob } from "../worker/jobs.ts";
import { createDb, getRepository, refreshRepositoryStatus, upsertRepository } from "../worker/repositories.ts";
import { search } from "../worker/search.ts";
import { TRANSFORM_VERSION } from "../worker/transform.ts";
import { insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO = Date.now() * 100 + 5;
const db = createDb(env);
const STREAMS = ["issues", "issue_comments", "review_comments"];

// Sorted by token count the embed job takes body:2 (shortest) and body:0 first, body:1 last.
const TEXTS = [
  "Limit the concurrency of async functions.",
  "The scheduler drifted after the daylight saving change.",
  "Rename the variable for clarity.",
];

async function status(): Promise<RepositoryRecord> {
  return (await getRepository(db, REPO))!;
}

async function searchFor(query: string) {
  return search({ db, embeddings: new FakeEmbeddingClient() }, { repository: await status(), query });
}

async function embed(batchSize: number, maxBatches: number) {
  const job = await createJob(db, REPO, EMBED_JOB_KIND);
  return embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, job.id, { batchSize, maxBatches });
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/status" }));
  await insertPassages(db, REPO, TEXTS.map((text) => ({ text })));
  // The fixture thread must look transformed by the current version, or it stays dirty.
  const { error } = await db
    .from("documents")
    .update({ transform_version: TRANSFORM_VERSION, sources_fetched_at: new Date().toISOString() })
    .eq("repository_id", REPO);
  if (error) throw new Error(error.message);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("repository status", () => {
  it("stays registered until a vector exists, and search says nothing is searchable", async () => {
    expect(await refreshRepositoryStatus(db, REPO, TRANSFORM_VERSION)).toBe("registered");
    expect(await status()).toMatchObject({ status: "registered", last_error: null });
    const response = await searchFor(TEXTS[0]);
    expect(response.index).toMatchObject({ status: "registered", partial: true, embedded: 0, pending: 3 });
    expect(response.index.warning).toMatch(/nothing from this repository is searchable yet/);
  });

  it("becomes searchable_partial after the first stored batch, and search works with a partial warning", async () => {
    const before = (await status()).status_changed_at;
    const result = await embed(2, 1);
    expect(result).toMatchObject({ done: false, batches: 1, inserted: 2 });
    const repo = await status();
    expect(repo.status).toBe("searchable_partial");
    expect(Date.parse(repo.status_changed_at)).toBeGreaterThan(Date.parse(before));

    const response = await searchFor(TEXTS[0]);
    expect(response).toMatchObject({ mode: "semantic", confidence: "high" });
    expect(response.results[0].passage_id).toBe(`github:${REPO}:issue:1:body:0`);
    expect(response.index).toMatchObject({ status: "searchable_partial", partial: true, embedded: 2, pending: 1 });
    expect(response.index.warning).toBe(
      "Partial index: 2 of 3 passages are searchable while extraction and indexing continue; older discussions may be missing.",
    );

    const res = await exports.default.fetch(`http://localhost/api/repositories/${REPO}`);
    expect(((await res.json()) as RepositoryRecord).status).toBe("searchable_partial");
  });

  it("stays partial while a stream is still listing, then becomes searchable once nothing is pending", async () => {
    expect(await embed(2, 1)).toMatchObject({ done: true, inserted: 1 });
    expect((await status()).status).toBe("searchable_partial"); // no stream has completed its listing

    const done = new Date().toISOString();
    for (const stream of STREAMS.slice(0, 2)) {
      await saveCheckpoint(db, { repository_id: REPO, stream, cursor: null, head_done_at: done, backfill_done_at: done });
    }
    await saveCheckpoint(db, { repository_id: REPO, stream: STREAMS[2], cursor: "https://api.github.com/page=2", head_done_at: done, backfill_done_at: null });
    expect(await refreshRepositoryStatus(db, REPO, TRANSFORM_VERSION)).toBe("searchable_partial");

    await saveCheckpoint(db, { repository_id: REPO, stream: STREAMS[2], cursor: null, backfill_done_at: done });
    expect(await refreshRepositoryStatus(db, REPO, TRANSFORM_VERSION)).toBe("searchable");
    const response = await searchFor(TEXTS[1]);
    expect(response.index).toEqual({ status: "searchable", partial: false, embedded: 3, pending: 0, capped_streams: [], warning: null });
  });

  it("keeps searchable when a later sync adds passages that still wait for a vector", async () => {
    await insertPassages(db, REPO, [{ text: "A new comment arrived in a sync." }], TEXTS.length);
    expect(await refreshRepositoryStatus(db, REPO, TRANSFORM_VERSION)).toBe("searchable");
    const response = await searchFor(TEXTS[1]);
    expect(response.index).toMatchObject({ status: "searchable", partial: false, embedded: 3, pending: 1, warning: null });
  });

  it("keeps inaccessible, and search warns that results may be stale", async () => {
    await db.from("repositories").update({ status: "inaccessible", last_error: "Not Found" }).eq("id", REPO);
    expect(await refreshRepositoryStatus(db, REPO, TRANSFORM_VERSION)).toBe("inaccessible");
    const response = await searchFor(TEXTS[1]);
    expect(response).toMatchObject({ mode: "semantic", confidence: "high" });
    expect(response.index).toMatchObject({ status: "inaccessible", partial: true });
    expect(response.index.warning).toMatch(/no longer accessible/);
  });

  it("rejects a status outside the known set", async () => {
    const { error } = await db.from("repositories").update({ status: "indexed" }).eq("id", REPO);
    expect(error?.code).toBe("23514");
  });
});
