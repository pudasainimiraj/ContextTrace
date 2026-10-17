# Decisions

Architecture decision records, one section each, in the order they were taken. Dates are 2026.

## ADR-0001 Supabase Postgres with pgvector instead of D1 and Upstash Vector (10-12)

**Context.** The plan named D1 for records and Upstash for vectors. Two stores mean two consistency boundaries for passages and their vectors, and D1 has no vector type.
**Decision.** One Supabase Postgres project holds everything: records, passages, `vector(384)` embeddings with an HNSW cosine index, budgets, and the SQL functions the Worker calls. Row Level Security is on everywhere; only the service role (the Worker's secret key) may read or write.
**Consequences.** Atomic multi-table operations in single RPCs (`sync_passages`, `reserve_budget`), one connection secret, free tier of 500 MB and 5 GB egress. The CLI expects `supabase/migrations`, which is a link to `migrations/`.

## ADR-0002 Cloudflare Workers Free with Queues (10-14, revised from Workers Paid)

**Context.** Queues required Workers Paid until 4 February 2026; since then the free plan includes 10,000 queue operations a day with 24-hour retention. The free plan documents 10 ms of CPU per invocation.
**Decision.** Stay on Workers Free. One job per consumer invocation (`max_batch_size` 1). Measured on the deployed Worker: transform runs of 44 to 749 ms CPU and 41 of 41 invocations successful on the small repositories, so the documented limit is not a hard kill at that scale. Revised 10-15: on tensorflow/tensorflow the limit showed as a tolerance; runs of 1.4 to 2 s CPU were terminated with `exceededCpu`, and once the tolerance was spent even 116 ms runs were cut. The splitter now tokenizes each part once (4 to 6 times less CPU) and `DOCUMENTS_PER_RUN` is 10; `EMBEDDING_BATCH_SIZE` is the next knob.
**Consequences.** No fixed charge. Queue operations become the tightest allowance, which drove ADR-0008's economy rules.

## ADR-0003 bge-small-en-v1.5 over the Workers AI REST API with cls pooling (10-13)

**Context.** 384 dimensions keep storage small; the model's native pooling is `cls`, Workers AI defaults to `mean` and the two are not comparable; the AI binding always runs remotely anyway.
**Decision.** One REST client with an injectable `fetch`, the request body literally `{ text, pooling: "cls" }`, the server's pooling checked and never copied, the table's CHECK constraint pinning model, pooling and dimensions. The query is embedded the same way on the server; no model is ever downloaded by the browser.
**Consequences.** Tests use a deterministic fake client; live tests are gated on credentials. Workers AI meters a batch at its longest text, so batches are sorted by length.

## ADR-0004 Deterministic ids and content hashes (10-13)

**Decision.** `document_id = github:{repository_id}:{issue|pull_request}:{number}`; `passage_id` appends `:body:{i}` or `:{source_type}:{github_id}:{i}`; `content_hash` is the SHA-256 of the passage text. The repository id, not the owner/name, keys everything because renames keep the id.
**Consequences.** A re-run writes nothing for unchanged text, a changed comment replaces its own passage and vector, and evaluation labels can name passages that still exist months later.

## ADR-0005 Newest-first head pass, delayed low-priority backfill, ascending syncs (10-13)

**Decision.** A stream's first run lists two pages newest-first and sets the high-water mark; the backfill continues the descending listing three pages per run with a 10 s delay between runs; syncs list ascending since the mark minus a 5-minute overlap and advance the mark on completion (a paused sync saves it too, which is safe in ascending order). The backfill never touches the mark.
**Consequences.** A repository is searchable within a minute; two repositories of different sizes share the queue fairly (the small one's deliveries all precede the large one's first backfill run); syncs and backfills run concurrently without a conflict.

## ADR-0006 Keyword baseline and the 0.80 / 0.70 thresholds (10-13)

**Context.** On p-limit with the real model, questions the repository answers scored 0.77 to 0.89, an exact identifier 0.77, off-topic questions at most 0.67.
**Decision.** Semantic results stand alone at or above 0.80; below that the Postgres full-text baseline answers if it matches; weak semantic results between 0.70 and 0.80 are shown with a warning; otherwise the response says nothing supports the query. A forced mode exists for evaluation.
**Consequences.** A newly submitted repository is keyword-searchable before its vectors exist. The thresholds were calibrated on one of the evaluation repositories, which the evaluation report discloses.

## ADR-0007 Rescans instead of trusting deletions (10-14)

**Context.** GitHub's list endpoints never report a deleted comment or issue.
**Decision.** Every fetch bumps `seen_at`; a weekly low-priority rescan walks the stream from the start and retires rows not seen since it began, with their passages and vectors; threads that lost a unit are re-transformed; a thread whose opening is gone loses its document. A capped rescan retires nothing.
**Consequences.** Deletions reach the index within a week at the cost of one extra listing per stream per week.

## ADR-0008 Budgets at 80% of free allowances; pauses, never failures (10-14)

**Decision.** `usage_budgets` with atomic reservations before every metered call. A refused reservation parks the job until the window resets without consuming an attempt, falls a search back to keywords with the reset time, or answers 429/503 with `Retry-After`. Runs that changed nothing queue no follow-up, syncs are hourly, schedulers defer below 20% of the day's queue budget, admissions close at 25 repositories or a storage warning, streams cap at 5,000 items with an explicit warning.
**Consequences.** The service cannot create a charge and never overstates its coverage; an idle repository costs about 216 queue operations a day.

## ADR-0009 Per-address rate limits, optional Turnstile, admin token (10-15)

**Decision.** Cloudflare's rate-limiting binding keyed by `cf-connecting-ip` in front of search, registration and reads; Turnstile verified server-side when a secret is configured; job triggers and repository removal require a bearer admin token compared in constant time; bodies above 8 KB are refused before parsing.
**Consequences.** The limiter is per location and eventually consistent, so it blunts bursts while the budgets remain the hard caps. Local development, which has no client address, is not limited.

## ADR-0010 What is never stored or served (10-15)

**Decision.** Only public repositories; only issues, pull requests, their comments and review comments with public logins and permalinks; no code, no raw HTML (the normaliser strips tags, the app renders text, the CSP forbids inline scripts), no secrets in configuration (`wrangler.jsonc` holds the public Supabase URL only), no credential in any response (pinned by tests). Repositories GitHub stops serving are marked, kept 30 days, then removed with a tombstone; an operator can remove any repository.
