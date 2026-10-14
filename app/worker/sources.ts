import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceRecord } from "../shared/api.ts";

/** A source row as the extractor produces it; the database fills fetched_at and seen_at. */
export type SourceDraft = Omit<SourceRecord, "fetched_at" | "seen_at">;

export type UpsertCounts = { inserted: number; updated: number; unchanged: number };

/**
 * Batch upsert. A draft never overwrites newer data already stored. A row whose content did
 * not change is counted as unchanged and keeps its fetched_at, so it dirties no thread; only
 * seen_at moves.
 */
export async function upsertSources(db: SupabaseClient, rows: SourceDraft[]): Promise<UpsertCounts> {
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await db.rpc("upsert_sources", { p_rows: rows }).single();
  if (error) throw new Error(`upsert_sources failed: ${error.message}`);
  return data as UpsertCounts;
}

export type Retirement = { sources_removed: number; documents_removed: number; documents_dirtied: number };

/**
 * Deletes the repository's rows of the given types that no fetch has returned since
 * `before` (a rescan's start). Their passages and vectors cascade away; threads that lost a
 * unit are marked for re-transform; a thread whose opening is gone loses its document.
 */
export async function retireUnseenSources(db: SupabaseClient, repositoryId: number, types: SourceRecord["type"][], before: string): Promise<Retirement> {
  const { data, error } = await db.rpc("retire_unseen_sources", { p_repository_id: repositoryId, p_types: types, p_before: before }).single();
  if (error) throw new Error(`retire_unseen_sources failed: ${error.message}`);
  return data as Retirement;
}

export const MAX_SOURCES_PAGE = 500;

export async function listSources(
  db: SupabaseClient,
  repositoryId: number,
  filter: { type?: SourceRecord["type"]; number?: number; limit?: number } = {},
): Promise<SourceRecord[]> {
  let query = db.from("sources").select("*").eq("repository_id", repositoryId).order("github_id");
  if (filter.type) query = query.eq("type", filter.type);
  if (filter.number !== undefined) query = query.eq("number", filter.number);
  query = query.limit(Math.min(filter.limit ?? MAX_SOURCES_PAGE, MAX_SOURCES_PAGE));
  const { data, error } = await query;
  if (error) throw new Error(`select sources failed: ${error.message}`);
  return (data ?? []) as SourceRecord[];
}
