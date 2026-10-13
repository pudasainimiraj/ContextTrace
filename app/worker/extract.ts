import type { SupabaseClient } from "@supabase/supabase-js";
import type { RepositoryRecord } from "../shared/api.ts";
import { getCheckpoint, saveCheckpoint } from "./checkpoints.ts";
import { GITHUB_API_ROOT, githubGetPage, type GitHubOptions } from "./github-rest.ts";
import { type SourceDraft, upsertSources } from "./sources.ts";

/** Pages fetched per job run before the job yields to a continuation job. */
export const MAX_PAGES_PER_RUN = 5;
export const PER_PAGE = 100;

export type RepoRef = { owner: string; name: string };

/** One GitHub list endpoint and how its items become source rows. */
export type StreamSpec<T> = {
  stream: string; // checkpoint key
  listUrl: (repo: RepoRef, since: string | null) => string;
  toSource: (item: T, repositoryId: number, jobId: number) => SourceDraft;
};

export type ExtractContext = GitHubOptions & { db: SupabaseClient };

export type ExtractResult = { done: boolean; pages: number; records: number; bytes: number };

/**
 * Page-limited, resumable extraction of one stream. Progress lives in the stream's
 * checkpoint: `cursor` is the next page URL while a listing is in progress, and
 * `last_item_at` is the updated_at high-water mark once a listing completes, which
 * becomes the next listing's `since`. A run that hits MAX_PAGES_PER_RUN saves the cursor
 * and reports done: false so the caller can schedule a continuation.
 */
export async function extractStream<T>(
  ctx: ExtractContext,
  spec: StreamSpec<T>,
  repository: RepositoryRecord,
  jobId: number,
): Promise<ExtractResult> {
  const checkpoint = await getCheckpoint(ctx.db, repository.id, spec.stream);
  const since = checkpoint?.last_item_at ? toGitHubTimestamp(checkpoint.last_item_at) : null;
  let url = checkpoint?.cursor ?? spec.listUrl({ owner: repository.owner, name: repository.name }, since);
  let highWater = checkpoint?.last_item_at ? Date.parse(checkpoint.last_item_at) : 0;
  const totals = { pages: 0, records: 0, bytes: 0 };

  for (;;) {
    const page = await githubGetPage<T>(url, { token: ctx.token, fetch: ctx.fetch });
    totals.pages += 1;
    totals.bytes += page.bytes;

    const rows = page.items.map((item) => spec.toSource(item, repository.id, jobId));
    await upsertSources(ctx.db, rows);
    totals.records += rows.length;
    for (const row of rows) highWater = Math.max(highWater, Date.parse(row.updated_at));

    if (page.nextUrl && totals.pages < MAX_PAGES_PER_RUN) {
      url = page.nextUrl;
      continue;
    }
    const base = { repository_id: repository.id, stream: spec.stream, job_id: jobId };
    if (page.nextUrl) {
      await saveCheckpoint(ctx.db, { ...base, cursor: page.nextUrl, last_item_at: checkpoint?.last_item_at ?? null });
      return { done: false, ...totals };
    }
    await saveCheckpoint(ctx.db, {
      ...base,
      cursor: null,
      last_item_at: highWater ? new Date(highWater).toISOString() : null,
    });
    return { done: true, ...totals };
  }
}

/** GitHub wants YYYY-MM-DDTHH:MM:SSZ for `since`. */
export function toGitHubTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function listUrl(repo: RepoRef, resource: string, since: string | null): string {
  const url = new URL(
    `${GITHUB_API_ROOT}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${resource}`,
  );
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", String(PER_PAGE));
  if (since) url.searchParams.set("since", since);
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
  listUrl: (repo, since) => {
    const url = new URL(listUrl(repo, "issues", since));
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
  listUrl: (repo, since) => listUrl(repo, "issues/comments", since),
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

/** Job kind -> stream. */
export const STREAMS: Record<string, StreamSpec<never>> = {
  fetch_issues: ISSUES_STREAM as StreamSpec<never>,
  fetch_issue_comments: ISSUE_COMMENTS_STREAM as StreamSpec<never>,
};
