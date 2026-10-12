import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryRecord } from "../shared/api.ts";
import { jsonResponse, repoFixture } from "./helpers.ts";

// Stands in for api.github.com. The Worker runs in the test isolate, so stubbing
// the global fetch intercepts its outbound calls.
const fakeGitHub = vi.fn<typeof globalThis.fetch>(async (input) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  switch (new URL(href).pathname) {
    case "/repos/dagster-io/dagster":
      return jsonResponse(200, repoFixture({ id: 1234 }));
    case "/repos/old-org/old-name": // GitHub redirects to the new name; fetch follows it
    case "/repos/new-org/new-name":
      return jsonResponse(200, repoFixture({ id: 5678, full_name: "new-org/new-name" }));
    case "/repos/secret/secret":
      return jsonResponse(200, repoFixture({ id: 9, full_name: "secret/secret", private: true }));
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

beforeEach(() => {
  fakeGitHub.mockClear();
  vi.stubGlobal("fetch", fakeGitHub);
});
afterEach(() => vi.unstubAllGlobals());

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

describe("POST /api/repositories", () => {
  it("registers an eligible repository once and returns the same identity on resubmission", async () => {
    const first = await post("https://github.com/dagster-io/dagster");
    expect(first.status).toBe(201);
    expect(first.headers.get("Location")).toBe("/api/repositories/1234");
    const created = (await first.json()) as RepositoryRecord;
    expect(created).toMatchObject({
      id: 1234,
      full_name: "dagster-io/dagster",
      status: "registered",
      submission_count: 1,
    });

    const second = await post("https://github.com/dagster-io/dagster");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: 1234, submission_count: 2, created_at: created.created_at });

    // A different input shape for the same repository still deduplicates.
    const third = await post("dagster-io/dagster.git");
    expect(third.status).toBe(200);
    const latest = (await third.json()) as RepositoryRecord;
    expect(latest).toMatchObject({ id: 1234, submission_count: 3 });

    const status = await get("/api/repositories/1234");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(latest);

    const missing = await get("/api/repositories/999");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });

    expect(fakeGitHub).toHaveBeenCalledTimes(3);
  });

  it("registers a renamed repository under its canonical name and stable id", async () => {
    const res = await post("https://github.com/old-org/old-name");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 5678, full_name: "new-org/new-name" });

    const again = await post("new-org/new-name");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: 5678, submission_count: 2 });
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
