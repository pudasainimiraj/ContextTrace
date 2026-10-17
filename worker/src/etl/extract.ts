import type { SupabaseClient } from "@supabase/supabase-js";
import type { RepositoryRecord, SourceType } from "../../../shared/api.ts";
import { getCheckpoint, saveCheckpoint, type StreamCheckpoint } from "./checkpoints.ts";
import { assertGitHubApiUrl, GITHUB_API_ROOT, githubGetPage, type GitHubOptions } from "./github-rest.ts";
import { JobError } from "../queue/retry.ts";
import { type Retirement, retireUnseenSources, type SourceDraft, upsertSources } from "./sources.ts";

/**
 * Page budgets per job run. A stream's first run is a head pass over the newest items,
 * short so the repository becomes searchable quickly. The rest of the history is fetched
 * by backfill runs that take a few pages each and wait BACKFILL_DELAY_SECONDS before the
 * next, so the head passes and syncs of every other repository on the shared queue get
 * ahead of them. Syncs list what changed since the high-water mark and take the most.
 */
export const HEAD_PAGES_PER_RUN = 2;
export const BACKFILL_PAGES_PER_RUN = 3;
export const BACKFILL_DELAY_SECONDS = 10;
export const MAX_PAGES_PER_RUN = 5;
export const PER_PAGE = 100;
/**
 * Items a stream stores at most. A head or backfill run that reaches it stops, marks the
 * stream complete and capped, and coverage and search say so: the index never claims more
 * than it holds. Syncs are not capped: they only read what changed.
 */
export const MAX_ITEMS_PER_STREAM = 5000;
/** A sync lists since the high-water mark minus this, so items re-dated or served late around the mark are seen again. */
export const SYNC_OVERLAP_SECONDS = 300;
/** Stop paging when fewer requests than this remain before the rate limit resets. */
export const RATE_LIMIT_RESERVE = 20;

export type RepoRef = { owner: string; name: string };
export type ListOptions = { since: string | null; direction: "asc" | "desc" };

/** One GitHub list endpoint and how its items become source rows. */
export type StreamSpec<T> = {
  stream: string; // checkpoint key
  sourceTypes: SourceType[]; // what the stream stores; a rescan retires unseen rows of these types
  listUrl: (repo: RepoRef, options: ListOptions) => string;
  toSource: (item: T, repositoryId: number, jobId: number) => SourceDraft;
};

export type ExtractContext = GitHubOptions & { db: SupabaseClient; maxItemsPerStream?: number };

/**
 * fetch_* jobs run the head pass, then syncs; backfill_* jobs continue the descending
 * listing; rescan_* jobs walk it again from the start to find deletions.
 */
export type StreamRole = "fetch" | "backfill" | "rescan";
export type StreamPhase = "head" | "sync" | "backfill" | "rescan";

export type ExtractResult = {
  done: boolean;
  phase: StreamPhase;
  followUpKind: string | null; // a low-priority job kind that must be waiting after this run
  retired?: Retirement; // what a completed rescan removed
  capped?: boolean; // the run stopped at MAX_ITEMS_PER_STREAM
  pages: number;
  records: number; // items received from GitHub
  bytes: number; // response bodies received
  upsertBytes: number; // JSON sent to upsert_sources
  inserted: number;
  updated: number;
  unchanged: number;
};

/**
 * Page-limited, resumable extraction of one stream, in one of three phases decided by
 * the job's role and the checkpoint:
 *
 * - head (fetch_*, no head_done_at): the newest items first, HEAD_PAGES_PER_RUN pages.
 *   Sets the high-water mark from what it saw and, when pages remain, leaves `cursor`
 *   for the backfill and reports backfillPending.
 * - backfill (backfill_*): continues the descending listing from `cursor` for
 *   BACKFILL_PAGES_PER_RUN pages per run until the end, then sets backfill_done_at. It
 *   never moves the high-water mark, so a sync can run at the same time.
 * - sync (fetch_*, head done): ascending listing since the high-water mark, continued
 *   from `sync_cursor` when a run hits MAX_PAGES_PER_RUN; the mark advances on completion.
 * - rescan (rescan_*): the descending listing again from the start, in backfill-sized runs,
 *   once the backfill is complete. Every row it returns gets a fresh seen_at; at the end the
 *   stream's rows not seen since the rescan began are retired with their passages and
 *   vectors. Like the backfill it never moves the high-water mark.
 *
 * A run about to exhaust the rate limit saves its position and raises a transient
 * rate_limited error timed to the reset, so the same job resumes from the cursor.
 */
