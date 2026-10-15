import type { DocumentType, PassageRecord, SourceRecord, SourceType } from "../../../shared/api.ts";
import { splitText, type TokenCounter } from "./chunk.ts";
import { normalizeMarkdown, TEXT_KIND } from "./normalize.ts";

/** One source unit as the passage builder consumes it: the opening body or one comment. */
export type UnitInput = {
  source_type: SourceType;
  source_github_id: number;
  author: string | null;
  created_at: string;
  source_url: string;
  body: string | null;
  path: string | null; // review comments
  line: number | null; // review comments
  in_reply_to_id: number | null; // review comments
};

/** One conversation thread: the opening unit plus its comments in thread order. */
export type DocumentInput = {
  document_id: string;
  repository_id: number;
  type: DocumentType;
  number: number;
  title: string;
  opening: UnitInput;
  comments: UnitInput[];
};

/** github:{repository_id}:{type}:{number}; the numeric repository id survives renames. */
export function documentId(repositoryId: number, type: DocumentType, number: number): string {
  return `github:${repositoryId}:${type}:${number}`;
}

/**
 * {document_id}:body:{i} for the opening, {document_id}:{source_type}:{github_id}:{i} for a
 * comment. The source type is part of the id because issue-comment and review-comment ids
 * are separate GitHub sequences and can collide.
 */
export function passageId(documentId: string, unit: UnitInput, index: number): string {
  const segment = isOpening(unit) ? "body" : `${unit.source_type}:${unit.source_github_id}`;
  return `${documentId}:${segment}:${index}`;
}

function isOpening(unit: UnitInput): boolean {
  return unit.source_type === "issue" || unit.source_type === "pull_request";
}

const TYPE_ORDER: Record<SourceType, number> = { issue: 0, pull_request: 0, issue_comment: 1, review_comment: 2 };

/** Thread order: creation time, then conversation comments before review comments, then id. */
export function compareUnits(a: UnitInput, b: UnitInput): number {
  return (
    Date.parse(a.created_at) - Date.parse(b.created_at) ||
    TYPE_ORDER[a.source_type] - TYPE_ORDER[b.source_type] ||
    a.source_github_id - b.source_github_id
  );
}

export function unitFromSource(source: SourceRecord): UnitInput {
  return {
    source_type: source.type,
    source_github_id: source.github_id,
    author: source.author,
    created_at: source.created_at,
    source_url: source.html_url,
    body: source.body,
    path: source.path,
    line: source.line,
    in_reply_to_id: source.in_reply_to_id,
  };
}

/** Groups one thread's source rows into a DocumentInput; null when the opening row is missing. */
export function documentFromSources(repositoryId: number, sources: SourceRecord[]): DocumentInput | null {
  const opening = sources.find((s) => s.type === "issue" || s.type === "pull_request");
  if (!opening) return null;
  const type = opening.type as DocumentType;
  const comments = sources
    .filter((s) => s.type === "issue_comment" || s.type === "review_comment")
    .map(unitFromSource)
    .sort(compareUnits);
  return {
    document_id: documentId(repositoryId, type, opening.number),
    repository_id: repositoryId,
    type,
    number: opening.number,
    title: opening.title ?? "",
    opening: unitFromSource(opening),
    comments,
  };
}

/**
 * "Comment k of N", or "Review comment k of N on path:line" for an inline review comment,
 * plus ", reply to comment j" when the parent review comment is in the thread.
 * `position` maps a review comment's GitHub id to its 1-based position.
 */
export function unitLocator(unit: UnitInput, index: number, total: number, position: Map<number, number>): string {
  let locator: string;
  if (unit.source_type === "review_comment") {
    const where = unit.line === null ? (unit.path ?? "?") : `${unit.path ?? "?"}:${unit.line}`;
    locator = `Review comment ${index} of ${total} on ${where}`;
  } else {
    locator = `Comment ${index} of ${total}`;
  }
  if (unit.in_reply_to_id !== null) {
    locator += `, reply to comment ${position.get(unit.in_reply_to_id) ?? "?"}`;
  }
  return locator;
}

/** Review comment GitHub id -> 1-based position among all comments. */
export function reviewPositions(comments: UnitInput[]): Map<number, number> {
  const position = new Map<number, number>();
  comments.forEach((unit, i) => {
    if (unit.source_type === "review_comment") position.set(unit.source_github_id, i + 1);
  });
  return position;
}

export type BuildOptions = { maxTokens: number; countTokens: TokenCounter; tokenizer: string };
export type PassageDraft = Omit<PassageRecord, "content_hash" | "transform_version" | "index_state" | "updated_at">;
export type BuildResult = { passages: PassageDraft[]; units: number; skipped: number };

/**
 * Port of build_passages(): every unit (the opening body, then each comment in thread
 * order) is normalized, split within the token budget, and labelled. A unit whose
 * normalized text is empty is skipped and counted. A passage never mixes units.
 */
export function buildPassages(doc: DocumentInput, options: BuildOptions): BuildResult {
  const position = reviewPositions(doc.comments);
  const units = [
    { unit: doc.opening, locator: "Opening body" },
    ...doc.comments.map((unit, i) => ({ unit, locator: unitLocator(unit, i + 1, doc.comments.length, position) })),
  ];

  const passages: PassageDraft[] = [];
  let skipped = 0;
  for (const { unit, locator } of units) {
    const text = normalizeMarkdown(unit.body);
    if (!text) {
      skipped += 1;
      continue;
    }
    const chunks = splitText(text, options.maxTokens, options.countTokens);
    chunks.forEach((chunk, index) => {
      passages.push({
        passage_id: passageId(doc.document_id, unit, index),
        document_id: doc.document_id,
        repository_id: doc.repository_id,
        source_type: unit.source_type,
        source_github_id: unit.source_github_id,
        chunk_index: index,
        chunk_count: chunks.length,
        token_count: options.countTokens(chunk),
        tokenizer: options.tokenizer,
        locator: chunks.length > 1 ? `${locator} (part ${index + 1} of ${chunks.length})` : locator,
        author: unit.author,
        created_at: unit.created_at,
        source_url: unit.source_url,
        text: chunk,
        text_kind: TEXT_KIND,
      });
    });
  }
  return { passages, units: units.length, skipped };
}

/** A storable row; the database owns index_state and updated_at. */
export type PassageRow = Omit<PassageRecord, "index_state" | "updated_at">;

/** SHA-256 of the UTF-8 bytes of `text`, lowercase hex. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Adds the content hash and the transform version that make a draft a storable row. */
export function finalizePassages(drafts: PassageDraft[], transformVersion: string): Promise<PassageRow[]> {
  return Promise.all(
    drafts.map(async (draft) => ({ ...draft, content_hash: await contentHash(draft.text), transform_version: transformVersion })),
  );
}
