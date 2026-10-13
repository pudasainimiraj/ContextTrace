import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import { EXCERPT_CHARS, excerptOf, resolveEvidence, verifySourceLink } from "../worker/evidence.ts";
import { createJob } from "../worker/jobs.ts";
import { contentHash } from "../worker/passages.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { search, searchSemantic } from "../worker/search.ts";
import { insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO = Date.now() * 100 + 96;
const db = createDb(env);

const LONG = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "); // well over EXCERPT_CHARS
const TEXTS = [
  "How do I limit the concurrency of async functions?",
  `Some **bold** text\n\nwith a second paragraph.\n${LONG}`,
  "The scheduler drifted after the daylight saving change.",
];
const ROGUE = "A passage whose link points somewhere other than GitHub.";
const ROGUE_ID = `github:${REPO}:issue:1:body:9`;

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/evidence" }));
  await insertPassages(db, REPO, TEXTS.map((text) => ({ text })));
  // A passage of the fixture issue whose stored link is not a GitHub permalink.
  const { error } = await db.from("passages").insert({
    passage_id: ROGUE_ID,
    document_id: `github:${REPO}:issue:1`,
    repository_id: REPO,
    source_type: "issue",
    source_github_id: 1,
    chunk_index: 9,
    chunk_count: 10,
    token_count: 12,
    tokenizer: "fixture",
    locator: "Opening body (part 10)",
    author: "ann",
    created_at: "2026-01-01T00:00:00Z",
    source_url: "https://example.com/o/r/issues/1",
    text: ROGUE,
    text_kind: "normalized_markdown",
    content_hash: await contentHash(ROGUE),
    transform_version: "fixture",
  });
  if (error) throw new Error(error.message);
  const job = await createJob(db, REPO, EMBED_JOB_KIND);
  const result = await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, job.id);
  expect(result.inserted).toBe(TEXTS.length + 1);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
});

describe("excerptOf", () => {
  it("flattens whitespace and keeps a short passage whole", () => {
    expect(excerptOf("  a\n\nb\tc  ")).toBe("a b c");
  });

  it("cuts a long passage at a word boundary and marks it", () => {
    const excerpt = excerptOf(TEXTS[1]);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 1);
    const flat = TEXTS[1].replace(/\s+/g, " ");
    const kept = excerpt.slice(0, -1);
    expect(flat.startsWith(kept)).toBe(true);
    expect(flat[kept.length]).toBe(" ");
    expect(excerpt.startsWith("Some **bold** text with a second paragraph. word0 word1")).toBe(true);
  });

  it("hard-cuts a single long word and never splits a surrogate pair", () => {
    expect(excerptOf("x".repeat(500), 20)).toBe(`${"x".repeat(20)}…`);
    const emoji = excerptOf("🙂".repeat(50), 10);
    expect(Array.from(emoji)).toHaveLength(11);
    expect(emoji.endsWith("…")).toBe(true);
  });
});

