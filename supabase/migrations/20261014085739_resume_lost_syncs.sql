-- CT-36: a stream whose sync continuation was lost (sync_cursor set, no fetch job alive) must
-- not fall out of the schedule. The job the cron queues resumes from the cursor.
create or replace function public.streams_due_for_sync(p_interval_seconds integer, p_limit integer, p_repository_id bigint default null)
returns table (repository_id bigint, stream text)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.repository_id, c.stream
    from public.stream_checkpoints c
    join public.repositories r on r.id = c.repository_id
   where r.status in ('searchable_partial', 'searchable')
     and (p_repository_id is null or c.repository_id = p_repository_id)
     and c.head_done_at is not null
     and (c.sync_cursor is not null or c.last_synced_at is null or c.last_synced_at < now() - make_interval(secs => p_interval_seconds))
     and not exists (
       select 1 from public.jobs j
        where j.repository_id = c.repository_id
          and j.kind = 'fetch_' || c.stream
          and j.state in ('queued', 'running', 'retry_pending')
     )
   order by c.last_synced_at nulls first, c.repository_id, c.stream
   limit greatest(1, least(p_limit, 500));
$$;
