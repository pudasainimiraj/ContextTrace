import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord, RepositoryStatus, SearchResponse, StreamCoverage } from "../shared/api.ts";
import { consumeJobMessage } from "../worker/consumer.ts";
import { getCoverage } from "../worker/coverage.ts";
import { FakeEmbeddingClient } from "../worker/embeddings.ts";
import {
  BACKFILL_DELAY_SECONDS,
  BACKFILL_PAGES_PER_RUN,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubReviewComment,
  HEAD_PAGES_PER_RUN,
  toGitHubTimestamp,
} from "../worker/extract.ts";
import type { JobMessage, JobQueue } from "../worker/jobs.ts";
import { startExtraction } from "../worker/pipeline.ts";
import { createDb, getRepository, upsertRepository } from "../worker/repositories.ts";
import { search } from "../worker/search.ts";
import { listSources } from "../worker/sources.ts";
import { scheduleSyncs } from "../worker/sync.ts";
import { type FakeGitHub, fakeGitHubPages, fakeMessage, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project with GitHub stubbed; see jobs.test.ts for the id
// scheme. Two repositories share one queue: "small" (one page per stream) and "large"
// (twelve pages of issues). Deliveries are simulated in virtual time, so a delayed message
// is delivered after every undelayed message sent before its due time, as the real queue does.
const SMALL = Date.now() * 100 + 42;
const LARGE = SMALL + 1;
const db = createDb(env);
const api = (owner: string) => `https://api.github.com/repos/${owner}/repo`;
const web = (owner: string) => `https://github.com/${owner}/repo`;
const at = (n: number) => toGitHubTimestamp(new Date(Date.UTC(2026, 2, 1) + n * 60_000).toISOString());
const LONG_TIMEOUT = 180_000;

function issue(owner: string, n: number): GitHubIssue {
  return {
    id: 1000 + n,
    node_id: `I_${owner}_${n}`,
    number: n,
    title: `Issue ${n}`,
    state: "open",
    body: `Issue ${n} of ${owner} discusses scheduler drift after daylight saving changes.`,
    html_url: `${web(owner)}/issues/${n}`,
    url: `${api(owner)}/issues/${n}`,
    user: { login: "bob" },
    created_at: at(0),
    updated_at: at(n),
    closed_at: null,
  };
}

function comment(owner: string, k: number, number: number): GitHubIssueComment {
  const id = 5000 + k;
  return {
    id,
    node_id: `IC_${owner}_${k}`,
    url: `${api(owner)}/issues/comments/${id}`,
    html_url: `${web(owner)}/issues/${number}#issuecomment-${id}`,
    issue_url: `${api(owner)}/issues/${number}`,
    user: { login: "carol" },
    body: `Comment ${k} on issue ${number} of ${owner}.`,
    created_at: at(0),
    updated_at: at(k),
  };
}

function review(owner: string, k: number, number: number): GitHubReviewComment {
  const id = 7000 + k;
  return {
    id,
    node_id: `RC_${owner}_${k}`,
    url: `${api(owner)}/pulls/comments/${id}`,
    html_url: `${web(owner)}/pull/${number}#discussion_r${id}`,
    pull_request_url: `${api(owner)}/pulls/${number}`,
    path: "src/a.ts",
    line: 12,
    original_line: 12,
    user: { login: "dave" },
    body: `Review ${k} on pull ${number} of ${owner}.`,
    created_at: at(0),
    updated_at: at(k),
  };
}

function pagesOf<T>(items: T[], perPage: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  return pages;
}

// The pull request that carries the review comment is listed as a pull request in the issues stream.
const withPull = (owner: string, item: GitHubIssue): GitHubIssue => ({ ...item, pull_request: { url: `${api(owner)}/pulls/${item.number}`, html_url: `${web(owner)}/pull/${item.number}` } });

const PAGES = {
  small: {
    issues: [[issue("small", 1), withPull("small", issue("small", 2)), issue("small", 3)]],
    issue_comments: [[comment("small", 1, 1), comment("small", 2, 3)]],
    review_comments: [[review("small", 1, 2)]],
  },
  large: {
    issues: pagesOf(Array.from({ length: 36 }, (_, i) => (i === 1 ? withPull("large", issue("large", i + 1)) : issue("large", i + 1))), 3),
    issue_comments: [[comment("large", 1, 1), comment("large", 2, 5)]],
    review_comments: [[review("large", 1, 2)]],
  },
};
type Stream = keyof typeof PAGES.small;
const fakes: Record<string, Record<Stream, FakeGitHub>> = Object.fromEntries(
  Object.entries(PAGES).map(([owner, streams]) => [owner, Object.fromEntries(Object.entries(streams).map(([s, pages]) => [s, fakeGitHubPages(pages)]))]),
) as Record<string, Record<Stream, FakeGitHub>>;

/** Routes a GitHub request to the stub of its repository and stream. */
const routedFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const owner = url.pathname.split("/")[2];
  const stream: Stream = url.pathname.endsWith("/issues/comments") ? "issue_comments" : url.pathname.endsWith("/pulls/comments") ? "review_comments" : "issues";
  return fakes[owner][stream].fetch(input, init);
};

