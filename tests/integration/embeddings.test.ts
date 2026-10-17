import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddingClient,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EMBEDDING_POOLING,
  FakeEmbeddingClient,
  fakeVector,
  neuronsFor,
  secondsUntilUtcMidnight,
  usdFor,
  validateVector,
  WorkersAiEmbeddingClient,
} from "../../worker/src/etl/embeddings.ts";
import { JobError } from "../../worker/src/queue/retry.ts";
import { countModelTokens } from "../../worker/src/etl/tokenizer.ts";
import { jsonResponse } from "./helpers.ts";

const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMS }, (_, i) => Math.sin(seed + i));

function envelope(vectors: number[][], extra: Record<string, unknown> = {}) {
  return { success: true, errors: [], messages: [], result: { shape: [vectors.length, EMBEDDING_DIMS], data: vectors, pooling: "cls", ...extra } };
}

function clientWith(response: Response | Error) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: new WorkersAiEmbeddingClient({ accountId: "acct-1", apiToken: "tok-1", fetch }), fetch };
}

async function failure(promise: Promise<unknown>): Promise<JobError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof JobError) return err;
    throw err;
  }
  throw new Error("expected a JobError");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

describe("WorkersAiEmbeddingClient", () => {
  it("sends one request per batch with the pinned model, cls pooling and the bearer token", async () => {
    const { client, fetch } = clientWith(jsonResponse(200, envelope([vector(1), vector(2)])));
    const result = await client.embed(["alpha", "beta"]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/${EMBEDDING_MODEL}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-1");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["pooling", "text"]);
    expect(body).toEqual({ text: ["alpha", "beta"], pooling: "cls" });

    expect(result.model).toBe(EMBEDDING_MODEL);
    expect(result.pooling).toBe(EMBEDDING_POOLING);
    expect(result.vectors).toEqual([vector(1), vector(2)]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.tokens).toBeUndefined();
  });

  it("reports the tokens Workers AI metered when the response carries usage", async () => {
    const { client } = clientWith(jsonResponse(200, envelope([vector(1)], { usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 } })));
    expect((await client.embed(["a"])).tokens).toBe(9);
  });

  it("sends nothing for an empty batch and refuses a batch above EMBEDDING_BATCH_SIZE", async () => {
    const { client, fetch } = clientWith(jsonResponse(200, envelope([])));
    expect(await client.embed([])).toMatchObject({ vectors: [], durationMs: 0 });
    const err = await failure(client.embed(Array.from({ length: EMBEDDING_BATCH_SIZE + 1 }, () => "x")));
    expect(err).toMatchObject({ code: "ai_bad_request", transient: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parks the job until 00:00 UTC when Workers AI's daily free allocation is used up", async () => {
    const message = "AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan";
    const err = await failure(clientWith(jsonResponse(429, { success: false, errors: [{ message }] })).client.embed(["a"]));
    expect(err).toMatchObject({ code: "budget_exhausted", transient: true });
    expect(err.message).toContain("daily free allocation");
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    // The helper: one minute at least, never more than a day, and exactly the gap to midnight otherwise.
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 9, 16, 23, 59, 30))).toBe(60);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 9, 16, 22, 0, 0))).toBe(7200);
  });

  it("maps 429 to a transient ai_rate_limited with Retry-After, defaulting to 60", async () => {
    const withHeader = await failure(clientWith(jsonResponse(429, { success: false, errors: [{ message: "slow down" }] }, { "Retry-After": "120" })).client.embed(["a"]));
    expect(withHeader).toMatchObject({ code: "ai_rate_limited", transient: true, retryAfterSeconds: 120, message: "slow down" });
    const without = await failure(clientWith(jsonResponse(429, {})).client.embed(["a"]));
    expect(without).toMatchObject({ code: "ai_rate_limited", retryAfterSeconds: 60 });
  });

  it("maps 401 and 403 to a permanent ai_auth", async () => {
    for (const status of [401, 403]) {
      const err = await failure(clientWith(jsonResponse(status, { success: false, errors: [{ message: "Authentication error" }] })).client.embed(["a"]));
      expect(err).toMatchObject({ code: "ai_auth", transient: false, message: "Authentication error" });
    }
  });

  it("maps 400 and a success:false envelope to a permanent ai_bad_request with the API message", async () => {
    const bad = await failure(clientWith(jsonResponse(400, { success: false, errors: [{ message: "text is required" }] })).client.embed(["a"]));
    expect(bad).toMatchObject({ code: "ai_bad_request", transient: false, message: "text is required" });
    const notSuccess = await failure(clientWith(jsonResponse(200, { success: false, errors: [{ message: "model unavailable" }] })).client.embed(["a"]));
    expect(notSuccess).toMatchObject({ code: "ai_bad_request", message: "model unavailable" });
  });

  it("maps 5xx to a transient ai_upstream and a thrown fetch to a transient network error", async () => {
    expect(await failure(clientWith(jsonResponse(502, {})).client.embed(["a"]))).toMatchObject({ code: "ai_upstream", transient: true });
    expect(await failure(clientWith(new Error("socket closed")).client.embed(["a"]))).toMatchObject({ code: "network", transient: true, message: "socket closed" });
  });

  it("rejects missing, misaligned or wrongly shaped data as ai_invalid_output", async () => {
    expect(await failure(clientWith(jsonResponse(200, { success: true, result: {} })).client.embed(["a"]))).toMatchObject({ code: "ai_invalid_output" });
    expect(await failure(clientWith(jsonResponse(200, envelope([vector(1)]))).client.embed(["a", "b"]))).toMatchObject({ code: "ai_invalid_output" });
    expect(
      await failure(clientWith(jsonResponse(200, envelope([vector(1), vector(2)], { shape: [2, 768] }))).client.embed(["a", "b"])),
    ).toMatchObject({ code: "ai_invalid_output" });
  });

  it("rejects a response pooled with mean as ai_pooling_mismatch", async () => {
    const err = await failure(clientWith(jsonResponse(200, envelope([vector(1)], { pooling: "mean" }))).client.embed(["a"]));
    expect(err).toMatchObject({ code: "ai_pooling_mismatch", transient: false });
  });

  it("is only created when both credentials are present", () => {
    expect(createEmbeddingClient({ CLOUDFLARE_ACCOUNT_ID: "", WORKERS_AI_API_TOKEN: "t" })).toBeUndefined();
    expect(createEmbeddingClient({ CLOUDFLARE_ACCOUNT_ID: "a", WORKERS_AI_API_TOKEN: "" })).toBeUndefined();
    expect(createEmbeddingClient({ CLOUDFLARE_ACCOUNT_ID: "a", WORKERS_AI_API_TOKEN: "t" })).toBeInstanceOf(WorkersAiEmbeddingClient);
  });
});

