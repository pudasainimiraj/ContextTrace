import { describe, expect, it } from "vitest";
import type { SourceRecord } from "../shared/api.ts";
import { MAX_PASSAGE_TOKENS } from "../worker/chunk.ts";
import {
  buildPassages,
  compareUnits,
  contentHash,
  documentFromSources,
  documentId,
  type PassageDraft,
  reviewPositions,
  unitLocator,
} from "../worker/passages.ts";
import { countModelTokens, TOKENIZER_NAME } from "../worker/tokenizer.ts";
import { fixtureDocument, type FixtureRecord, loadFixture, words } from "./fixtures.ts";

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
    seen_at: "2026-10-13T00:00:00Z",
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

/** Builds the passages of a Python fixture with the reference word counter unless told otherwise. */
function build(name: string, maxTokens: number, countTokens = words) {
  return buildPassages(fixtureDocument(loadFixture(name)), { maxTokens, countTokens, tokenizer: "words" });
}

function ofComment(passages: PassageDraft[], id: number): PassageDraft[] {
  return passages.filter((p) => p.source_type === "issue_comment" && p.source_github_id === id);
}

function assertWithinBudget(passages: PassageDraft[], maxTokens: number, count = words) {
  for (const p of passages) {
    expect(count(p.text), p.passage_id).toBeLessThanOrEqual(maxTokens);
    expect(p.token_count, p.passage_id).toBeLessThanOrEqual(maxTokens);
  }
}

