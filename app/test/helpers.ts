import type { GitHubRepo } from "../worker/github-api.ts";

/** Builds a minimal GitHub "Get a repository" response body. */
export function repoFixture(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  const full_name = overrides.full_name ?? "dagster-io/dagster";
  const [login, name] = full_name.split("/");
  return { id: 1234, name, full_name, owner: { login }, private: false, ...overrides };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
