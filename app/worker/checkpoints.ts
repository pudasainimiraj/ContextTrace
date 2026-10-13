import type { SupabaseClient } from "@supabase/supabase-js";

export type StreamCheckpoint = {
  repository_id: number;
  stream: string;
  cursor: string | null; // next page URL while a listing is in progress
  last_item_at: string | null; // updated_at high-water mark of completed listings
  job_id: number | null;
  updated_at: string;
};

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
  if (error) throw new Error(`select stream_checkpoints failed: ${error.message}`);
  return data as StreamCheckpoint | null;
}

export async function saveCheckpoint(
  db: SupabaseClient,
  checkpoint: Omit<StreamCheckpoint, "updated_at">,
): Promise<void> {
  const { error } = await db.from("stream_checkpoints").upsert(checkpoint);
  if (error) throw new Error(`upsert stream_checkpoints failed: ${error.message}`);
}
