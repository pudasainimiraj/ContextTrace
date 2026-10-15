# Next

Milestone 8 (evaluation, user validation, public launch), in order:

1. **CT-44** Publish the retrieval evaluation: semantic vs keyword on the 25 frozen questions, Recall@3, MRR@5, abstention on unsupported questions, failure cases. Runner: `npm run eval` (public API only). Report: `docs/EVALUATION.md`.
2. **CT-45** Playwright + axe checks against the live URL: accessibility, mobile layout, cold start, permalinks answering 200, coverage versus GitHub's counts. Report: `docs/usability.md`.
3. **CT-46** Three developers run three decision-history tasks each on the live URL (`docs/user-testing/protocol.md`); findings recorded one tester at a time with the fixes applied between sessions.
4. **CT-47** Remaining documentation: usage and quotas, local development, setup from zero, source policy, known limitations, the case study; `pipeline/README.md`; CHANGELOG.
5. **CT-48** Lineage endpoint and test, cost test, `npm run smoke` against the live URL, CI, final deploy, `v1.0` tag.

Open items from earlier milestones:

- Turnstile stays off until `TURNSTILE_SECRET_KEY` and `VITE_TURNSTILE_SITE_KEY` are set (hostname `contexttrace.contexttrace.workers.dev`).
- `docs/PROJECT_PLAN.pdf` is to be added by the project owner.
