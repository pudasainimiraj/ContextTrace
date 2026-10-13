import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceRecord } from "../shared/api.ts";
import { MAX_PASSAGE_TOKENS, type TokenCounter } from "./chunk.ts";
import { dirtyDocuments, type DocumentRow, listDocumentSources, syncPassages } from "./documents.ts";
import { buildPassages, documentFromSources, finalizePassages, type PassageRow } from "./passages.ts";
import { countModelTokens, TOKENIZER_NAME } from "./tokenizer.ts";

export const TRANSFORM_JOB_KIND = "transform_passages";
/** Bump when normalizeMarkdown, splitText, MAX_PASSAGE_TOKENS or the tokenizer files change. */
export const TRANSFORM_VERSION = "1";
/** Threads transformed per job run before the job yields to a continuation job. */
export const DOCUMENTS_PER_RUN = 50;

export type TransformResult = {
  done: boolean;
  documents: number;
  units: number;
  skippedUnits: number;
  passages: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  syncBytes: number;
};

export type TransformOptions = {
  limit?: number;
  transformVersion?: string;
  maxTokens?: number;
  countTokens?: TokenCounter;
  tokenizer?: string;
};

/**
 * Transforms the repository's dirty threads: sources are grouped by thread, normalized,
 * chunked and written through sync_passages, which leaves unchanged passages untouched and
 * removes parts that no longer exist. A thread stays dirty until its opening row exists.
 */
export async function transformRepository(
  db: SupabaseClient,
  repositoryId: number,
  options: TransformOptions = {},
): Promise<TransformResult> {
  const limit = options.limit ?? DOCUMENTS_PER_RUN;
  const version = options.transformVersion ?? TRANSFORM_VERSION;
  const build = {
    maxTokens: options.maxTokens ?? MAX_PASSAGE_TOKENS,
    countTokens: options.countTokens ?? countModelTokens,
    tokenizer: options.tokenizer ?? TOKENIZER_NAME,
  };

  const numbers = await dirtyDocuments(db, repositoryId, version, limit);
  const totals = { documents: 0, units: 0, skippedUnits: 0, passages: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, syncBytes: 0 };
  if (numbers.length === 0) return { done: true, ...totals };

  const byNumber = new Map<number, SourceRecord[]>();
  for (const row of await listDocumentSources(db, repositoryId, numbers)) {
    byNumber.set(row.number, [...(byNumber.get(row.number) ?? []), row]);
  }

  const documents: DocumentRow[] = [];
  const passages: PassageRow[] = [];
  for (const number of numbers) {
    const sources = byNumber.get(number) ?? [];
    const doc = documentFromSources(repositoryId, sources);
    if (!doc) continue;
    const built = buildPassages(doc, build);
    totals.units += built.units;
    totals.skippedUnits += built.skipped;
    documents.push({
      document_id: doc.document_id,
      repository_id: repositoryId,
      type: doc.type,
      number: doc.number,
      title: doc.title,
      transform_version: version,
      // The newest fetched_at among the rows actually read; anything fetched later stays dirty.
      // PostgREST timestamps share a fixed-width prefix, so the string maximum is the latest.
      sources_fetched_at: sources.map((s) => s.fetched_at).reduce((a, b) => (a > b ? a : b)),
    });
    passages.push(...(await finalizePassages(built.passages, version)));
  }

  const counts = await syncPassages(db, documents, passages);
  totals.documents = counts.documents;
  totals.passages = passages.length;
  totals.inserted = counts.inserted;
  totals.updated = counts.updated;
  totals.unchanged = counts.unchanged;
  totals.removed = counts.removed;
  totals.syncBytes = new TextEncoder().encode(JSON.stringify({ documents, passages })).length;

  const remaining = await dirtyDocuments(db, repositoryId, version, 1);
  return { done: remaining.length === 0, ...totals };
}
