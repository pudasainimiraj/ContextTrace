import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CoverageReport, RepositoryRecord } from "../../../shared/api.ts";
import { useAnnounce } from "../lib/announce.ts";
import { api } from "../lib/api.ts";
import { coverageInterval, POLL_FAST_MS } from "../lib/coverage.ts";
import { useNow, usePolling } from "../lib/polling.ts";
import { useLocation } from "../lib/router.ts";
import { secondsSince } from "../lib/time.ts";
import { repositoryStatus } from "../lib/vocabulary.ts";
import { useServiceStatus } from "../lib/service-status.ts";
import { Icon } from "../components/Icon.tsx";
import { IndexingPanel } from "../components/IndexingPanel.tsx";
import { Link } from "../components/Link.tsx";
import { StateBlock } from "../components/StateBlock.tsx";
import { ErrorNotice, Notice } from "../components/Notice.tsx";
import { SearchPanel } from "../components/SearchPanel.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { ADDED_KEY } from "./Home.tsx";

export default function RepositoryPage({ owner, name }: { owner: string; name: string }) {
  const fullName = `${owner}/${name}`;
  const lookup = usePolling<RepositoryRecord>(() => api<RepositoryRecord>(`/api/repositories/by-name/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, "read"), null, fullName);
  if (lookup.loading || !lookup.data) {
    return (
      <>
        <Crumbs />
        <h1 id="page-title" tabIndex={-1}>
          {fullName}
        </h1>
        {lookup.loading && <StateBlock kind="loading" title="Loading the repository" />}
        {!lookup.loading && lookup.error && lookup.status !== 404 && (
          <StateBlock
            kind="error"
            title="Couldn't load the repository"
            hint={lookup.error.copy}
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={lookup.reload}>
                Retry
              </button>
            }
          />
        )}
        {!lookup.loading && (!lookup.error || lookup.status === 404) && (
          <StateBlock
            kind="empty"
            title="This repository is not indexed"
            hint="Add it from the home page; the newest discussions are searchable within about a minute."
            action={
              <Link to={`/?add=${encodeURIComponent(fullName)}`} className="btn btn-secondary btn-sm">
                Add {fullName}
              </Link>
            }
          />
        )}
      </>
    );
  }
  return <RepositoryView repo={lookup.data} />;
}

function Crumbs() {
  return (
    <p className="crumbs">
      <Link to="/">
        <Icon name="arrow-left" /> All repositories
      </Link>
    </p>
  );
}

type Tab = "search" | "indexing" | "about";
const TABS: { id: Tab; label: string }[] = [
  { id: "search", label: "Search" },
  { id: "indexing", label: "Indexing" },
  { id: "about", label: "About this index" },
];

function RepositoryView({ repo }: { repo: RepositoryRecord }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const query = params.get("q") ?? "";
  const linkedTab = TABS.find((t) => t.id === params.get("tab"))?.id ?? null;
  const service = useServiceStatus();
  const announce = useAnnounce();
  const now = useNow(1000);
  const [pollMs, setPollMs] = useState<number | null>(POLL_FAST_MS);
  const coverage = usePolling<CoverageReport>(async () => {
    const result = await api<CoverageReport>(`/api/repositories/${repo.id}/coverage`, "read");
    if (result.ok) setPollMs(coverageInterval(result.value));
    return result;
  }, pollMs, `coverage-${repo.id}`);
  const c = coverage.data;
  const status = c?.status ?? repo.status;
  const view = repositoryStatus(status, {
    activeJobs: c ? c.active_jobs.length : undefined,
    lastError: c?.last_error ?? repo.last_error,
    statusChangedAt: repo.status_changed_at,
    capped: c?.streams.some((s) => s.capped) ?? false,
    pending: c?.pending ?? 0,
  });

  // One-time notices: just added (from the home page), and the flip to fully indexed while watching.
  const [added] = useState(() => {
    try {
      return sessionStorage.getItem(ADDED_KEY) === String(repo.id);
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!added) return;
    try {
      sessionStorage.removeItem(ADDED_KEY);
    } catch {
      // Nothing to clear.
    }
  }, [added]);
  const [seen, setSeen] = useState(status);
  const [completed, setCompleted] = useState(false);
  if (seen !== status) {
    setSeen(status);
    if (status === "searchable") setCompleted(true);
  }
  const announced = useRef(status);
  useEffect(() => {
    if (announced.current === status) return;
    announced.current = status;
    announce(`${repo.full_name} is now ${view.label.toLowerCase()}.`);
  }, [status, repo.full_name, view.label, announce]);

  // Tabs: the reader's choice wins; before that, Indexing while nothing is searchable, else Search.
  const [chosen, setChosen] = useState<Tab | null>(linkedTab);
  const tab: Tab = chosen ?? (query ? "search" : status === "registered" ? "indexing" : "search");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = (next + TABS.length) % TABS.length;
    setChosen(TABS[target].id);
    tabRefs.current[target]?.focus();
  }

  return (
    <>
      <Crumbs />
      <div className="repo-head">
        <h1 id="page-title" tabIndex={-1}>
          <span>{repo.full_name}</span>
          <a className="ext" href={`https://github.com/${repo.full_name}`} target="_blank" rel="noreferrer" aria-label={`${repo.full_name} on GitHub`}>
            <Icon name="external-link" />
          </a>
        </h1>
        <StatusPill view={view} />
      </div>
      <p className="description">{view.meaning}</p>
      <p className="meta updated" aria-live="off">
        {pollMs !== null && <span className="dot pulse tone-text-done" aria-hidden="true" />}
        {pollMs !== null ? "Live · " : ""}
        {coverage.updatedAt ? `Updated ${secondsSince(coverage.updatedAt, now)} s ago` : "Loading the index state…"}
      </p>
      {added && <Notice tone="green">Added. Indexing has started; the newest discussions are searchable within about a minute.</Notice>}
      {completed && <Notice tone="green">Fully indexed. Every discussion is now searchable.</Notice>}
      {coverage.error && <ErrorNotice error={coverage.error} onRetry={coverage.reload} />}

      <div role="tablist" aria-label="Repository sections" className="segments">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            className="segment"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setChosen(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="panel-search" aria-labelledby="tab-search" hidden={tab !== "search"}>
        {tab === "search" && <SearchPanel repository={repo} coverage={c} initialQuery={query} />}
      </div>
      <div role="tabpanel" id="panel-indexing" aria-labelledby="tab-indexing" hidden={tab !== "indexing"}>
        {tab === "indexing" && (c ? <IndexingPanel coverage={c} service={service} now={now} /> : <StateBlock kind="loading" title="Loading the index state" />)}
      </div>
      <div role="tabpanel" id="panel-about" aria-labelledby="tab-about" hidden={tab !== "about"}>
        {tab === "about" && <AboutIndex repo={repo} coverage={c} />}
      </div>
    </>
  );
}

function AboutIndex({ repo, coverage: c }: { repo: RepositoryRecord; coverage: CoverageReport | null }) {
  return (
    <div className="about-index stack fade-in">
      <p>
        This index holds the public issues, pull requests, comments and review comments of {repo.full_name} as text, each passage with a verified link to its comment on GitHub. It never holds the code, raw HTML or anything private.
      </p>
      {c && (
        <p className="meta">
          {c.sources.issue} issues · {c.sources.pull_request} pull requests · {c.sources.issue_comment} comments · {c.sources.review_comment} review comments · {c.documents} threads · {c.passages} passages
        </p>
      )}
      <ul>
        <li>Search works by meaning first; when nothing is close, it falls back to passages that contain the words.</li>
        <li>New discussions are picked up every hour. Deleted ones leave the index within a week.</li>
        <li>Each stream stops at 5,000 items; older history is not included.</li>
        <li>A repository GitHub stops serving stays searchable for 30 days, then its data is removed.</li>
      </ul>
      <p className="meta">
        <Link to="/about">How ContextTrace works</Link> · <Link to="/status">Service status</Link>
      </p>
    </div>
  );
}
