import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import envExample from "../../.env.example?raw";
import headersFile from "../../web/public/_headers?raw";
import wranglerConfig from "../../wrangler.jsonc?raw";
import type { ApiError } from "../../shared/api.ts";
import { consumeJobMessage } from "../../worker/src/queue/consumer.ts";
import { getCheckpoint, saveCheckpoint } from "../../worker/src/etl/checkpoints.ts";
import { EMBED_JOB_KIND, embedPassages } from "../../worker/src/etl/embed.ts";
import { FakeEmbeddingClient, fakeVector } from "../../worker/src/etl/embeddings.ts";
import { assertGitHubApiUrl, githubGetPage } from "../../worker/src/etl/github-rest.ts";
import worker from "../../worker/src/index.ts";
import { createJob, enqueueJob, getJob, type JobQueue } from "../../worker/src/queue/jobs.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { searchSemantic } from "../../worker/src/api/search.ts";
import { JOB_KINDS } from "../../worker/src/api/validate.ts";
import { expectNoSecrets, fakeExecutionContext, fakeGitHubPages, fakeMessage, insertPassages, repoFixture, SECRET_ENV_NAMES } from "./helpers.ts";

// Every component of the app, so a new file cannot slip past the no-raw-HTML rule.
const appSources = import.meta.glob("../../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO = Date.now() * 100 + 13;
const db = createDb(env);
type WorkerRequest = Parameters<typeof worker.fetch>[0];
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`http://localhost${path}`, init) as unknown as WorkerRequest, env, fakeExecutionContext());
const post = (path: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => call(path, { method: "POST", headers, body });

const TEXTS = Array.from({ length: 12 }, (_, i) => `Security passage number ${i} about zebras and budgets.`);
const INJECTED = '<script>alert("x")</script><img src=x onerror="alert(1)"> and <b>bold</b> text';

function fakeQueue() {
  return { send: vi.fn<JobQueue["send"]>(async () => {}) };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO, full_name: "alice/security" }));
  await insertPassages(db, REPO, [...TEXTS, INJECTED].map((text) => ({ text })));
  const job = await createJob(db, REPO, EMBED_JOB_KIND);
  expect(await embedPassages({ db, embeddings: new FakeEmbeddingClient() }, REPO, job.id)).toMatchObject({ inserted: 13 });
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO);
});
afterEach(() => vi.unstubAllGlobals());