describe("verifySourceLink", () => {
  const issue = { type: "issue", number: 12, source_type: "issue", source_github_id: 500 } as const;
  const pull = { type: "pull_request", number: 8, source_type: "pull_request", source_github_id: 501 } as const;
  const issueComment = { type: "issue", number: 12, source_type: "issue_comment", source_github_id: 7001 } as const;
  const prComment = { type: "pull_request", number: 8, source_type: "issue_comment", source_github_id: 7002 } as const;
  const review = { type: "pull_request", number: 8, source_type: "review_comment", source_github_id: 9001 } as const;

  it("accepts GitHub permalinks to the unit", () => {
    expect(verifySourceLink("https://github.com/o/r/issues/12", issue)).toBe(true);
    expect(verifySourceLink("https://github.com/o/r/pull/8", pull)).toBe(true);
    expect(verifySourceLink("https://github.com/o/r/issues/12#issuecomment-7001", issueComment)).toBe(true);
    expect(verifySourceLink("https://github.com/o/r/pull/8#issuecomment-7002", prComment)).toBe(true);
    expect(verifySourceLink("https://github.com/o/r/pull/8#discussion_r9001", review)).toBe(true);
  });

  it("rejects links to another thread, another comment, another host or scheme", () => {
    expect(verifySourceLink("https://github.com/o/r/issues/13", issue)).toBe(false);
    expect(verifySourceLink("https://github.com/o/r/pull/12", issue)).toBe(false);
    expect(verifySourceLink("https://github.com/o/r/issues/8", pull)).toBe(false);
    expect(verifySourceLink("https://github.com/o/r/issues/12", issueComment)).toBe(false);
    expect(verifySourceLink("https://github.com/o/r/issues/12#issuecomment-7000", issueComment)).toBe(false);
    expect(verifySourceLink("https://github.com/o/r/pull/8#issuecomment-9001", review)).toBe(false);
    expect(verifySourceLink("https://github.com/o/r/issues/12#issuecomment-1", issue)).toBe(false);
    expect(verifySourceLink("http://github.com/o/r/issues/12", issue)).toBe(false);
    expect(verifySourceLink("https://gist.github.com/o/r/issues/12", issue)).toBe(false);
    expect(verifySourceLink("https://example.com/o/r/issues/12", issue)).toBe(false);
    expect(verifySourceLink("https://github.com/o/issues/12", issue)).toBe(false);
    expect(verifySourceLink("not a url", issue)).toBe(false);
    expect(verifySourceLink("", issue)).toBe(false);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("resolveEvidence", () => {
  it("builds cards in hit order with the thread title, locator, excerpt and permalink", async () => {
    // Fake vectors of different texts are unrelated, so the rogue passage can land anywhere
    // after the identical text; it is left out here and covered by the next test.
    const hits = (await searchSemantic(db, REPO, fakeVector(TEXTS[1]), 4)).filter((h) => h.passage_id !== ROGUE_ID);
    expect(hits).toHaveLength(TEXTS.length);
    const { cards, unverified } = await resolveEvidence(db, REPO, hits);
    expect(unverified).toBe(0);
    expect(cards.map((c) => c.passage_id)).toEqual(hits.map((h) => h.passage_id));
    expect(cards.map((c) => c.score)).toEqual(hits.map((h) => h.score));
    expect(cards[0]).toMatchObject({
      passage_id: `github:${REPO}:issue:1:body:1`,
      document_id: `github:${REPO}:issue:1`,
      type: "issue",
      number: 1,
      title: "Fixture thread",
      source_type: "issue",
      locator: "Opening body (part 2)",
      author: "ann",
      created_at: "2026-01-01T00:00:00+00:00",
      source_url: "https://github.com/o/r/issues/1",
    });
    expect(cards[0].excerpt).toBe(excerptOf(TEXTS[1]));
    expect(cards[0].match).toBe("semantic");
    expect(cards[0]).not.toHaveProperty("text");
    const keyword = await resolveEvidence(db, REPO, hits.slice(0, 1), "keyword");
    expect(keyword.cards[0].match).toBe("keyword");
  });

  it("leaves out a hit whose source link cannot be verified and counts it", async () => {
    const hits = await searchSemantic(db, REPO, fakeVector(ROGUE), 4);
    expect(hits[0].passage_id).toBe(ROGUE_ID);
    const { cards, unverified } = await resolveEvidence(db, REPO, hits);
    expect(unverified).toBe(1);
    expect(cards).toHaveLength(3);
    expect(cards.some((c) => c.passage_id === ROGUE_ID)).toBe(false);

    const response = await search({ db, embeddings: new FakeEmbeddingClient() }, { repositoryId: REPO, query: ROGUE, limit: 4 });
    expect(response).toMatchObject({ mode: "semantic", confidence: "high", message: null, unverified: 1 });
    expect(response.results.map((c) => c.passage_id)).toEqual(cards.map((c) => c.passage_id));
    expect(response.results.every((c) => c.source_url.startsWith("https://github.com/"))).toBe(true);
  });

  it("skips a hit whose passage no longer exists", async () => {
    const [hit] = await searchSemantic(db, REPO, fakeVector(TEXTS[0]), 1);
    const gone = { ...hit, passage_id: `github:${REPO}:issue:1:body:42` };
    const { cards, unverified } = await resolveEvidence(db, REPO, [gone, hit]);
    expect(unverified).toBe(0);
    expect(cards.map((c) => c.passage_id)).toEqual([hit.passage_id]);
    expect(await resolveEvidence(db, REPO, [])).toEqual({ cards: [], unverified: 0 });
  });
});
