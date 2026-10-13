import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import type { PendingPassage } from "../worker/embed.ts";
import { contentHash } from "../worker/passages.ts";
import { upsertSources } from "../worker/sources.ts";
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

/**
 * Inserts passages for a repository without running the transform: one issue source,
 * one document and one passage per item, with real content hashes. Items get consecutive
 * chunk indexes starting at `firstIndex`, so later calls for the same repository must
 * continue the numbering.
 */
export async function insertPassages(
  db: SupabaseClient,
  repositoryId: number,
  items: { text: string; tokenCount?: number }[],
  firstIndex = 0,
): Promise<PendingPassage[]> {
  const documentId = `github:${repositoryId}:issue:1`;
  if (firstIndex === 0) {
    await upsertSources(db, [
      {
        repository_id: repositoryId,
        type: "issue",
        github_id: 1,
        number: 1,
        node_id: null,
        title: "Fixture thread",
        author: "ann",
        body: "fixture",
        state: "open",
        html_url: "https://github.com/o/r/issues/1",
        api_url: "https://api.github.com/repos/o/r/issues/1",
        path: null,
        line: null,
        in_reply_to_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        closed_at: null,
        fetched_by_job: null,
      },
    ]);
    const doc = await db.from("documents").upsert({
      document_id: documentId,
      repository_id: repositoryId,
      type: "issue",
      number: 1,
      title: "Fixture thread",
      transform_version: "fixture",
      sources_fetched_at: "2026-01-01T00:00:00Z",
    });
    if (doc.error) throw new Error(doc.error.message);
  }
  const rows = await Promise.all(
    items.map(async (item, i) => {
      const index = firstIndex + i;
      return {
        passage_id: `${documentId}:body:${index}`,
        document_id: documentId,
        repository_id: repositoryId,
        source_type: "issue",
        source_github_id: 1,
        chunk_index: index,
        chunk_count: index + 1,
        token_count: item.tokenCount ?? Math.ceil(item.text.length / 4) + 2,
        tokenizer: "fixture",
        locator: `Opening body (part ${index + 1})`,
        author: "ann",
        created_at: "2026-01-01T00:00:00Z",
        source_url: "https://github.com/o/r/issues/1",
        text: item.text,
        text_kind: "normalized_markdown",
        content_hash: await contentHash(item.text),
        transform_version: "fixture",
      };
    }),
  );
  const { error } = await db.from("passages").insert(rows);
  if (error) throw new Error(error.message);
  return rows.map((r) => ({ passage_id: r.passage_id, text: r.text, token_count: r.token_count, content_hash: r.content_hash }));
}