describe("buildPassages on the Python fixtures", () => {
  it("short comment is one passage with its source", () => {
    const record = loadFixture("short_comment");
    const comment = ofComment(build("short_comment", 512).passages, 123);
    expect(comment).toHaveLength(1);
    expect(comment[0]).toMatchObject({
      text: record.comments[0].body,
      source_url: "https://github.com/example/project/issues/1#issuecomment-123",
      author: "bob",
      locator: "Comment 1 of 1",
      chunk_count: 1,
      tokenizer: "words",
    });
  });

  it("long comment splits within budget and loses nothing", () => {
    const record = loadFixture("long_comment");
    const parts = ofComment(build("long_comment", 40).passages, 900);
    expect(parts.length).toBeGreaterThan(1);
    assertWithinBudget(parts, 40);
    expect(parts.map((p) => p.text).join(" ").split(/\s+/)).toEqual(record.comments[0].body.split(/\s+/));
    expect(parts.map((p) => p.chunk_index)).toEqual(parts.map((_, i) => i));
    expect(parts.every((p) => p.chunk_count === parts.length)).toBe(true);
    expect(parts[0].locator).toBe(`Comment 1 of 1 (part 1 of ${parts.length})`);
    for (const p of parts) {
      expect(p.source_url).toBe(record.comments[0].html_url);
      expect(p.author).toBe("ann");
    }
  });

  it("long comment respects the real WordPiece budget", () => {
    const { passages } = build("long_comment", 64, countModelTokens);
    expect(passages.length).toBeGreaterThan(1);
    assertWithinBudget(passages, 64, countModelTokens);
  });

  it("separate speakers are never merged", () => {
    const record = loadFixture("separate_speakers");
    const comments = build("separate_speakers", 512).passages.filter((p) => p.source_type === "issue_comment");
    expect(comments.map((p) => p.author)).toEqual(["ann", "bob"]);
    expect(comments.map((p) => p.source_github_id)).toEqual([11, 12]);
    const [annText, bobText] = record.comments.map((c) => c.body);
    for (const p of comments) expect(p.text.includes(annText) && p.text.includes(bobText), p.text).toBe(false);
    expect(comments[0].source_url).not.toBe(comments[1].source_url);
  });

  it("empty comments produce no passages", () => {
    const { passages, skipped } = build("empty_comment", 512);
    expect(skipped).toBe(3);
    expect(passages.map((p) => p.source_type)).toEqual(["issue"]);
    expect(passages.every((p) => p.text.trim())).toBe(true);
  });

  it("code name is preserved in every form", () => {
    const joined = build("code_name", 512).passages.map((p) => p.text).join("\n");
    expect(joined.split("AutoMaterializePolicy").length - 1).toBe(5);
    expect(joined).toContain("`AutoMaterializePolicy`");
    expect(joined).toContain("AutoMaterializePolicy.eager()");
    expect(joined).toContain("auto_materialize_policy=AutoMaterializePolicy.lazy()");
    expect(joined).not.toContain("**");
  });

  it("fenced block stays intact when it fits", () => {
    const small = ofComment(build("fenced_block", 512).passages, 1);
    expect(small).toHaveLength(1);
    expect(small[0].text).toContain("```yaml\nscheduler:\n  kind: tick\n  interval: 30s\n```");
  });

  it("oversized fenced block splits into fenced parts", () => {
    const record = loadFixture("fenced_block");
    const parts = ofComment(build("fenced_block", 12).passages, 2);
    expect(parts.length).toBeGreaterThan(1);
    assertWithinBudget(parts, 12);
    const expectedLines = record.comments[1].body.split("\n").filter((l) => l.startsWith("step_"));
    const keptLines = parts.flatMap((p) => p.text.split("\n").filter((l) => l.startsWith("step_")));
    expect(keptLines).toEqual(expectedLines);
    for (const p of parts) {
      if (p.text.includes("step_")) {
        expect(p.text.startsWith("```text\n"), p.text).toBe(true);
        expect(p.text.endsWith("\n```"), p.text).toBe(true);
      }
    }
  });

  it("permalink is kept on every passage and the blob URL is never broken", () => {
    const parts = ofComment(build("permalink", 20).passages, 777);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.source_url === "https://github.com/example/project/issues/9#issuecomment-777")).toBe(true);
    const blob = "https://github.com/example/project/blob/0a1b2c3d/src/scheduler/policy.py#L42-L57";
    expect(parts.filter((p) => p.text.includes(blob))).toHaveLength(1);
  });

  it("lead-ins move with what they introduce", () => {
    const { passages } = build("lead_in", 24);
    expect(passages.length).toBeGreaterThan(1);
    const texts = passages.map((p) => p.text);
    for (const [leadIn, follower] of [
      ["You could instead construct the check like so:", "```python"],
      ["## Why this change", "The old policy computed"],
      ["F.A.Q.", "- Will the old policy be removed?"],
    ]) {
      const holder = texts.filter((t) => t.includes(leadIn));
      expect(holder, leadIn).toHaveLength(1);
      expect(holder[0], leadIn).toContain(follower);
      expect(holder[0].trimEnd().endsWith(leadIn), leadIn).toBe(false);
    }
  });

  it("explanation stays with its proposal", () => {
    expect(build("context_needed", 50).passages).toHaveLength(1);
    const tight = build("context_needed", 15).passages;
    expect(tight).toHaveLength(3);
    for (const p of tight) {
      const lines = p.text.split("\n");
      expect(lines, p.text).toHaveLength(2);
      expect(lines[0].startsWith("We ")).toBe(true);
      expect(/^(However|It )/.test(lines[1]), lines[1]).toBe(true);
    }
  });

  it("passages never mix units", () => {
    const record: FixtureRecord = {
      type: "issue",
      document_id: "github:o/r:issue:1",
      issue: { title: "T", author: "ann", created_at: "2024-01-01T00:00:00Z", html_url: "u", body: "p1 p2 p3 p4 p5 p6" },
      comments: [
        { id: 7, author: "bob", created_at: "2024-01-02T00:00:00Z", html_url: "u#7", body: "c1 c2 c3 c4 c5" },
        { id: 8, author: "cy", created_at: "2024-01-03T00:00:00Z", html_url: "u#8", body: "<!-- x -->" },
        { id: 9, author: "dee", created_at: "2024-01-04T00:00:00Z", html_url: "u#9", body: "short" },
      ],
    };
    const { passages, skipped } = buildPassages(fixtureDocument(record), { maxTokens: 4, countTokens: words, tokenizer: "words" });
    expect(skipped).toBe(1);
    const ids = passages.map((p) => p.passage_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(passages.every((p) => p.token_count <= 4)).toBe(true);

    const body = passages.filter((p) => p.source_type === "issue");
    expect(body.map((p) => p.locator)).toEqual(["Opening body (part 1 of 2)", "Opening body (part 2 of 2)"]);
    expect(body.every((p) => p.author === "ann" && p.source_url === "u")).toBe(true);
    expect(body.map((p) => p.passage_id)).toEqual(["github:424242:issue:1:body:0", "github:424242:issue:1:body:1"]);

    const c7 = ofComment(passages, 7);
    expect(c7.map((p) => p.locator)).toEqual(["Comment 1 of 3 (part 1 of 2)", "Comment 1 of 3 (part 2 of 2)"]);
    expect(c7.every((p) => p.author === "bob" && p.source_url === "u#7")).toBe(true);
    expect(c7[0].passage_id).toBe("github:424242:issue:1:issue_comment:7:0");

    const c9 = ofComment(passages, 9);
    expect(c9).toHaveLength(1);
    expect(c9[0]).toMatchObject({ locator: "Comment 3 of 3", chunk_count: 1 });
  });
});

