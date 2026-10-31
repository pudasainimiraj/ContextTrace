import type { CoverageReport, ServiceStatus, StreamCoverage } from "../../../shared/api.ts";
import { pipelineSteps } from "../lib/coverage.ts";
import { absoluteUtc, formatCount, relativeTime } from "../lib/time.ts";
import { cappedBadge, jobSentence, lastRunSentence, RESCAN_INTERVAL_MS, resourceName, STREAM_NAMES, streamDot, streamSentence, SYNC_INTERVAL_MS } from "../lib/vocabulary.ts";

function newest(times: (string | null)[]): string | null {
  return times.filter((t): t is string => t !== null).reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
}

type Props = { coverage: CoverageReport; service: ServiceStatus | null; now: number };

export function IndexingPanel({ coverage: c, service, now }: Props) {
  const steps = pipelineSteps(c);
  const paused = c.paused_until !== null || c.active_jobs.some((j) => j.error_code === "budget_exhausted");
  const pauseReasons = (service?.budgets ?? []).filter((b) => b.paused).map((b) => resourceName(b).toLowerCase());
  const lastSync = c.last_successful_sync_at;
  const nextSync = lastSync ? new Date(Date.parse(lastSync) + SYNC_INTERVAL_MS).toISOString() : null;
  const lastRescan = newest(c.streams.map((s) => s.last_rescan_at));
  const nextRescan = lastRescan ? new Date(Date.parse(lastRescan) + RESCAN_INTERVAL_MS).toISOString() : null;
  const idle = c.active_jobs.length === 0;
  const terminal = c.status === "inaccessible" || c.status === "removed";
  const lastRuns = [...c.last_runs].sort((a, b) => b.finished_at.localeCompare(a.finished_at)).slice(0, 5);

  return (
    <div className="indexing fade-in">
      <section className="section" aria-labelledby="pipeline-title">
        <div className="section-head">
          <h3 id="pipeline-title">Pipeline</h3>
        </div>
        <ol className="pipeline">
          {steps.map((step) => (
            <li key={step.name} className={`step ${step.state}`}>
              <span className="step-name">
                <span className={`dot${step.state === "waiting" ? " hollow" : ""}${step.state === "running" ? " pulse" : ""}`} aria-hidden="true" /> {step.name}
              </span>
              <span className="step-state">{step.state}</span>
              <span className="meta">{step.detail}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="now-title">
        <div className="section-head">
          <h3 id="now-title">Happening now</h3>
        </div>
        {paused && (
          <p className="notice tone-amber" role="status">
            <span>
              Paused{c.paused_until ? ` until ${absoluteUtc(c.paused_until)}` : ""}: a free-tier allowance is used up{pauseReasons.length > 0 ? ` (${pauseReasons.join("; ")})` : ""}. Indexing resumes by itself.
            </span>
          </p>
        )}
        {!idle && (
          <ul className="now">
            {c.active_jobs.map((job, i) => (
              <li key={`${job.kind}-${i}`}>
                <span className={`dot${job.state === "running" ? " pulse" : job.state === "queued" ? " hollow" : ""}`} aria-hidden="true" />
                {jobSentence(job, c.streams, now)}
              </li>
            ))}
          </ul>
        )}
        {idle && c.status === "registered" && <p className="meta">Nothing is queued or running. Add the repository again to restart indexing.</p>}
        {idle && !terminal && c.status !== "registered" && (
          <p className="meta">Idle. {nextSync ? `The next check for new discussions is ${relativeTime(nextSync, now)}.` : "The next check for new discussions runs within an hour."}</p>
        )}
        {idle && terminal && <p className="meta">Nothing runs for this repository any more.</p>}
        {c.jobs.failed > 0 && (
          <p className="meta">
            {c.jobs.failed} step{c.jobs.failed === 1 ? "" : "s"} failed{c.last_error ? `: ${c.last_error}` : ""}. Splitting and embedding are retried by the cron within five minutes; a failed fetch is not.
          </p>
        )}
      </section>

      {lastRuns.length > 0 && (
        <section className="section" aria-labelledby="runs-title">
          <div className="section-head">
            <h3 id="runs-title">Last runs</h3>
          </div>
          <ul className="runs">
            {lastRuns.map((run) => (
              <li key={run.kind} title={absoluteUtc(run.finished_at)}>
                {lastRunSentence(run, c.streams, now)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section" aria-labelledby="streams-title">
        <div className="section-head">
          <h3 id="streams-title">Streams</h3>
        </div>
        <ul className="streams">
          {c.streams.map((s) => (
            <StreamRow key={s.stream} stream={s} now={now} />
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="fresh-title">
        <div className="section-head">
          <h3 id="fresh-title">Freshness</h3>
        </div>
        <p className="meta">
          {lastSync ? (
            <>
              Last synced <span title={absoluteUtc(lastSync)}>{relativeTime(lastSync, now)}</span>
              {nextSync && !terminal ? ` · next sync ${Date.parse(nextSync) <= now ? "due now" : relativeTime(nextSync, now)}` : ""}
            </>
          ) : (
            "Not synced yet: every stream completes its first run first."
          )}
        </p>
        <p className="meta">
          {lastRescan ? (
            <>
              Deleted items checked <span title={absoluteUtc(lastRescan)}>{relativeTime(lastRescan, now)}</span>
              {nextRescan && !terminal ? ` · next check ${Date.parse(nextRescan) <= now ? "due now" : relativeTime(nextRescan, now)}` : ""}
            </>
          ) : (
            "Deleted items are checked weekly once the history is fetched."
          )}
        </p>
        {c.streams.some((s) => s.capped) && (
          <p className="meta">History beyond the item limit is not indexed: {c.streams.filter((s) => s.capped).map((s) => STREAM_NAMES[s.stream] ?? s.stream).join(", ")}.</p>
        )}
      </section>

      <section className="section" aria-labelledby="stored-title">
        <div className="section-head">
          <h3 id="stored-title">What is stored</h3>
        </div>
        <p className="meta">
          {formatCount(c.sources.issue)} issues · {formatCount(c.sources.pull_request)} pull requests · {formatCount(c.sources.issue_comment)} comments · {formatCount(c.sources.review_comment)} review comments
        </p>
        <p className="meta">
          Searchable: {formatCount(c.embedded)} of {formatCount(c.embedded + c.pending)} passages
          {c.pending > 0 ? ` (${formatCount(c.pending)} waiting for a vector)` : ""}
        </p>
      </section>

      <details className="operator meta">
        <summary>Operator details</summary>
        <dl>
          <dt>Repository id</dt>
          <dd>{c.repository_id}</dd>
          <dt>Status</dt>
          <dd>{c.status}</dd>
          <dt>Last error</dt>
          <dd>{c.last_error ?? "—"}</dd>
          <dt>Jobs</dt>
          <dd>
            queued {c.jobs.queued} · running {c.jobs.running} · retry_pending {c.jobs.retry_pending} · failed {c.jobs.failed}
          </dd>
          <dt>Active jobs</dt>
          <dd>{c.active_jobs.length > 0 ? c.active_jobs.map((j) => `${j.kind} ${j.state}${j.error_code ? ` (${j.error_code})` : ""} attempt ${j.attempt}`).join("; ") : "—"}</dd>
          <dt>Documents</dt>
          <dd>{c.documents}</dd>
          <dt>Complete source types</dt>
          <dd>{c.completed_source_types.length > 0 ? c.completed_source_types.join(", ") : "none yet"}</dd>
          {c.streams.map((s) => (
            <StreamDetails key={s.stream} stream={s} />
          ))}
        </dl>
      </details>
    </div>
  );
}

function StreamRow({ stream: s, now }: { stream: StreamCoverage; now: number }) {
  const state = streamDot(s);
  const badge = cappedBadge(s);
  return (
    <li className="stream">
      <span className={`stream-name tone-text-${state}`}>
        <span className={`dot${state === "waiting" ? " hollow" : ""}${state === "running" ? " pulse" : ""}`} aria-hidden="true" /> {STREAM_NAMES[s.stream] ?? s.stream}
      </span>
      <span className="meta">
        {streamSentence(s)}
        {s.last_synced_at ? (
          <>
            {" "}
            · synced <span title={absoluteUtc(s.last_synced_at)}>{relativeTime(s.last_synced_at, now)}</span>
          </>
        ) : null}
      </span>
      {badge && <span className="badge tone-amber">{badge}</span>}
    </li>
  );
}

function StreamDetails({ stream: s }: { stream: StreamCoverage }) {
  return (
    <>
      <dt>{s.stream}</dt>
      <dd>
        phase {s.phase} · pages {s.pages_fetched} · items {s.items_fetched} · high-water mark {s.high_water_mark ?? "—"} · backfill pending {String(s.backfill_pending)} · sync in progress {String(s.sync_in_progress)} · rescan in progress {String(s.rescan_in_progress)} · capped at {s.capped_at ?? "—"}
      </dd>
    </>
  );
}
