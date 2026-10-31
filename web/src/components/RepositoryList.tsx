import type { RepositorySummary } from "../../../shared/api.ts";
import { repositoryPath } from "../lib/router.ts";
import { absoluteUtc, formatCount, relativeTime } from "../lib/time.ts";
import { jobSentence, repositoryStatus, searchablePercent } from "../lib/vocabulary.ts";
import { Icon } from "./Icon.tsx";
import { Link } from "./Link.tsx";
import { StatusPill } from "./StatusPill.tsx";

export function RepositoryList({ repositories, now }: { repositories: RepositorySummary[]; now: number }) {
  return (
    <ul className="repo-list fade-in">
      {repositories.map((repo) => (
        <RepositoryRow key={repo.id} repo={repo} now={now} />
      ))}
    </ul>
  );
}

function RepositoryRow({ repo, now }: { repo: RepositorySummary; now: number }) {
  const view = repositoryStatus(repo.status, {
    activeJobs: repo.active_jobs.length,
    lastError: repo.last_error,
    statusChangedAt: repo.status_changed_at,
    pending: repo.pending,
  });
  const muted = repo.status === "inaccessible" || repo.status === "removed";
  const stalled = repo.status === "registered" && repo.active_jobs.length === 0;
  const again = repo.status === "removed" || repo.status === "inaccessible" || stalled;
  const pct = searchablePercent(repo.embedded, repo.pending);
  const path = repositoryPath(repo.full_name);
  return (
    <li className={`repo-row${muted ? " muted" : ""}`}>
      <div className="repo-main">
        {/* The name's link stretches over the whole row; "Add again" sits above it. */}
        <Link to={path} className="repo-name">
          {repo.full_name}
        </Link>
        <span className="repo-end">
          <StatusPill view={view} />
          <Icon name="arrow-right" className="repo-go" />
        </span>
      </div>
      <p className="meta">
        {formatCount(repo.passages)} passages ·{" "}
        {repo.last_successful_sync_at ? <span title={absoluteUtc(repo.last_successful_sync_at)}>synced {relativeTime(repo.last_successful_sync_at, now)}</span> : "not synced yet"}
      </p>
      {repo.active_jobs.length > 0 && (
        <p className="meta now">
          <span className="dot pulse" aria-hidden="true" />
          {jobSentence(repo.active_jobs[0], undefined, now)}
          {repo.active_jobs.length > 1 ? ` · ${repo.active_jobs.length - 1} more` : ""}
        </p>
      )}
      {/* At 100% the pill alone says older history is still coming; a full bar beside it read as a contradiction. */}
      {pct !== null && pct < 100 && repo.status !== "searchable" && (
        <p className="meta bar">
          <progress value={repo.embedded} max={repo.embedded + repo.pending} aria-label="Share of fetched passages that are searchable" /> {pct}% searchable
        </p>
      )}
      <p className="repo-actions">
        {again && (
          <Link to={`/?add=${encodeURIComponent(repo.full_name)}`} className="btn btn-ghost btn-sm">
            Add again
          </Link>
        )}
      </p>
    </li>
  );
}
