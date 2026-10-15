# Retrieval evaluation

Status: **question set frozen on 2026-10-15** (CT-43), reviewed by the project owner. `app/eval/questions.json` SHA-256 `3b7232a3bb4dd14ed09a53a11d8d8f805856cef8973d22d522e68cc7268a4828`, pinned by `app/test/eval-dataset.test.ts`. No ranking or threshold code changed between the freeze and the first measurement (CT-44).

## Question set

25 developer questions over the four indexed repositories: 20 answerable from the stored discussions ("supported", 1 to 3 labelled units each) and 5 not ("unsupported": two plausible but never discussed, three off-topic). Relevance is labelled per unit (an opening post or one comment); any chunk of a labelled unit counts. The file is `app/eval/questions.json`.

| id | repository | supported | question | labelled units |
| --- | --- | --- | --- | --- |
| q01 | p-queue | yes | How do I wait until every task I added to the queue has finished? | [9#issuecomment-304635713](https://github.com/sindresorhus/p-queue/issues/9#issuecomment-304635713), [9#issuecomment-304666591](https://github.com/sindresorhus/p-queue/issues/9#issuecomment-304666591), [12](https://github.com/sindresorhus/p-queue/issues/12) |
| q02 | p-queue | yes | What is the difference between onEmpty and onIdle, and why do they return promises instead of events? | [28](https://github.com/sindresorhus/p-queue/issues/28), [28#issuecomment-370831999](https://github.com/sindresorhus/p-queue/issues/28#issuecomment-370831999), [28#issuecomment-452169011](https://github.com/sindresorhus/p-queue/issues/28#issuecomment-452169011) |
| q03 | p-queue | yes | If one task throws, does p-queue stop processing the rest of the queue? | [29#issuecomment-378490250](https://github.com/sindresorhus/p-queue/issues/29#issuecomment-378490250), [29#issuecomment-378490756](https://github.com/sindresorhus/p-queue/issues/29#issuecomment-378490756), [29#issuecomment-416897264](https://github.com/sindresorhus/p-queue/issues/29#issuecomment-416897264) |
| q04 | p-queue | yes | How do I run at most N tasks per second, like a rate limit, with p-queue? | [46#issuecomment-426794940](https://github.com/sindresorhus/p-queue/issues/46#issuecomment-426794940), [35](https://github.com/sindresorhus/p-queue/pull/35), [35#issuecomment-405172958](https://github.com/sindresorhus/p-queue/pull/35#issuecomment-405172958) |
| q05 | p-queue | yes | Can I change the concurrency of a queue after it has been created? | [52](https://github.com/sindresorhus/p-queue/pull/52), [52#discussion_r244627481](https://github.com/sindresorhus/p-queue/pull/52#discussion_r244627481), [52#discussion_r244627588](https://github.com/sindresorhus/p-queue/pull/52#discussion_r244627588) |
| q06 | p-queue | yes | How do I apply backpressure so the queue does not grow without bound before I add more tasks? | [87#issuecomment-585936028](https://github.com/sindresorhus/p-queue/issues/87#issuecomment-585936028), [87#issuecomment-816799445](https://github.com/sindresorhus/p-queue/issues/87#issuecomment-816799445), [131](https://github.com/sindresorhus/p-queue/pull/131) |
| q07 | p-queue | yes | Can I change the priority of a task that is already waiting in the queue? | [209](https://github.com/sindresorhus/p-queue/pull/209), [209#discussion_r1681289162](https://github.com/sindresorhus/p-queue/pull/209#discussion_r1681289162), [209#discussion_r1903097475](https://github.com/sindresorhus/p-queue/pull/209#discussion_r1903097475) |
| q08 | p-queue | yes | When I abort a task with an AbortSignal, is it removed from the queue? | [219](https://github.com/sindresorhus/p-queue/issues/219), [219#issuecomment-2714301065](https://github.com/sindresorhus/p-queue/issues/219#issuecomment-2714301065) |
| q09 | p-limit | yes | Can I limit the concurrency of a single function instead of wrapping every call with limit()? | [86](https://github.com/sindresorhus/p-limit/issues/86), [86#issuecomment-2242853511](https://github.com/sindresorhus/p-limit/issues/86#issuecomment-2242853511), [86#issuecomment-2554721244](https://github.com/sindresorhus/p-limit/issues/86#issuecomment-2554721244) |
| q10 | p-limit | yes | What happens to promises that are still waiting when I call clearQueue()? | [25](https://github.com/sindresorhus/p-limit/issues/25), [27](https://github.com/sindresorhus/p-limit/pull/27), [27#issuecomment-633890368](https://github.com/sindresorhus/p-limit/pull/27#issuecomment-633890368) |
| q11 | p-limit | yes | Is it safe to call the same limiter recursively from inside a limited task? | [91](https://github.com/sindresorhus/p-limit/issues/91), [91#issuecomment-3844873705](https://github.com/sindresorhus/p-limit/issues/91#issuecomment-3844873705), [91#issuecomment-3841257122](https://github.com/sindresorhus/p-limit/issues/91#issuecomment-3841257122) |
| q12 | p-limit | yes | Can I change the concurrency limit of a limiter at runtime? | [79#discussion_r1592984324](https://github.com/sindresorhus/p-limit/pull/79#discussion_r1592984324), [79#discussion_r1665964056](https://github.com/sindresorhus/p-limit/pull/79#discussion_r1665964056) |
| q13 | p-limit | yes | Why does p-limit v5 fail with "Cannot resolve '#async_hooks'" in Next.js, esbuild or tsx? | [72#issuecomment-1793770212](https://github.com/sindresorhus/p-limit/issues/72#issuecomment-1793770212), [75#issuecomment-2135265931](https://github.com/sindresorhus/p-limit/issues/75#issuecomment-2135265931), [75#issuecomment-2208787869](https://github.com/sindresorhus/p-limit/issues/75#issuecomment-2208787869) |
| q14 | p-limit | yes | Does the function passed to limit() run synchronously when there is free capacity? | [22](https://github.com/sindresorhus/p-limit/issues/22), [22#issuecomment-589939738](https://github.com/sindresorhus/p-limit/issues/22#issuecomment-589939738), [28](https://github.com/sindresorhus/p-limit/pull/28) |
| q15 | p-limit | yes | Is there a built-in way to map over an array with the limiter, like Promise.all with a concurrency limit? | [90](https://github.com/sindresorhus/p-limit/pull/90), [74](https://github.com/sindresorhus/p-limit/issues/74), [74#issuecomment-2798172848](https://github.com/sindresorhus/p-limit/issues/74#issuecomment-2798172848) |
| q16 | yocto-queue | yes | Is yocto-queue actually faster than using a plain array as a queue? | [10](https://github.com/sindresorhus/yocto-queue/issues/10), [10#issuecomment-2520827594](https://github.com/sindresorhus/yocto-queue/issues/10#issuecomment-2520827594), [9](https://github.com/sindresorhus/yocto-queue/issues/9) |
| q17 | yocto-queue | yes | Does iterating over the queue remove the items, and how do I drain it instead? | [11#issuecomment-2696500039](https://github.com/sindresorhus/yocto-queue/issues/11#issuecomment-2696500039), [11](https://github.com/sindresorhus/yocto-queue/issues/11), [12](https://github.com/sindresorhus/yocto-queue/pull/12) |
| q18 | yocto-queue | yes | Can I use yocto-queue from CommonJS with require, or under Jest? | [15#issuecomment-2855037712](https://github.com/sindresorhus/yocto-queue/issues/15#issuecomment-2855037712), [15](https://github.com/sindresorhus/yocto-queue/issues/15) |
| q19 | p-defer | yes | Is p-defer still needed now that Promise.withResolvers exists? | [8](https://github.com/sindresorhus/p-defer/issues/8), [8#issuecomment-2743855787](https://github.com/sindresorhus/p-defer/issues/8#issuecomment-2743855787), [8#issuecomment-3265832301](https://github.com/sindresorhus/p-defer/issues/8#issuecomment-3265832301) |
| q20 | p-defer | yes | Why does requiring p-defer v4 fail with "Must use import to load ES Module"? | [7](https://github.com/sindresorhus/p-defer/issues/7), [7#issuecomment-839427648](https://github.com/sindresorhus/p-defer/issues/7#issuecomment-839427648), [7#issuecomment-864476408](https://github.com/sindresorhus/p-defer/issues/7#issuecomment-864476408) |
| q21 | p-limit | no | Can p-limit distribute tasks across worker threads or multiple processes? | — |
| q22 | p-queue | no | Does p-queue persist its tasks to Redis or disk so they survive a restart? | — |
| q23 | yocto-queue | no | How do I configure yocto-queue to order items by priority? | — |
| q24 | p-defer | no | How do I use p-defer together with Python's asyncio? | — |
| q25 | p-queue | no | What Kubernetes resource limits should I set for pods that run p-queue? | — |

## Semantic versus keyword retrieval (CT-44)

Measured on 2026-10-15 (11:27 to 11:31 UTC) against the live service `https://contexttrace.contexttrace.workers.dev`, Worker version `34bf976e`, through the public API only. Every question was sent three times with `limit: 5`: `mode: "semantic"`, `mode: "keyword"` and `mode: "auto"` (the mode the product uses). The raw responses, the scores and every table below are in `app/eval/results.json`.

Definitions, implemented and unit-tested in `app/eval/metrics.ts`:

- **Recall@3**: share of a question's labelled units that appear in the top 3, averaged over the 20 supported questions.
- **Hit@3**: share of supported questions with at least one labelled unit in the top 3.
- **MRR@5**: mean of 1/rank of the first labelled unit within the top 5 (0 when absent).
- **Thread Hit@k**: a secondary, looser view: at least one result among the top k belongs to the same issue or pull request as a labelled unit.
- **Unsupported outcome** (auto mode): `abstained` when the response has no results, `hedged` when it answers with `low` confidence, `false_positive` when it answers with `high` confidence.
- **Auto decision**: correct for a supported question when auto returns a labelled unit in the top 3; correct for an unsupported question when auto abstains.

### Overall

| mode | Recall@3 | Hit@3 | MRR@5 | zero hits in top 5 (of 20) | thread Hit@3 | thread Hit@5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| semantic | 0.292 | 0.65 | 0.546 | 6 | 0.80 | 0.95 |
| keyword | 0.05 | 0.05 | 0.05 | 19 | 0.10 | 0.10 |
| auto | 0.292 | 0.65 | 0.546 | 6 | 0.80 | 0.95 |

Auto equals semantic on every question: all 20 supported questions scored at or above 0.80 (the `SCORE_HIGH` threshold), so the keyword fallback never ran. Auto mode decided correctly for 13 of 25 questions (13 supported hits, 0 correct abstentions).

### Per repository

| repository | passages | n | semantic Recall@3 | semantic MRR@5 | keyword Recall@3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| sindresorhus/p-queue | 1,403 | 8 | 0.083 | 0.135 | 0 |
| sindresorhus/p-limit | 500 | 7 | 0.381 | 0.69 | 0 |
| sindresorhus/yocto-queue | 51 | 3 | 0.5 | 1 | 0.333 |
| sindresorhus/p-defer | 24 | 2 | 0.5 | 1 | 0 |

Quality falls with corpus size. In p-queue the same topic (aborting, rate limiting, backpressure, draining) recurs in many threads over eight years, and the labelled thread competes with newer ones that say almost the same thing.

### Unsupported questions

| question | auto outcome | semantic top score | keyword hits |
| --- | --- | ---: | ---: |
| q21 Can p-limit distribute tasks across worker threads or multiple processes? | false_positive | 0.813 | 1 |
| q22 Does p-queue persist its tasks to Redis or disk so they survive a restart? | hedged | 0.797 | 0 |
| q23 How do I configure yocto-queue to order items by priority? | hedged | 0.702 | 0 |
| q24 How do I use p-defer together with Python's asyncio? | hedged | 0.763 | 0 |
| q25 What Kubernetes resource limits should I set for pods that run p-queue? | hedged | 0.763 | 0 |

The service never abstained. Four questions got a `low` answer with the "may not be covered" message, and one got a confident wrong answer. The top cosine score does not separate the two groups: the supported questions' top scores run from 0.805 to 0.910 and the unsupported ones from 0.702 to 0.813, so a question about worker threads scores higher than a question that the discussions answer. The thresholds stay as they were frozen; a calibrated abstention is listed under "Not applied".

### Failure cases (semantic, no labelled unit in the top 3)

| id | question | labelled | returned top 3 (score) | first labelled unit | same thread | diagnosis |
| --- | --- | --- | --- | ---: | ---: | --- |
| q01 | How do I wait until every task I added to the queue has finished? | p-queue #9 (two comments), #12 body | #96 body (0.805), #23 body (0.801), #12 comment 2 (0.800) | — | rank 3 | Right thread (#12), other unit. #96 and #23 discuss `onIdle` and clearing too; the labels probably miss relevant threads. |
| q03 | If one task throws, does p-queue stop processing the rest of the queue? | p-queue #29 (three comments) | #29 comment 3 (0.839), #187 comment 2 (0.825), #215 body (0.811) | — | rank 1 | Right thread at rank 1, but an earlier comment of a 25-comment thread, not the ones that state the answer. |
| q04 | How do I run at most N tasks per second, like a rate limit, with p-queue? | p-queue #46 comment, PR #35 body and comment | #176 comment 3 (0.807), #204 body (0.798), #231 body (0.798) | — | rank 5 | Newer threads about `intervalCap` outrank the original design discussion; the labelled PR text is implementation-centred. |
| q05 | Can I change the concurrency of a queue after it has been created? | p-queue PR #52 body and two review comments | #38 body (0.816), #107 comment 4 (0.802), PR #10 review comment (0.801) | — | — | The only complete miss. The labelled pull request is code review prose on `index.js`; the question reads like an issue, and #38 may be the feature request behind the PR (label incompleteness). |
| q06 | How do I apply backpressure so the queue does not grow without bound before I add more tasks? | p-queue #87 (two comments), PR #131 body | #48 comment 4 (0.806), #204 comment 1 (0.805), #41 body (0.800) | — | rank 4 | Related threads (#48 "wait for queue size", #41) say nearly the same thing; the labelled thread is at rank 4. |
| q08 | When I abort a task with an AbortSignal, is it removed from the queue? | p-queue #219 body and comment | #140 comment 6 (0.890), #241 body (0.864), #254 body (0.852) | rank 4 | rank 4 | Three later `AbortSignal` threads outrank #219; the labelled unit is at rank 4, so MRR@5 credits it. |
| q13 | Why does p-limit v5 fail with "Cannot resolve '#async_hooks'" in Next.js, esbuild or tsx? | p-limit #72 comment, #75 (two comments) | #75 comment 6 (0.877), #72 body (0.869), #75 comment 10 (0.846) | — | rank 1 | All five results are in the two right threads. The question matches the problem reports better than the comments that give the fix. |

Five of the seven misses return the right thread within the top 5 and a different unit; one (q08) has the labelled unit at rank 4; one (q05) misses the thread. Unit-level labels are strict by design: the product shows one passage with one permalink, so a reader who lands on comment 3 of 25 still has to scroll.

Keyword retrieval returned nothing for 17 of the 20 supported questions. `search_passages_keyword` uses `websearch_to_tsquery`, which ANDs every word of the question; a 12-word natural-language question rarely has all its words in one passage. The three questions with hits were q08 (two results, wrong threads), q13 (five results, right thread, wrong unit) and q18 (three results, correct at rank 1: "CommonJS", "require" and "Jest" are rare, exact words). The keyword path is a floor for outages and a help for identifier-like queries, not a competitor on questions.

### Not applied (frozen set, no tuning)

Nothing was changed after the freeze. Candidates for a later milestone, recorded in `LATER.md`:

- Group results by thread and show the best unit per thread, or boost sibling units of a strong hit.
- Make the keyword path OR its terms (or `plainto_tsquery` with rank) so that natural-language questions get candidates.
- Calibrate abstention on a score gap or a margin between the first and the fifth result instead of the top score alone.
- Re-rank the top semantic hits with a second model.
- Add a second labeller and measure agreement before trusting Recall@3 to the second decimal.

### What this does not show

- Four small repositories by one author (sindresorhus) with one writing style; other projects may score differently.
- Labels by one person, reviewed by the project owner; no inter-annotator agreement. Several misses look like missing labels rather than wrong retrieval.
- One embedding model (`@cf/baai/bge-small-en-v1.5`, 384 dimensions, cls pooling) and no re-ranking.
- One run on one day. The index syncs every five minutes; a new comment in a labelled thread can move ranks by one or two places on a re-run.
- Twenty supported questions: one question is 0.05 of Hit@3.

### Reproduce

Anyone can run the evaluation against the public API without secrets (Node 22, no dependencies; about three minutes at one call every 2.2 s to stay under the 30 searches per minute limit):

```
cd app
node eval/run.ts --base https://contexttrace.contexttrace.workers.dev --out eval/results.json
node eval/run.ts --rescore eval/results.json      # recompute the tables from a saved run, no network
```

The author's path adds the dataset checks (schema, frozen checksum, every labelled passage still active in the live index, every permalink verified) and the metric unit tests:

```
cd app
npx vitest run test/eval-dataset.test.ts test/eval-metrics.test.ts
```
