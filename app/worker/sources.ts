import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceRecord } from "../shared/api.ts";

/** A source row as the extractor produces it; the database fills fetched_at. */
export type SourceDraft = Omit<SourceRecord, "fetched_at">;

export type UpsertCounts = { inserted: number; updated: number; unchanged: number };

/** Batch upsert; a draft never overwrites newer data already stored. */
export async function upsertSources(db: SupabaseClient, rows: SourceDraft[]): Promise<UpsertCounts> {
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await db.rpc("upsert_sources", { p_rows: rows }).single();
  if (error) throw new Error(`upsert_sources failed: ${error.message}`);
  return data as UpsertCounts;
}

export async function listSources(
  db: SupabaseClient,
  repositoryId: number,
  filter: { type?: SourceRecord["type"]; number?: number } = {},
): Promise<SourceRecord[]> {
  let query = db.from("sources").select("*").eq("repository_id", repositoryId).order("github_id");
  if (filter.type) query = query.eq("type", filter.type);
  if (filter.number !== undefined) query = query.eq("number", filter.number);
  const { data, error } = await query;
  if (error) throw new Error(`select sources failed: ${error.message}`);
  return (data ?? []) as SourceRecord[];
}
