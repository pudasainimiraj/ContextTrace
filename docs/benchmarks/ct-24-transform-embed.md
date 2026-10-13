# CT-24: transform and embed benchmark on a small public repository

Date: 2026-10-13. Branch `feat/ct-03-06-app` at CT-23. Repository: [sindresorhus/p-limit](https://github.com/sindresorhus/p-limit),
GitHub id 71542716, 427 source records (69 issues, 38 pull requests, 258 issue comments,
62 review comments) extracted in CT-18.

## Setup

- Runtime: `npm run dev` in `app/` (Cloudflare Vite plugin 1.63.1, workerd 1.20261006.1) on
  macOS. The Worker, the local Queue and its consumer run in one process. The database is the
  Supabase project in eu-west-2, reached over the Data API from the laptop.
- Model: Workers AI `@cf/baai/bge-small-en-v1.5`, pooling `cls`, 384 dimensions, reached over
  the REST API with `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_AI_API_TOKEN` from `app/.env`.
- Tokenizer: the model's own WordPiece tokenizer, vendored; `passages.token_count` is the model
  input length including `[CLS]` and `[SEP]`.
- Method: `POST /api/repositories/71542716/jobs {"kind":"transform_passages"}`, then
  `{"kind":"embed_passages"}`. The local queue delivered each job and its continuation; figures
  come from `jobs.result`, the job timestamps, `embedding_usage` and the stats route.

## Transform (CT-21)

| Run | Threads | Units | Skipped units | Passages written | Payload to Postgres | Run wall ms | Job wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 50 | 176 | 6 | 191 | 175,961 B | 631 | 725 |
| 2 | 50 | 237 | 3 | 288 | 266,428 B | 591 | 677 |
| 3 | 7 | 14 | 0 | 21 | 23,519 B | 383 | 470 |
| **Total** | **107** | **427** | **9** | **500** | **465,908 B** | **1,605** | **1,872** |

The three runs chained through continuation jobs and settled 7 s after the POST. Every
passage carries the tokenizer name; the largest is 256 tokens (the budget), the average 83;
117 passages are parts of a split unit. A second transform reports zero dirty threads.

## Embed (CT-23)

Before the run: 500 passages, 500 pending, 0 embedded. Two drill passages were added to
issue 10 first: one with `token_count` 600 and one whose text is blank.

| Run | Batches | Texts | Exact tokens | Billed tokens | Neurons | Oversized | Empty | Model calls ms | Run wall ms | Job wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 5 | 498 | 41,515 | 52,788 | 97.18 | 1 | 1 | 1,569 | 4,521 | 4,682 |
| 2 | 1 | 2 | 44 | 60 | 0.11 | 1 | 1 | 172 | 424 | 513 |
| **Total** | **6** | **500** | **41,559** | **52,848** | **97.29** | | | **1,741** | **4,945** | **5,195** |

- Both runs settled 10 s after the POST (the queue's batch timeout accounts for most of it).
- Cost: 52,848 billed tokens × $0.020 per million = **$0.00106** for the whole repository,
  97.3 neurons of the free plan's 10,000 per day.
- Storage: `passage_embeddings` is 2,176 kB for 500 rows including the HNSW index, about
  4.4 kB per row (1.5 kB of float4 vector plus index and row overhead).
- Re-run with nothing changed: `{ texts: 0, batches: 0, inserted: 0, updated: 0 }`, 78 ms of
  run time, no model call, no usage row.

### Metering: exact tokens versus billed tokens

Workers AI reports `usage.total_tokens` on every embedding response. Observed on three texts
of 11, 11 and 8 tokens: 33 billed, i.e. **every text in a batch is metered at the batch's
longest text**. The consumer therefore sorts a run's passages by `token_count` before
batching. Even so, the first run billed 52,788 tokens for 41,515 exact tokens, a 27%
padding overhead, because the sorted 500 still spanned 10 to 256 tokens across five batches
of 100. Smaller batches of more uniform length would cut the overhead at the price of more
requests; at $0.001 per repository it is not worth tuning yet. The dashboard figure for the
day (Dashboard → AI → Workers AI → Usage) should match Σ `billed_tokens` × 1841 / 1e6
= 97.3 neurons; `embedding_usage` keeps both numbers per run so the comparison can be made
at any time.

## Failure cases

| Case | How it was triggered | Code | Transient | Result |
| --- | --- | --- | --- | --- |
| Invalid token | Real API call with `apiToken: "invalid-token"` | `ai_auth` | no | HTTP 401 "Authentication error"; a job would fail on attempt 1 with no retry |
| Wrong account id | Real API call with a bogus 32-hex account | `ai_auth` | no | HTTP 401 "Authentication error" |
| Oversized passage | Drill row with `token_count` 600 | skipped | | Counted as `oversized: 1` in both runs; never sent, never truncated; listed by the stats route |
| Empty passage | Drill row with blank text | skipped | | Counted as `empty: 1`; never sent |
| Rate limit (429) | Fake client in the test suite | `ai_rate_limited` | yes | Job parks as `retry_pending` for `Retry-After` seconds (45 in the test), earlier batches stay stored, the redelivery finishes as attempt 2 |
| 5xx / network | Fake fetch in the client tests | `ai_upstream` / `network` | yes | Backoff from 30 s doubling to 15 min, `failed` after 5 attempts |
| Malformed output | Fake fetch: missing data, misaligned count, wrong shape, mean pooling | `ai_invalid_output` / `ai_pooling_mismatch` | no | Job fails; nothing stored |
| Invalid vector | Fake client returning NaN or 383 values for one passage | per passage | | Only that passage is counted `invalid` and stays pending; the batch's other vectors are stored |
| Missing credentials | Consumer context without a client | `ai_not_configured` | no | Job fails on attempt 1 |
| Daily quota exhausted | Not reproducible on demand | `ai_rate_limited` | yes | Same path as a 429: retries with backoff, `failed` after 5 attempts (about 30 min), re-POST the next day |

The drill passages were removed after the run; the stats route then reported 500 passages,
500 embedded, 0 pending.

## Acceptance

```
select count(*) as embedded, count(distinct model) as models, count(distinct pooling) as poolings,
       count(distinct dims) as dim_variants, min(model), min(pooling), min(dims)
  from public.passage_embeddings where repository_id = 71542716;
-- 500 | 1 | 1 | 1 | @cf/baai/bge-small-en-v1.5 | cls | 384

select count(*) as stale from public.passage_embeddings e join public.passages p using (passage_id)
 where p.repository_id = 71542716 and e.content_hash <> p.content_hash;
-- 0

select * from public.embedding_stats(71542716);
-- passages 500, embedded 500, pending 0, billed_tokens 52848, neurons 97.29
```

At least 20 real passages are embedded automatically in the cloud (500), with deterministic
ids (the no-op re-run) and no model mixing (one distinct model, pooling and dimension, enforced
by the table's CHECK constraint).

Similarity smoke test, query "how do I limit concurrency of async functions" embedded the same
way and compared with cosine distance:

| Cosine | Locator | Passage |
| ---: | --- | --- |
| 0.864 | Review comment 4 of 4 on index.d.ts:24 | "Run multiple promise-returning & async functions with limited concurrency." |
| 0.846 | Comment 1 of 2 | "Sounds good. I think the `concurrency` parameter should be an options-object instead." |
| 0.825 | Opening body | `export function limitFunction<Arguments extends unknown[], ReturnType>(…` |

## CPU time

Local workerd exposes no CPU accounting, and `Date.now()` inside a Worker only advances across
I/O, so every figure above is wall time: the model calls (1.7 s) and the Supabase round trips
dominate. True CPU time needs a deployed Worker (Workers Observability or `wrangler tail`
`cpuTime`), and this Worker cannot deploy on the free plan because `wrangler.jsonc` declares
Queues bindings (Workers Paid). The CPU work per batch is serialising about 200 KB of request
JSON and parsing about 700 KB of floats plus the upsert payload; it is expected in single-digit
milliseconds, far inside the consumer's limits.

## Reproduce

```
cd app && npm run dev
curl -X POST localhost:5173/api/repositories/71542716/jobs -H 'content-type: application/json' -d '{"kind":"transform_passages"}'
curl -X POST localhost:5173/api/repositories/71542716/jobs -H 'content-type: application/json' -d '{"kind":"embed_passages"}'
curl localhost:5173/api/repositories/71542716/embeddings/stats
# then read jobs.result and embedding_usage for the repository
```
