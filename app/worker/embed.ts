import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingStats } from "../shared/api.ts";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMS,
  EMBEDDING_MAX_TOKENS,
  EMBEDDING_MODEL,
  EMBEDDING_POOLING,
  type EmbeddingClient,
  neuronsFor,
  usdFor,
  validateVector,
} from "./embeddings.ts";
import { refreshRepositoryStatus } from "./repositories.ts";
import { JobError } from "./retry.ts";
import { TRANSFORM_VERSION } from "./transform.ts";

export const EMBED_JOB_KIND = "embed_passages";
/** Batches per job run before the job yields to a continuation job. */
export const MAX_BATCHES_PER_RUN = 5;

export type EmbedContext = { db: SupabaseClient; embeddings?: EmbeddingClient };
export type EmbedOptions = { batchSize?: number; maxBatches?: number };
export type PendingPassage = { passage_id: string; text: string; token_count: number; content_hash: string };

export type EmbedResult = {
  done: boolean;
  batches: number;
  texts: number;
  tokens: number; // sum of the passages' model input lengths
  billedTokens: number; // as metered by Workers AI, or the padded estimate when not reported
  neuronsEstimated: number;
  inserted: number;
  updated: number;
  invalid: number;
  oversized: number;
  empty: number;
  embedMs: number;
};

export type PassageEmbeddingDraft = {
  passage_id: string;
  repository_id: number;
  model: typeof EMBEDDING_MODEL;
  pooling: typeof EMBEDDING_POOLING;
  dims: number;
  content_hash: string;
  token_count: number;
  embedding: number[];
  embedded_by_job: number;
};

/**
 * Embeds the repository's passages that have no current embedding. A run takes at most
 * batchSize x maxBatches pending passages; done is decided by that budget, never by what
 * is still pending, so a passage that can never be embedded cannot loop forever. Texts
 * are batched by length because Workers AI meters a batch at its longest text. One
 * invalid vector fails one passage; a failing batch keeps the batches stored before it.
 * The repository status is refreshed after the first stored batch, so the repository is
 * searchable (partially) within one batch, and again at the end of the run.
 */
export async function embedPassages(
  ctx: EmbedContext,
  repositoryId: number,
  jobId: number,
  options: EmbedOptions = {},
): Promise<EmbedResult> {
  const client = ctx.embeddings;
  if (!client) {
    throw new JobError("ai_not_configured", "Workers AI credentials are missing (CLOUDFLARE_ACCOUNT_ID, WORKERS_AI_API_TOKEN)", {
      transient: false,
    });
  }
  const batchSize = options.batchSize ?? EMBEDDING_BATCH_SIZE;
  const budget = batchSize * (options.maxBatches ?? MAX_BATCHES_PER_RUN);

  const rows = await pendingPassages(ctx.db, repositoryId, budget + 1);
  const hasMore = rows.length > budget;
  const { eligible, oversized, empty } = partitionPassages(rows.slice(0, budget));
  const totals = {
    batches: 0,
    texts: 0,
    tokens: 0,
    billedTokens: 0,
    inserted: 0,
    updated: 0,
    invalid: 0,
    oversized: oversized.length,
    empty: empty.length,
    embedMs: 0,
  };
  for (const p of [...oversized, ...empty]) console.warn(`passage ${p.passage_id} skipped: ${oversized.includes(p) ? "oversized" : "empty"}`);

  const ordered = [...eligible].sort((a, b) => a.token_count - b.token_count || (a.passage_id < b.passage_id ? -1 : 1));
  let firstBatchStored = false;
  try {
    for (const batch of chunk(ordered, batchSize)) {
      const result = await client.embed(batch.map((p) => p.text));
      totals.batches += 1;
      totals.texts += batch.length;
      totals.embedMs += result.durationMs;
      totals.tokens += batch.reduce((sum, p) => sum + p.token_count, 0);
      totals.billedTokens += result.tokens ?? batch.length * Math.max(...batch.map((p) => p.token_count));

      const drafts: PassageEmbeddingDraft[] = [];
      batch.forEach((p, i) => {
        const problem = validateVector(result.vectors[i]);
        if (problem) {
          totals.invalid += 1;
          console.warn(`passage ${p.passage_id}: invalid embedding (${problem})`);
          return;
        }
        drafts.push({
          passage_id: p.passage_id,
          repository_id: repositoryId,
          model: EMBEDDING_MODEL,
          pooling: EMBEDDING_POOLING,
          dims: EMBEDDING_DIMS,
          content_hash: p.content_hash,
          token_count: p.token_count,
          embedding: result.vectors[i],
          embedded_by_job: jobId,
        });
      });
      if (drafts.length) {
        const counts = await upsertPassageEmbeddings(ctx.db, drafts);
        totals.inserted += counts.inserted;
        totals.updated += counts.updated;
        if (!firstBatchStored) {
          firstBatchStored = true;
          await refreshRepositoryStatus(ctx.db, repositoryId, TRANSFORM_VERSION);
        }
      }
    }
  } finally {
    if (totals.batches > 0) {
      try {
        await recordEmbeddingUsage(ctx.db, {
          job_id: jobId,
          repository_id: repositoryId,
          model: EMBEDDING_MODEL,
          batches: totals.batches,
          texts: totals.texts,
          tokens: totals.tokens,
          billed_tokens: totals.billedTokens,
          neurons_estimated: neuronsFor(totals.billedTokens),
          duration_ms: totals.embedMs,
        });
      } catch (err) {
        console.error("could not record embedding usage", err);
      }
    }
  }
  await refreshRepositoryStatus(ctx.db, repositoryId, TRANSFORM_VERSION);
  return { done: !hasMore, ...totals, neuronsEstimated: neuronsFor(totals.billedTokens) };
}