export async function extractStream<T>(
  ctx: ExtractContext,
  spec: StreamSpec<T>,
  repository: RepositoryRecord,
  jobId: number,
  role: StreamRole = "fetch",
): Promise<ExtractResult> {
  const repo = { owner: repository.owner, name: repository.name };
  const checkpoint = await getCheckpoint(ctx.db, repository.id, spec.stream);
  const phase: StreamPhase = role === "fetch" ? (checkpoint?.head_done_at ? "sync" : "head") : role;
  const totals = { pages: 0, records: 0, bytes: 0, upsertBytes: 0, inserted: 0, updated: 0, unchanged: 0 };
  const nothing = (): ExtractResult => ({ done: true, phase, followUpKind: null, ...totals });

  let url: string;
  let budget: number;
  let rescanStartedAt: string | null = null;
  if (phase === "head") {
    url = checkpoint?.cursor ?? spec.listUrl(repo, { since: null, direction: "desc" });
    budget = HEAD_PAGES_PER_RUN;
  } else if (phase === "backfill") {
    // Nothing to do once the listing reached the end, or while a rescan owns the cursor.
    if (!checkpoint?.cursor || checkpoint.rescan_started_at) return nothing();
    url = checkpoint.cursor;
    budget = BACKFILL_PAGES_PER_RUN;
  } else if (phase === "rescan") {
    // A rescan starts only after the backfill; a cursor without rescan_started_at is the backfill's.
    if (!checkpoint?.backfill_done_at || (checkpoint.cursor && !checkpoint.rescan_started_at)) return nothing();
    rescanStartedAt = checkpoint.rescan_started_at ?? new Date().toISOString();
    url = checkpoint.rescan_started_at ? (checkpoint.cursor ?? spec.listUrl(repo, { since: null, direction: "desc" })) : spec.listUrl(repo, { since: null, direction: "desc" });
    budget = BACKFILL_PAGES_PER_RUN;
  } else {
    const since = checkpoint?.last_item_at ? overlapSince(checkpoint.last_item_at) : null;
    url = checkpoint?.sync_cursor ?? spec.listUrl(repo, { since, direction: "asc" });
    budget = MAX_PAGES_PER_RUN;
  }

  let highWater = checkpoint?.last_item_at ? Date.parse(checkpoint.last_item_at) : 0;
  const mark = () => (highWater ? new Date(highWater).toISOString() : null);
  const now = () => new Date().toISOString();
  /** The stored row plus this run's counters and the given changes. */
  const save = (changes: Partial<StreamCheckpoint>) =>
    saveCheckpoint(ctx.db, {
      repository_id: repository.id,
      stream: spec.stream,
      job_id: jobId,
      pages_fetched: (checkpoint?.pages_fetched ?? 0) + totals.pages,
      items_fetched: (checkpoint?.items_fetched ?? 0) + totals.records,
      ...changes,
    });
  /**
   * Where to continue: the head hands its pages to the backfill, the others continue
   * themselves. A paused sync also advances the high-water mark: the listing is ascending,
   * so everything before the cursor has been stored and what follows is newer.
   */
  const paused = (next: string): Partial<StreamCheckpoint> =>
    phase === "sync"
      ? { sync_cursor: next, last_item_at: mark() }
      : phase === "head"
        ? { cursor: next, head_done_at: now(), last_item_at: mark(), last_synced_at: now() }
        : phase === "rescan"
          ? { cursor: next, rescan_started_at: rescanStartedAt }
          : { cursor: next };
  // A sync also reports a backfill or rescan that still owns the cursor, in case its job was lost.
  const pendingWalk = checkpoint?.cursor ? (checkpoint.rescan_started_at ? rescanKind(spec.stream) : backfillKind(spec.stream)) : null;

  for (;;) {
    // Cursors come back from the database: a tampered one is dropped and the job fails.
    try {
      assertGitHubApiUrl(url, { ...repo, id: repository.id });
    } catch (err) {
      await save({ cursor: null, sync_cursor: null, rescan_started_at: null });
      throw err;
    }
    const page = await githubGetPage<T>(url, { token: ctx.token, fetch: ctx.fetch, budget: ctx.budget });
    totals.pages += 1;
    totals.bytes += page.bytes;

    const rows = newestPerKey(page.items.map((item) => spec.toSource(item, repository.id, jobId)));
    const counts = await upsertSources(ctx.db, rows);
    totals.records += page.items.length; // items received; inserted + updated + unchanged = rows upserted
    totals.upsertBytes += new TextEncoder().encode(JSON.stringify(rows)).length;
    totals.inserted += counts.inserted;
    totals.updated += counts.updated;
    totals.unchanged += counts.unchanged;
    if (phase === "head" || phase === "sync") for (const row of rows) highWater = Math.max(highWater, Date.parse(row.updated_at));

    if (page.nextUrl && page.remaining !== null && page.remaining < RATE_LIMIT_RESERVE) {
      await save(paused(page.nextUrl));
      const wait = page.resetAt ? Math.max(1, page.resetAt - Math.floor(Date.now() / 1000) + 1) : 60;
      throw new JobError(
        "rate_limited",
        `GitHub rate limit nearly exhausted (${page.remaining} requests left); resuming after the reset`,
        { transient: true, retryAfterSeconds: wait },
      );
    }
    // The cap: the listing is treated as finished here. A capped rescan retires nothing,
    // because what lies beyond the cap was never seen.
    const stored = (checkpoint?.items_fetched ?? 0) + totals.records;
    const cap = ctx.maxItemsPerStream ?? MAX_ITEMS_PER_STREAM;
    if (page.nextUrl && phase !== "sync" && stored >= cap) {
      await save(
        phase === "rescan"
          ? { cursor: null, rescan_started_at: null, last_rescan_at: now(), capped_at: now() }
          : { cursor: null, head_done_at: checkpoint?.head_done_at ?? now(), backfill_done_at: now(), capped_at: now(), ...(phase === "head" ? { last_item_at: mark(), last_synced_at: now() } : {}) },
      );
      return { done: true, phase, followUpKind: null, capped: true, ...totals };
    }
    if (page.nextUrl && totals.pages < budget) {
      url = page.nextUrl;
      continue;
    }
    if (page.nextUrl) {
      await save(paused(page.nextUrl));
      return { done: phase === "head", phase, followUpKind: phase === "head" ? backfillKind(spec.stream) : phase === "sync" ? pendingWalk : null, ...totals };
    }
    if (phase === "rescan") {
      const retired = await retireUnseenSources(ctx.db, repository.id, spec.sourceTypes, rescanStartedAt!);
      await save({ cursor: null, rescan_started_at: null, last_rescan_at: now() });
      return { done: true, phase, followUpKind: null, retired, ...totals };
    }
    await save(
      phase === "sync"
        ? { sync_cursor: null, last_item_at: mark(), last_synced_at: now() }
        : phase === "head"
          ? { cursor: null, head_done_at: now(), backfill_done_at: now(), last_item_at: mark(), last_synced_at: now() }
          : { cursor: null, backfill_done_at: now() },
    );
    return { done: true, phase, followUpKind: phase === "sync" ? pendingWalk : null, ...totals };
  }
}

