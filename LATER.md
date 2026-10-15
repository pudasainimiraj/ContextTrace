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
- **The 10 ms CPU rule on Workers Free** is documented as not enforced on this workload; if `exceededCpu` ever appears, shrink `DOCUMENTS_PER_RUN` and `EMBEDDING_BATCH_SIZE`.
- **Streaming the backfill's progress** to the SPA (the coverage panel polls every 5 s today).
