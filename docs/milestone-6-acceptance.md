# Milestone 6 acceptance: progressive coverage and automatic synchronization

Date: 2026-10-14. Branch `feat/ct-03-06-app` at CT-36. Runtime as in the earlier benchmarks:
`npm run dev` in `app/` (Worker, local queue and consumer in one process), Supabase in
eu-west-2, Workers AI `@cf/baai/bge-small-en-v1.5`. GitHub unauthenticated (60 requests/hour).

## 1. A partial index remains usable while the backfill runs

`POST /api/repositories {"url":"https://github.com/sindresorhus/p-queue"}` (GitHub id 72200120,
254 issues and pull requests, 690 conversation comments, 255 review comments). The coverage
endpoint was polled every 3 s; the lines below are the changes.

```
t+  0s status=registered          embedded=0/0        issues=pending   issue_comments=pending   review_comments=pending
t+  6s status=registered          embedded=0/0        issues=backfill* issue_comments=backfill* review_comments=pending      (head passes: 200 items each)
t+ 23s status=registered          embedded=0/124      issues=complete  issue_comments=backfill* review_comments=backfill*
t+ 29s status=searchable_partial  embedded=256/256    issues=complete  issue_comments=backfill* review_comments=backfill*
t+ 46s status=searchable_partial  embedded=756/772    issues=complete  issue_comments=complete  review_comments=complete
t+ 59s status=searchable          embedded=1403/1403  all streams complete, 0 pending, 0 jobs in flight
```

Search at t+29 s, while the comment backfill was still running (`*` = backfill pending):

```
POST /api/search {"repositoryId":72200120,"query":"how do I pause the queue","limit":3}
mode=semantic confidence=high results=3 index={status=searchable_partial, partial=true, embedded=256}
warning: Partial index: 256 of 256 passages are searchable while extraction and indexing continue; older discussions may be missing.
0.805 | #96 Howto: Wait for currently executing tasks to complete | Opening body | https://github.com/sindresorhus/p-queue/issues/96
0.770 | #23 If a queue is cleared before completion, newly-added ... | Opening body | https://github.com/sindresorhus/p-queue/issues/23
0.769 | #52 Add ability to update concurrency | Review comment 3 of 21 on index.js:114 | https://github.com/sindresorhus/p-queue/pull/52#discussion_r244627461
```

After the backfill the same query answers `status=searchable, partial=false, warning=null`.

Job summary for the repository (from `jobs`):

| Kind | Runs | Pages | Items | Notes |
| --- | ---: | ---: | ---: | --- |
| fetch_issues / fetch_issue_comments / fetch_review_comments | 1 each | 2 each | 200 each | head passes, newest first |
| backfill_issues | 1 | 1 | 54 | low priority, 10 s delay |
| backfill_issue_comments | 2 | 5 | 490 | two delayed runs of up to 3 pages |
| backfill_review_comments | 1 | 1 | 55 | |
| transform_passages | 7 | | | one after every stream run |
| embed_passages | 4 | | | first stored batch flipped the status to searchable_partial |

## 2. A changed source updates after the next successful sync

No comment on a third-party repository can be edited on demand, so the changed-source path
is pinned by tests with stubbed GitHub pages and exercised live for the unchanged case:

- `app/test/sync.test.ts`: an edited issue body is counted as `updated: 1` by the scheduled
  sync, the sync chains the transform and the embedding through the queue, and the search
  returns the new text under the same passage id while the old text is gone.
- `app/test/fairness.test.ts`: on a shared queue with a small and a large repository, every
  delivery of the small one precedes the large one's first backfill run; a re-sync of both
  re-reads 45 items as unchanged with no transform work and no model call; editing one issue
  deep in the large history makes exactly one sync run count it as updated, one thread
  re-transform and one passage re-embed, and the new text is served with its permalink.
- `app/test/reconcile-sources.test.ts`: a rescan retires a comment GitHub no longer lists,
  with its passage and vector, and relabels the thread; a thread whose opening vanished
  loses its document; a 404 marks the repository inaccessible and a resubmission reinstates it.

Live, the sync the cron queues was triggered for yocto-queue (`POST .../jobs {"kind":"fetch_issues"}`):

```
1910 fetch_issues       succeeded {"phase":"sync","pages":1,"records":1,"inserted":0,"updated":0,"unchanged":1}
1911 transform_passages succeeded {"documents":0,"passages":0, ...}
1912 embed_passages     succeeded {"texts":0,"batches":0, ...}
issues.last_synced_at: 2026-10-13T17:05:51Z -> 2026-10-14T08:56:53Z   high-water mark unchanged
```

The one item returned inside the 5-minute overlap window was recognised as unchanged, so
nothing was re-transformed or re-embedded and no model call was made.

## Two gaps the CT-36 test found and fixed

- A sync that spans several runs saved its high-water mark only on its last run, so an
  item seen by a middle run did not advance it. A paused sync now saves the mark; the
  listing is ascending, so everything before the cursor is stored and what follows is newer.
- A stream whose sync continuation was lost (cursor set, no fetch job alive) fell out of
  the schedule. The cron now queues a sync for it, which resumes from the cursor.

## Reproduce

```
cd app && npm run dev
curl -s -X POST localhost:5173/api/repositories -H 'content-type: application/json' -d '{"url":"https://github.com/sindresorhus/p-queue"}'
watch -n 3 curl -s localhost:5173/api/repositories/72200120/coverage
curl -s -X POST localhost:5173/api/search -H 'content-type: application/json' -d '{"repositoryId":72200120,"query":"how do I pause the queue","limit":3}'
curl -s -X POST localhost:5173/api/repositories/315531538/jobs -H 'content-type: application/json' -d '{"kind":"fetch_issues"}'
```
