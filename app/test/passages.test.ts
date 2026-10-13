import { describe, expect, it } from "vitest";
import type { SourceRecord } from "../shared/api.ts";
import { compareUnits, documentFromSources, documentId, reviewPositions, unitLocator } from "../worker/passages.ts";

function source(partial: Partial<SourceRecord> & Pick<SourceRecord, "type" | "github_id" | "number" | "created_at">): SourceRecord {
  return {
    repository_id: 424242,
    node_id: null,
    title: null,
    author: "ann",
    body: "text",
    state: null,
    html_url: `https://github.com/o/r/issues/${partial.number}`,
    api_url: `https://api.github.com/repos/o/r/issues/${partial.number}`,
    path: null,
    line: null,
    in_reply_to_id: null,
    closed_at: null,
    updated_at: partial.created_at,
    fetched_at: "2026-10-13T00:00:00Z",
    fetched_by_job: null,
    ...partial,
  };
}

describe("documentFromSources", () => {
  const rows: SourceRecord[] = [
    source({ type: "review_comment", github_id: 7002, number: 8, created_at: "2026-01-04T00:00:00Z", path: "src/a.ts", line: 12, in_reply_to_id: 7001 }),
    source({ type: "issue_comment", github_id: 5002, number: 8, created_at: "2026-01-05T00:00:00Z" }),
    source({ type: "pull_request", github_id: 1008, number: 8, created_at: "2026-01-01T00:00:00Z", title: "Add retries", html_url: "https://github.com/o/r/pull/8" }),
    source({ type: "issue_comment", github_id: 5001, number: 8, created_at: "2026-01-02T00:00:00Z" }),
    source({ type: "review_comment", github_id: 7001, number: 8, created_at: "2026-01-03T00:00:00Z", path: "src/a.ts", line: 12 }),
  ];

  it("maps a thread's sources to chronological units with locators", () => {
    const doc = documentFromSources(424242, rows)!;
    expect(doc).toMatchObject({ document_id: "github:424242:pull_request:8", type: "pull_request", number: 8, title: "Add retries" });
    expect(doc.opening).toMatchObject({ source_type: "pull_request", source_github_id: 1008, source_url: "https://github.com/o/r/pull/8" });
    expect(doc.comments.map((u) => u.source_github_id)).toEqual([5001, 7001, 7002, 5002]);

    const position = reviewPositions(doc.comments);
    const locators = doc.comments.map((u, i) => unitLocator(u, i + 1, doc.comments.length, position));
    expect(locators).toEqual([
      "Comment 1 of 4",
      "Review comment 2 of 4 on src/a.ts:12",
      "Review comment 3 of 4 on src/a.ts:12, reply to comment 2",
      "Comment 4 of 4",
    ]);
  });

  it("derives the document id from the repository id, type and number", () => {
    expect(documentId(71542716, "issue", 12)).toBe("github:71542716:issue:12");
  });

  it("returns null when the opening row is missing", () => {
    expect(documentFromSources(424242, rows.filter((r) => r.type !== "pull_request"))).toBeNull();
  });

  it("orders comments with the same timestamp by type then id", () => {
    const at = "2026-01-02T00:00:00Z";
    const units = [
      source({ type: "review_comment", github_id: 9, number: 1, created_at: at }),
      source({ type: "issue_comment", github_id: 20, number: 1, created_at: at }),
      source({ type: "issue_comment", github_id: 10, number: 1, created_at: at }),
    ].map((s) => ({ ...s, source_type: s.type, source_github_id: s.github_id, source_url: s.html_url }));
    const sorted = [...units].sort(compareUnits).map((u) => `${u.source_type}:${u.source_github_id}`);
    expect(sorted).toEqual(["issue_comment:10", "issue_comment:20", "review_comment:9"]);
  });

  it("omits the line and shows a question mark for an unknown reply parent", () => {
    const doc = documentFromSources(424242, [
      source({ type: "issue", github_id: 1, number: 1, created_at: "2026-01-01T00:00:00Z", title: "t" }),
      source({ type: "review_comment", github_id: 7, number: 1, created_at: "2026-01-02T00:00:00Z", path: "README.md", line: null, in_reply_to_id: 6 }),
    ])!;
    expect(unitLocator(doc.comments[0], 1, 1, reviewPositions(doc.comments))).toBe("Review comment 1 of 1 on README.md, reply to comment ?");
  });
});
