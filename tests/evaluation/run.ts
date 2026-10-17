/**
 * Reproduces the retrieval evaluation against a deployed ContextTrace through its public API.
 *
 *   node tests/evaluation/run.ts [--base https://contexttrace.contexttrace.workers.dev] [--out tests/evaluation/results.json] [--pace 2200]
 *   node tests/evaluation/run.ts --rescore tests/evaluation/results.json      # recompute every table from saved responses, no network
 *
 * For every question in tests/evaluation/questions.json it asks the same query three times, in forced
 * semantic mode, forced keyword mode and auto mode (limit 5), paces the calls under the
 * public rate limit (30 searches a minute per address), honours Retry-After on a 429, then
 * prints the metrics as Markdown and writes every response to the results file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hitAtK, mean, reciprocalRankAtK, recallAtK, round, threadHitAtK, unitOf, unsupportedOutcome } from "./metrics.ts";

type Question = { id: string; repository_id: number; repository: string; question: string; supported: boolean; relevant: { passage_id: string; url: string }[] };
type Card = { passage_id: string; number: number; title: string; locator: string; source_url: string; score: number; match: string };
type Response = { mode: string; confidence: string; message: string | null; semantic_error: string | null; results: Card[]; requested_mode: string };
type Modes = "semantic" | "keyword" | "auto";
const MODES: Modes[] = ["semantic", "keyword", "auto"];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const base = arg("base", "https://contexttrace.contexttrace.workers.dev").replace(/\/$/, "");
const out = arg("out", "tests/evaluation/results.json");
const pace = Number(arg("pace", "2200"));
const questionsPath = arg("questions", "tests/evaluation/questions.json");
const raw = readFileSync(questionsPath, "utf8");
const dataset = JSON.parse(raw) as { frozen_at: string | null; questions: Question[] };
const sha256 = createHash("sha256").update(raw).digest("hex");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function search(q: Question, mode: Modes): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId: q.repository_id, query: q.question, limit: 5, mode }),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? "60") * 1000;
      console.error(`429 on ${q.id}/${mode}; waiting ${wait} ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${q.id}/${mode}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as Response;
  }
  throw new Error(`${q.id}/${mode}: rate limited five times`);
}

const rescore = arg("rescore", "");
const saved = rescore ? (JSON.parse(readFileSync(rescore, "utf8")) as { started_at: string; base: string; runs: { id: string; mode: Modes; response: Response }[] }) : null;
const runs: { id: string; mode: Modes; response: Response }[] = saved ? saved.runs : [];
const startedAt = saved ? saved.started_at : new Date().toISOString();
if (!saved) {
  for (const q of dataset.questions) {
    for (const mode of MODES) {
      runs.push({ id: q.id, mode, response: await search(q, mode) });
      await sleep(pace);
    }
  }
}

const supported = dataset.questions.filter((q) => q.supported);
const unsupported = dataset.questions.filter((q) => !q.supported);
const response = (id: string, mode: Modes) => runs.find((r) => r.id === id && r.mode === mode)!.response;
const ids = (r: Response) => r.results.map((c) => c.passage_id);
const relevant = (q: Question) => q.relevant.map((r) => r.passage_id);

type Row = { mode: Modes; recall3: number; hit3: number; mrr5: number; zero: number; threadHit3: number; threadHit5: number };
const perMode: Row[] = MODES.map((mode) => ({
  mode,
  recall3: round(mean(supported.map((q) => recallAtK(relevant(q), ids(response(q.id, mode)), 3)))),
  hit3: round(mean(supported.map((q) => hitAtK(relevant(q), ids(response(q.id, mode)), 3)))),
  mrr5: round(mean(supported.map((q) => reciprocalRankAtK(relevant(q), ids(response(q.id, mode)), 5)))),
  zero: supported.filter((q) => hitAtK(relevant(q), ids(response(q.id, mode)), 5) === 0).length,
  threadHit3: round(mean(supported.map((q) => threadHitAtK(relevant(q), ids(response(q.id, mode)), 3)))),
  threadHit5: round(mean(supported.map((q) => threadHitAtK(relevant(q), ids(response(q.id, mode)), 5)))),
}));
const repositories = [...new Set(dataset.questions.map((q) => q.repository))];
const perRepository = repositories.flatMap((repo) =>
  MODES.map((mode) => {
    const qs = supported.filter((q) => q.repository === repo);
    return { repo, mode, n: qs.length, recall3: round(mean(qs.map((q) => recallAtK(relevant(q), ids(response(q.id, mode)), 3)))), mrr5: round(mean(qs.map((q) => reciprocalRankAtK(relevant(q), ids(response(q.id, mode)), 5)))) };
  }),
);
const abstentions = unsupported.map((q) => ({ id: q.id, question: q.question, auto: unsupportedOutcome(response(q.id, "auto")), semanticTop: response(q.id, "semantic").results[0]?.score ?? null, keywordHits: response(q.id, "keyword").results.length }));
// Auto mode's decision: correct when a supported question gets a high-confidence answer with a relevant unit in the top 3, or an unsupported one gets none.
const decisions = dataset.questions.map((q) => {
  const auto = response(q.id, "auto");
  const correct = q.supported ? auto.confidence === "high" && hitAtK(relevant(q), ids(auto), 3) === 1 : auto.mode === "none";
  return { id: q.id, supported: q.supported, mode: auto.mode, confidence: auto.confidence, correct };
});
const failures = supported.flatMap((q) =>
  MODES.filter((mode) => hitAtK(relevant(q), ids(response(q.id, mode)), 3) === 0).map((mode) => ({
    id: q.id,
    mode,
    question: q.question,
    expected: q.relevant.map((r) => `${unitOf(r.passage_id)} ${r.url}`),
    returned: response(q.id, mode).results.slice(0, 3).map((c) => `#${c.number} ${c.locator} (${c.score.toFixed(3)}) ${c.source_url}`),
  })),
);

const results = { base: saved ? saved.base : base, started_at: startedAt, finished_at: saved ? startedAt : new Date().toISOString(), questions_sha256: sha256, frozen_at: dataset.frozen_at, per_mode: perMode, per_repository: perRepository, abstentions, decisions, failures, runs };
if (!saved) writeFileSync(out, JSON.stringify(results, null, 2) + "\n");

const lines: string[] = [];
lines.push(`Base ${results.base}, started ${startedAt}, questions.json sha256 ${sha256} (frozen ${dataset.frozen_at}).`, "");
lines.push("| mode | Recall@3 | Hit@3 | MRR@5 | zero hits in top 5 (of 20) | thread Hit@3 | thread Hit@5 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of perMode) lines.push(`| ${r.mode} | ${r.recall3} | ${r.hit3} | ${r.mrr5} | ${r.zero} | ${r.threadHit3} | ${r.threadHit5} |`);
lines.push("", "| repository | mode | n | Recall@3 | MRR@5 |", "| --- | --- | ---: | ---: | ---: |");
for (const r of perRepository) lines.push(`| ${r.repo} | ${r.mode} | ${r.n} | ${r.recall3} | ${r.mrr5} |`);
lines.push("", "| unsupported question | auto outcome | semantic top score | keyword hits |", "| --- | --- | ---: | ---: |");
for (const a of abstentions) lines.push(`| ${a.id} ${a.question} | ${a.auto} | ${a.semanticTop === null ? "none" : a.semanticTop.toFixed(3)} | ${a.keywordHits} |`);
lines.push("", `Auto mode decided correctly for ${decisions.filter((d) => d.correct).length} of 25 questions.`, "");
lines.push(`Failures (no relevant unit in the top 3): ${failures.length}`);
for (const f of failures) lines.push(`- ${f.id} [${f.mode}] ${f.question}`, `  expected: ${f.expected.join(" | ")}`, `  returned: ${f.returned.join(" | ") || "nothing"}`);
console.log(lines.join("\n"));
