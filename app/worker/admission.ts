import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "./retry.ts";
import type { Budget } from "./budget.ts";

/** Repositories the service admits in total; beyond it, new registrations wait. */
export const MAX_REPOSITORIES = 25;
/** Share of the storage budget at which new registrations stop. */
export const STORAGE_WARN_RATIO = 0.8;

export type Admission = { open: boolean; reason: string | null };
export type AdmissionOptions = { maxRepositories?: number; storageWarnRatio?: number };

/**
 * Whether a new repository may be registered now. Closed when storage has reached the
 * warning share of its budget or the repository count has reached the cap. A repository
 * that is already registered is never turned away by this check.
 */
export async function admissionState(db: SupabaseClient, budget: Budget, options: AdmissionOptions = {}): Promise<Admission> {
  const storage = (await budget.summary()).find((b) => b.resource === "storage_bytes");
  const ratio = options.storageWarnRatio ?? STORAGE_WARN_RATIO;
  if (storage && storage.limit > 0 && storage.used >= storage.limit * ratio) {
    return { open: false, reason: `Storage is at ${Math.round((storage.used / storage.limit) * 100)}% of its budget; new repositories are not accepted until space is freed` };
  }
  const { count, error } = await db.from("repositories").select("id", { count: "exact", head: true }).neq("status", "removed");
  if (error) throw dbError("count repositories", error);
  const max = options.maxRepositories ?? MAX_REPOSITORIES;
  if ((count ?? 0) >= max) {
    return { open: false, reason: `The service holds its maximum of ${max} repositories; new registrations are not accepted` };
  }
  return { open: true, reason: null };
}

/** The repository row that a resubmission refers to, by its current GitHub name. */
export async function findByFullName(db: SupabaseClient, fullName: string): Promise<{ id: number } | null> {
  const { data, error } = await db.from("repositories").select("id").ilike("full_name", fullName).limit(1).maybeSingle();
  if (error) throw dbError("select repositories", error);
  return data as { id: number } | null;
}