type Delivery = { at: number; kind: string; repoId: number };

/** A shared queue in virtual time: the earliest due message first, FIFO among equals. */
class VirtualQueue implements JobQueue {
  clock = 0;
  private seq = 0;
  private pending: { body: JobMessage; dueAt: number; seq: number }[] = [];
  readonly log: Delivery[] = [];
  async send(body: JobMessage, options?: { delaySeconds?: number }): Promise<void> {
    this.pending.push({ body, dueAt: this.clock + (options?.delaySeconds ?? 0), seq: this.seq++ });
  }
  next(): JobMessage | undefined {
    if (this.pending.length === 0) return undefined;
    this.pending.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
    const message = this.pending.shift()!;
    this.clock = Math.max(this.clock, message.dueAt);
    return message.body;
  }
}

const embeddings = new FakeEmbeddingClient();
const queue = new VirtualQueue();

async function drain(onDelivered?: (delivery: Delivery, index: number) => Promise<void>): Promise<Delivery[]> {
  const start = queue.log.length;
  for (let body = queue.next(); body; body = queue.next()) {
    await consumeJobMessage({ db, queue, fetch: routedFetch, embeddings }, fakeMessage(body), "worker");
    const delivery = { at: queue.clock, kind: body.kind, repoId: body.repoId };
    queue.log.push(delivery);
    await onDelivered?.(delivery, queue.log.length - 1);
    if (queue.log.length - start > 300) throw new Error("the queue never drained");
  }
  return queue.log.slice(start);
}

async function statusOf(id: number): Promise<RepositoryStatus> {
  return (await getRepository(db, id))!.status;
}

async function jobsSince(lastId: number): Promise<Pick<JobRecord, "id" | "repository_id" | "kind" | "state" | "result">[]> {
  const { data } = await db.from("jobs").select("id, repository_id, kind, state, result").in("repository_id", [SMALL, LARGE]).gt("id", lastId).order("id");
  return (data ?? []) as Pick<JobRecord, "id" | "repository_id" | "kind" | "state" | "result">[];
}

