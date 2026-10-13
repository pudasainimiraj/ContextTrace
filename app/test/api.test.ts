import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, RepositoryRecord } from "../shared/api.ts";
import { createDb } from "../worker/repositories.ts";
import { jsonResponse, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed. Ids sit far above
// GitHub's range so they cannot collide with real repositories, and the rows are
// removed afterwards. The tens digit keeps this file's ids apart from
// repositories.test.ts, which runs in parallel.
const ID_DAGSTER = Date.now() * 100 + 50;
const ID_RENAMED = ID_DAGSTER + 1;
const ID_PRIVATE = ID_DAGSTER + 2;
const ID_MISSING = ID_DAGSTER + 3;

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function hrefOf(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

// Stands in for api.github.com.
const fakeGitHub = vi.fn<typeof globalThis.fetch>(async (input) => {
  switch (new URL(hrefOf(input)).pathname) {
    case "/repos/dagster-io/dagster":
      return jsonResponse(200, repoFixture({ id: ID_DAGSTER }));
    case "/repos/old-org/old-name": // GitHub redirects to the new name; fetch follows it
    case "/repos/new-org/new-name":
      return jsonResponse(200, repoFixture({ id: ID_RENAMED, full_name: "new-org/new-name" }));
    case "/repos/secret/secret":
      return jsonResponse(200, repoFixture({ id: ID_PRIVATE, full_name: "secret/secret", private: true }));
    case "/repos/limited/limited":
      return jsonResponse(
        403,
        { message: "API rate limit exceeded" },
        { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 30) },
      );
    default:
      return jsonResponse(404, { message: "Not Found" });
  }
});

// The Worker runs in the test isolate, so stubbing the global fetch intercepts its
// outbound calls. Only api.github.com is faked; Supabase traffic goes to the network.
const realFetch = globalThis.fetch;
function routedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  return new URL(hrefOf(input)).hostname === "api.github.com"
    ? fakeGitHub(input, init)
    : realFetch(input, init);
}

beforeEach(() => {
  fakeGitHub.mockClear();
  vi.stubGlobal("fetch", routedFetch);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await createDb(env).from("repositories").delete().in("id", [ID_DAGSTER, ID_RENAMED]);
});

function post(url: unknown, rawBody?: string): Promise<Response> {
  return exports.default.fetch("http://localhost/api/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify({ url }),
  });
}

function get(path: string): Promise<Response> {
  return exports.default.fetch(`http://localhost${path}`);
}

describe.skipIf(!env.SUPABASE_SECRET_KEY)("POST /api/repositories", () => {
  it("registers an eligible repository once and returns the same identity on resubmission", async () => {
    const first = await post("https://github.com/dagster-io/dagster");
    expect(first.status).toBe(201);
    expect(first.headers.get("Location")).toBe(`/api/repositories/${ID_DAGSTER}`);
    const created = (await first.json()) as RepositoryRecord;
    expect(created).toMatchObject({
      id: ID_DAGSTER,
      full_name: "dagster-io/dagster",
      status: "registered",
      submission_count: 1,
    });

    const second = await post("https://github.com/dagster-io/dagster");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: ID_DAGSTER, submission_count: 2, created_at: created.created_at });

    // A different input shape for the same repository still deduplicates.
    const third = await post("dagster-io/dagster.git");
    expect(third.status).toBe(200);
    const latest = (await third.json()) as RepositoryRecord;
    expect(latest).toMatchObject({ id: ID_DAGSTER, submission_count: 3 });

    const status = await get(`/api/repositories/${ID_DAGSTER}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(latest);

    const missing = await get(`/api/repositories/${ID_MISSING}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });

    expect(fakeGitHub).toHaveBeenCalledTimes(3);

    // Registration started one extraction job per stream, once.
    const { data: jobs } = await createDb(env).from("jobs").select("kind").eq("repository_id", ID_DAGSTER).order("kind");
    expect(jobs?.map((j) => j.kind)).toEqual(["fetch_issue_comments", "fetch_issues", "fetch_review_comments"]);
  });

  it("creates and enqueues a job for a registered repository", async () => {
    await post("https://github.com/dagster-io/dagster");
    const jobs = (repositoryId: number, body: unknown) =>
      exports.default.fetch(`http://localhost/api/repositories/${repositoryId}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const res = await jobs(ID_DAGSTER, { kind: "fetch_issues" });
    expect(res.status).toBe(202);
    expect((await res.json()) as JobRecord).toMatchObject({
      repository_id: ID_DAGSTER,
      kind: "fetch_issues",
      state: "queued",
      generation: 1,
    });

    const unknown = await jobs(ID_MISSING, { kind: "fetch_issues" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "not_found" });

    const badKind = await jobs(ID_DAGSTER, { kind: "Fetch Issues" });
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toMatchObject({ error: "invalid_input" });
  });

  it("registers a renamed repository under its canonical name and stable id", async () => {
    const res = await post("https://github.com/old-org/old-name");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: ID_RENAMED, full_name: "new-org/new-name" });

    const again = await post("new-org/new-name");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: ID_RENAMED, submission_count: 2 });
  });

  it("rejects invalid input without calling GitHub", async () => {
    const notJson = await post(undefined, "not json");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_input" });

    const notString = await post(42);
    expect(notString.status).toBe(400);
    expect(await notString.json()).toMatchObject({ error: "invalid_input" });

    const otherHost = await post("https://gitlab.com/a/b");
    expect(otherHost.status).toBe(400);
    expect(await otherHost.json()).toMatchObject({ error: "invalid_input" });

    expect(fakeGitHub).not.toHaveBeenCalled();
  });

  it("reports a nonexistent repository", async () => {
    const res = await post("nope/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "repository_not_found" });
  });

  it("reports a private repository", async () => {
    const res = await post("secret/secret");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "repository_not_public" });
  });

  it("reports GitHub rate limiting with Retry-After", async () => {
    const res = await post("limited/limited");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });
});
