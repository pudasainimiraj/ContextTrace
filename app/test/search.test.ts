import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import { createJob } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { belongsToRepository, searchSemantic } from "../worker/search.ts";
import { insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme. Two
// repositories hold the same texts so cross-repository leakage would show up.
const REPO_A = Date.now() * 100 + 85;
const REPO_B = REPO_A + 1;
const db = createDb(env);

const TEXTS = [
  "How do I limit the concurrency of async functions?",
  "The scheduler drifted after the daylight saving change.",
  "Rename the variable for clarity.",
  "A recipe for sourdough bread with a long cold proof.",
];

async function seed(repositoryId: number, name: string): Promise<void> {
  await upsertRepository(db, repoFixture({ id: repositoryId, full_name: name }));
  await insertPassages(db, repositoryId, TEXTS.map((text) => ({ text })));
  const job = await createJob(db, repositoryId, EMBED_JOB_KIND);
  const result = await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, repositoryId, job.id);
  expect(result.inserted).toBe(TEXTS.length);
}

beforeAll(async () => {
  await seed(REPO_A, "alice/search-a");
  await seed(REPO_B, "alice/search-b");
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [REPO_A, REPO_B]);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("searchSemantic", () => {
  it("returns the nearest passages by cosine similarity, the identical text first", async () => {
    const matches = await searchSemantic(db, REPO_A, fakeVector(TEXTS[1]), 3);
    expect(matches).toHaveLength(3);
    expect(matches[0]).toMatchObject({ passage_id: `github:${REPO_A}:issue:1:body:1`, document_id: `github:${REPO_A}:issue:1` });
    expect(matches[0].score).toBeCloseTo(1, 4);
    expect(matches.map((m) => m.score)).toEqual([...matches.map((m) => m.score)].sort((a, b) => b - a));
    expect(matches[1].score).toBeLessThan(matches[0].score);
  });

  it("clamps the limit and returns nothing for a repository without vectors", async () => {
    expect(await searchSemantic(db, REPO_A, fakeVector(TEXTS[0]), 50)).toHaveLength(TEXTS.length);
    expect(await searchSemantic(db, REPO_A, fakeVector(TEXTS[0]), 0)).toHaveLength(1);
    expect(await searchSemantic(db, REPO_A + 7, fakeVector(TEXTS[0]))).toEqual([]);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("repository isolation", () => {
  it("never returns another repository's passages, even for identical texts", async () => {
    for (const [mine, other] of [
      [REPO_A, REPO_B],
      [REPO_B, REPO_A],
    ]) {
      for (const text of TEXTS) {
        const matches = await searchSemantic(db, mine, fakeVector(text), 10);
        expect(matches).toHaveLength(TEXTS.length);
        expect(matches.every((m) => m.passage_id.startsWith(`github:${mine}:`))).toBe(true);
        expect(matches.every((m) => belongsToRepository(m.document_id, mine))).toBe(true);
        expect(matches.some((m) => m.passage_id.includes(`github:${other}:`))).toBe(false);
      }
    }
  });

  it("scores the same text identically in both repositories, so isolation is not a ranking artefact", async () => {
    const [a] = await searchSemantic(db, REPO_A, fakeVector(TEXTS[3]), 1);
    const [b] = await searchSemantic(db, REPO_B, fakeVector(TEXTS[3]), 1);
    expect(a.passage_id).toBe(`github:${REPO_A}:issue:1:body:3`);
    expect(b.passage_id).toBe(`github:${REPO_B}:issue:1:body:3`);
    expect(a.score).toBeCloseTo(b.score, 5);
  });

  it("rejects an invalid repository id before querying", async () => {
    await expect(searchSemantic(db, 0, fakeVector(TEXTS[0]))).rejects.toThrow(/invalid repository id/);
    await expect(searchSemantic(db, Number.NaN, fakeVector(TEXTS[0]))).rejects.toThrow(/invalid repository id/);
    expect(belongsToRepository(`github:${REPO_A}:issue:1`, REPO_A)).toBe(true);
    expect(belongsToRepository(`github:${REPO_A}1:issue:1`, REPO_A)).toBe(false);
  });
});
