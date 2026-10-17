import type { SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_WARN_RATIO } from "../api/admission.ts";
import { type Budget, databaseSize } from "../queue/budget.ts";
import { JobError, dbError } from "../queue/retry.ts";

/** Finished jobs (and their transitions) are kept this long; the newest per repository and kind is always kept. */
export const JOB_RETENTION_DAYS = 14;
/** Embedding usage rows are kept this long; the budget ledger keeps the running totals. */
export const USAGE_RETENTION_DAYS = 90;
/** A repository GitHub stopped serving is removed after this long; its row stays as a tombstone. */
export const INACCESSIBLE_RETENTION_DAYS = 30;
/** Share of the storage budget at which syncs pause too (backfills and rescans pause at the warning). */
export const STORAGE_CRITICAL_RATIO = 0.95;
/** How long a job parked for storage waits before it looks again (the cron measures every 5 minutes). */
export const STORAGE_RETRY_SECONDS = 300;

export type StorageLevel = "ok" | "warning" | "critical";
export type StorageState = { used: number; limit: number; level: StorageLevel };
export type Removal = { sources: number; documents: number; passages: number; vectors: number; jobs_cancelled: number };
export type Maintenance = { jobs_purged: number; usage_purged: number; repositories_removed: number[]; storage: StorageState };
export type MaintenanceOptions = { repositoryId?: number; jobDays?: number; usageDays?: number; inaccessibleDays?: number };

/** Where storage stands against its budget, from the gauge the cron keeps. */
export async function storageState(budget: Budget): Promise<StorageState> {
  const storage = (await budget.summary()).find((b) => b.resource === "storage_bytes");
  const used = storage?.used ?? 0;
  const limit = storage?.limit ?? 0;
  const level: StorageLevel = limit > 0 && used >= limit * STORAGE_CRITICAL_RATIO ? "critical" : limit > 0 && used >= limit * STORAGE_WARN_RATIO ? "warning" : "ok";
  return { used, limit, level };
}

/** The pause a job takes when storage has reached the level that stops its kind of work. */
export function storagePause(state: StorageState, work: string): JobError {
  const pct = state.limit > 0 ? Math.round((state.used / state.limit) * 100) : 0;
  return new JobError("budget_exhausted", `Storage is at ${pct}% of its budget; ${work} waits for space`, {
    transient: true,
    retryAfterSeconds: STORAGE_RETRY_SECONDS,
    data: { resource: "storage_bytes", used: state.used, limit: state.limit, resets_at: null },
  });
}

/** Deletes everything a repository holds and leaves a tombstone row; open jobs are cancelled. */
export async function removeRepository(db: SupabaseClient, repositoryId: number, reason: string): Promise<Removal> {
  const { data, error } = await db.rpc("remove_repository", { p_repository_id: repositoryId, p_reason: reason }).single();
  if (error) throw dbError("remove_repository", error);
  return data as Removal;
}

async function purge(db: SupabaseClient, fn: "purge_job_history" | "purge_embedding_usage", days: number, repositoryId?: number): Promise<number> {
  const { data, error } = await db.rpc(fn, { p_days: days, p_repository_id: repositoryId ?? null });
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return Number(data ?? 0);
}

/**
 * The cron's housekeeping: purge old job history and usage rows, remove repositories that
 * have been unreachable for longer than the retention window, and measure storage into
 * the gauge. Searchable repositories are never removed here; that is an operator's call
 * through DELETE /api/repositories/:id.
 */
export async function maintain(db: SupabaseClient, budget: Budget, options: MaintenanceOptions = {}): Promise<Maintenance> {
  const jobsPurged = await purge(db, "purge_job_history", options.jobDays ?? JOB_RETENTION_DAYS, options.repositoryId);
  const usagePurged = await purge(db, "purge_embedding_usage", options.usageDays ?? USAGE_RETENTION_DAYS, options.repositoryId);

  const { data, error } = await db.rpc("stale_inaccessible_repositories", { p_days: options.inaccessibleDays ?? INACCESSIBLE_RETENTION_DAYS, p_repository_id: options.repositoryId ?? null });
  if (error) throw dbError("stale_inaccessible_repositories", error);
  const removed: number[] = [];
  for (const row of (data ?? []) as (number | { stale_inaccessible_repositories: number })[]) {
    const id = typeof row === "number" ? row : row.stale_inaccessible_repositories;
    await removeRepository(db, id, `removed after ${options.inaccessibleDays ?? INACCESSIBLE_RETENTION_DAYS} days unreachable on GitHub`);
    removed.push(id);
  }

  await budget.gauge("storage_bytes", await databaseSize(db));
  return { jobs_purged: jobsPurged, usage_purged: usagePurged, repositories_removed: removed, storage: await storageState(budget) };
}
