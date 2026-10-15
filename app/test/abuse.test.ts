import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, ServiceStatus } from "../shared/api.ts";
import { secretsEqual } from "../worker/admin.ts";
import type { Budget } from "../worker/budget.ts";
import { EMBEDDING_DIMS, fakeVector } from "../worker/embeddings.ts";
import worker, { MAX_BODY_BYTES } from "../worker/index.ts";
import { clientKey } from "../worker/ratelimit.ts";
import { createDb, upsertRepository } from "../worker/repositories.ts";
import { dropBudget, fakeExecutionContext, insertPassages, jsonResponse, repoFixture, seedBudget } from "./helpers.ts";

// Runs against the real Supabase project with GitHub, Turnstile and Workers AI stubbed; see
// jobs.test.ts for the id scheme. Addresses 10.9.0.x are this file's own rate-limit keys.
const REPO = Date.now() * 100 + 9;
const SCOPE = `test-${REPO}`;
const db = createDb(env);
let budget: Budget;

// Cloudflare's published test secrets: always pass, always fail, token already spent.
const ALWAYS_PASS = "1x0000000000000000000000000000000AA";
const ALWAYS_FAIL = "2x0000000000000000000000000000000AA";
const SPENT = "3x0000000000000000000000000000000AA";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
const hrefOf = (input: FetchInput) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const calls = { github: 0, turnstile: 0, ai: 0 };
let turnstileDown = false;
const realFetch = globalThis.fetch;
async function routedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  const url = new URL(hrefOf(input));
  if (url.hostname === "api.github.com") {
    calls.github += 1;
    return jsonResponse(404, { message: "Not Found" });
  }
  if (url.hostname === "challenges.cloudflare.com") {
    calls.turnstile += 1;
    if (turnstileDown) throw new TypeError("fetch failed");
    const { secret } = JSON.parse(String(init?.body)) as { secret: string };
    return jsonResponse(
      200,
      secret === ALWAYS_PASS ? { success: true } : { success: false, "error-codes": [secret === SPENT ? "timeout-or-duplicate" : "invalid-input-response"] },
    );
  }
  if (url.hostname === "api.cloudflare.com") {
    calls.ai += 1;
    const { text } = JSON.parse(String(init?.body)) as { text: string[] };
    return jsonResponse(200, { success: true, result: { shape: [text.length, EMBEDDING_DIMS], data: text.map((t) => fakeVector(t)), pooling: "cls" } });
  }
  return realFetch(input, init);
}

beforeEach(() => {
  calls.github = calls.turnstile = calls.ai = 0;
  turnstileDown = false;
  vi.stubGlobal("fetch", routedFetch);
});
afterEach(() => vi.unstubAllGlobals());

const scoped = (extra: Record<string, string | undefined> = {}) => ({ ...env, BUDGET_SCOPE: SCOPE, ...extra }) as typeof env;

function request(path: string, options: { method?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {}): Request {
  const { method = "GET", body, ip, headers = {} } = options;
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
type WorkerRequest = Parameters<typeof worker.fetch>[0];
const call = (path: string, options?: Parameters<typeof request>[1], e = scoped()) =>
  worker.fetch(request(path, options) as unknown as WorkerRequest, e, fakeExecutionContext());
const register = (url: string, options: Parameters<typeof request>[1] = {}, e = scoped()) =>
  call("/api/repositories", { ...options, method: "POST", body: { url, ...(options.body as object) } }, e);

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/abuse" }));
  await insertPassages(db, REPO, [{ text: "A passage about zebras." }]);
  budget = await seedBudget(db, SCOPE);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
  await dropBudget(db, SCOPE);
});

/** Spends a limiter's whole window for a key, the way a burst would, without waiting on the network. */
async function exhaustLimiter(limiter: { limit(o: { key: string }): Promise<{ success: boolean }> }, key: string): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < 200; i++) {
    if (!(await limiter.limit({ key })).success) return allowed;
    allowed += 1;
  }
  throw new Error(`limiter never refused ${key}`);
}