describe("long comments with the model tokenizer", () => {
  it("a 10 KB comment with prose, a 120-line fence and a long URL stays within MAX_PASSAGE_TOKENS", () => {
    const prose = Array.from({ length: 24 }, (_, i) =>
      `Paragraph ${i + 1}: the scheduler drifted after the daylight saving change, so we moved to ticks and kept the cron syntax as the user-facing format for everyone. The translator is lossless for every expression in the corpus.`,
    );
    const code = ["```ts", ...Array.from({ length: 120 }, (_, i) => `const value_${i} = compute(${i}) + offset_${i} * scale;`), "```"];
    const url = `https://github.com/example/project/blob/${"a1b2c3d4".repeat(5)}/src/${"deep/".repeat(20)}policy.ts#L42-L57`;
    const body = [...prose.slice(0, 12), code.join("\n"), `See ${url} for the policy.`, ...prose.slice(12)].join("\n\n");
    expect(body.length).toBeGreaterThan(10_000);

    const record: FixtureRecord = {
      type: "issue",
      document_id: "github:o/r:issue:77",
      issue: { title: "Long", author: "ann", created_at: "2024-01-01T00:00:00Z", html_url: "u", body: "intro" },
      comments: [{ id: 5, author: "bob", created_at: "2024-01-02T00:00:00Z", html_url: "u#5", body }],
    };
    const { passages } = buildPassages(fixtureDocument(record), {
      maxTokens: MAX_PASSAGE_TOKENS,
      countTokens: countModelTokens,
      tokenizer: TOKENIZER_NAME,
    });
    const parts = ofComment(passages, 5);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) {
      expect(countModelTokens(p.text), p.passage_id).toBeLessThanOrEqual(MAX_PASSAGE_TOKENS);
      expect(p.token_count).toBe(countModelTokens(p.text));
      expect(p.tokenizer).toBe(TOKENIZER_NAME);
    }
    expect(parts.map((p) => p.chunk_index)).toEqual(parts.map((_, i) => i));

    const isFenceLine = (line: string) => line === "```ts" || line === "```";
    const wordsOf = (text: string) => text.split("\n").filter((l) => !isFenceLine(l)).join("\n").split(/\s+/).filter(Boolean);
    expect(parts.flatMap((p) => wordsOf(p.text))).toEqual(wordsOf(body));

    const codeLines = (text: string) => text.split("\n").filter((l) => l.startsWith("const value_"));
    expect(parts.flatMap((p) => codeLines(p.text))).toEqual(codeLines(body));
    for (const p of parts) {
      if (codeLines(p.text).length) {
        expect(p.text.startsWith("```ts\n"), p.passage_id).toBe(true);
        expect(p.text.endsWith("\n```"), p.passage_id).toBe(true);
      }
    }
    expect(parts.filter((p) => p.text.includes(url))).toHaveLength(1);
  });
});

describe("stable ids and content hashes", () => {
  it("passage ids are deterministic and distinct across comment types", () => {
    const rows: SourceRecord[] = [
      source({ type: "issue", github_id: 1, number: 1, created_at: "2026-01-01T00:00:00Z", title: "t", body: "opening" }),
      source({ type: "issue_comment", github_id: 7, number: 1, created_at: "2026-01-02T00:00:00Z", body: "conversation" }),
      source({ type: "review_comment", github_id: 7, number: 1, created_at: "2026-01-03T00:00:00Z", body: "inline", path: "a.ts", line: 1 }),
    ];
    const build = () => buildPassages(documentFromSources(424242, rows)!, { maxTokens: 512, countTokens: words, tokenizer: "words" });
    const ids = build().passages.map((p) => p.passage_id);
    expect(ids).toEqual([
      "github:424242:issue:1:body:0",
      "github:424242:issue:1:issue_comment:7:0",
      "github:424242:issue:1:review_comment:7:0",
    ]);
    expect(build().passages.map((p) => p.passage_id)).toEqual(ids);
  });

  it("content hash is the SHA-256 hex of the text", async () => {
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await contentHash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