export function partitionPassages(rows: PendingPassage[]): {
  eligible: PendingPassage[];
  oversized: PendingPassage[];
  empty: PendingPassage[];
} {
  const eligible: PendingPassage[] = [];
  const oversized: PendingPassage[] = [];
  const empty: PendingPassage[] = [];
  for (const row of rows) {
    if (row.text.trim() === "") empty.push(row);
    else if (row.token_count > EMBEDDING_MAX_TOKENS) oversized.push(row);
    else eligible.push(row);
  }
  return { eligible, oversized, empty };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export async function pendingPassages(db: SupabaseClient, repositoryId: number, limit: number): Promise<PendingPassage[]> {
  const { data, error } = await db.rpc("pending_passages", { p_repository_id: repositoryId, p_limit: limit });
  if (error) throw new Error(`pending_passages failed: ${error.message}`);
  return (data ?? []) as PendingPassage[];
}

export async function upsertPassageEmbeddings(
  db: SupabaseClient,
  rows: PassageEmbeddingDraft[],
): Promise<{ inserted: number; updated: number }> {
  const { data, error } = await db.rpc("upsert_passage_embeddings", { p_rows: rows }).single();
  if (error) throw new Error(`upsert_passage_embeddings failed: ${error.message}`);
  return data as { inserted: number; updated: number };
}

export async function recordEmbeddingUsage(
  db: SupabaseClient,
  usage: {
    job_id: number;
    repository_id: number;
    model: string;
    batches: number;
    texts: number;
    tokens: number;
    billed_tokens: number;
    neurons_estimated: number;
    duration_ms: number;
  },
): Promise<void> {
  const { error } = await db.from("embedding_usage").insert(usage);
  if (error) throw new Error(`insert embedding_usage failed: ${error.message}`);
}

export async function embeddingStats(db: SupabaseClient, repositoryId: number): Promise<EmbeddingStats> {
  const { data, error } = await db.rpc("embedding_stats", { p_repository_id: repositoryId }).single();
  if (error) throw new Error(`embedding_stats failed: ${error.message}`);
  const row = data as Record<string, number | string | null>;
  const n = (key: string) => Number(row[key] ?? 0);
  return {
    repository_id: repositoryId,
    model: EMBEDDING_MODEL,
    pooling: EMBEDDING_POOLING,
    dims: EMBEDDING_DIMS,
    passages: n("passages"),
    embedded: n("embedded"),
    pending: n("pending"),
    oversized: n("oversized"),
    empty: n("empty"),
    texts: n("texts"),
    tokens: n("tokens"),
    billed_tokens: n("billed_tokens"),
    neurons_estimated: n("neurons_estimated"),
    usd_estimated: usdFor(n("billed_tokens")),
  };
}
