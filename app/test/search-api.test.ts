import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, SearchResponse } from "../shared/api.ts";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { EMBEDDING_DIMS, FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import { createJob } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { MAX_QUERY_CHARS, SCORE_HIGH, SCORE_LOW, search } from "../worker/search.ts";
import { insertPassages, jsonResponse, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with Workers AI stubbed; see jobs.test.ts for the
// id scheme. Two repositories hold the same texts so cross-repository leakage would show
// up at the API level; one has a passage without a vector yet; one has nothing extracted.
const BASE = Date.now() * 100;
const REPO = BASE + 97;
const REPO_TWIN = BASE + 98;
const REPO_PENDING = BASE + 99;
const REPO_BARE = BASE + 15;
const db = createDb(env);
const PENDING_TEXT = "Pending passage about zebras, not embedded yet.";

const TEXTS = [
  "How do I limit the concurrency of async functions?",
  "The scheduler drifted after the daylight saving change.",
  "Rename the variable for clarity.",
  "A recipe for sourdough bread with a long cold proof.",
];

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type AiRequest = { text: string[]; pooling: string };

function hrefOf(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

// Stands in for Workers AI: answers with the same deterministic vectors the passages were
// embedded with, unless a test swaps the responder. Every request body is recorded.
const aiCalls: AiRequest[] = [];
const AI_ERROR_MARKER = "SECRET-MARKER-DO-NOT-LEAK";

/** A unit vector whose cosine similarity to fakeVector(text) is exactly `cosine`. */
function vectorNear(text: string, cosine: number): number[] {
  const a = fakeVector(text);
  const b = fakeVector(`${text} (other)`);
  const dot = a.reduce((sum, x, i) => sum + x * b[i], 0);
  const ortho = b.map((x, i) => x - dot * a[i]);
  const norm = Math.hypot(...ortho);
  const sine = Math.sqrt(1 - cosine * cosine);
  return a.map((x, i) => cosine * x + (sine * ortho[i]) / norm);
}

function respondWith(vector: number[]): (texts: string[]) => Response {
  return (texts) =>
    jsonResponse(200, { success: true, result: { shape: [texts.length, EMBEDDING_DIMS], data: texts.map(() => vector), pooling: "cls" } });
}

/** Nothing from the environment or from the model's error text may reach a client. */
function expectNoSecrets(text: string): void {
  for (const secret of [env.WORKERS_AI_API_TOKEN, env.SUPABASE_SECRET_KEY, env.CLOUDFLARE_ACCOUNT_ID, AI_ERROR_MARKER]) {
    expect(secret).toBeTruthy();
    expect(text).not.toContain(secret);
  }
}
function vectorsFor(texts: string[]): Response {
  return jsonResponse(200, {
    success: true,
    errors: [],
    result: { shape: [texts.length, EMBEDDING_DIMS], data: texts.map((t) => fakeVector(t)), pooling: "cls" },
  });
}
let aiRespond: (texts: string[]) => Response = vectorsFor;

const realFetch = globalThis.fetch;
async function routedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  if (new URL(hrefOf(input)).hostname !== "api.cloudflare.com") return realFetch(input, init);
  const body = JSON.parse(String(init?.body)) as AiRequest;
  aiCalls.push(body);
  return aiRespond(body.text);
}

async function seed(repositoryId: number, name: string): Promise<void> {
  await upsertRepository(db, repoFixture({ id: repositoryId, full_name: name }));
  await insertPassages(db, repositoryId, TEXTS.map((text) => ({ text })));
  const job = await createJob(db, repositoryId, EMBED_JOB_KIND);
  const result = await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, repositoryId, job.id);
  expect(result.inserted).toBe(TEXTS.length);
}

beforeAll(async () => {
  await seed(REPO, "alice/search-api");
  await seed(REPO_TWIN, "alice/search-api-twin");
  await upsertRepository(db, repoFixture({ id: REPO_PENDING, full_name: "alice/search-api-pending" }));
  await insertPassages(db, REPO_PENDING, [{ text: PENDING_TEXT }]);
  await upsertRepository(db, repoFixture({ id: REPO_BARE, full_name: "alice/search-api-bare" }));
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [REPO, REPO_TWIN, REPO_PENDING, REPO_BARE]);
});
beforeEach(() => {
  aiCalls.length = 0;
  aiRespond = vectorsFor;
  vi.stubGlobal("fetch", routedFetch);
});
afterEach(() => vi.unstubAllGlobals());

