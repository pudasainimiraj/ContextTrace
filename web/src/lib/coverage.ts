// What the coverage report implies: how often to read it again, and where the pipeline stands.

import type { CoverageReport } from "../../../shared/api.ts";
import { formatCount } from "./time.ts";

export const POLL_FAST_MS = 5_000;
export const POLL_SLOW_MS = 30_000;
export const POLL_STALLED_MS = 60_000;

/** How often the coverage is read: fast while something runs, slow while parked or partial, never once it is settled. */
export function coverageInterval(c: CoverageReport | null): number | null {
  if (!c) return POLL_FAST_MS;
  const states = c.active_jobs.map((j) => j.state);
  if (states.includes("queued") || states.includes("running")) return POLL_FAST_MS;
  if (c.status === "registered") return c.active_jobs.length > 0 ? POLL_SLOW_MS : POLL_STALLED_MS;
  if (states.includes("retry_pending") || c.status === "searchable_partial") return POLL_SLOW_MS;
  return null;
}

type StepState = "done" | "running" | "waiting";
type Step = { name: string; state: StepState; detail: string };

/** The four steps of the pipeline as the stored counts and the active jobs show them. */
export function pipelineSteps(c: CoverageReport): Step[] {
  const kinds = c.active_jobs.map((j) => j.kind);
  const fetching = kinds.some((k) => /^(fetch|backfill|rescan)_/.test(k)) || c.streams.some((s) => s.phase === "head" || s.phase === "backfill");
  const allListed = c.streams.every((s) => s.complete);
  const transforming = kinds.includes("transform_passages");
  const embedding = kinds.includes("embed_passages");
  const total = c.embedded + c.pending;
  return [
    {
      name: "Fetch",
      state: fetching ? "running" : allListed ? "done" : "waiting",
      detail: `${c.streams.filter((s) => s.complete).length} of ${c.streams.length} streams listed`,
    },
    {
      name: "Split into passages",
      state: transforming ? "running" : c.passages > 0 ? "done" : "waiting",
      detail: `${formatCount(c.documents)} threads, ${formatCount(c.passages)} passages`,
    },
    {
      name: "Make searchable",
      state: embedding ? "running" : total > 0 && c.pending === 0 ? "done" : total > 0 ? "running" : "waiting",
      detail: total > 0 ? `${formatCount(c.embedded)} of ${formatCount(total)} (${Math.round((c.embedded / total) * 100)}%)` : "nothing to embed yet",
    },
    {
      name: "Complete",
      state: c.status === "searchable" ? "done" : "waiting",
      detail: c.status === "searchable" ? "every stream listed, nothing pending" : "when every stream is listed and nothing is pending",
    },
  ];
}
