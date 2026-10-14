import { useEffect, useState, type FormEvent } from "react";
import type { ApiError, CoverageReport, EvidenceCard, RepositoryRecord, SearchResponse, StreamCoverage } from "../shared/api.ts";
import "./App.css";

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; repo: RepositoryRecord; created: boolean }
  | { kind: "error"; message: string };

function App() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPhase({ kind: "submitting" });
    try {
      const res = await fetch("/api/repositories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as RepositoryRecord | ApiError;
      if (!res.ok) {
        const message = "message" in body ? body.message : `Request failed (${res.status})`;
        setPhase({ kind: "error", message });
        return;
      }
      setPhase({ kind: "done", repo: body as RepositoryRecord, created: res.status === 201 });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <main>
      <h1>ContextTrace</h1>
      <p>Register a public GitHub repository to trace.</p>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          aria-label="GitHub repository URL"
          required
        />
        <button type="submit" disabled={phase.kind === "submitting"}>
          {phase.kind === "submitting" ? "Checking…" : "Register"}
        </button>
      </form>
      {phase.kind === "error" && (
        <p role="alert" className="error">
          {phase.message}
        </p>
      )}
      {phase.kind === "done" && (
        <>
          <RepositoryStatus repo={phase.repo} created={phase.created} />
          <CoveragePanel repositoryId={phase.repo.id} />
          <SearchPanel repositoryId={phase.repo.id} />
        </>
      )}
    </main>
  );
}

function RepositoryStatus({ repo, created }: { repo: RepositoryRecord; created: boolean }) {
  return (
    <section className="status" aria-live="polite">
      <p className="badge">
        {created ? "Registered" : `Already registered (submission #${repo.submission_count})`}
      </p>
      <dl>
        <dt>Repository</dt>
        <dd>
          <a href={`https://github.com/${repo.full_name}`} target="_blank" rel="noreferrer">
            {repo.full_name}
          </a>
        </dd>
        <dt>ID</dt>
        <dd>{repo.id}</dd>
        <dt>Status</dt>
        <dd>{repo.status}</dd>
        <dt>Registered at</dt>
        <dd>{repo.created_at}</dd>
      </dl>
    </section>
  );
}

const COVERAGE_POLL_MS = 5000;

/** Live coverage: polls while the repository is still being indexed, then once more and stops. */
function CoveragePanel({ repositoryId }: { repositoryId: number }) {
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const res = await fetch(`/api/repositories/${repositoryId}/coverage`);
        const body = (await res.json()) as CoverageReport | ApiError;
        if (!active) return;
        if (!res.ok) {
          setFailure("error" in body ? body.message : `Request failed (${res.status})`);
          return;
        }
        const report = body as CoverageReport;
        setCoverage(report);
        setFailure(null);
        if (report.status !== "searchable" && report.status !== "inaccessible") timer = setTimeout(poll, COVERAGE_POLL_MS);
      } catch (err) {
        if (active) setFailure(err instanceof Error ? err.message : String(err));
      }
    }
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [repositoryId]);

  if (failure) return <p className="error">Coverage unavailable: {failure}</p>;
  if (!coverage) return <p className="meta">Loading coverage…</p>;

  const activeJobs = coverage.jobs.queued + coverage.jobs.running + coverage.jobs.retry_pending;
  return (
    <section className="coverage" aria-label="Coverage">
      <p className="badge">
        {STATUS_LABEL[coverage.status]}
        {activeJobs > 0 ? ` · ${activeJobs} job${activeJobs === 1 ? "" : "s"} in flight` : ""}
        {coverage.jobs.failed > 0 ? ` · ${coverage.jobs.failed} failed` : ""}
      </p>
      <dl>
        <dt>Issues / pull requests</dt>
        <dd>
          {coverage.sources.issue} / {coverage.sources.pull_request}
        </dd>
        <dt>Comments / review comments</dt>
        <dd>
          {coverage.sources.issue_comment} / {coverage.sources.review_comment}
        </dd>
        <dt>Passages searchable</dt>
        <dd>
          {coverage.embedded} of {coverage.passages}
          {coverage.pending > 0 ? ` (${coverage.pending} waiting for a vector)` : ""}
        </dd>
        <dt>Complete source types</dt>
        <dd>{coverage.completed_source_types.length > 0 ? coverage.completed_source_types.join(", ") : "none yet"}</dd>
        <dt>Last successful sync</dt>
        <dd>{coverage.last_successful_sync_at ? formatTime(coverage.last_successful_sync_at) : "not yet"}</dd>
      </dl>
      <table className="streams">
        <thead>
          <tr>
            <th>Stream</th>
            <th>Phase</th>
            <th>Items</th>
            <th>High-water mark</th>
            <th>Last sync</th>
          </tr>
        </thead>
        <tbody>
          {coverage.streams.map((s) => (
            <StreamRow key={s.stream} stream={s} />
          ))}
        </tbody>
      </table>
      {coverage.last_error && (
        <p role="alert" className="error">
          {coverage.last_error}
        </p>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<CoverageReport["status"], string> = {
  registered: "Registered, not searchable yet",
  searchable_partial: "Searchable, index still growing",
  searchable: "Searchable, fully indexed",
  inaccessible: "No longer accessible on GitHub",
};

const PHASE_LABEL: Record<StreamCoverage["phase"], string> = {
  pending: "pending",
  head: "newest pages",
  backfill: "backfilling history",
  rescan: "checking for deletions",
  complete: "complete",
};

function StreamRow({ stream }: { stream: StreamCoverage }) {
  const phase = PHASE_LABEL[stream.phase];
  return (
    <tr>
      <td>{stream.stream.replace("_", " ")}</td>
      <td>{phase}</td>
      <td>{stream.items_fetched}</td>
      <td>{stream.high_water_mark ? formatTime(stream.high_water_mark) : "—"}</td>
      <td>{stream.last_synced_at ? formatTime(stream.last_synced_at) : "—"}</td>
    </tr>
  );
}

function formatTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 16) + " UTC";
}

type SearchPhase =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; response: SearchResponse }
  | { kind: "error"; message: string };

