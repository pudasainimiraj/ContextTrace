# CT-18: queue consumer benchmark on a small public repository

Date: 2026-10-13. Branch `feat/ct-03-06-app` at CT-17 (d9f029b) plus the `durationMs`
and `upsertBytes` fields added for this milestone.

## Setup

- Repository: [sindresorhus/p-limit](https://github.com/sindresorhus/p-limit), GitHub id
  71542716. Small and public, with issues, pull request conversation comments and inline
  review comments, so all three streams run.
- Runtime: `npm run dev` in `app/` (Cloudflare Vite plugin 1.63.1, workerd 1.20261006.1)
  on macOS. The Worker, the local Queue and its consumer run in one process. The database
  is the Supabase project in eu-west-2, reached over the Data API from the laptop.
- GitHub access: unauthenticated (60 requests per hour). A token placed in `app/.env.local`
  did not take effect because `app/.env` sets `GITHUB_TOKEN=` (empty) and wins. Put the
  token in `app/.env` as `.env.example` says.
- Method: `POST /api/repositories` registered the repository. Since CT-16 that queues one
  job per stream. The local queue delivered the three messages as one batch after its
  5 s batch timeout and the consumer ran them in order, each in a single attempt. The
  figures below come from `jobs.result`, the job timestamps and the dev server log.

## Results

| Stream | Pages | Items received | Bytes from GitHub | Upsert JSON bytes | Rows inserted | Run wall ms | Job wall ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fetch_issues | 2 | 107 | 424,015 | 118,781 | 107 | 2,633 | 2,722 |
| fetch_issue_comments | 3 | 258 | 494,848 | 204,178 | 258 | 2,378 | 2,459 |
| fetch_review_comments | 1 | 62 | 166,269 | 40,852 | 62 | 4,615 | 4,695 |
| **Total** | **6** | **427** | **1,085,132** | **363,811** | **427** | **9,626** | **9,876** |

- The batch of three messages took 10,196 ms end to end (`QUEUE contexttrace-jobs 3/3`).
- Per page, on average: 181 KB received from GitHub, 61 KB sent to Postgres, 1.6 s of wall time.
- Queue message size: 76 bytes (`{"jobId":308,"repoId":71542716,"kind":"fetch_issue_comments","generation":1}`).
- Stored record bodies: issues 47.8 KB (69 rows), pull requests 12.1 KB (38 rows),
  issue comments 69.5 KB (258 rows), review comments 8.3 KB (62 rows).
- Every stream completed its first listing, so each checkpoint holds a high-water mark
  and no cursor. The oldest record dates from 2016 and the newest from 2026.

"Run wall ms" is `durationMs` measured inside the consumer around the extractor. "Job
wall ms" is `finished_at - started_at` on the job row, which adds the claim and finish
round trips to the database.

## CPU time

Local workerd reports no CPU accounting, and `Date.now()` inside a Worker only advances
across I/O, so the figures above are wall time dominated by network: one GitHub page
fetch and one `upsert_sources` call per page. True CPU time needs a deployed Worker;
Workers Observability and `wrangler tail` report `cpuTime` per invocation. The CPU work
per page is parsing up to about 250 KB of JSON and mapping up to 100 rows, so it is
expected to sit far below the 30 s limit for a queue consumer invocation.

## Conclusions

- A run at the page budget (`MAX_PAGES_PER_RUN = 5`) of the comment stream would receive
  about 1 MB and send about 350 KB, in roughly 8 s of wall time. That is comfortably
  inside the consumer limits, and continuation jobs keep larger repositories bounded.
- The review-comment page took longest (4.6 s for one page of 62 items). The variance is
  in GitHub latency, not in the Worker.
- The 76-byte message leaves the payload in the database, where the extractor reads it,
  so queue size is never a concern.

## Reproduce

```
cd app && npm run dev
curl -s -X POST localhost:5173/api/repositories -H 'content-type: application/json' \
  -d '{"url":"https://github.com/sindresorhus/p-limit"}'
# then read jobs.result for the repository, for example with psql or the Supabase dashboard
```