/** One row per (type, github_id), keeping the newest; a batch cannot update a row twice. */
export function newestPerKey(rows: SourceDraft[]): SourceDraft[] {
  const byKey = new Map<string, SourceDraft>();
  for (const row of rows) {
    const key = `${row.type}:${row.github_id}`;
    const seen = byKey.get(key);
    if (!seen || Date.parse(row.updated_at) >= Date.parse(seen.updated_at)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

/** The `since` of a sync: the high-water mark minus the overlap. Re-read unchanged items cost nothing. */
export function overlapSince(lastItemAt: string): string {
  return toGitHubTimestamp(new Date(Date.parse(lastItemAt) - SYNC_OVERLAP_SECONDS * 1000).toISOString());
}

/** GitHub wants YYYY-MM-DDTHH:MM:SSZ for `since`. */
export function toGitHubTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function listUrl(repo: RepoRef, resource: string, options: ListOptions): string {
  const url = new URL(
    `${GITHUB_API_ROOT}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${resource}`,
  );
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", options.direction);
  url.searchParams.set("per_page", String(PER_PAGE));
  if (options.since) url.searchParams.set("since", options.since);
  return url.toString();
}

/** Shape of an item from GET /repos/{owner}/{repo}/issues; pull requests carry pull_request. */
export type GitHubIssue = {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { url: string; html_url: string };
};

/** Issues and pull requests, which GitHub lists together. */
export const ISSUES_STREAM: StreamSpec<GitHubIssue> = {
  stream: "issues",
  sourceTypes: ["issue", "pull_request"],
  listUrl: (repo, options) => {
    const url = new URL(listUrl(repo, "issues", options));
    url.searchParams.set("state", "all");
    return url.toString();
  },
  toSource: (item, repositoryId, jobId) => ({
    repository_id: repositoryId,
    type: item.pull_request ? "pull_request" : "issue",
    github_id: item.id,
    number: item.number,
    node_id: item.node_id,
    title: item.title,
    author: item.user?.login ?? null,
    body: item.body,
    state: item.state,
    html_url: item.html_url,
    api_url: item.pull_request?.url ?? item.url,
    path: null,
    line: null,
    in_reply_to_id: null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.closed_at,
    fetched_by_job: jobId,
  }),
};

/** Shape of an item from GET /repos/{owner}/{repo}/issues/comments. */
export type GitHubIssueComment = {
  id: number;
  node_id: string;
  url: string;
  html_url: string; // permalink: .../issues/N#issuecomment-ID, or .../pull/N for a PR
  issue_url: string; // .../issues/N for issues and pull requests alike
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  updated_at: string;
};

/** The issue or pull request number at the end of an API URL. */
export function numberFromUrl(url: string): number {
  return Number(url.slice(url.lastIndexOf("/") + 1));
}

/**
 * Conversation comments on issues and pull requests. GitHub serves both from the
 * issues/comments endpoint; inline review comments are a separate stream.
 */
export const ISSUE_COMMENTS_STREAM: StreamSpec<GitHubIssueComment> = {
  stream: "issue_comments",
  sourceTypes: ["issue_comment"],
  listUrl: (repo, options) => listUrl(repo, "issues/comments", options),
  toSource: (item, repositoryId, jobId) => ({
    repository_id: repositoryId,
    type: "issue_comment",
    github_id: item.id,
    number: numberFromUrl(item.issue_url),
    node_id: item.node_id,
    title: null,
    author: item.user?.login ?? null,
    body: item.body,
    state: null,
    html_url: item.html_url,
    api_url: item.url,
    path: null,
    line: null,
    in_reply_to_id: null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: null,
    fetched_by_job: jobId,
  }),
};

/** Shape of an item from GET /repos/{owner}/{repo}/pulls/comments. */
export type GitHubReviewComment = {
  id: number;
  node_id: string;
  url: string;
  html_url: string; // permalink: .../pull/N#discussion_rID
  pull_request_url: string; // .../pulls/N
  path: string;
  line: number | null; // null once the diff is outdated
  original_line: number | null;
  in_reply_to_id?: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  updated_at: string;
};

/** Inline review comments on pull request diffs, with their own checkpoint. */
export const REVIEW_COMMENTS_STREAM: StreamSpec<GitHubReviewComment> = {
  stream: "review_comments",
  sourceTypes: ["review_comment"],
  listUrl: (repo, options) => listUrl(repo, "pulls/comments", options),
  toSource: (item, repositoryId, jobId) => ({
    repository_id: repositoryId,
    type: "review_comment",
    github_id: item.id,
    number: numberFromUrl(item.pull_request_url),
    node_id: item.node_id,
    title: null,
    author: item.user?.login ?? null,
    body: item.body,
    state: null,
    html_url: item.html_url,
    api_url: item.url,
    path: item.path,
    line: item.line ?? item.original_line,
    in_reply_to_id: item.in_reply_to_id ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: null,
    fetched_by_job: jobId,
  }),
};

const SPECS = [ISSUES_STREAM, ISSUE_COMMENTS_STREAM, REVIEW_COMMENTS_STREAM] as StreamSpec<never>[];

export function fetchKind(stream: string): string {
  return `fetch_${stream}`;
}

export function backfillKind(stream: string): string {
  return `backfill_${stream}`;
}

export function rescanKind(stream: string): string {
  return `rescan_${stream}`;
}

/** Job kind -> stream and role. fetch_* runs the head pass and the syncs; backfill_* the history; rescan_* the deletion sweep. */
export const STREAM_KINDS: Record<string, { spec: StreamSpec<never>; role: StreamRole }> = Object.fromEntries(
  SPECS.flatMap((spec) => [
    [fetchKind(spec.stream), { spec, role: "fetch" }],
    [backfillKind(spec.stream), { spec, role: "backfill" }],
    [rescanKind(spec.stream), { spec, role: "rescan" }],
  ]),
);

/** Stream -> the source types it stores. */
export const STREAM_SOURCE_TYPES: Record<string, SourceType[]> = Object.fromEntries(SPECS.map((spec) => [spec.stream, spec.sourceTypes]));

/** The jobs that start a repository: one head pass per stream. */
export const FETCH_KINDS = SPECS.map((spec) => fetchKind(spec.stream));