/** Asks the server for evidence; the query is embedded there, so nothing is downloaded here. */
function SearchPanel({ repositoryId }: { repositoryId: number }) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<SearchPhase>({ kind: "idle" });

  async function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPhase({ kind: "searching" });
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId, query }),
      });
      const body = (await res.json()) as SearchResponse | ApiError;
      if (!res.ok) {
        const message = "error" in body ? body.message : `Request failed (${res.status})`;
        setPhase({ kind: "error", message });
        return;
      }
      setPhase({ kind: "done", response: body as SearchResponse });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section className="search" aria-label="Search">
      <h2>Search the discussions</h2>
      <form onSubmit={onSearch}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="How do I limit concurrency?"
          aria-label="Search query"
          maxLength={500}
          required
        />
        <button type="submit" disabled={phase.kind === "searching"}>
          {phase.kind === "searching" ? "Searching…" : "Search"}
        </button>
      </form>
      {phase.kind === "error" && (
        <p role="alert" className="error">
          {phase.message}
        </p>
      )}
      {phase.kind === "done" && <SearchResults response={phase.response} />}
    </section>
  );
}

function SearchResults({ response }: { response: SearchResponse }) {
  const total = response.index.embedded + response.index.pending;
  return (
    <div aria-live="polite">
      {response.index.warning && (
        <p role="status" className="notice warning">
          {response.index.warning}
        </p>
      )}
      {response.message && (
        <p role="status" className={`notice ${response.confidence}`}>
          {response.message}
        </p>
      )}
      <p className="meta">
        {response.results.length} result{response.results.length === 1 ? "" : "s"} · {response.mode} search · {response.index.embedded} of{" "}
        {total} passages embedded
        {response.unverified > 0 ? ` · ${response.unverified} left out without a verified link` : ""}
      </p>
      <ol className="results">
        {response.results.map((card) => (
          <EvidenceCardView key={card.passage_id} card={card} />
        ))}
      </ol>
    </div>
  );
}

function EvidenceCardView({ card }: { card: EvidenceCard }) {
  const kind = card.type === "issue" ? "Issue" : "Pull request";
  return (
    <li className="card">
      <a href={card.source_url} target="_blank" rel="noreferrer">
        {card.title}
      </a>
      <p className="meta">
        {kind} #{card.number} · {card.locator}
        {card.author ? ` · ${card.author}` : ""} · {card.created_at.slice(0, 10)} · {card.match} match {card.score.toFixed(2)}
      </p>
      <p className="excerpt">{card.excerpt}</p>
    </li>
  );
}

export default App;
