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
