// Types shared between the Worker (API) and the React app (status screen).

/**
 * registered: nothing searchable yet. searchable_partial: the first vectors are stored while
 * extraction, transform or embedding continues. searchable: every stream listed and nothing
 * is dirty or pending (sticky). inaccessible: GitHub no longer serves the repository.
 * removed: the data was deleted (after 30 days unreachable, or by an operator); the row stays.
 */
export type RepositoryStatus = "registered" | "searchable_partial" | "searchable" | "inaccessible" | "removed";

export type RepositoryRecord = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  status: RepositoryStatus;
  status_changed_at: string;
  last_error: string | null;
  submission_count: number;
  created_at: string;
  updated_at: string;
};

/** One row of GET /api/repositories: enough for the list on the home page, nothing per passage. */
export type RepositorySummary = {
  id: number;
  full_name: string;
  status: RepositoryStatus;
  status_changed_at: string;
  last_error: string | null;
  passages: number;
  embedded: number; // passages with a current vector
  pending: number; // passages waiting for one
  last_successful_sync_at: string | null; // every stream had completed a head or sync run by this time
  active_jobs: ActiveJob[]; // queued, running or retry_pending
};

/** GET /api/repositories: every repository that is not removed, active ones first, and the admission capacity. */
export type RepositoryListResponse = {
  repositories: RepositorySummary[];
  capacity: { used: number; max: number }; // used counts the same rows as the admission check
};

export type ApiError = {
  error: string;
  message: string;
};

