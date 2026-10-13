import type { SupabaseClient } from "@supabase/supabase-js";
import type { SearchResponse } from "../shared/api.ts";
import { type EmbeddingClient, validateVector } from "./embeddings.ts";
import { JobError } from "./retry.ts";

/** Results per search; the evidence cards show the top 3 to 5. */
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;
/** A query is a question or a few keywords; longer input is rejected before it reaches the model. */
export const MAX_QUERY_CHARS = 500;

export type SearchContext = { db: SupabaseClient; embeddings?: EmbeddingClient };
export type SearchRequest = { repositoryId: number; query: string; limit?: number };

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

/** One search: embed the query, then rank the repository's passages against it. */
export async function search(ctx: SearchContext, request: SearchRequest): Promise<SearchResponse> {
  const query = request.query.trim();
  const limit = Math.min(Math.max(request.limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
  const { vector, durationMs } = await embedQuery(ctx.embeddings, query);
  const results = await searchSemantic(ctx.db, request.repositoryId, vector, limit);
  return { repository_id: request.repositoryId, query, limit, embed_ms: durationMs, results };
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
  const matches = (data ?? []) as SearchMatch[];
  const own = matches.filter((m) => belongsToRepository(m.document_id, repositoryId));
  if (own.length !== matches.length) console.error(`search_passages returned ${matches.length - own.length} rows outside repository ${repositoryId}`);
  return own;
}
