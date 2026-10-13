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
