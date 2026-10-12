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
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};
