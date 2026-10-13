// Types shared between the Worker (API) and the React app (status screen).

export type RepositoryRecord = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  status: string;
  submission_count: number;
  created_at: string;
  updated_at: string;
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
  fetched_at: string;
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
  sources_fetched_at: string;
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

/** POST /api/search response. The query is embedded on the server; no vector leaves it. */
export type SearchResponse = {
  repository_id: number;
  query: string; // as searched, trimmed
  limit: number;
  embed_ms: number; // wall time of the query embedding call
  results: SearchHit[];
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
