import type { DocumentType } from "../../shared/api.ts";
import type { DocumentInput, UnitInput } from "../../worker/src/etl/passages.ts";

// The Python pipeline's fixture records, copied verbatim from pipeline/tests/fixtures.
const RAW = import.meta.glob("./*.json", { eager: true, query: "?raw", import: "default" }) as Record<
  string,
  string
>;

export type FixtureUnit = {
  title?: string;
  author: string;
  created_at: string;
  html_url: string;
  body: string;
};

export type FixtureComment = FixtureUnit & { id: number; reply_to?: number };

export type FixtureRecord = {
  type: string;
  document_id: string;
  comments: FixtureComment[];
} & Record<string, unknown>;

export function loadFixture(name: string): FixtureRecord {
  const raw = RAW[`./${name}.json`];
  if (raw === undefined) throw new Error(`no fixture named ${name}`);
  return JSON.parse(raw) as FixtureRecord;
}

/** Python `len(text.split())`: the token counter the reference tests use. */
export function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Adapts the Python record shape to DocumentInput. A discussion maps to an issue. */
export function fixtureDocument(record: FixtureRecord, repositoryId = 424242): DocumentInput {
  const type: DocumentType = record.type === "pull_request" ? "pull_request" : "issue";
  const number = Number(record.document_id.slice(record.document_id.lastIndexOf(":") + 1));
  const opening = record[record.type] as FixtureUnit;
  const unit = (u: FixtureUnit, source_type: UnitInput["source_type"], id: number, replyTo?: number): UnitInput => ({
    source_type,
    source_github_id: id,
    author: u.author,
    created_at: u.created_at,
    source_url: u.html_url,
    body: u.body,
    path: null,
    line: null,
    in_reply_to_id: replyTo ?? null,
  });
  return {
    document_id: `github:${repositoryId}:${type}:${number}`,
    repository_id: repositoryId,
    type,
    number,
    title: opening.title ?? "",
    opening: unit(opening, type, number),
    comments: record.comments.map((c) => unit(c, "issue_comment", c.id, c.reply_to)),
  };
}
