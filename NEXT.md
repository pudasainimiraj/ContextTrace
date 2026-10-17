# Next

Milestone 8 (evaluation, user validation, public launch), in order:

1. **CT-44** Publish the retrieval evaluation: semantic vs keyword on the 25 frozen questions, Recall@3, MRR@5, abstention on unsupported questions, failure cases. Runner: `npm run eval` (public API only). Report: `docs/EVALUATION.md`.
2. **CT-45** Playwright + axe checks against the live URL: accessibility, mobile layout, cold start, permalinks answering 200, coverage versus GitHub's counts. Report: `docs/usability.md`.
3. **CT-46** Three developers run three decision-history tasks each on the live URL (`docs/user-testing/protocol.md`); findings recorded one tester at a time with the fixes applied between sessions.
4. **CT-47** Remaining documentation: usage and quotas, local development, setup from zero, source policy, known limitations, the case study; `pipeline/README.md`; CHANGELOG.
5. **CT-48** Lineage endpoint and test, cost test, `npm run smoke` against the live URL, CI, final deploy, `v1.0` tag.

Open items from earlier milestones:

- Turnstile stays off until `TURNSTILE_SECRET_KEY` and `VITE_TURNSTILE_SITE_KEY` are set (hostnames `contexttrace.contexttrace.workers.dev` and `pudasainimiraj.github.io`).
- GitHub Pages serves a deep link (`/r/owner/name`, `/status`, `/about`) from `404.html`, a copy of `index.html`, with status 404. The CT-45 permalink check applies to the Worker URL.
- `docs/PROJECT_PLAN.pdf` is to be added by the project owner.
- **Calibrate the Workers AI ledger.** On 2026-10-16 Workers AI refused embeddings with "you have used up your daily free allocation of 10,000 neurons" while `usage_budgets` showed 1,683 of 8,000 neurons for the day. Either the neurons-per-token rate (1,841 per million) or the reset window differs from Cloudflare's accounting; compare the dashboard's neuron graph with `embedding_usage` for one day and correct `NEURONS_PER_MILLION_TOKENS` or the window. Until then the provider's own 429 parks embed jobs until 00:00 UTC.
- A repository with issues disabled (torvalds/linux, 2026-10-15) gets a 404 from the issue-comments stream and is marked `inaccessible`; the lookup should read `has_issues` and skip the stream instead.
- Resubmitting a repository that has no jobs (ClickHouse/ClickHouse, registered 2026-10-12 before the job system, resubmitted 11 times) does not start extraction; `submitRepository` should start the chain when no fetch job exists.
