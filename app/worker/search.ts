import type { SupabaseClient } from "@supabase/supabase-js";
import type { RepositoryRecord, SearchConfidence, SearchIndexState, SearchMode, SearchResponse } from "../shared/api.ts";
import { embeddingStats } from "./embed.ts";
import { type EmbeddingClient, validateVector } from "./embeddings.ts";
import { resolveEvidence } from "./evidence.ts";
import { JobError } from "./retry.ts";

/** Results per search; the evidence cards show the top 3 to 5. */
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;
/** A query is a question or a few keywords; longer input is rejected before it reaches the model. */
export const MAX_QUERY_CHARS = 500;
/**
 * Cosine thresholds for bge-small-en-v1.5 (cls), calibrated on p-limit on 2026-10-13: the
 * top hit of a question the repository answers scored 0.77 to 0.89, an exact identifier
 * 0.77, and off-topic questions at most 0.67. At or above HIGH the semantic results stand
 * on their own; between LOW and HIGH they are shown as weak; below LOW they are not shown.
 */
export const SCORE_HIGH = 0.8;
export const SCORE_LOW = 0.7;

export type SearchContext = { db: SupabaseClient; embeddings?: EmbeddingClient };
export type SearchRequest = { repository: RepositoryRecord; query: string; limit?: number };

export type SearchMatch = {
  passage_id: string;
  document_id: string;
  score: number; // cosine similarity, 1 = identical
};

/** True when a document id belongs to the repository: ids embed the numeric repository id. */
export function belongsToRepository(documentId: string, repositoryId: number): boolean {
  return documentId.startsWith(`github:${repositoryId}:`);
}

/**
 * Embeds a query on the server with the passages' own model and pooling. The browser
 * never downloads a model and never sees a vector. Failures are JobErrors with the
 * client's codes, plus ai_not_configured when there is no client.
 */
export async function embedQuery(
  embeddings: EmbeddingClient | undefined,
  query: string,
): Promise<{ vector: number[]; durationMs: number }> {
  if (!embeddings) throw new JobError("ai_not_configured", "No embedding client is configured", { transient: false });
  const result = await embeddings.embed([query]);
  const vector = result.vectors[0];
  const problem = validateVector(vector);
  if (problem) throw new JobError("ai_invalid_output", `Query vector is ${problem}`, { transient: false });
  return { vector, durationMs: result.durationMs };
}

/**
 * One search. The query is embedded and ranked against the repository's vectors; when the
 * best match is not close, or the model is unavailable, the keyword baseline runs instead.
 * Whatever is shown comes with a mode, a confidence and a message that says why, so a weak
 * or missing answer is never dressed up as a supported one.
 */
