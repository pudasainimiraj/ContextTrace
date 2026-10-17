/**
 * Retrieval metrics for the evaluation. Relevance is labelled per unit (an opening post or
 * one comment); a passage id names one chunk of a unit, so credit is given at unit level:
 * every chunk of a unit shares the same permalink and the reader reaches the same evidence.
 */

/** The unit a passage belongs to: the id without its trailing chunk index. */
export function unitOf(passageId: string): string {
  return passageId.replace(/:\d+$/, "");
}

/** The thread (issue or pull request) a passage belongs to: `github:{repo}:{type}:{number}`. */
export function threadOf(passageId: string): string {
  return passageId.split(":").slice(0, 4).join(":");
}

/** 1 when any result among the first k is in the same thread as a relevant unit: a looser, secondary view. */
export function threadHitAtK(relevant: string[], returned: string[], k: number): number {
  const wanted = new Set(relevant.map(threadOf));
  return returned.slice(0, k).some((id) => wanted.has(threadOf(id))) ? 1 : 0;
}

/** Share of the relevant units found among the first k results (duplicate chunks count once). */
export function recallAtK(relevant: string[], returned: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const found = new Set(returned.slice(0, k).map(unitOf));
  return relevant.filter((unit) => found.has(unitOf(unit))).length / new Set(relevant.map(unitOf)).size;
}

/** 1 when any relevant unit is among the first k results, else 0. */
export function hitAtK(relevant: string[], returned: string[], k: number): number {
  const wanted = new Set(relevant.map(unitOf));
  return returned.slice(0, k).some((id) => wanted.has(unitOf(id))) ? 1 : 0;
}

/** Reciprocal rank of the first relevant unit within the first k results, else 0. */
export function reciprocalRankAtK(relevant: string[], returned: string[], k: number): number {
  const wanted = new Set(relevant.map(unitOf));
  const index = returned.slice(0, k).findIndex((id) => wanted.has(unitOf(id)));
  return index === -1 ? 0 : 1 / (index + 1);
}

export type Outcome = "abstained" | "hedged" | "false_positive";

/** How a response to an unsupported question is judged: none is right, low confidence is a hedge, high confidence is a false positive. */
export function unsupportedOutcome(response: { mode: string; confidence: string }): Outcome {
  if (response.mode === "none") return "abstained";
  return response.confidence === "high" ? "false_positive" : "hedged";
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
