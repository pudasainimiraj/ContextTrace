import type { SupabaseClient } from "@supabase/supabase-js";
import type { BudgetState } from "../shared/api.ts";
import { NEURONS_PER_MILLION_TOKENS } from "./embeddings.ts";
import { JobError } from "./retry.ts";

/**
 * Metered resources. Every budget sits at 80% of a free allowance (see the migration), so a
 * refused reservation is the service pausing itself, never a surprise charge.
 */
export type BudgetResource =
  | "ai_neurons_milli"
  | "github_requests_auth"
  | "github_requests_anon"
  | "queue_ops"
  | "searches"
  | "registrations"
  | "db_egress_bytes"
  | "storage_bytes";

export const GLOBAL_SCOPE = "global";
/** Milli-neurons reserved for one search query before its real token count is known. */
export const QUERY_RESERVE_MILLI_NEURONS = 200;
/** Operations one queue message costs: write, read, delete. */
export const QUEUE_OPS_PER_MESSAGE = 3;
/** A refused gauge (storage) is re-measured by the cron; retry after this long. */
const GAUGE_RETRY_SECONDS = 300;

export type Reservation = { allowed: boolean; used: number; limit: number; resetsAt: string | null };

/** Workers AI meters 1,841 neurons per million input tokens: 1.841 milli-neurons per token. */
export function milliNeuronsFor(tokens: number): number {
  return Math.ceil((tokens * NEURONS_PER_MILLION_TOKENS) / 1000);
}

export function githubResource(token: string | undefined): BudgetResource {
  return token ? "github_requests_auth" : "github_requests_anon";
}

/**
 * The budget ledger for one scope. Production uses the global scope; a test seeds its own
 * scope (see test/helpers.ts) so parallel files never touch the same rows.
 */
export class Budget {
  private readonly db: SupabaseClient;
  readonly scope: string;

  constructor(db: SupabaseClient, scope: string = GLOBAL_SCOPE) {
    this.db = db;
    this.scope = scope;
  }

  /** Atomically reserves `amount`; refused when it would cross the limit, with the row unchanged. */
  async reserve(resource: BudgetResource, amount: number): Promise<Reservation> {
    const { data, error } = await this.db.rpc("reserve_budget", { p_scope: this.scope, p_resource: resource, p_amount: amount }).single();
    if (error) throw new Error(`reserve_budget failed: ${error.message}`);
    const row = data as { allowed: boolean; used: number | string; limit_amount: number | string; resets_at: string | null };
    return { allowed: row.allowed, used: Number(row.used), limit: Number(row.limit_amount), resetsAt: row.resets_at };
  }

  /** Reserves or throws budget_exhausted, a transient JobError timed to the window's end. */
  async take(resource: BudgetResource, amount: number): Promise<Reservation> {
    const reservation = await this.reserve(resource, amount);
    if (!reservation.allowed) throw budgetExhausted(resource, reservation);
    return reservation;
  }

  /** Adjusts usage once the real cost is known; negative deltas give budget back. */
  async settle(resource: BudgetResource, delta: number): Promise<number> {
    if (delta === 0) return Number.NaN;
    const { data, error } = await this.db.rpc("settle_budget", { p_scope: this.scope, p_resource: resource, p_delta: Math.round(delta) });
    if (error) throw new Error(`settle_budget failed: ${error.message}`);
    return Number(data);
  }

  /** Records a measured value for a gauge resource (storage). */
  async gauge(resource: BudgetResource, value: number): Promise<void> {
    const { error } = await this.db.rpc("set_budget_gauge", { p_scope: this.scope, p_resource: resource, p_value: Math.round(value) });
    if (error) throw new Error(`set_budget_gauge failed: ${error.message}`);
  }

  /** Every resource of the scope as it stands now; a passed window reads as empty. */
  async summary(): Promise<BudgetState[]> {
    const { data, error } = await this.db.rpc("budget_status", { p_scope: this.scope });
    if (error) throw new Error(`budget_status failed: ${error.message}`);
    return ((data ?? []) as { resource: string; period: string; used: number | string; limit_amount: number | string; resets_at: string | null }[]).map(
      (row) => {
        const used = Number(row.used);
        const limit = Number(row.limit_amount);
        return {
          resource: row.resource as BudgetResource,
          period: row.period as BudgetState["period"],
          used,
          limit,
          remaining_pct: limit === 0 ? 0 : Math.max(0, Math.round(((limit - used) / limit) * 1000) / 10),
          paused: used >= limit,
          resets_at: row.resets_at,
        };
      },
    );
  }
}

/** The error a refused reservation raises: transient, retried once the window has reset. */
export function budgetExhausted(resource: BudgetResource, reservation: Reservation): JobError {
  const resetMs = reservation.resetsAt ? Date.parse(reservation.resetsAt) - Date.now() : Number.NaN;
  const retryAfterSeconds = Number.isFinite(resetMs) ? Math.max(60, Math.ceil(resetMs / 1000)) : GAUGE_RETRY_SECONDS;
  const until = reservation.resetsAt ? ` until ${reservation.resetsAt}` : "";
  return new JobError("budget_exhausted", `Budget ${resource} is exhausted (${reservation.used} of ${reservation.limit})${until}`, {
    transient: true,
    retryAfterSeconds,
    data: { resource, used: reservation.used, limit: reservation.limit, resets_at: reservation.resetsAt },
  });
}

export function isBudgetExhausted(err: unknown): err is JobError {
  return err instanceof JobError && err.code === "budget_exhausted";
}

/** Milliseconds until the budget resets, as a Retry-After header value in seconds (at least 1). */
export function retryAfterHeader(err: JobError): string {
  return String(Math.max(1, err.retryAfterSeconds ?? 60));
}

/** Database size in bytes, for the storage gauge. */
export async function databaseSize(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc("database_size");
  if (error) throw new Error(`database_size failed: ${error.message}`);
  return Number(data);
}
