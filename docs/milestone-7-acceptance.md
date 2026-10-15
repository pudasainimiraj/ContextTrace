# Milestone 7 acceptance: free operations, security and reliability

Branch `feat/ct-03-06-app`. This file grows with the milestone; the sections below record what
has been measured or verified so far.

## Step 0 (2026-10-14): deployed on Workers Free, CPU time per job kind

Cloudflare Queues have been included on the Workers Free plan since 2026-02-04 (10,000
operations per day, 24-hour retention, every other limit as on Paid), so the Worker now runs on
the free plan at `https://contexttrace.contexttrace.workers.dev` with its queue, its cron and
its secrets (`wrangler secret bulk`, names only in the logs). The account is on Workers Free
(confirmed in the dashboard). `max_batch_size` is 1, so each consumer invocation runs one job.

Local workerd reports no CPU time, so the figures come from `wrangler tail --format json`
(`cpuTime`, `wallTime` per invocation) and from the GraphQL dataset `workersInvocationsAdaptive`
(by status). The consumer logs `job succeeded|failed` with the kind and id, which attributes
each invocation.

| Invocation | Work | CPU ms | Wall ms | Outcome |
| --- | --- | ---: | ---: | --- |
| transform_passages | 50 p-limit threads | 179 to 208 | 3,400 to 3,600 | ok |
| transform_passages | 50 p-queue threads (comment-heavy) | 194 to 749 | 2,700 to 4,400 | ok |
| transform_passages | 4 to 7 threads | 29 to 44 | 1,100 to 2,200 | ok |
| embed_passages | 500 passages, 5 batches of 100 | 70 | 8,720 | ok |
| embed_passages | nothing pending | 3 to 6 | 400 to 1,100 | ok |
| fetch / rescan streams | one page, or a GitHub 403 | 3 to 11 | 1,000 to 1,700 | ok (job rate_limited) |
| scheduled (cron) | reconcile, sync and rescan scheduling | 56 | 15,513 | ok |
| POST /api/search | one query, real model | 3 to 29 | 230 to 830 | ok |
| GET coverage, POST jobs | one call | 12 to 23 | 260 to 550 | ok |

Analytics for the two drills: 41 invocations, 41 `success`, 0 `exceededCpu`, CPU p50 4.7 ms,
p99 750 ms, maximum 750 ms.

**Conclusion.** The documented free-plan limit is 10 ms of CPU per invocation, but eleven
consecutive transform invocations of 44 to 749 ms and a 56 ms cron run all completed. Cloudflare
terminates only sustained overruns, and this workload is not treated as one. The work-unit
sizes from Milestones 4 to 6 stay as they are; the budget layer meters queue operations and
inference, which are the allowances this workload can actually exhaust. If `exceededCpu`
outcomes ever appear in the dashboard, `DOCUMENTS_PER_RUN` (50) and `EMBEDDING_BATCH_SIZE` (100)
are the knobs, at the price of more queue operations per repository.

**Also learned.** Unauthenticated GitHub calls from Cloudflare's shared egress addresses are
rate-limited at once (every fetch and rescan parked as `rate_limited`), so the deployed Worker
needs `GITHUB_TOKEN`; it was added as a secret. `wrangler tail --format json` pretty-prints
each event over many lines, so a reader must decode concatenated JSON objects, not lines.

## CT-37 to CT-42: what was built

| Task | Delivered | Pinned by |
| --- | --- | --- |
| CT-37 | `usage_budgets` with atomic reservations at 80% of every free allowance; reservations at every metered call; `GET /api/status` | `budget.test.ts` |
| CT-38 | pauses that keep the attempt and resume at the next window; 429/503 with Retry-After for admissions and searches; no follow-up jobs after runs that changed nothing; hourly syncs; schedulers defer below 20% queue budget; 25-repository and storage-warning admission limits; 5,000-item stream cap with explicit warnings | `pause.test.ts` |
| CT-39 | per-address rate limits (30 searches, 5 registrations, 120 reads a minute); Turnstile when configured; admin token on job triggers; 8 KB body cap | `abuse.test.ts` |
| CT-40 | secrets only in Wrangler secrets and `app/.env`; one validator per route; topK clamped to 10 in SQL and API; fetch targets pinned to `api.github.com` under the job's repository; CSP and security headers; generic 500 | `security.test.ts` |
| CT-41 | 14-day job history, 90-day usage, removal after 30 days unreachable with a tombstone; admin `DELETE`; storage warning pauses admissions, backfills and rescans, critical pauses syncs; nothing searchable is ever deleted by the cron | `retention.test.ts` |
| CT-42 | drills for zero quota, GitHub and Workers AI 429, expired lease, duplicate delivery, database partial failure and model errors; database failures are now transient `db_error` and failed model calls refund their reservation | `reliability.test.ts` |

## Live acceptance (2026-10-15, Workers Free, version f65aa628)

The global inference budget was cut from 8,000,000 to 100 milli-neurons (about 54 tokens),
then `sindresorhus/p-defer` (GitHub id 71531782) was registered through the public API.

```
t+12s  jobs: fetch_issues succeeded, fetch_issue_comments running, transform queued
t+17s  jobs: heads succeeded, transform succeeded (15 passages), embed_passages retry_pending:budget_exhausted
       job 4406: attempt 0, "Budget ai_neurons_milli is exhausted (16675 of 100) until 2026-10-16T00:00:00+00:00"
GET /api/status      paused: true  reasons: ["ai_neurons_milli: 16675 of 100 used, resets at 2026-10-16T00:00:00+00:00"]  admissions open: true
POST /api/search     "defer a promise"  -> 200 mode=keyword confidence=low results=2 semantic_error=budget_exhausted
                     message: Semantic search is paused until 2026-10-16T00:00:00+00:00 (inference budget reached). Showing passages that contain your search words; verify them at the source.
                     0.065 | #9 Update typings to explicitly not require a bo… | https://github.com/sindresorhus/p-defer/pull/9
POST /api/search     "resolve later"    -> 200 mode=none  message: Semantic search is paused … and no passage contains your search words.
```

The budget was restored and the parked job's `next_attempt_at` moved into the past, as the
window's end would. Nobody touched the job again: the 5-minute reconcile cron resent its
message, it ran at t+82 s and succeeded at t+88 s with attempt 1 (24 texts, 1,729 tokens,
6,072 billed, 11.2 neurons). Afterwards:

```
GET /api/repositories/71531782/coverage   status=searchable passages=24 embedded=24 pending=0 jobs all 0
GET /api/status                           paused: false
select active passages, vectors, stale    24 | 24 | 0
responses captured: 11 | secret values found: 0
```

**Acceptance.** The public service paused predictably at the budget cap (one refused
reservation, no attempt consumed, the reason and the reset time on `/api/status` and in
the search message), kept serving the keyword baseline, resumed by itself once the window
reset, leaked no credential in any response, and left the index consistent (every active
passage has exactly one vector with the current hash). No plan was upgraded: the Worker,
Queues, Workers AI and Supabase all stayed on their free tiers.

**Fix found by the live run.** None in the code; the measurement script's own output
formatting failed on four lines and the captured responses were read back from disk.
