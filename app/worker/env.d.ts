// Secrets are not declared in wrangler.jsonc, so `wrangler types` does not emit them.
interface Env {
  /** Optional GitHub token. Local: app/.env (see .env.example). Remote: `wrangler secret put GITHUB_TOKEN`. */
  GITHUB_TOKEN?: string;
}
