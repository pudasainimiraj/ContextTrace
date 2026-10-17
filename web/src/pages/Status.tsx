import type { BudgetState } from "../../../shared/api.ts";
import { absoluteUtc, formatCount, humanizeTimes, relativeTime } from "../lib/time.ts";
import { useNow } from "../lib/polling.ts";
import { useServiceStatus } from "../lib/service-status.ts";
import { stripView } from "../lib/vocabulary.ts";

const RESOURCE_NAMES: Record<string, string> = {
  ai_neurons_milli: "Embeddings today",
  github_requests_auth: "GitHub requests this hour",
  github_requests_anon: "GitHub requests this hour (without a token)",
  queue_ops: "Indexing steps today",
  searches: "Searches today",
  registrations: "New repositories today",
  db_egress_bytes: "Data transfer this month",
  storage_bytes: "Storage",
};

function resourceName(b: BudgetState): string {
  return RESOURCE_NAMES[b.resource] ?? `${b.resource.replace(/_/g, " ")} (${b.period})`;
}

function amount(b: BudgetState, n: number): string {
  if (b.resource.endsWith("_bytes")) return n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)} MB`;
  if (b.resource.endsWith("_milli")) return formatCount(Math.round(n / 1000));
  return formatCount(n);
}

export default function StatusPage() {
  const status = useServiceStatus();
  const now = useNow(30_000);
  const strip = stripView(status);
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        Service status
      </h1>
      <p className={`notice tone-${strip.tone}`} role="status">
        <span className={`dot${strip.tone === "muted" ? " hollow" : ""}`} aria-hidden="true" /> <span>{strip.label}</span>
      </p>
      <p className="lede">
        ContextTrace runs entirely on free tiers and keeps itself at 80% of each allowance. When an allowance is used up, indexing waits and resumes by itself, and search falls back to keywords. Nothing ever creates a charge.
      </p>
      {!status && <p className="meta">Loading…</p>}
      {status && (
        <>
          {status.paused && (
            <section className="section" aria-labelledby="paused-title">
              <div className="section-head">
                <h2 id="paused-title">Paused</h2>
              </div>
              <ul>
                {status.reasons.map((r) => (
                  <li key={r}>{humanizeTimes(r)}</li>
                ))}
              </ul>
            </section>
          )}
          {status.deferred.length > 0 && (
            <section className="section" aria-labelledby="deferred-title">
              <div className="section-head">
                <h2 id="deferred-title">Waiting</h2>
              </div>
              <ul>
                {status.deferred.map((r) => (
                  <li key={r}>{humanizeTimes(r)}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="section" aria-labelledby="budgets-title">
            <div className="section-head">
              <h2 id="budgets-title">Allowances</h2>
              <p className="description">Each allowance is 80% of the free tier. At the limit the work waits and resumes by itself.</p>
            </div>
            <ul className="budgets">
              {status.budgets.map((b) => (
                <li key={b.resource} className={b.paused ? "exhausted" : undefined}>
                  <span className="budget-name">{resourceName(b)}</span>
                  <progress value={Math.min(b.used, b.limit)} max={b.limit} aria-label={`${resourceName(b)}: ${amount(b, b.used)} of ${amount(b, b.limit)}`} />
                  <span className="meta">
                    {amount(b, b.used)} of {amount(b, b.limit)}
                    {b.resets_at ? ` · resets ${relativeTime(b.resets_at, now)}` : ""}
                    {b.paused ? <span className="badge tone-amber">used up</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="section" aria-labelledby="admissions-title">
            <div className="section-head">
              <h2 id="admissions-title">New repositories</h2>
            </div>
            <p>{status.admissions.open ? "Accepted." : `Not accepted right now: ${status.admissions.reason}.`}</p>
          </section>
          <section className="section" aria-labelledby="protections-title">
            <div className="section-head">
              <h2 id="protections-title">Protections</h2>
            </div>
            <ul>
              <li>Bot check on registration: {status.protections.turnstile ? "on" : "off"}</li>
              <li>Rate limits per address: {status.protections.rate_limits ? "on (30 searches, 5 registrations, 120 reads a minute)" : "off"}</li>
              <li>Operator actions require a token: {status.protections.admin ? "yes" : "no"}</li>
            </ul>
          </section>
          <section className="section" aria-labelledby="limits-title">
            <div className="section-head">
              <h2 id="limits-title">Limits</h2>
            </div>
            <ul>
              <li>25 repositories at a time.</li>
              <li>5,000 items per stream (issues and pull requests, issue comments, review comments).</li>
              <li>New discussions every hour; deletions within a week.</li>
              <li>A repository GitHub stops serving is kept for 30 days.</li>
            </ul>
          </section>
          <p className="meta section">Generated {absoluteUtc(status.generated_at)}.</p>
        </>
      )}
    </>
  );
}
