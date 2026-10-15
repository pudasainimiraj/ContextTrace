import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "./retry.ts";
import type { DocumentRecord, PassageRecord, SourceRecord } from "../shared/api.ts";
import type { PassageRow } from "./passages.ts";

export type DocumentRow = Omit<DocumentRecord, "transformed_at">;
export type SyncCounts = { documents: number; inserted: number; updated: number; unchanged: number; removed: number };

/** Thread numbers that need (re)transformation, oldest number first. */
export async function dirtyDocuments(
  db: SupabaseClient,
  repositoryId: number,
  transformVersion: string,
  limit: number,
): Promise<number[]> {
  const { data, error } = await db.rpc("dirty_documents", {
    p_repository_id: repositoryId,
    p_transform_version: transformVersion,
    p_limit: limit,
  });
  if (error) throw dbError("dirty_documents", error);
  return ((data ?? []) as { number: number }[]).map((row) => row.number);
}

const SOURCES_PAGE = 1000; // PostgREST's default max-rows

/** All source rows of the given threads, paged under the PostgREST row cap. */
export async function listDocumentSources(db: SupabaseClient, repositoryId: number, numbers: number[]): Promise<SourceRecord[]> {
  const rows: SourceRecord[] = [];
  for (let from = 0; ; from += SOURCES_PAGE) {
    const { data, error } = await db
      .from("sources")
      .select("*")
      .eq("repository_id", repositoryId)
      .in("number", numbers)
      .order("number")
      .order("type")
      .order("github_id")
      .range(from, from + SOURCES_PAGE - 1);
    if (error) throw dbError("select sources", error);
    rows.push(...((data ?? []) as SourceRecord[]));
    if (!data || data.length < SOURCES_PAGE) return rows;
  }
}

/** One round trip: upsert documents, upsert changed passages, remove stale ones. */
export async function syncPassages(db: SupabaseClient, documents: DocumentRow[], passages: PassageRow[]): Promise<SyncCounts> {
  const { data, error } = await db.rpc("sync_passages", { p_documents: documents, p_passages: passages }).single();
  if (error) throw dbError("sync_passages", error);
  return data as SyncCounts;
}

export async function getDocumentByNumber(db: SupabaseClient, repositoryId: number, number: number): Promise<DocumentRecord | null> {
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("repository_id", repositoryId)
    .eq("number", number)
    .maybeSingle();
  if (error) throw dbError("select documents", error);
  return data as DocumentRecord | null;
}

export const MAX_PASSAGES_PAGE = 500;

/** Passages of a repository, or of one thread, in thread order. */
export async function listPassages(
  db: SupabaseClient,
  repositoryId: number,
  filter: { number?: number; limit?: number } = {},
): Promise<PassageRecord[]> {
  let query = db.from("passages").select("*").eq("repository_id", repositoryId);
  if (filter.number !== undefined) {
    const document = await getDocumentByNumber(db, repositoryId, filter.number);
    if (!document) return [];
    query = query.eq("document_id", document.document_id);
  }
  const { data, error } = await query
    .order("document_id")
    .order("created_at")
    .order("source_github_id")
    .order("chunk_index")
    .limit(Math.min(filter.limit ?? MAX_PASSAGES_PAGE, MAX_PASSAGES_PAGE));
  if (error) throw dbError("select passages", error);
  return (data ?? []) as PassageRecord[];
}
