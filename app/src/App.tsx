import { useState, type FormEvent } from "react";
import type { ApiError, EvidenceCard, RepositoryRecord, SearchResponse } from "../shared/api.ts";
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
        const message = "message" in body ? body.message : `Request failed (${res.status})`;
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
  if (response.results.length === 0) return <p className="notice">No results for “{response.query}”.</p>;
  return (
    <ol className="results" aria-live="polite">
      {response.results.map((card) => (
        <EvidenceCardView key={card.passage_id} card={card} />
      ))}
    </ol>
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
        {card.author ? ` · ${card.author}` : ""} · {card.created_at.slice(0, 10)} · score {card.score.toFixed(2)}
      </p>
      <p className="excerpt">{card.excerpt}</p>
    </li>
  );
}

export default App;
