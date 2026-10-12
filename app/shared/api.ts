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