function post(body: unknown, rawBody?: string): Promise<Response> {
  return exports.default.fetch("http://localhost/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
}

describe.skipIf(!env.SUPABASE_SECRET_KEY || !env.CLOUDFLARE_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN)("POST /api/search", () => {
  it("embeds the query on the server and returns the repository's nearest passages", async () => {
    const res = await post({ repositoryId: REPO, query: ` ${TEXTS[1]} ` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body).toMatchObject({
      repository_id: REPO,
      query: TEXTS[1],
      limit: 5,
      mode: "semantic",
      confidence: "high",
      message: null,
      semantic_error: null,
      index: { embedded: TEXTS.length, pending: 0 },
      unverified: 0,
    });
    expect(body.embed_ms).toBeGreaterThanOrEqual(0);
    expect(body.results).toHaveLength(TEXTS.length);
    expect(body.results[0]).toMatchObject({
      passage_id: `github:${REPO}:issue:1:body:1`,
      document_id: `github:${REPO}:issue:1`,
      type: "issue",
      number: 1,
      title: "Fixture thread",
      source_type: "issue",
      locator: "Opening body (part 2)",
      author: "ann",
      source_url: "https://github.com/o/r/issues/1",
      excerpt: TEXTS[1],
      match: "semantic",
    });
    expect(body.results[0].score).toBeCloseTo(1, 4);
    expect(body.results.map((r) => r.score)).toEqual([...body.results.map((r) => r.score)].sort((a, b) => b - a));
    // One call to Workers AI from the Worker, pinned to the passages' pooling; the
    // response carries cards only, never a vector, a model or the passage's full text.
    expect(aiCalls).toEqual([{ text: [TEXTS[1]], pooling: "cls" }]);
    expect(Object.keys(body.results[0]).sort()).toEqual([
      "author", "created_at", "document_id", "excerpt", "locator", "match", "number", "passage_id", "score", "source_type", "source_url", "title", "type",
    ]);
    expectNoSecrets(JSON.stringify(body));
  });

  it("applies the limit and rejects one outside 1 to 10", async () => {
    const res = await post({ repositoryId: REPO, query: TEXTS[0], limit: 2 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SearchResponse).results).toHaveLength(2);
    for (const limit of [0, 11, 1.5, "3", null]) {
      const bad = await post({ repositoryId: REPO, query: "anything", limit });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as ApiError).message).toMatch(/limit/);
    }
  });

  it("rejects malformed input before calling the model", async () => {
    const cases: [unknown, string?][] = [
      [undefined, "not json"],
      [[]],
      [{ query: "x" }],
      [{ repositoryId: "1", query: "x" }],
      [{ repositoryId: 0, query: "x" }],
      [{ repositoryId: REPO }],
      [{ repositoryId: REPO, query: "   " }],
      [{ repositoryId: REPO, query: "x".repeat(MAX_QUERY_CHARS + 1) }],
    ];
    for (const [body, raw] of cases) {
      const res = await post(body, raw);
      expect(res.status, JSON.stringify(body ?? raw)).toBe(400);
      expect(((await res.json()) as ApiError).error).toBe("invalid_input");
    }
    expect(aiCalls).toEqual([]);
  });

  it("returns 404 for an unregistered repository without calling the model", async () => {
    const res = await post({ repositoryId: REPO + 50, query: "anything" });
    expect(res.status).toBe(404);
    expect(aiCalls).toEqual([]);
  });

  it("falls back to keyword matches when no passage is semantically close", async () => {
    // Fake vectors of different texts are unrelated, so "daylight saving" scores near 0
    // semantically but its words are in one passage.
    const res = await post({ repositoryId: REPO, query: "daylight saving" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body).toMatchObject({ mode: "keyword", confidence: "low", semantic_error: null, unverified: 0 });
    expect(body.message).toMatch(/^No discussion is a close semantic match\. Showing passages that contain your search words/);
    expect(body.results.map((r) => r.passage_id)).toEqual([`github:${REPO}:issue:1:body:1`]);
    expect(body.results[0]).toMatchObject({ match: "keyword", title: "Fixture thread", source_url: "https://github.com/o/r/issues/1" });
    expect(body.results[0].score).toBeGreaterThan(0);
  });

  it("says so when neither search supports the query", async () => {
    const res = await post({ repositoryId: REPO, query: "zebra giraffe" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body).toMatchObject({ mode: "none", confidence: "none", results: [], semantic_error: null });
    expect(body.message).toBe("No supporting discussion was found for this query in this repository.");
  });

  it("shows weak semantic matches as low confidence, unless the words match somewhere", async () => {
    aiRespond = respondWith(vectorNear(TEXTS[2], (SCORE_LOW + SCORE_HIGH) / 2));
    const weak = (await (await post({ repositoryId: REPO, query: "xyzzy" })).json()) as SearchResponse;
    expect(weak).toMatchObject({ mode: "semantic", confidence: "low" });
    expect(weak.message).toMatch(/^Only weak matches were found/);
    expect(weak.results[0]).toMatchObject({ passage_id: `github:${REPO}:issue:1:body:2`, match: "semantic" });
    expect(weak.results[0].score).toBeCloseTo((SCORE_LOW + SCORE_HIGH) / 2, 3);

    const words = (await (await post({ repositoryId: REPO, query: "clarity" })).json()) as SearchResponse;
    expect(words).toMatchObject({ mode: "keyword", confidence: "low" });
    expect(words.results.map((r) => r.passage_id)).toEqual([`github:${REPO}:issue:1:body:2`]);

    aiRespond = respondWith(vectorNear(TEXTS[2], SCORE_LOW - 0.01));
    const below = (await (await post({ repositoryId: REPO, query: "xyzzy" })).json()) as SearchResponse;
    expect(below).toMatchObject({ mode: "none", results: [] });
  });

  it("searches a passage by its words before its vector exists, and says the index is building", async () => {
    const found = (await (await post({ repositoryId: REPO_PENDING, query: "zebras" })).json()) as SearchResponse;
    expect(found).toMatchObject({ mode: "keyword", confidence: "low", index: { embedded: 0, pending: 1 } });
    expect(found.message).toMatch(/^The semantic index is still building \(0 of 1 passages\)\. Showing passages/);
    expect(found.results.map((r) => r.passage_id)).toEqual([`github:${REPO_PENDING}:issue:1:body:0`]);
    expect(found.results[0].excerpt).toBe(PENDING_TEXT);

    const missing = (await (await post({ repositoryId: REPO_PENDING, query: "giraffes" })).json()) as SearchResponse;
    expect(missing).toMatchObject({ mode: "none", results: [] });
    expect(missing.message).toBe("The semantic index is still building (0 of 1 passages) and no passage contains your search words.");

    const bare = (await (await post({ repositoryId: REPO_BARE, query: "zebras" })).json()) as SearchResponse;
    expect(bare).toMatchObject({ mode: "none", results: [], index: { embedded: 0, pending: 0 } });
    expect(bare.message).toBe("This repository has no indexed discussions yet; extraction may still be running.");
  });

  it("never returns another repository's passages through the API", async () => {
    for (const text of TEXTS) {
      const res = await post({ repositoryId: REPO_TWIN, query: text, limit: 10 });
      const body = (await res.json()) as SearchResponse;
      expect(body.results).toHaveLength(TEXTS.length);
      expect(body.results.every((r) => r.passage_id.startsWith(`github:${REPO_TWIN}:`))).toBe(true);
      expect(JSON.stringify(body)).not.toContain(`github:${REPO}:`);
    }
  });

  it("keeps serving keyword matches when the model fails, naming the failure but not its text", async () => {
    aiRespond = () => jsonResponse(429, { success: false, errors: [{ message: `rate limited ${AI_ERROR_MARKER}` }] }, { "Retry-After": "7" });
    const limited = await post({ repositoryId: REPO, query: "clarity" });
    expect(limited.status).toBe(200);
    const body = (await limited.json()) as SearchResponse;
    expect(body).toMatchObject({ mode: "keyword", confidence: "low", semantic_error: "ai_rate_limited", embed_ms: null });
    expect(body.message).toMatch(/^Semantic search is unavailable \(ai_rate_limited\)\. Showing passages/);
    expect(body.results.map((r) => r.passage_id)).toEqual([`github:${REPO}:issue:1:body:2`]);
    expectNoSecrets(JSON.stringify(body));

    aiRespond = () => jsonResponse(401, { success: false, errors: [{ message: `Authentication error ${AI_ERROR_MARKER}` }] });
    const unauthorised = (await (await post({ repositoryId: REPO, query: "zebra" })).json()) as SearchResponse;
    expect(unauthorised).toMatchObject({ mode: "none", results: [], semantic_error: "ai_auth" });
    expect(unauthorised.message).toBe("Semantic search is unavailable (ai_auth) and no passage contains your search words.");
    expectNoSecrets(JSON.stringify(unauthorised));

    aiRespond = (texts) =>
      jsonResponse(200, {
        success: true,
        result: { shape: [texts.length, EMBEDDING_DIMS], data: texts.map(() => new Array(EMBEDDING_DIMS).fill(0)), pooling: "cls" },
      });
    const zero = (await (await post({ repositoryId: REPO, query: "zebra" })).json()) as SearchResponse;
    expect(zero).toMatchObject({ mode: "none", semantic_error: "ai_invalid_output" });
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("search without an embedding client", () => {
  it("serves keyword matches and reports ai_not_configured instead of guessing a vector", async () => {
    const response = await search({ db }, { repositoryId: REPO, query: "sourdough" });
    expect(response).toMatchObject({ mode: "keyword", confidence: "low", semantic_error: "ai_not_configured", embed_ms: null });
    expect(response.results.map((r) => r.passage_id)).toEqual([`github:${REPO}:issue:1:body:3`]);
  });
});