describe.skipIf(!env.SUPABASE_SECRET_KEY)("rate limits", () => {
  it("refuse the 31st search a minute from one address with 429, which costs no budget", async () => {
    // The local limiter refills over time, so the burst is made through the binding itself
    // (the route keys searches as search:<address>) and the route's answer is checked once.
    expect(await exhaustLimiter(env.SEARCH_LIMITER, "search:10.9.0.1")).toBe(30);
    const refused = await call("/api/search", { method: "POST", body: { repositoryId: REPO, query: "zebras" }, ip: "10.9.0.1" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(((await refused.json()) as ApiError).error).toBe("rate_limited");
    expect(calls.ai).toBe(0);
    expect((await budget.summary()).find((b) => b.resource === "searches")?.used).toBe(0);

    const other = await call("/api/search", { method: "POST", body: { repositoryId: REPO, query: "zebras" }, ip: "10.9.0.9" });
    expect(other.status).toBe(200);
    expect(calls.ai).toBe(1);
    expect((await budget.summary()).find((b) => b.resource === "searches")?.used).toBe(1);
  });

  it("limit registrations to 5 a minute per address and leave other addresses alone", async () => {
    expect(await exhaustLimiter(env.REGISTER_LIMITER, "register:10.9.0.2")).toBe(5);
    expect((await register("https://github.com/alice/abuse-x", { ip: "10.9.0.2" })).status).toBe(429);
    expect(calls.github).toBe(0); // the refused one never reached GitHub
    expect((await register("https://github.com/alice/abuse-x", { ip: "10.9.0.3" })).status).toBe(404);
    expect(calls.github).toBe(1);
  });

  it("do not apply without a client address, which only local development lacks", () => {
    expect(clientKey(new Request("http://localhost/api/search"))).toBeNull();
    expect(clientKey(new Request("http://localhost/api/search", { headers: { "cf-connecting-ip": "203.0.113.9" } }))).toBe("203.0.113.9");
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("turnstile", () => {
  it("is off without a secret, and the status says so", async () => {
    const status = (await (await call("/api/status")).json()) as ServiceStatus;
    expect(status.protections).toEqual({ turnstile: false, rate_limits: true, admin: true });
    expect((await register("https://github.com/alice/abuse-open")).status).toBe(404);
    expect(calls.turnstile).toBe(0);
    expect(calls.github).toBe(1);
  });

  it("requires a token, rejects a failed or replayed one, and lets a valid one through", async () => {
    const failing = scoped({ TURNSTILE_SECRET_KEY: ALWAYS_FAIL });
    const missing = await register("https://github.com/alice/abuse-t", {}, failing);
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as ApiError).message).toMatch(/Complete the Turnstile check/);
    expect(calls.turnstile).toBe(0);

    const rejected = await register("https://github.com/alice/abuse-t", { body: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" } }, failing);
    expect(rejected.status).toBe(403);
    expect(((await rejected.json()) as ApiError).message).toMatch(/invalid-input-response/);

    const replayed = await register("https://github.com/alice/abuse-t", { body: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" } }, scoped({ TURNSTILE_SECRET_KEY: SPENT }));
    expect(((await replayed.json()) as ApiError).message).toMatch(/timeout-or-duplicate/);
    expect(calls.github).toBe(0); // nothing reached GitHub so far

    const tooLong = await register("https://github.com/alice/abuse-t", { body: { turnstileToken: "x".repeat(2049) } }, scoped({ TURNSTILE_SECRET_KEY: ALWAYS_PASS }));
    expect(tooLong.status).toBe(403);
    expect(calls.turnstile).toBe(2);

    const passed = await register("https://github.com/alice/abuse-t", { body: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" } }, scoped({ TURNSTILE_SECRET_KEY: ALWAYS_PASS }));
    expect(passed.status).toBe(404); // verified, then GitHub said the repository does not exist
    expect(calls.turnstile).toBe(3);
    expect(calls.github).toBe(1);

    const status = (await (await call("/api/status", {}, scoped({ TURNSTILE_SECRET_KEY: ALWAYS_PASS }))).json()) as ServiceStatus;
    expect(status.protections.turnstile).toBe(true);
  });

  it("fails closed when the verification service cannot be reached", async () => {
    turnstileDown = true;
    const res = await register("https://github.com/alice/abuse-t", { body: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" } }, scoped({ TURNSTILE_SECRET_KEY: ALWAYS_PASS }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error).toBe("verification_unavailable");
    expect(calls.github).toBe(0);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("admin token", () => {
  it("guards manual job triggers, compared in constant time", async () => {
    const trigger = (headers: Record<string, string>, e = scoped()) => call(`/api/repositories/${REPO}/jobs`, { method: "POST", body: { kind: "transform_passages" }, headers }, e);
    const anonymous = await trigger({});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await trigger({ authorization: "Bearer not-the-token" })).status).toBe(403);
    expect((await trigger({ authorization: `Bearer ${env.ADMIN_TOKEN}` }, scoped({ ADMIN_TOKEN: undefined }))).status).toBe(503);

    const accepted = await trigger({ authorization: `Bearer ${env.ADMIN_TOKEN}` });
    expect(accepted.status).toBe(202);
    const job = (await accepted.json()) as { id: number };
    await db.from("jobs").update({ state: "cancelled" }).eq("id", job.id);

    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("request bodies", () => {
  it("refuses an oversized body before any lookup", async () => {
    const padded = JSON.stringify({ url: "https://github.com/alice/abuse", pad: "x".repeat(MAX_BODY_BYTES) });
    const registration = await call("/api/repositories", { method: "POST", body: padded });
    expect(registration.status).toBe(413);
    expect(((await registration.json()) as ApiError).error).toBe("payload_too_large");
    expect(calls.github).toBe(0);
    const searchRes = await call("/api/search", { method: "POST", body: JSON.stringify({ repositoryId: REPO, query: "x".repeat(MAX_BODY_BYTES) }) });
    expect(searchRes.status).toBe(413);
    expect(calls.ai).toBe(0);
  });
});
