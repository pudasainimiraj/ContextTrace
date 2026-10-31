import { useState } from "react";
import type { RepositoryListResponse, RepositoryRecord } from "../../../shared/api.ts";
import { api } from "../lib/api.ts";
import { useNow, usePolling } from "../lib/polling.ts";
import { navigate, repositoryPath, useLocation } from "../lib/router.ts";
import { RegisterForm } from "../components/RegisterForm.tsx";
import { RepositoryList } from "../components/RepositoryList.tsx";
import { SkeletonRows, StateBlock } from "../components/StateBlock.tsx";

const LIST_POLL_BUSY_MS = 15_000;
const LIST_POLL_IDLE_MS = 60_000;
/** Remembered across the navigation that follows a registration, for the one-time notice on the repository page. */
export const ADDED_KEY = "contexttrace:added";

export default function HomePage() {
  const location = useLocation();
  const add = new URLSearchParams(location.search).get("add") ?? "";
  const [filter, setFilter] = useState("");
  const now = useNow(30_000);
  const [pollMs, setPollMs] = useState<number>(LIST_POLL_IDLE_MS);
  const list = usePolling<RepositoryListResponse>(async () => {
    const result = await api<RepositoryListResponse>("/api/repositories", "read");
    // Poll faster only while something is queued or running; a parked retry can wait for hours.
    if (result.ok) setPollMs(result.value.repositories.some((r) => r.active_jobs.some((j) => j.state !== "retry_pending")) ? LIST_POLL_BUSY_MS : LIST_POLL_IDLE_MS);
    return result;
  }, pollMs, "repositories");

  const repositories = list.data?.repositories ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? repositories.filter((r) => r.full_name.toLowerCase().includes(needle)) : repositories;
  const capacity = list.data?.capacity ?? null;
  const full = capacity !== null && capacity.used >= capacity.max;

  function onRegistered(repo: RepositoryRecord, created: boolean) {
    if (created) {
      try {
        sessionStorage.setItem(ADDED_KEY, String(repo.id));
      } catch {
        // The notice is a convenience; without storage the repository page simply shows its state.
      }
    }
    navigate(repositoryPath(repo.full_name));
  }

  return (
    <>
      <section className="section" aria-labelledby="page-title">
        <h1 id="page-title" tabIndex={-1}>
          Find out why the code is the way it is.
        </h1>
        <p className="lede">
          ContextTrace indexes the issues and pull-request discussions of a public GitHub repository. Search them by meaning and open the exact comment on GitHub.
        </p>
        <RegisterForm initial={add} onRegistered={onRegistered} />
        <details className="how" open={list.data !== null && repositories.length === 0}>
          <summary>How it works</summary>
          <ol>
            <li>Add a public repository.</li>
            <li>ContextTrace fetches its issues, pull requests and comments and makes them searchable by meaning. The newest ones are ready within about a minute; the history follows.</li>
            <li>Search in plain words. Every result links to the exact comment on GitHub.</li>
          </ol>
        </details>
      </section>

      <section aria-labelledby="repositories-title" id="repositories" className="section">
        <div className="section-head">
          <h2 id="repositories-title">Repositories{capacity ? ` (${capacity.used} of ${capacity.max})` : ""}</h2>
          {repositories.length > 3 && (
            <input type="search" className="input-sm" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter the repositories by name" />
          )}
          <p className="description">Each row shows whether the repository can be searched. Working ones are listed first.</p>
        </div>
        {list.loading && !list.error && <SkeletonRows rows={3} />}
        {list.error && (
          <StateBlock
            kind="error"
            title="Couldn't load the repositories"
            hint={list.error.copy}
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={list.reload}>
                Retry
              </button>
            }
          />
        )}
        {list.data && repositories.length === 0 && (
          <StateBlock kind="empty" title="No repository is indexed yet" hint="Add the first one above. A small repository is searchable within a minute." />
        )}
        {list.data && repositories.length > 0 && shown.length === 0 && <StateBlock kind="empty" icon="search" title={`No repository matches "${filter}"`} />}
        {shown.length > 0 && <RepositoryList repositories={shown} now={now} />}
        {capacity && (
          <p className={`meta capacity${full ? " full" : ""}`}>
            <progress value={capacity.used} max={capacity.max} aria-label="Repositories registered, of the maximum" />
            <span>
              {capacity.used} of {capacity.max} repositories{full ? ". The service is full and accepts no new repositories for now. Search a repository above in the meantime." : ""}
            </span>
          </p>
        )}
      </section>
    </>
  );
}