export async function search(ctx: SearchContext, request: SearchRequest): Promise<SearchResponse> {
  const { repository } = request;
  const repositoryId = repository.id;
  const query = request.query.trim();
  const limit = Math.min(Math.max(request.limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);

  const [semantic, stats] = await Promise.all([semanticSearch(ctx, repositoryId, query, limit), embeddingStats(ctx.db, repositoryId)]);
  const index = indexState(repository, stats);
  const top = semantic.hits[0]?.score ?? 0;

  let mode: SearchMode;
  let confidence: SearchConfidence;
  let message: string | null;
  let hits: SearchMatch[];
  if (top >= SCORE_HIGH) {
    [mode, confidence, message, hits] = ["semantic", "high", null, semantic.hits];
  } else {
    const keyword = await searchKeyword(ctx.db, repositoryId, query, limit);
    const building = index.embedded === 0 && index.pending > 0;
    if (keyword.length > 0) {
      [mode, confidence, hits] = ["keyword", "low", keyword];
      message = `${
        semantic.error
          ? `Semantic search is unavailable (${semantic.error}).`
          : building
            ? `The semantic index is still building (${index.embedded} of ${stats.passages} passages).`
            : "No discussion is a close semantic match."
      } Showing passages that contain your search words; verify them at the source.`;
    } else if (top >= SCORE_LOW) {
      [mode, confidence, hits] = ["semantic", "low", semantic.hits];
      message = "Only weak matches were found. This repository may not discuss the topic; verify them at the source before relying on them.";
    } else {
      [mode, confidence, hits] = ["none", "none", []];
      message = semantic.error
        ? `Semantic search is unavailable (${semantic.error}) and no passage contains your search words.`
        : stats.passages === 0
          ? "This repository has no indexed discussions yet; extraction may still be running."
          : building
            ? `The semantic index is still building (0 of ${stats.passages} passages) and no passage contains your search words.`
            : "No supporting discussion was found for this query in this repository.";
    }
  }

  const { cards, unverified } = await resolveEvidence(ctx.db, repositoryId, hits, mode === "keyword" ? "keyword" : "semantic");
  return {
    repository_id: repositoryId,
    query,
    limit,
    mode,
    confidence,
    message,
    semantic_error: semantic.error,
    embed_ms: semantic.embedMs,
    index,
    results: cards,
    unverified,
  };
}

/** The index state for the response: a repository that is not fully searchable says so explicitly. */
export function indexState(repository: RepositoryRecord, stats: { passages: number; embedded: number; pending: number }): SearchIndexState {
  const { status } = repository;
  const base = { status, partial: status !== "searchable", embedded: stats.embedded, pending: stats.pending };
  switch (status) {
    case "searchable":
      return { ...base, warning: null };
    case "inaccessible":
      return { ...base, warning: "The source repository is no longer accessible on GitHub; results reflect the last successful sync and may be stale." };
    case "searchable_partial":
      return {
        ...base,
        warning: `Partial index: ${stats.embedded} of ${stats.passages} passages are searchable while extraction and indexing continue; older discussions may be missing.`,
      };
    default:
      return { ...base, warning: "The index is still being built; nothing from this repository is searchable yet." };
  }
}

/** The semantic hits, or the error code that stopped them; only the model's own failures are caught. */
async function semanticSearch(
  ctx: SearchContext,
  repositoryId: number,
  query: string,
  limit: number,
): Promise<{ hits: SearchMatch[]; embedMs: number | null; error: string | null }> {
  try {
    const { vector, durationMs } = await embedQuery(ctx.embeddings, query);
    return { hits: await searchSemantic(ctx.db, repositoryId, vector, limit), embedMs: durationMs, error: null };
  } catch (err) {
    if (!(err instanceof JobError)) throw err;
    console.error(`semantic search unavailable: ${err.code}: ${err.message}`);
    return { hits: [], embedMs: null, error: err.code };
  }
}

/**
 * Keyword baseline: Postgres full-text search over the repository's passages with web
 * search syntax (phrases in quotes, -word to exclude), ranked by ts_rank_cd. It needs no
 * vector, so passages still waiting to be embedded are found by the words they contain.
 */
export async function searchKeyword(
  db: SupabaseClient,
  repositoryId: number,
  query: string,
  limit = SEARCH_LIMIT_DEFAULT,
): Promise<SearchMatch[]> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error(`invalid repository id ${repositoryId}`);
  const { data, error } = await db.rpc("search_passages_keyword", {
    p_repository_id: repositoryId,
    p_query: query,
    p_limit: Math.min(Math.max(limit, 1), SEARCH_LIMIT_MAX),
  });
  if (error) throw new Error(`search_passages_keyword failed: ${error.message}`);
  return ownRows((data ?? []) as SearchMatch[], repositoryId, "search_passages_keyword");
}

/**
 * Nearest passages of one repository to a query vector, by cosine similarity on the HNSW
 * index. The repository filter is applied inside the search, and every row is checked
 * again here against the repository id embedded in its document id, so results never
 * cross repositories even if the query or the data were ever wrong.
 */
export async function searchSemantic(
  db: SupabaseClient,
  repositoryId: number,
  queryVector: number[],
  limit = SEARCH_LIMIT_DEFAULT,
): Promise<SearchMatch[]> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error(`invalid repository id ${repositoryId}`);
  const { data, error } = await db.rpc("search_passages", {
    p_repository_id: repositoryId,
    p_query: JSON.stringify(queryVector),
    p_limit: Math.min(Math.max(limit, 1), SEARCH_LIMIT_MAX),
  });
  if (error) throw new Error(`search_passages failed: ${error.message}`);
  return ownRows((data ?? []) as SearchMatch[], repositoryId, "search_passages");
}

function ownRows(matches: SearchMatch[], repositoryId: number, source: string): SearchMatch[] {
  const own = matches.filter((m) => belongsToRepository(m.document_id, repositoryId));
  if (own.length !== matches.length) console.error(`${source} returned ${matches.length - own.length} rows outside repository ${repositoryId}`);
  return own;
}
