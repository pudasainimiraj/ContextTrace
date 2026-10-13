import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, SearchResponse } from "../shared/api.ts";
import { EMBED_JOB_KIND, embedPassages } from "../worker/embed.ts";
import { EMBEDDING_DIMS, FakeEmbeddingClient, fakeVector } from "../worker/embeddings.ts";
import { createJob } from "../worker/jobs.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { MAX_QUERY_CHARS, search } from "../worker/search.ts";
import { insertPassages, jsonResponse, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with Workers AI stubbed; see jobs.test.ts for the
// id scheme. Two repositories hold the same texts so cross-repository leakage would show
// up at the API level; a third is registered but has nothing extracted.
const REPO = Date.now() * 100 + 97;
const REPO_TWIN = REPO + 1;
const REPO_EMPTY = REPO + 2;
const db = createDb(env);

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
  await upsertRepository(db, repoFixture({ id: REPO_EMPTY, full_name: "alice/search-api-empty" }));
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [REPO, REPO_TWIN, REPO_EMPTY]);
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
    expect(body).toMatchObject({ repository_id: REPO, query: TEXTS[1], limit: 5, unverified: 0 });
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
    });
    expect(body.results[0].score).toBeCloseTo(1, 4);
    expect(body.results.map((r) => r.score)).toEqual([...body.results.map((r) => r.score)].sort((a, b) => b - a));
    // One call to Workers AI from the Worker, pinned to the passages' pooling; the
    // response carries cards only, never a vector, a model or the passage's full text.
    expect(aiCalls).toEqual([{ text: [TEXTS[1]], pooling: "cls" }]);
    expect(Object.keys(body.results[0]).sort()).toEqual([
      "author", "created_at", "document_id", "excerpt", "locator", "number", "passage_id", "score", "source_type", "source_url", "title", "type",
    ]);
  });

  it("applies the limit and rejects one outside 1 to 10", async () => {
    const res = await post({ repositoryId: REPO, query: "anything", limit: 2 });
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

  it("returns no results for a registered repository that has no vectors yet", async () => {
    const res = await post({ repositoryId: REPO_EMPTY, query: "anything" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SearchResponse).results).toEqual([]);
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

  it("maps a model rate limit to 503 with Retry-After and other model failures to 502", async () => {
    aiRespond = () => jsonResponse(429, { success: false, errors: [{ message: "rate limited" }] }, { "Retry-After": "7" });
    const limited = await post({ repositoryId: REPO, query: "anything" });
    expect(limited.status).toBe(503);
    expect(limited.headers.get("Retry-After")).toBe("7");
    expect(((await limited.json()) as ApiError).error).toBe("rate_limited");

    aiRespond = () => jsonResponse(502, { success: false, errors: [{ message: "upstream" }] });
    const failed = await post({ repositoryId: REPO, query: "anything" });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as ApiError).error).toBe("embedding_failed");

    aiRespond = (texts) =>
      jsonResponse(200, {
        success: true,
        result: { shape: [texts.length, EMBEDDING_DIMS], data: texts.map(() => new Array(EMBEDDING_DIMS).fill(0)), pooling: "cls" },
      });
    const zero = await post({ repositoryId: REPO, query: "anything" });
    expect(zero.status).toBe(502);
    expect(((await zero.json()) as ApiError).message).toContain("ai_invalid_output");
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("search without an embedding client", () => {
  it("fails with ai_not_configured instead of guessing a vector", async () => {
    await expect(search({ db }, { repositoryId: REPO, query: "anything" })).rejects.toMatchObject({ code: "ai_not_configured" });
  });
});
