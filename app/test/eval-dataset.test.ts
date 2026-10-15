import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import questionsRaw from "../eval/questions.json?raw";
import { verifySourceLink } from "../worker/evidence.ts";
import { contentHash } from "../worker/passages.ts";
import { createDb } from "../worker/repositories.ts";

// The frozen evaluation set: 25 real developer questions over the four indexed repositories.
// Pinned here so the labels cannot drift from the index they were made on.
type Question = { id: string; repository_id: number; repository: string; question: string; supported: boolean; relevant: { passage_id: string; url: string }[]; rationale: string };
type Dataset = { version: number; frozen_at: string | null; questions: Question[]; };

const dataset = JSON.parse(questionsRaw) as Dataset;
const REPOSITORIES: Record<number, string> = { 71542716: "sindresorhus/p-limit", 72200120: "sindresorhus/p-queue", 315531538: "sindresorhus/yocto-queue", 71531782: "sindresorhus/p-defer" };
const PASSAGE_ID = /^github:(\d+):(issue|pull_request):(\d+):(body|issue_comment|review_comment)(?::(\d+))?:(\d+)$/;

/** Once the set is frozen, the report cites this digest; a changed file fails here. */
export const QUESTIONS_SHA256: string | null = "3b7232a3bb4dd14ed09a53a11d8d8f805856cef8973d22d522e68cc7268a4828";

describe("evaluation dataset", () => {
  it("has 25 questions, 20 supported and 5 unsupported, with unique ids over the indexed repositories", () => {
    const { questions } = dataset;
    expect(questions).toHaveLength(25);
    expect(questions.filter((q) => q.supported)).toHaveLength(20);
    expect(new Set(questions.map((q) => q.id)).size).toBe(25);
    for (const q of questions) {
      expect(REPOSITORIES[q.repository_id], q.id).toBe(q.repository);
      expect(q.question.length, q.id).toBeGreaterThan(15);
      expect(q.question.length, q.id).toBeLessThanOrEqual(200);
      expect(q.rationale.length, q.id).toBeGreaterThan(10);
      if (q.supported) {
        expect(q.relevant.length, q.id).toBeGreaterThanOrEqual(1);
        expect(q.relevant.length, q.id).toBeLessThanOrEqual(3);
      } else {
        expect(q.relevant, q.id).toEqual([]);
      }
      for (const r of q.relevant) {
        const m = PASSAGE_ID.exec(r.passage_id);
        expect(m, r.passage_id).not.toBeNull();
        expect(Number(m![1]), r.passage_id).toBe(q.repository_id);
        const [, , kind, number, unit, githubId] = m!;
        const sourceType = unit === "body" ? kind : unit;
        expect(verifySourceLink(r.url, { type: kind as "issue" | "pull_request", number: Number(number), source_type: sourceType as never, source_github_id: Number(githubId ?? 0) }), r.url).toBe(unit === "body" || Boolean(githubId));
      }
    }
  });

  it("is frozen with a recorded digest", async () => {
    const digest = await contentHash(questionsRaw);
    if (QUESTIONS_SHA256 === null) {
      expect(dataset.frozen_at).toBeNull(); // still under review
      console.log(`questions.json sha256 ${digest} (not frozen yet)`);
    } else {
      expect(dataset.frozen_at).not.toBeNull();
      expect(digest).toBe(QUESTIONS_SHA256);
    }
  });

  it.skipIf(!env.SUPABASE_SECRET_KEY)("labels every unit with a passage that exists in the live index and is searchable", async () => {
    const db = createDb(env);
    const ids = dataset.questions.flatMap((q) => q.relevant.map((r) => r.passage_id));
    const { data, error } = await db.from("passages").select("passage_id, index_state, source_url, repository_id").in("passage_id", ids);
    expect(error).toBeNull();
    const rows = new Map((data as { passage_id: string; index_state: string; source_url: string; repository_id: number }[]).map((r) => [r.passage_id, r]));
    for (const q of dataset.questions) {
      for (const r of q.relevant) {
        const row = rows.get(r.passage_id);
        expect(row, `${q.id}: ${r.passage_id} missing from the index`).toBeDefined();
        expect(row!.index_state, r.passage_id).toBe("active");
        expect(row!.repository_id, r.passage_id).toBe(q.repository_id);
        expect(row!.source_url.split("#")[0], r.passage_id).toBe(r.url.split("#")[0]);
      }
    }
  });
});
