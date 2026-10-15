import { env } from "cloudflare:workers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, vi } from "vitest";
import { Budget, type BudgetResource } from "../../worker/src/queue/budget.ts";
import type { PendingPassage } from "../../worker/src/etl/embed.ts";
import { contentHash } from "../../worker/src/etl/passages.ts";
import { upsertSources } from "../../worker/src/etl/sources.ts";
import type { GitHubRepo } from "../../worker/src/api/github-api.ts";

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
 * `headersFor` adds headers to a page's response, for rate-limit cases. With
 * `linkRepositoryId` the next links take GitHub's real form, which names the repository
 * by id (`/repositories/{id}/issues?page=2`) instead of `/repos/{owner}/{name}/`.
 */
export function fakeGitHubPages(
  pages: unknown[][],
  respond?: (url: URL) => Response | undefined,
  headersFor?: (page: number) => Record<string, string>,
  options: { linkRepositoryId?: number } = {},
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
      if (options.linkRepositoryId !== undefined) next.pathname = next.pathname.replace(/^\/repos\/[^/]+\/[^/]+\//, `/repositories/${options.linkRepositoryId}/`);
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

/** The production limits, so a scoped test ledger behaves like the global one unless overridden. */
export const BUDGET_DEFAULTS: Record<BudgetResource, { period: "hour" | "day" | "month" | "gauge"; limit: number }> = {
  ai_neurons_milli: { period: "day", limit: 8_000_000 },
  github_requests_auth: { period: "hour", limit: 4000 },
  github_requests_anon: { period: "hour", limit: 48 },
  queue_ops: { period: "day", limit: 8000 },
  searches: { period: "day", limit: 20_000 },
  registrations: { period: "day", limit: 50 },
  db_egress_bytes: { period: "month", limit: 4_000_000_000 },
  storage_bytes: { period: "gauge", limit: 400_000_000 },
};

/** Seeds every budget row under its own scope, so parallel test files never share a ledger. */
export async function seedBudget(db: SupabaseClient, scope: string, limits: Partial<Record<BudgetResource, number>> = {}): Promise<Budget> {
  const rows = Object.entries(BUDGET_DEFAULTS).map(([resource, d]) => ({
    scope,
    resource,
    period: d.period,
    limit_amount: limits[resource as BudgetResource] ?? d.limit,
    window_start: new Date().toISOString(),
  }));
  const { error } = await db.from("usage_budgets").insert(rows);
  if (error) throw new Error(error.message);
  return new Budget(db, scope);
}

export async function dropBudget(db: SupabaseClient, scope: string): Promise<void> {
  await db.from("usage_budgets").delete().eq("scope", scope);
}

/** A test double for the handler's ExecutionContext. */
export function fakeExecutionContext(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

/** Fills a resource of a scoped ledger up to its limit. */
export async function exhaustBudget(budget: Budget, resource: BudgetResource): Promise<void> {
  const state = (await budget.summary()).find((b) => b.resource === resource)!;
  await budget.settle(resource, state.limit - state.used);
}

/** The values that must never appear in a response: every secret and credential the Worker holds. */
export const SECRET_ENV_NAMES = ["SUPABASE_SECRET_KEY", "WORKERS_AI_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GITHUB_TOKEN", "ADMIN_TOKEN", "TURNSTILE_SECRET_KEY", "SUPABASE_PASSWORD"] as const;

/** Fails when any configured secret value, or an extra marker, appears in the text. */
export function expectNoSecrets(text: string, extraMarkers: string[] = []): void {
  const values = SECRET_ENV_NAMES.map((name) => (env as unknown as Record<string, string | undefined>)[name]).filter((v): v is string => Boolean(v));
  expect(values.length).toBeGreaterThan(0);
  for (const secret of [...values, ...extraMarkers]) expect(text).not.toContain(secret);
}
