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
  updated_at: string;
};
