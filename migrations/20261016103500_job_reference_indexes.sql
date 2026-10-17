-- Indexes for the columns that reference jobs with ON DELETE SET NULL.
--
-- Deleting a job makes Postgres look for referencing rows in sources (fetched_by_job),
-- passage_embeddings (embedded_by_job), stream_checkpoints (job_id) and embedding_usage
-- (job_id). Without an index each lookup is a sequential scan of the whole table, once per
-- deleted job: removing 29 test repositories (141 jobs) timed out in the Supabase SQL editor
-- on 2026-10-16, and the retention sweep that deletes jobs older than JOB_RETENTION_DAYS
-- pays the same cost. `if not exists` keeps the file idempotent for a database where the
-- indexes were created by hand first.

create index if not exists sources_fetched_by_job_idx on public.sources (fetched_by_job);
create index if not exists passage_embeddings_embedded_by_job_idx on public.passage_embeddings (embedded_by_job);
create index if not exists stream_checkpoints_job_id_idx on public.stream_checkpoints (job_id);
create index if not exists embedding_usage_job_id_idx on public.embedding_usage (job_id);
