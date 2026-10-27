import { describe, expect, it, vi } from "vitest";
import { countIssuesAndPullRequests, lookupPublicRepository } from "../../worker/src/api/github-api.ts";
import { jsonResponse, repoFixture } from "./helpers.ts";

const DAGSTER = { owner: "dagster-io", name: "dagster" };

function stubFetch(result: Response | Error) {
  return vi.fn<typeof globalThis.fetch>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

describe("lookupPublicRepository", () => {
  it("returns ok for a public repository", async () => {
    const repo = repoFixture();
    const result = await lookupPublicRepository(DAGSTER, { fetch: stubFetch(jsonResponse(200, repo)) });
    expect(result).toEqual({ kind: "ok", repo });
  });

  it("returns the canonical name and stable id for a renamed repository", async () => {
    // GitHub redirects old-org/old-name and fetch follows it: the body has the new name.
    const repo = repoFixture({ id: 5678, full_name: "new-org/new-name" });
    const result = await lookupPublicRepository(
      { owner: "old-org", name: "old-name" },
      { fetch: stubFetch(jsonResponse(200, repo)) },
    );
    expect(result).toEqual({ kind: "ok", repo });
    expect(result.kind === "ok" && result.repo.full_name).toBe("new-org/new-name");
    expect(result.kind === "ok" && result.repo.id).toBe(5678);
  });

  it("returns private for a private repository", async () => {
    const repo = repoFixture({ private: true });
    const result = await lookupPublicRepository(DAGSTER, { fetch: stubFetch(jsonResponse(200, repo)) });
    expect(result).toEqual({ kind: "private" });
  });

  it("returns not_found for a nonexistent repository", async () => {
    const result = await lookupPublicRepository(
      { owner: "nope", name: "nope" },
      { fetch: stubFetch(jsonResponse(404, { message: "Not Found" })) },
    );
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns rate_limited from the primary-limit headers", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const res = jsonResponse(
      403,
      { message: "API rate limit exceeded" },
      { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) },
    );
    const result = await lookupPublicRepository(DAGSTER, { fetch: stubFetch(res) });
    expect(result.kind).toBe("rate_limited");
    const wait = result.kind === "rate_limited" ? result.retryAfterSeconds : -1;
    expect(wait).toBeGreaterThanOrEqual(29);
    expect(wait).toBeLessThanOrEqual(32);
  });

  it("returns rate_limited from Retry-After on a secondary limit", async () => {
    const res = jsonResponse(429, { message: "slow down" }, { "Retry-After": "7" });
    const result = await lookupPublicRepository(DAGSTER, { fetch: stubFetch(res) });
    expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
  });

  it("returns upstream_error for a plain 403", async () => {
    const res = jsonResponse(403, { message: "Forbidden" });
    const result = await lookupPublicRepository(DAGSTER, { fetch: stubFetch(res) });
    expect(result).toEqual({ kind: "upstream_error", status: 403, message: "Forbidden" });
  });

  it("returns upstream_error for a 5xx", async () => {
    const result = await lookupPublicRepository(DAGSTER, {
      fetch: stubFetch(new Response("bad gateway", { status: 502 })),
    });
    expect(result).toMatchObject({ kind: "upstream_error", status: 502 });
  });

  it("returns upstream_error when fetch throws", async () => {
    const result = await lookupPublicRepository(DAGSTER, { fetch: stubFetch(new Error("boom")) });
    expect(result).toEqual({ kind: "upstream_error", status: 0, message: "boom" });
  });

  it("returns upstream_error for a malformed 200 body", async () => {
    const result = await lookupPublicRepository(DAGSTER, {
      fetch: stubFetch(jsonResponse(200, { hello: "world" })),
    });
    expect(result).toMatchObject({ kind: "upstream_error", status: 200 });
  });

  it("sends the GitHub headers and the bearer token only when given", async () => {
    const withToken = stubFetch(jsonResponse(200, repoFixture()));
    await lookupPublicRepository(DAGSTER, { fetch: withToken, token: "t0k" });
    const [url, init] = withToken.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/dagster-io/dagster");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(headers.get("User-Agent")).toBe("contexttrace-worker");
    expect(headers.get("Authorization")).toBe("Bearer t0k");

    const withoutToken = stubFetch(jsonResponse(200, repoFixture()));
    await lookupPublicRepository(DAGSTER, { fetch: withoutToken });
    expect(new Headers(withoutToken.mock.calls[0][1]?.headers).get("Authorization")).toBeNull();
  });
});

describe("countIssuesAndPullRequests", () => {
  it("reads the newest issue or pull request number", async () => {
    const fetch = stubFetch(jsonResponse(200, [{ number: 742 }]));
    expect(await countIssuesAndPullRequests("dagster-io/dagster", { fetch })).toEqual({ kind: "ok", items: 742 });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repos/dagster-io/dagster/issues?state=all&sort=created&direction=desc&per_page=1");
  });

  it("counts zero for an empty list or turned-off issues", async () => {
    expect(await countIssuesAndPullRequests("a/b", { fetch: stubFetch(jsonResponse(200, [])) })).toEqual({ kind: "ok", items: 0 });
    expect(await countIssuesAndPullRequests("a/b", { fetch: stubFetch(jsonResponse(410, { message: "Issues are disabled" })) })).toEqual({ kind: "ok", items: 0 });
  });

  it("returns rate_limited and upstream_error like the lookup", async () => {
    const limited = jsonResponse(403, { message: "API rate limit exceeded" }, { "Retry-After": "7" });
    expect(await countIssuesAndPullRequests("a/b", { fetch: stubFetch(limited) })).toEqual({ kind: "rate_limited", retryAfterSeconds: 7 });
    expect(await countIssuesAndPullRequests("a/b", { fetch: stubFetch(jsonResponse(200, { hello: "world" })) })).toMatchObject({ kind: "upstream_error" });
  });
});
