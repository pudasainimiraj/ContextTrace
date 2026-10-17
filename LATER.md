# Later

Ideas and limitations deliberately left out of v1.0.

- **GitHub Discussions** as a fourth stream (GraphQL only; different pagination and permalink shapes).
- **Re-ranking** of the top semantic hits (a cross-encoder or a second model) and hybrid scoring instead of the semantic-or-keyword decision.
- **Thread grouping in results**: show the best unit per issue or pull request, or boost sibling units of a strong hit. Five of the seven semantic misses in the CT-44 evaluation returned the right thread and a different unit.
- **Keyword path for questions**: `websearch_to_tsquery` ANDs every word, so 17 of 20 natural-language questions got no keyword candidates; OR the terms or use `plainto_tsquery` with rank.
- **Calibrated abstention**: the top cosine score does not separate supported (0.805 to 0.910) from unsupported (0.702 to 0.813) questions; try a score gap or a margin between the first and fifth result.
- **Second labeller** for the evaluation set and inter-annotator agreement; thresholds calibrated on repositories outside the evaluation set.
- **Custom domain** and a Turnstile widget bound to it.
- **Repository list and search without re-registering** in the SPA (the API already serves everything by id).
- **Per-repository search analytics** (last searched, popular queries) to inform which repositories to keep at the storage warning.
- **Multiple embedding models** behind the same passage ids, with the model name in the vector table already pinned by a CHECK constraint.
- **Authenticated GitHub per user** (OAuth) to lift the shared token's hourly limit and allow private repositories for their owners; today the source policy is public only.
- **The 10 ms CPU rule on Workers Free** is enforced with a tolerance: tensorflow/tensorflow (2026-10-15) got transform runs of 1.4 to 2 s CPU terminated with `exceededCpu`, and once the tolerance was used up even 116 ms runs were cut. The splitter now tokenizes each part once and `DOCUMENTS_PER_RUN` is 10; `EMBEDDING_BATCH_SIZE` is the next knob if embed runs (about 47 ms CPU) ever show the same outcome. A killed invocation leaves its job leased for up to 5 minutes before the cron recovers it; a shorter lease for transform jobs would speed that up.
- **Streaming the backfill's progress** to the SPA (the coverage panel polls every 5 s today).
- **One active job per kind and repository at the database level.** `ensureQueuedJob` checks and then inserts, so two backfill runs that finish in the same instant can still start two transforms. A partial unique index on `jobs (repository_id, kind) where state in ('queued','running','retry_pending')`, with `ensureQueuedJob` treating the unique violation as "already active", would close the race.
- **Embedding upserts under load.** On ClickHouse (2026-10-16) two embed jobs failed after five `upsert_passage_embeddings` statement timeouts (8 s on the `authenticator` role) while 25 transforms wrote passages concurrently; the vectors of a failed batch are paid for and lost, and the passages are picked up by the next run. With one transform at a time the load drops; if timeouts persist, upsert 50 rows per call instead of 100, or raise the role's statement timeout for the service role.
- **Cold reads on the free database instance.** With 70,000 passages and 26,000 vectors the working set no longer fits the Nano instance's cache: the first `pending_passages` or `embedding_stats` call for ClickHouse after a quiet spell takes about 6 s (then 50 ms warm), and the live test suite now runs 2 to 3 times longer than it did with four small repositories. Options: `embedding_stats` from `index_state` counts instead of joins, fewer stats calls per embed run, or a paid compute add-on.
- **Test leftovers count against admissions.** The live tests register repositories with ids above 1e12 and delete them in `afterAll`; a killed or timed-out run leaves them behind, and on 2026-10-15 29 leftovers plus 8 real repositories closed admissions at `MAX_REPOSITORIES` 25. A Vitest global setup that deletes stale test repositories before a run would prevent it; the production code should keep ignoring test conventions.
