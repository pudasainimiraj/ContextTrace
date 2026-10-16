-- UX v1.1: one read for the home page list, and the active jobs and last runs for the coverage report.

-- Every repository that is not removed (the same set the admission count uses) with its passage
-- counts, how many of its streams have completed a run, its oldest completed run, and its queued,
-- running or parked jobs. The error message of a job never leaves the database: it may name
-- internal calls. Sorting and the sentences are the application's job.
create or replace function public.repository_summaries()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with passage_counts as (
    select p.repository_id,
           count(*) as passages,
           count(*) filter (where p.index_state = 'active') as embedded,
           count(*) filter (where p.index_state = 'pending_index') as pending_raw
      from public.passages p
     group by p.repository_id
  ),
  unembeddable as (
    -- Blank or oversized passages are never sent to the model; only pending rows are read here.
    select p.repository_id, count(*) as n
      from public.passages p
     where p.index_state = 'pending_index' and (btrim(p.text) = '' or p.token_count > 512)
     group by p.repository_id
  ),
  syncs as (
    select c.repository_id,
           count(*) filter (where c.last_synced_at is not null) as streams_synced,
           min(c.last_synced_at) as oldest_sync_at
      from public.stream_checkpoints c
     group by c.repository_id
  ),
  active as (
    select j.repository_id,
           jsonb_agg(jsonb_build_object(
             'kind', j.kind,
             'state', j.state,
             'error_code', j.error_code,
             'next_attempt_at', j.next_attempt_at,
             'started_at', j.started_at,
             'attempt', j.attempt,
             'lease_until', j.lease_until
           ) order by j.id) as active_jobs
      from public.jobs j
     where j.state in ('queued', 'running', 'retry_pending')
     group by j.repository_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id,
           'full_name', r.full_name,
           'status', r.status,
           'status_changed_at', r.status_changed_at,
           'last_error', r.last_error,
           'passages', coalesce(pc.passages, 0),
           'embedded', coalesce(pc.embedded, 0),
           'pending', coalesce(pc.pending_raw, 0) - coalesce(u.n, 0),
           'streams_synced', coalesce(s.streams_synced, 0),
           'oldest_sync_at', s.oldest_sync_at,
           'active_jobs', coalesce(a.active_jobs, '[]'::jsonb)
         ) order by r.id), '[]'::jsonb)
    from public.repositories r
    left join passage_counts pc on pc.repository_id = r.id
    left join unembeddable u on u.repository_id = r.id
    left join syncs s on s.repository_id = r.id
    left join active a on a.repository_id = r.id
   where r.status <> 'removed';
$$;

revoke all on function public.repository_summaries() from public, anon, authenticated;
grant execute on function public.repository_summaries() to service_role;

-- The coverage report gains the active jobs (same shape as above) and the newest succeeded run
-- per job kind, which purge_job_history always keeps.
create or replace function public.repository_coverage(p_repository_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'sources', (
      select coalesce(jsonb_object_agg(t.type, t.n), '{}'::jsonb)
        from (select s.type, count(*) as n from public.sources s where s.repository_id = p_repository_id group by s.type) t
    ),
    'documents', (select count(*) from public.documents d where d.repository_id = p_repository_id),
    'passages', (select count(*) from public.passages p where p.repository_id = p_repository_id),
    'embedded', (select count(*) from public.passages p where p.repository_id = p_repository_id and p.index_state = 'active'),
    'pending', (
      select count(*) from public.passages p
       where p.repository_id = p_repository_id
         and p.index_state = 'pending_index'
         and btrim(p.text) <> ''
         and p.token_count <= 512
    ),
    'jobs', (
      select coalesce(jsonb_object_agg(j.state, j.n), '{}'::jsonb)
        from (
          select j.state, count(*) as n from public.jobs j
           where j.repository_id = p_repository_id and j.state in ('queued', 'running', 'retry_pending', 'failed')
           group by j.state
        ) j
    ),
    'active_jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind', j.kind,
               'state', j.state,
               'error_code', j.error_code,
               'next_attempt_at', j.next_attempt_at,
               'started_at', j.started_at,
               'attempt', j.attempt,
               'lease_until', j.lease_until
             ) order by j.id), '[]'::jsonb)
        from public.jobs j
       where j.repository_id = p_repository_id and j.state in ('queued', 'running', 'retry_pending')
    ),
    'last_runs', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'finished_at', x.finished_at, 'result', x.result) order by x.kind), '[]'::jsonb)
        from (
          select distinct on (j.kind) j.kind, j.finished_at, j.result
            from public.jobs j
           where j.repository_id = p_repository_id and j.state = 'succeeded'
           order by j.kind, j.id desc
        ) x
    ),
    'streams', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.stream), '[]'::jsonb)
        from public.stream_checkpoints c where c.repository_id = p_repository_id
    )
  );
$$;
