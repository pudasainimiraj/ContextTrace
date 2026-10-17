import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { CoverageReport, EvidenceCard, RepositoryRecord, SearchResponse } from "../../../shared/api.ts";
import { api, postJson } from "../lib/api.ts";
import type { ErrorView } from "../lib/errors.ts";
import { navigate, repositoryPath } from "../lib/router.ts";
import { formatCount } from "../lib/time.ts";
import { useAnnounce } from "../lib/announce.ts";
import { confidenceChip, ITEM_CAP, searchablePercent } from "../lib/vocabulary.ts";
import { EvidenceCardView } from "./EvidenceCard.tsx";
import { Icon } from "./Icon.tsx";
import { ErrorNotice, Notice } from "./Notice.tsx";
import { Spinner } from "./Spinner.tsx";
import { StateBlock } from "./StateBlock.tsx";

const SEARCH_LIMIT = 10;
const MAX_QUERY_CHARS = 500;

const EXAMPLES = ["Why was this default chosen?", "Is it safe to call this concurrently?", "Why does this fail after an upgrade?"];

type Phase = { kind: "idle" } | { kind: "searching" } | { kind: "done"; response: SearchResponse } | { kind: "error"; error: ErrorView };

type Props = { repository: RepositoryRecord; coverage: CoverageReport | null; initialQuery: string };

/** Asks the server for evidence; the query is embedded there, so nothing is downloaded here. The query lives in the URL. */
export function SearchPanel({ repository, coverage, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const announce = useAnnounce();
  const status = coverage?.status ?? repository.status;
  const indexing = status === "registered" && (coverage === null || coverage.active_jobs.length > 0);

  // "/" focuses the search box from anywhere on the page; Escape clears it.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      } else if (event.key === "Escape" && target === inputRef.current) {
        setQuery("");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const lastRun = useRef<string | null>(null);
  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      lastRun.current = trimmed;
      setPhase({ kind: "searching" });
      navigate(repositoryPath(repository.full_name, trimmed), { replace: true });
      const result = await api<SearchResponse>("/api/search", "search", postJson({ repositoryId: repository.id, query: trimmed, limit: SEARCH_LIMIT }));
      if (!result.ok) {
        setPhase({ kind: "error", error: result.error });
        announce("The search failed.");
        return;
      }
      setPhase({ kind: "done", response: result.value });
      announce(result.value.results.length === 0 ? "No results." : `${result.value.results.length} results.`);
      resultsRef.current?.focus();
    },
    [repository.id, repository.full_name, announce],
  );

  // A permalink runs its query on load; a query this panel wrote to the URL itself is not run twice.
  useEffect(() => {
    if (initialQuery && initialQuery !== lastRun.current) void run(initialQuery);
  }, [initialQuery, run]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(query);
  }

  return (
    <section className="search" aria-labelledby="search-title">
      <h2 id="search-title" className="sr-only">
        Search the discussions
      </h2>
      <form onSubmit={onSubmit} className="search-form">
        <label className="sr-only" htmlFor="search-query">
          Search query
        </label>
        <input
          id="search-query"
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask in plain words, for example: why do tasks keep running after an error?"
          maxLength={MAX_QUERY_CHARS}
          autoComplete="off"
          required
        />
        <button type="submit" className="btn btn-primary" disabled={phase.kind === "searching" || indexing}>
          {phase.kind === "searching" ? <Spinner size={20} /> : <Icon name="search" />}
          {phase.kind === "searching" ? "Searching…" : indexing ? "Search opens in about a minute" : "Search"}
        </button>
      </form>
      {phase.kind === "idle" && (
        <div className="chip-row">
          <span className="meta">Try:</span>
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="btn btn-secondary btn-sm round" onClick={() => void run(example)} disabled={indexing}>
              {example}
            </button>
          ))}
        </div>
      )}
      {phase.kind === "error" && <ErrorNotice error={phase.error} onRetry={() => void run(query)} />}
      {phase.kind === "searching" && <Skeleton />}
      {phase.kind === "done" && <SearchResults response={phase.response} headingRef={resultsRef} />}
    </section>
  );
}

function Skeleton() {
  return (
    <ol className="results" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="card skeleton">
          <span className="line w40" />
          <span className="line w80" />
          <span className="line w100" />
        </li>
      ))}
    </ol>
  );
}

function SearchResults({ response, headingRef }: { response: SearchResponse; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const chip = confidenceChip(response);
  const pct = searchablePercent(response.index.embedded, response.index.pending);
  const threads = groupByThread(response.results);
  const n = response.results.length;
  return (
    <div className="results-block">
      <h3 ref={headingRef} tabIndex={-1} className="results-head">
        <span className={`pill tone-${chip.tone}`}>
          {chip.warn ? <Icon name="alert-triangle" /> : <span className={`dot${chip.tone === "muted" ? " hollow" : ""}`} aria-hidden="true" />} {chip.label}
        </span>{" "}
        <span className="meta">
          {n} result{n === 1 ? "" : "s"}
          {pct !== null ? ` from ${pct}% of fetched passages` : ""}
          {response.embed_ms !== null ? ` · ${(response.embed_ms / 1000).toFixed(1)} s` : ""}
        </span>
      </h3>
      {response.message && n > 0 && <Notice tone="amber">{response.message}</Notice>}
      {response.index.partial && response.index.status !== "inaccessible" && response.index.status !== "removed" && (
        <p className="meta">The total grows while older history is fetched; search again in a few minutes for more.</p>
      )}
      {response.index.capped_streams.length > 0 && <p className="meta">History beyond the {formatCount(ITEM_CAP)}-item limit per stream is not included.</p>}
      {response.index.warning && <p className="meta">{response.index.warning}</p>}
      {response.unverified > 0 && (
        <p className="meta" title="A result is shown only when its GitHub link names the same thread and comment it came from.">
          {response.unverified} result{response.unverified === 1 ? " was" : "s were"} left out because the GitHub link could not be verified.
        </p>
      )}
      {n === 0 && (
        <StateBlock
          kind="empty"
          icon="search"
          title="Nothing here supports this query"
          hint={
            <>
              {response.message && <p>{response.message}</p>}
              <ul>
                <li>Use the words the maintainers would use, such as the name of the function, option or error.</li>
                <li>Ask one question at a time.</li>
                <li>The answer may live in the code or the documentation rather than in a discussion.</li>
              </ul>
            </>
          }
        />
      )}
      <ol className="results">
        {threads.map((thread) => (
          <Thread key={thread.document_id} cards={thread.cards} />
        ))}
      </ol>
    </div>
  );
}

type ThreadGroup = { document_id: string; cards: EvidenceCard[] };

/** Results grouped by issue or pull request, in the order of their best passage. */
function groupByThread(cards: EvidenceCard[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const card of cards) {
    const group = groups.get(card.document_id);
    if (group) group.cards.push(card);
    else groups.set(card.document_id, { document_id: card.document_id, cards: [card] });
  }
  return [...groups.values()];
}

function Thread({ cards }: { cards: EvidenceCard[] }) {
  const [open, setOpen] = useState(false);
  const [best, ...rest] = cards;
  return (
    <>
      <EvidenceCardView card={best} />
      {rest.length > 0 && (
        <li className="thread-more">
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? "chevron-up" : "chevron-down"} /> {open ? "Hide" : "Show"} {rest.length} more passage{rest.length === 1 ? "" : "s"} in this thread
          </button>
          {open && (
            <ol className="results nested">
              {rest.map((card) => (
                <EvidenceCardView key={card.passage_id} card={card} />
              ))}
            </ol>
          )}
        </li>
      )}
    </>
  );
}
