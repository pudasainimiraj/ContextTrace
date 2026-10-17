# ContextTrace
Context Trace helps you trace the root of decision in your codebase. 

Context Trace is a hybrid search based system that Vectorize each passage of PR desc. comments and discussions using an embedding model, stores the embeddings in a vector database and answers users queries based on the neareast vector match.

Context Trace is for developer tools to accelerate a developers understanding of a repo. I came up with the idea when trying to contribute to open source reposiotries. 

Imagine you are trying to read a code base with 1Millions+ line. You take up an issue and start a discussion but wait for a week to get one single response. 
Not anymore, ContextTrace gives you a full detail of why a certain line was added to the code base. It parses through each split issue, PR description and comments into passages, preservinf each passage's original Github URL and helps you get fimiliar with the code in lightnight speed. 

## Deployment and secrets

The Worker runs on the Cloudflare Workers Free plan (Queues are included since February 2026)
at `https://contexttrace.<subdomain>.workers.dev`. Deploy from the repository root:

```
npx vite build && npx wrangler deploy
```

Secrets never live in `wrangler.jsonc`, which holds only the public `SUPABASE_URL`. Locally
they come from `.env` (gitignored, see `.env.example`); on the Worker they are set once
with Wrangler and read from `env`:

```
npx wrangler secret put SUPABASE_SECRET_KEY     # Supabase service-role key (server only)
npx wrangler secret put WORKERS_AI_API_TOKEN    # Workers AI token (not CLOUDFLARE_API_TOKEN)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID   # account id for the Workers AI REST API
npx wrangler secret put GITHUB_TOKEN            # fine-grained token, public repositories, read-only
npx wrangler secret put ADMIN_TOKEN             # bearer token for admin-only endpoints
npx wrangler secret put TURNSTILE_SECRET_KEY    # optional; enables Turnstile on registration
```

`VITE_TURNSTILE_SITE_KEY` is public and is baked into the SPA at build time. `GET /api/status`
reports which protections are enforced and how much of each free-tier budget is used; no
response ever carries a secret, and `tests/integration/security.test.ts` checks that.

### GitHub Pages

The SPA is also published at `https://pudasainimiraj.github.io/ContextTrace/` by
`.github/workflows/pages.yml`, on every push to `main` or by hand from the Actions tab. The Worker
stays on Cloudflare and the site calls it across origins: `ALLOWED_ORIGINS` in `wrangler.jsonc`
names the site, and the Worker answers preflights and adds the CORS headers for that origin alone.

One-time setup in the repository settings: Pages > Build and deployment > Source: "GitHub Actions".
Optional repository variables (Settings > Secrets and variables > Actions): `VITE_API_BASE_URL`
(overrides the Worker URL set in `vite.config.ts`) and `VITE_TURNSTILE_SITE_KEY`. When Turnstile
is on, its widget must list `pudasainimiraj.github.io` as a hostname too.

`npm run build:pages` makes the same build locally into `dist/pages`. `vite build --mode pages`
leaves the Worker out, sets the base path
`/ContextTrace/` and, since Pages sends no custom headers, writes the policy of `web/public/_headers`
into a meta tag with the Worker's origin in `connect-src` (`frame-ancestors` and `X-Frame-Options`
have no meta form). `404.html` is a copy of `index.html`: Pages has no SPA fallback, so a direct
visit to `/r/owner/name` is served by it, with status 404.

## Repository layout

| Path | What is there |
| --- | --- |
| `web/` | The React + Vite application: `index.html`, `src/`, `public/` (with the CSP headers). |
| `worker/src/` | The Cloudflare Worker. `index.ts` is the entry. `api/` holds registration, status, search and evidence; `queue/` the consumer, jobs and leases, budget and retry; `etl/` GitHub extraction, chunking, passages and embeddings; `cron/` sync, reconciliation and retention. |
| `shared/` | The API contract (`api.ts`) that the web application and the Worker both import. |
| `migrations/` | The Supabase SQL migrations. `supabase/migrations` is a symlink to this directory for the Supabase CLI. |
| `tests/` | `integration/` runs Vitest in the Workers runtime against the live Supabase project; `fixtures/` holds the records shared with the Python prototype; `evaluation/` holds the frozen question set, the metrics, the runner and the published results. |
| `docs/` | `ARCHITECTURE.md`, `DECISIONS.md` (ADRs), `EVALUATION.md`, the benchmarks and the milestone acceptance records. |
| `pipeline/` | The Python prototype that `worker/src/etl/` ports. It is not deployed. |
| `NEXT.md`, `LATER.md` | What is in progress and what is deliberately deferred. |

The root holds `package.json` (scripts `dev`, `build`, `build:pages`, `test`, `typecheck`, `lint`, `eval`, `deploy`, `db:push`), `wrangler.jsonc`, `vite.config.ts`, `vitest.config.ts`, the `tsconfig*.json` set and `.env.example`. Node 22 is required (`.nvmrc`).
