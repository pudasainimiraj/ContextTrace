import type { SupabaseClient } from "@supabase/supabase-js";

/** Results per search; the evidence cards show the top 3 to 5. */
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;

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
