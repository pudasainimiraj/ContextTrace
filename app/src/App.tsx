import { useState, type FormEvent } from "react";
import type { ApiError, RepositoryRecord } from "../shared/api.ts";
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
      {phase.kind === "done" && <RepositoryStatus repo={phase.repo} created={phase.created} />}
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

export default App;