export type JobRecord = {
  id: number;
  repository_id: number;
  kind: string;
  state: string;
  generation: number;
  attempt: number;
  lease_owner: string | null;
  lease_until: string | null;
  next_attempt_at: string | null;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type SourceType = "issue" | "pull_request" | "issue_comment" | "review_comment";

/** One GitHub conversation record as stored in the sources table. */
export type SourceRecord = {
  repository_id: number;
  type: SourceType;
  github_id: number;
  number: number;
  node_id: string | null;
  title: string | null;
  author: string | null;
  body: string | null;
  state: string | null;
  html_url: string;
  api_url: string;
  path: string | null;
  line: number | null;
  in_reply_to_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  fetched_at: string; // when the content last changed in a fetch
  seen_at: string; // when a fetch last returned the record, changed or not
  fetched_by_job: number | null;
};

export type DocumentType = "issue" | "pull_request";

/** One transformed conversation thread. */
export type DocumentRecord = {
  document_id: string; // github:{repository_id}:{type}:{number}
  repository_id: number;
  type: DocumentType;
  number: number;
  title: string;
  transform_version: string;
  sources_fetched_at: string | null; // null: a unit was retired, re-transform the thread
  transformed_at: string;
};

/** One embedding-ready passage from exactly one source unit. */
export type PassageRecord = {
  passage_id: string;
  document_id: string;
  repository_id: number;
  source_type: SourceType;
  source_github_id: number;
  chunk_index: number;
  chunk_count: number;
  token_count: number; // model input length: [CLS] + text tokens + [SEP]
  tokenizer: string;
  locator: string;
  author: string | null;
  created_at: string; // GitHub time of the source unit
  source_url: string;
  text: string;
  text_kind: "normalized_markdown";
  content_hash: string; // sha256 hex of text
  transform_version: string;
  index_state: "pending_index" | "active"; // active once the vector for this text is stored
  updated_at: string;
};

/** One search hit: a passage of the requested repository and its cosine similarity to the query. */
export type SearchHit = {
  passage_id: string;
  document_id: string;
  score: number; // 1 = identical text
};

/** One search result, resolved from its passage and thread: enough to read and to verify at the source. */
export type EvidenceCard = {
  passage_id: string;
  document_id: string;
  type: DocumentType;
  number: number; // issue or pull request number
  title: string; // thread title
  source_type: SourceType;
  locator: string; // where in the thread, e.g. "Comment 2 of 5"
  author: string | null;
  created_at: string; // GitHub time of the source unit
  source_url: string; // verified github.com permalink to the thread, anchored to the comment
  excerpt: string; // start of the passage on one line, cut at a word boundary
  score: number; // cosine similarity for a semantic match, ts_rank_cd for a keyword match
  match: EvidenceMatch;
};

export type EvidenceMatch = "semantic" | "keyword";
export type SearchMode = "semantic" | "keyword" | "none";
/** What the caller asked for: auto (the default) decides by score; the forced modes run one retrieval only. */
export type SearchModeRequest = "auto" | "semantic" | "keyword";
export type SearchConfidence = "high" | "low" | "none";

/** How much of the repository the search can see, and the warning to show when it is not all of it. */
export type SearchIndexState = {
  status: RepositoryStatus;
  partial: boolean; // true unless the status is searchable
  embedded: number; // passages with a current vector
  pending: number; // passages waiting for one
  capped_streams: string[]; // streams that stopped at the item cap
  warning: string | null;
};

/** POST /api/search response. The query is embedded on the server; no vector leaves it. */
export type SearchResponse = {
  repository_id: number;
  query: string; // as searched, trimmed
  limit: number;
  requested_mode: SearchModeRequest;
  mode: SearchMode; // where the results come from
  confidence: SearchConfidence; // high: close semantic matches; low: weak or keyword-only; none: nothing shown
  message: string | null; // what the reader should know when confidence is not high
  semantic_error: string | null; // error code when the semantic search could not run
  embed_ms: number | null; // wall time of the query embedding call
  index: SearchIndexState;
  results: EvidenceCard[];
  unverified: number; // hits left out because their source link could not be verified
};

export type StreamPhase = "pending" | "head" | "backfill" | "rescan" | "complete";

/** How far one extraction stream has come. */
export type StreamCoverage = {
  stream: string; // issues | issue_comments | review_comments
  source_types: SourceType[]; // what the stream stores
  phase: StreamPhase; // pending: not started; head: newest pages; backfill: history; rescan: re-listing for deletions; complete: listed to the end
  complete: boolean; // listed to the end at least once (a rescan does not reset this)
  high_water_mark: string | null; // updated_at of the newest item seen; the next sync lists since this
  last_synced_at: string | null; // last completed head or sync run
  backfill_done_at: string | null;
  backfill_pending: boolean; // a backfill cursor is waiting for its job
  sync_in_progress: boolean; // a sync left a cursor behind
  rescan_in_progress: boolean;
  last_rescan_at: string | null; // when deleted sources were last reconciled
  capped: boolean; // stopped at the per-stream item cap; counts as complete, older items are not indexed
  capped_at: string | null;
  pages_fetched: number;
  items_fetched: number;
};

/** A job that is queued, running or parked for a retry. Never carries the error message: it may name internal calls. */
export type ActiveJob = {
  kind: string;
  state: "queued" | "running" | "retry_pending";
  error_code: string | null; // budget_exhausted marks a budget pause
  next_attempt_at: string | null;
  started_at: string | null;
  attempt: number;
  lease_until: string | null; // a running job past its lease is stalled until the cron recovers it
};

/** The newest succeeded run of one job kind, from the job's stored result. */
export type LastRun = {
  kind: string;
  finished_at: string;
  pages: number | null;
  records: number | null;
  inserted: number | null;
  duration_ms: number | null;
};

/** GET /api/repositories/:id/coverage: what is stored, what is searchable, and how current it is. */
export type CoverageReport = {
  repository_id: number;
  status: RepositoryStatus;
  partial: boolean;
  last_error: string | null;
  sources: Record<SourceType, number>; // stored records per type
  documents: number;
  passages: number;
  embedded: number; // passages with a current vector
  pending: number; // passages waiting for one
  streams: StreamCoverage[];
  completed_source_types: SourceType[]; // types whose stream has been listed to the end
  last_successful_sync_at: string | null; // every stream had completed a head or sync run by this time
  jobs: { queued: number; running: number; retry_pending: number; failed: number };
  active_jobs: ActiveJob[];
  last_runs: LastRun[];
  paused_until: string | null; // the latest reset time among exhausted budgets, when any is exhausted
};

/** One metered resource as the budget ledger sees it now. */
export type BudgetState = {
  resource: string;
  period: "hour" | "day" | "month" | "gauge";
  used: number;
  limit: number;
  remaining_pct: number;
  paused: boolean; // used >= limit: reservations are refused until resets_at
  resets_at: string | null; // null for a gauge
};

/** GET /api/status: whether the service is pausing itself, and why. Never carries a secret. */
export type ServiceStatus = {
  paused: boolean;
  reasons: string[]; // one line per exhausted budget
  deferred: string[]; // one line per scheduler that is holding back without a budget being exhausted
  budgets: BudgetState[];
  admissions: { open: boolean; reason: string | null }; // whether a new repository can be registered now
  protections: { turnstile: boolean; rate_limits: boolean; admin: boolean }; // what is enforced in this deployment
  storage: { used: number; limit: number; level: "ok" | "warning" | "critical" }; // warning pauses admissions, backfills and rescans; critical pauses syncs too
  generated_at: string;
};

/** Embedding coverage and metering for one repository. */
export type EmbeddingStats = {
  repository_id: number;
  model: string;
  pooling: string;
  dims: number;
  passages: number;
  embedded: number; // passages whose stored vector matches their current content hash
  pending: number; // embeddable passages without a current vector
  oversized: number; // token_count above the model limit; never sent
  empty: number; // blank text; never sent
  texts: number; // texts sent to the model, all runs
  tokens: number; // sum of the texts' model input lengths
  billed_tokens: number; // as metered by Workers AI
  neurons_estimated: number;
  usd_estimated: number;
};
