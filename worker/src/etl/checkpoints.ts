import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "../queue/retry.ts";

/**
 * Where a stream stands, per repository. The descending (newest first) listing that the
 * head pass starts and the backfill continues lives in `cursor`; an unfinished ascending
 * sync lives in `sync_cursor`; `last_item_at` is the updated_at high-water mark that the
 * next sync lists since. The backfill never moves the high-water mark.
 */
export type StreamCheckpoint = {
  repository_id: number;
  stream: string;
  cursor: string | null; // next page of the descending listing, for the backfill
  sync_cursor: string | null; // next page of an unfinished sync
  last_item_at: string | null; // updated_at high-water mark seen by the head and the syncs
  head_done_at: string | null;
  backfill_done_at: string | null;
  last_synced_at: string | null;
  rescan_started_at: string | null; // a rescan is walking the listing from the start
  last_rescan_at: string | null;
  capped_at: string | null; // the stream stopped at MAX_ITEMS_PER_STREAM and counts as complete
  pages_fetched: number;
  items_fetched: number;
  job_id: number | null;
  updated_at: string;
};

/** A save names the stream and the columns to set; the others keep their stored values. */
export type CheckpointPatch = Pick<StreamCheckpoint, "repository_id" | "stream"> &
  Partial<Omit<StreamCheckpoint, "repository_id" | "stream" | "updated_at">>;

export async function getCheckpoint(
  db: SupabaseClient,
  repositoryId: number,
  stream: string,
): Promise<StreamCheckpoint | null> {
  const { data, error } = await db
    .from("stream_checkpoints")
    .select("*")
    .eq("repository_id", repositoryId)
    .eq("stream", stream)
    .maybeSingle();
  if (error) throw dbError("select stream_checkpoints", error);
  return data as StreamCheckpoint | null;
}

export async function saveCheckpoint(db: SupabaseClient, checkpoint: CheckpointPatch): Promise<void> {
  const { error } = await db.from("stream_checkpoints").upsert(checkpoint);
  if (error) throw dbError("upsert stream_checkpoints", error);
}

export async function listCheckpoints(db: SupabaseClient, repositoryId: number): Promise<StreamCheckpoint[]> {
  const { data, error } = await db.from("stream_checkpoints").select("*").eq("repository_id", repositoryId).order("stream");
  if (error) throw dbError("select stream_checkpoints", error);
  return (data ?? []) as StreamCheckpoint[];
}