describe("configuration", () => {
  it("keeps every secret out of wrangler.jsonc and lists every one in .env.example", () => {
    const vars = /"vars":\s*\{([^}]*)\}/.exec(wranglerConfig)?.[1] ?? "";
    expect([...vars.matchAll(/"([A-Z_]+)":/g)].map((m) => m[1])).toEqual(["SUPABASE_URL", "ALLOWED_ORIGINS"]);
    for (const name of SECRET_ENV_NAMES) {
      if (name === "SUPABASE_PASSWORD") continue; // only the migration tool uses it, from the shell
      expect(envExample, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    // Names may be mentioned in comments; none may be declared.
    expect(wranglerConfig).not.toMatch(/"(SUPABASE_SECRET_KEY|WORKERS_AI_API_TOKEN|GITHUB_TOKEN|ADMIN_TOKEN|TURNSTILE_SECRET_KEY|SUPABASE_PASSWORD)"\s*:/);
  });

  it("renders text only: no raw HTML in the app, and a strict policy on the static assets", () => {
    expect(Object.keys(appSources).length).toBeGreaterThan(0);
    for (const [file, source] of Object.entries(appSources)) {
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      if (/target="_blank"/.test(source)) expect(source, file).toMatch(/rel="noreferrer"/);
    }
    expect(headersFile).toMatch(/^\/\*$/m);
    expect(headersFile).toMatch(/Content-Security-Policy: default-src 'self'; script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
    expect(headersFile).toMatch(/frame-ancestors 'none'/);
    expect(headersFile).toMatch(/object-src 'none'/);
    expect(headersFile).toMatch(/X-Content-Type-Options: nosniff/);
    expect(headersFile).toMatch(/X-Frame-Options: DENY/);
    expect(headersFile).toMatch(/Referrer-Policy: no-referrer/);
  });
});

describe("cross-origin access", () => {
  const PAGES = "https://pudasainimiraj.github.io";

  it("answers a preflight from the Pages site and exposes the headers the client reads", async () => {
    const preflight = await call("/api/search", { method: "OPTIONS", headers: { origin: PAGES, "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(PAGES);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toMatch(/content-type/i);
    const res = await call("/api/health", { headers: { origin: PAGES } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PAGES);
    expect(res.headers.get("Access-Control-Expose-Headers")).toMatch(/Retry-After/);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("gives any other origin, and a request without one, no cross-origin permission", async () => {
    const cases: Record<string, string>[] = [{ origin: "https://evil.example" }, {}];
    for (const headers of cases) {
      expect((await call("/api/health", { headers })).headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect((await call("/api/health", { method: "OPTIONS", headers })).status).toBe(404);
    }
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("responses", () => {
  it("carry nosniff and no-store on success and on error, and never a secret", async () => {
    for (const path of ["/api/health", "/api/status", "/api/repositories", "/api/repositories/by-name/alice/security", "/api/repositories/by-name/no/such", `/api/repositories/${REPO}`, `/api/repositories/${REPO}/coverage`, `/api/repositories/${REPO}/sources`, `/api/repositories/${REPO}/passages?limit=2`, `/api/repositories/${REPO}/embeddings/stats`, "/api/repositories/1/coverage", "/nope"]) {
      const res = await call(path);
      expect(res.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expectNoSecrets(await res.text());
    }
  });

  it("answer an unexpected failure with a generic 500 that reveals nothing", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).hostname.endsWith("supabase.co")) throw new TypeError(`connection refused to ${href} with key ${env.SUPABASE_SECRET_KEY}`);
      return realFetch(input, init);
    });
    const res = await call(`/api/repositories/${REPO}`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error", message: "Something went wrong on our side; the problem has been logged" });
    expectNoSecrets(text, ["supabase.co", "connection refused"]);
  });

  it("serve injected markup as inert text", async () => {
    // Postgres's text parser skips words inside tags, so the query names the plain word.
    const res = await post("/api/search", JSON.stringify({ repositoryId: REPO, query: "bold" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = (await res.json()) as { results: { excerpt: string }[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].excerpt).toBe(INJECTED); // data, not markup: the client renders it as text
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("request validation", () => {
  it("refuses bodies that are not JSON documents, before any work", async () => {
    expect((await post("/api/search", "repositoryId=1", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post("/api/repositories", "{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/api/search", "{not json")).status).toBe(400);
    expect((await post("/api/search", "[1,2]")).status).toBe(400);
  });

  it("checks every field with limits and never echoes the input", async () => {
    const longUrl = `https://github.com/alice/${"a".repeat(600)}`;
    const res = await post("/api/repositories", JSON.stringify({ url: longUrl }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/url must be at most 512 characters/);
    expect(text).not.toContain("aaaaaaaaaa");
    expect((await post("/api/repositories", JSON.stringify({ url: "https://github.com/a/b", turnstileToken: 42 }))).status).toBe(400);

    const job = await post(`/api/repositories/${REPO}/jobs`, JSON.stringify({ kind: "drop_tables" }), { "content-type": "application/json", authorization: `Bearer ${env.ADMIN_TOKEN}` });
    expect(job.status).toBe(400);
    expect(((await job.json()) as ApiError).message).toBe(`kind must be one of ${JOB_KINDS.join(", ")}`);
    expect(JOB_KINDS).toContain("transform_passages");
    expect(JOB_KINDS).toContain("rescan_issues");
  });

  it("caps the number of results at 10 in the database as well as the API", async () => {
    const { data } = await db.rpc("search_passages", { p_repository_id: REPO, p_query: JSON.stringify(fakeVector(TEXTS[0])), p_limit: 1000 });
    expect((data as unknown[]).length).toBe(10);
    expect(await searchSemantic(db, REPO, fakeVector(TEXTS[0]), 500)).toHaveLength(10);
    const res = await post("/api/search", JSON.stringify({ repositoryId: REPO, query: TEXTS[0], limit: 11 }));
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("fetch targets", () => {
  it("accepts only GitHub's API under the job's repository", () => {
    const repo = { owner: "alice", name: "security" };
    expect(() => assertGitHubApiUrl("https://api.github.com/repos/alice/security/issues?page=3", repo)).not.toThrow();
    expect(() => assertGitHubApiUrl("http://api.github.com/repos/alice/security/issues", repo)).toThrow(/not GitHub's API/);
    expect(() => assertGitHubApiUrl("https://evil.example/repos/alice/security/issues", repo)).toThrow(/not GitHub's API/);
    expect(() => assertGitHubApiUrl("https://user:pw@api.github.com/repos/alice/security/issues", repo)).toThrow(/not GitHub's API/);
    expect(() => assertGitHubApiUrl("https://api.github.com/repos/mallory/other/issues", repo)).toThrow(/outside the job's repository/);
    expect(() => assertGitHubApiUrl("https://api.github.com/user", repo)).toThrow(/outside the job's repository/);
    expect(() => assertGitHubApiUrl("not a url")).toThrow(/not a URL/);
  });

  it("accepts GitHub's pagination form, which names the repository by id, only for the job's id", () => {
    // Real header: Link: <https://api.github.com/repositories/45717250/issues?state=all&per_page=100&page=2>; rel="next"
    const repo = { owner: "alice", name: "security", id: 45717250 };
    expect(() => assertGitHubApiUrl("https://api.github.com/repositories/45717250/issues?state=all&per_page=100&page=2", repo)).not.toThrow();
    expect(() => assertGitHubApiUrl("https://api.github.com/repositories/45717250/issues/comments?page=2", repo)).not.toThrow();
    expect(() => assertGitHubApiUrl("https://api.github.com/repositories/457172500/issues?page=2", repo)).toThrow(/outside the job's repository/);
    expect(() => assertGitHubApiUrl("https://api.github.com/repositories/1/issues?page=2", repo)).toThrow(/outside the job's repository/);
    expect(() => assertGitHubApiUrl("https://api.github.com/repositories/45717250/issues?page=2", { owner: "alice", name: "security" })).toThrow(/outside the job's repository/);
  });

  it("never follows a tampered cursor: the job fails, the cursor is cleared, nothing is fetched", async () => {
    await saveCheckpoint(db, { repository_id: REPO, stream: "issues", cursor: "https://evil.example/repos/alice/security/issues?page=2", head_done_at: new Date().toISOString() });
    const github = fakeGitHubPages([[]]);
    const queue = fakeQueue();
    const job = await createJob(db, REPO, "backfill_issues");
    const sent = (await enqueueJob(db, queue, job.id))!;
    await consumeJobMessage({ db, queue, fetch: github.fetch }, fakeMessage({ jobId: job.id, repoId: REPO, kind: "backfill_issues", generation: sent.generation }), "w");
    expect(await getJob(db, job.id)).toMatchObject({ state: "failed", error_code: "invalid_cursor" });
    expect(github.requests).toHaveLength(0);
    expect((await getCheckpoint(db, REPO, "issues"))?.cursor).toBeNull();

    const direct = vi.fn<typeof globalThis.fetch>();
    await expect(githubGetPage("https://evil.example/repos/x/y/issues", { fetch: direct })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(direct).not.toHaveBeenCalled();
  });
});