describe("FakeEmbeddingClient and helpers", () => {
  it("fake vectors are deterministic, finite and unit length", async () => {
    const fake = new FakeEmbeddingClient();
    const { vectors } = await fake.embed(["same", "same", "different"]);
    expect(vectors[0]).toEqual(vectors[1]);
    expect(vectors[0]).not.toEqual(vectors[2]);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMS);
    expect(vectors.every((v) => v.every(Number.isFinite))).toBe(true);
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 6);
    expect(fakeVector("same")).toEqual(vectors[0]);
    expect(fake.calls).toEqual([["same", "same", "different"]]);
  });

  it("fake overrides and failures are applied per call", async () => {
    const boom = new JobError("ai_rate_limited", "later", { transient: true, retryAfterSeconds: 7 });
    const fake = new FakeEmbeddingClient({
      vectorFor: (_text, index) => (index === 1 ? [Number.NaN] : undefined),
      fail: (_texts, call) => (call === 1 ? boom : undefined),
    });
    const { vectors } = await fake.embed(["a", "b"]);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMS);
    expect(vectors[1]).toEqual([Number.NaN]);
    await expect(fake.embed(["c"])).rejects.toBe(boom);
  });

  it("validateVector flags a short vector, NaN, Infinity and all zeros and accepts a valid one", () => {
    expect(validateVector("nope")).toBe("not_array");
    expect(validateVector(vector(1).slice(0, 383))).toBe("wrong_dims");
    expect(validateVector([Number.NaN, ...vector(1).slice(1)])).toBe("not_finite");
    expect(validateVector([Number.POSITIVE_INFINITY, ...vector(1).slice(1)])).toBe("not_finite");
    expect(validateVector(new Array(EMBEDDING_DIMS).fill(0))).toBe("all_zero");
    expect(validateVector(vector(1))).toBeNull();
  });

  it("meters tokens into neurons and dollars", () => {
    expect(neuronsFor(1_000_000)).toBe(1841);
    expect(neuronsFor(66)).toBeCloseTo(0.1215, 4);
    expect(usdFor(1_000_000)).toBe(0.02);
  });
});

describe.skipIf(!env.CLOUDFLARE_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN)("Workers AI live", () => {
  it("embeds three texts with cls pooling into 384 finite dimensions", async () => {
    const client = createEmbeddingClient(env)!;
    const texts = ["p-limit queues promise-returning functions", "p-limit queues promise-returning functions", "a recipe for sourdough bread"];
    const { vectors, durationMs, tokens } = await client.embed(texts);
    expect(vectors).toHaveLength(3);
    // Workers AI meters each text at the batch's longest model input length (observed:
    // 33 for lengths 11, 11 and 8), never below the exact sum the vendored tokenizer gives.
    const lengths = texts.map(countModelTokens);
    const exact = lengths.reduce((sum, n) => sum + n, 0);
    console.log(`Workers AI metered ${tokens} tokens for lengths ${lengths.join("+")} (exact ${exact})`);
    expect(tokens).toBeGreaterThanOrEqual(exact);
    expect(tokens).toBeLessThanOrEqual(texts.length * Math.max(...lengths));
    expect(vectors.every((v) => validateVector(v) === null)).toBe(true);
    expect(vectors[0]).toEqual(vectors[1]);
    expect(cosine(vectors[0], vectors[2])).toBeLessThan(0.9);
    expect(durationMs).toBeGreaterThan(0);

    const again = await client.embed([texts[0]]);
    expect(cosine(vectors[0], again.vectors[0])).toBeGreaterThanOrEqual(0.999);
  });
});
