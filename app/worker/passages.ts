import type { DocumentType, SourceRecord, SourceType } from "../shared/api.ts";

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