async function lastJobId(): Promise<number> {
  const { data } = await db.from("jobs").select("id").in("repository_id", [SMALL, LARGE]).order("id", { ascending: false }).limit(1);
  return (data?.[0] as { id: number } | undefined)?.id ?? 0;
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: SMALL, full_name: "small/repo" }));
  await upsertRepository(db, repoFixture({ id: LARGE, full_name: "large/repo" }));
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [SMALL, LARGE]);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("two repositories on one queue", () => {
  const seen: {
    smallStatus?: RepositoryStatus;
    largeStatus?: RepositoryStatus;
    largeSearch?: SearchResponse;
    largeIssues?: StreamCoverage;
  } = {};

  it(
    "finishes the small repository before the large one's backfill, which stays searchable while it runs",
    async () => {
      // The large repository registers first: the worst case for the small one.
      await startExtraction(db, queue, LARGE);
      await startExtraction(db, queue, SMALL);
      const log = await drain(async (delivery) => {
        if (delivery.repoId === SMALL && delivery.kind === "embed_passages" && !seen.smallStatus) {
          seen.smallStatus = await statusOf(SMALL);
          seen.largeStatus = await statusOf(LARGE);
          const large = (await getRepository(db, LARGE))!;
          seen.largeSearch = await search({ db, embeddings }, { repository: large, query: PAGES.large.issues[0][0].body! });
          seen.largeIssues = (await getCoverage(db, large)).streams.find((s) => s.stream === "issues");
        }
      });

      // Every delivery for the small repository came before the large one's first backfill run.
      const firstBackfill = log.findIndex((d) => d.kind === "backfill_issues");
      expect(firstBackfill).toBeGreaterThan(0);
      const smallDeliveries = log.filter((d) => d.repoId === SMALL);
      expect(smallDeliveries.length).toBeGreaterThanOrEqual(5); // three heads, a transform, an embed
      expect(log.slice(0, firstBackfill).filter((d) => d.repoId === SMALL)).toHaveLength(smallDeliveries.length);
      expect(smallDeliveries.every((d) => d.at === 0)).toBe(true);

      // The backfill took its pages in delayed runs: 36 issues = 2 head pages + 10 pages in runs of 3.
      const backfills = log.filter((d) => d.kind === "backfill_issues");
      expect(backfills.map((d) => d.at)).toEqual([1, 2, 3, 4].map((i) => i * BACKFILL_DELAY_SECONDS));
      expect(fakes.large.issues.requests).toHaveLength(12);
      expect(fakes.small.issues.requests).toHaveLength(1);
      expect(log.filter((d) => d.repoId === LARGE && d.kind === "transform_passages").length).toBeGreaterThanOrEqual(1 + backfills.length);

      // When the small repository became searchable the large one was partial, and usable.
      expect(seen.smallStatus).toBe("searchable");
      expect(seen.largeStatus).toBe("searchable_partial");
      expect(seen.largeSearch).toMatchObject({ mode: "semantic", confidence: "high" });
      expect(seen.largeSearch!.results.length).toBeGreaterThan(0);
      expect(seen.largeSearch!.results[0].source_url).toBe(`${web("large")}/issues/1`);
      expect(seen.largeSearch!.index).toMatchObject({ status: "searchable_partial", partial: true });
      expect(seen.largeSearch!.index.warning).toMatch(/^Partial index: \d+ of \d+ passages are searchable/);
      expect(seen.largeIssues).toMatchObject({ phase: "backfill", backfill_pending: true, items_fetched: HEAD_PAGES_PER_RUN * 3, pages_fetched: HEAD_PAGES_PER_RUN });

      // Both end complete.
      expect(await statusOf(SMALL)).toBe("searchable");
      expect(await statusOf(LARGE)).toBe("searchable");
      const large = await getCoverage(db, (await getRepository(db, LARGE))!);
      expect(large).toMatchObject({ partial: false, sources: { issue: 35, pull_request: 1, issue_comment: 2, review_comment: 1 }, pending: 0 });
      expect(large.streams.find((s) => s.stream === "issues")).toMatchObject({ phase: "complete", pages_fetched: 12, items_fetched: 36 });
      expect(large.embedded).toBe(large.passages);
      expect(await listSources(db, SMALL)).toHaveLength(6);
      expect(BACKFILL_PAGES_PER_RUN * backfills.length).toBeGreaterThanOrEqual(10);
    },
    LONG_TIMEOUT,
  );

  it(
    "re-syncs both repositories without re-transforming or re-embedding anything when nothing changed",
    async () => {
      const calls = embeddings.calls.length;
      const since = await lastJobId();
      for (const id of [SMALL, LARGE]) {
        expect((await scheduleSyncs(db, queue, { intervalSeconds: 0, repositoryId: id })).queued).toHaveLength(3);
      }
      const log = await drain();
      expect(log.length).toBeGreaterThanOrEqual(8);

      const jobs = await jobsSince(since);
      expect(jobs.every((j) => j.state === "succeeded")).toBe(true);
      const syncs = jobs.filter((j) => j.kind.startsWith("fetch_"));
      expect(syncs.every((j) => j.result?.phase === "sync" && j.result?.inserted === 0 && j.result?.updated === 0)).toBe(true);
      const unchanged = (id: number) => syncs.filter((j) => j.repository_id === id).reduce((n, j) => n + Number(j.result?.unchanged), 0);
      expect(unchanged(SMALL)).toBe(6);
      expect(unchanged(LARGE)).toBe(39);
      expect(jobs.filter((j) => j.kind === "transform_passages").every((j) => j.result?.documents === 0)).toBe(true);
      expect(jobs.filter((j) => j.kind === "embed_passages").every((j) => j.result?.texts === 0 && j.result?.batches === 0)).toBe(true);
      expect(embeddings.calls).toHaveLength(calls);
    },
    LONG_TIMEOUT,
  );

  it(
    "re-embeds only the passage whose source changed, and serves the new text after the sync",
    async () => {
      const edited = PAGES.large.issues[5][1]; // issue 17, deep in the backfilled history
      edited.body = "Edited: the scheduler now drains the queue in priority order after a daylight saving change.";
      edited.updated_at = at(500);
      const calls = embeddings.calls.length;
      const since = await lastJobId();
      for (const id of [SMALL, LARGE]) await scheduleSyncs(db, queue, { intervalSeconds: 0, repositoryId: id });
      await drain();

      const jobs = await jobsSince(since);
      const updated = jobs.filter((j) => j.kind.startsWith("fetch_")).reduce((n, j) => n + Number(j.result?.updated), 0);
      expect(updated).toBe(1);
      expect(jobs.filter((j) => j.kind === "transform_passages").reduce((n, j) => n + Number(j.result?.documents), 0)).toBe(1);
      expect(jobs.filter((j) => j.kind === "embed_passages").reduce((n, j) => n + Number(j.result?.texts), 0)).toBe(1);
      expect(embeddings.calls).toHaveLength(calls + 1);

      const large = (await getRepository(db, LARGE))!;
      const found = await search({ db, embeddings }, { repository: large, query: edited.body });
      expect(found).toMatchObject({ mode: "semantic", confidence: "high" });
      expect(found.results[0]).toMatchObject({ number: 17, excerpt: edited.body, source_url: `${web("large")}/issues/17` });
      expect(found.index).toEqual({ status: "searchable", partial: false, embedded: found.index.embedded, pending: 0, warning: null });
      const issues = (await getCoverage(db, large)).streams.find((s) => s.stream === "issues")!;
      expect(toGitHubTimestamp(issues.high_water_mark!)).toBe(at(500));
    },
    LONG_TIMEOUT,
  );
});
