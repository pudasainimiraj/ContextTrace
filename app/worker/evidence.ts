import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentType, EvidenceCard, SearchHit, SourceType } from "../shared/api.ts";

/** Excerpt length in code points; a sentence or two, enough to judge a result before opening it. */
export const EXCERPT_CHARS = 300;

/** The start of a passage on one line, cut at a word boundary and marked with an ellipsis. */
export function excerptOf(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const head = chars.slice(0, max).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

const GITHUB_THREAD_PATH = /^\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)$/;

export type SourceUnit = { type: DocumentType; number: number; source_type: SourceType; source_github_id: number };

/**
 * True when the url is a github.com permalink to the unit the passage came from: the
 * thread under /issues/{number} or /pull/{number}, and for a comment the anchor GitHub
 * gives it (#issuecomment-{id} or #discussion_r{id}). The owner and name segments are not
 * compared, because GitHub redirects renamed repositories and the links keep working.
 */
export function verifySourceLink(url: string, unit: SourceUnit): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return false;
  const match = GITHUB_THREAD_PATH.exec(parsed.pathname);
  if (!match) return false;
  if (match[1] !== (unit.type === "issue" ? "issues" : "pull") || Number(match[2]) !== unit.number) return false;
  switch (unit.source_type) {
    case "issue_comment":
      return parsed.hash === `#issuecomment-${unit.source_github_id}`;
    case "review_comment":
      return parsed.hash === `#discussion_r${unit.source_github_id}`;
    default:
      return parsed.hash === "";
  }
}

type PassageJoin = {
  passage_id: string;
  document_id: string;
  source_type: SourceType;
  source_github_id: number;
  locator: string;
  author: string | null;
  created_at: string;
  source_url: string;
  text: string;
  documents: { type: DocumentType; number: number; title: string } | null;
};

/**
 * Resolves search hits into evidence cards through passages and documents, in hit order.
 * A hit whose passage disappeared since the search is skipped; one whose source link
 * fails verification is left out and counted, so every card shown links to its source.
 */
export async function resolveEvidence(
  db: SupabaseClient,
  repositoryId: number,
  hits: SearchHit[],
): Promise<{ cards: EvidenceCard[]; unverified: number }> {
  if (hits.length === 0) return { cards: [], unverified: 0 };
  const { data, error } = await db
    .from("passages")
    .select("passage_id, document_id, source_type, source_github_id, locator, author, created_at, source_url, text, documents(type, number, title)")
    .eq("repository_id", repositoryId)
    .in(
      "passage_id",
      hits.map((h) => h.passage_id),
    );
  if (error) throw new Error(`select passages failed: ${error.message}`);
  const rows = new Map(((data ?? []) as unknown as PassageJoin[]).map((row) => [row.passage_id, row]));

  const cards: EvidenceCard[] = [];
  let unverified = 0;
  for (const hit of hits) {
    const row = rows.get(hit.passage_id);
    if (!row?.documents) continue;
    const doc = row.documents;
    const unit = { type: doc.type, number: doc.number, source_type: row.source_type, source_github_id: row.source_github_id };
    if (!verifySourceLink(row.source_url, unit)) {
      unverified++;
      console.error(`passage ${row.passage_id} has an unverifiable source link`);
      continue;
    }
    cards.push({
      passage_id: row.passage_id,
      document_id: row.document_id,
      type: doc.type,
      number: doc.number,
      title: doc.title,
      source_type: row.source_type,
      locator: row.locator,
      author: row.author,
      created_at: row.created_at,
      source_url: row.source_url,
      excerpt: excerptOf(row.text),
      score: hit.score,
    });
  }
  return { cards, unverified };
}
