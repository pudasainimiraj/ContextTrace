import type { SupabaseClient } from "@supabase/supabase-js";

/** Results per search; the evidence cards show the top 3 to 5. */
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;

export type SearchMatch = {
  passage_id: string;
  document_id: string;
  score: number; // cosine similarity, 1 = identical
};

/**
 * Nearest passages of one repository to a query vector, by cosine similarity on the HNSW
 * index. The repository filter is applied inside the search, so results never cross
 * repositories.
 */
export async function searchSemantic(
  db: SupabaseClient,
  repositoryId: number,
  queryVector: number[],
  limit = SEARCH_LIMIT_DEFAULT,
): Promise<SearchMatch[]> {
  const { data, error } = await db.rpc("search_passages", {
    p_repository_id: repositoryId,
    p_query: JSON.stringify(queryVector),
    p_limit: Math.min(Math.max(limit, 1), SEARCH_LIMIT_MAX),
  });
  if (error) throw new Error(`search_passages failed: ${error.message}`);
  return (data ?? []) as SearchMatch[];
}
