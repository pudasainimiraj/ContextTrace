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
