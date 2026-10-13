import { vi } from "vitest";
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

export type FakeMessage = {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack: ReturnType<typeof vi.fn<() => void>>;
  retry: ReturnType<typeof vi.fn<(options?: QueueRetryOptions) => void>>;
};

/** A queue message with spies for ack and retry, shaped like the runtime's Message. */
export function fakeMessage(body: unknown, attempts = 1): FakeMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn<() => void>(),
    retry: vi.fn<(options?: QueueRetryOptions) => void>(),
  };
}

export type FakeGitHub = { fetch: typeof globalThis.fetch; requests: URL[] };

/**
 * A stubbed GitHub list endpoint: serves `pages` in order with rel="next" Link headers
 * and records every request. `respond` can override any request, for error cases;
 * `headersFor` adds headers to a page's response, for rate-limit cases.
 */
export function fakeGitHubPages(
  pages: unknown[][],
  respond?: (url: URL) => Response | undefined,
  headersFor?: (page: number) => Record<string, string>,
): FakeGitHub {
  const requests: URL[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    const override = respond?.(url);
    if (override) return override;
    const page = Number(url.searchParams.get("page") ?? "1");
    const headers: Record<string, string> = { "X-RateLimit-Remaining": "4999", ...headersFor?.(page) };
    if (page < pages.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.Link = `<${next}>; rel="next"`;
    }
    return jsonResponse(200, pages[page - 1] ?? [], headers);
  });
  return { fetch, requests };
}
