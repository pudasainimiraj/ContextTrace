import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RepositoryRecord } from "../shared/api.ts";
import type { GitHubRepo } from "./github-api.ts";

/** Server-side Supabase client. The secret key bypasses RLS; never expose it to the browser. */
export function createDb(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SECRET_KEY">): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Registers a repository keyed by GitHub's repo id through the register_repository
 * function (one atomic INSERT ... ON CONFLICT). A repeated submission refreshes the
 * name columns and bumps submission_count instead of inserting a second row.
 */
export async function upsertRepository(
  db: SupabaseClient,
  repo: GitHubRepo,
): Promise<{ row: RepositoryRecord; created: boolean }> {
  const { data, error } = await db
    .rpc("register_repository", {
      p_id: repo.id,
      p_owner: repo.owner.login,
      p_name: repo.name,
      p_full_name: repo.full_name,
    })
    .single();
  if (error) throw new Error(`register_repository failed: ${error.message}`);
  const row = data as RepositoryRecord;
  return { row, created: row.submission_count === 1 };
}

export async function getRepository(db: SupabaseClient, id: number): Promise<RepositoryRecord | null> {
  const { data, error } = await db.from("repositories").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`select repositories failed: ${error.message}`);
  return data as RepositoryRecord | null;
}
