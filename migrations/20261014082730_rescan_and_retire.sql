-- CT-35: reconcile deleted sources and retire what depends on them.
--
-- GitHub's list endpoints never report a deletion, so a stream is rescanned from the start
-- now and then (rescan_<stream> jobs, low priority). Every row the rescan returns has its
-- seen_at bumped by upsert_sources; when the walk reaches the end, retire_unseen_sources
-- deletes the stream's rows not seen since the rescan began. Their passages and vectors go
-- with them (cascades), threads that lost a unit are marked for re-transform so locators and
-- counts are rebuilt, and a thread whose opening is gone loses its document.

alter table public.stream_checkpoints
  add column rescan_started_at timestamptz,   -- a rescan is walking the listing from the start
  add column last_rescan_at    timestamptz;   -- when the last rescan finished

-- null now means "re-transform this thread" (see dirty_documents).
alter table public.documents alter column sources_fetched_at drop not null;

create or replace function public.retire_unseen_sources(p_repository_id bigint, p_types text[], p_before timestamptz)
returns table (sources_removed integer, documents_removed integer, documents_dirtied integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removed      integer;
  v_numbers      integer[];
  v_docs_removed integer;
  v_dirtied      integer;
begin
  with gone as (
    delete from public.sources s
     where s.repository_id = p_repository_id
       and s.type = any (p_types)
       and s.seen_at < p_before
    returning s.number
  )
  select count(*), array_agg(distinct number) into v_removed, v_numbers from gone;

  with orphan as (
    delete from public.documents d
     where d.repository_id = p_repository_id
       and not exists (
         select 1 from public.sources s
          where s.repository_id = d.repository_id
            and s.number = d.number
            and s.type in ('issue', 'pull_request')
       )
    returning d.document_id
  )
  select count(*) into v_docs_removed from orphan;

  update public.documents d
     set sources_fetched_at = null
   where d.repository_id = p_repository_id
     and d.number = any (coalesce(v_numbers, '{}'::integer[]));
  get diagnostics v_dirtied = row_count;

  return query select v_removed, v_docs_removed, v_dirtied;
end;
$$;

revoke all on function public.retire_unseen_sources(bigint, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.retire_unseen_sources(bigint, text[], timestamptz) to service_role;

-- Streams whose backfill is complete, with no walk in progress, whose last rescan (or the
-- backfill itself) is older than the interval, and no rescan job already waiting or running.
create or replace function public.streams_due_for_rescan(p_interval_seconds integer, p_limit integer, p_repository_id bigint default null)
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
     and c.backfill_done_at is not null
     and c.cursor is null
     and coalesce(c.last_rescan_at, c.backfill_done_at) < now() - make_interval(secs => p_interval_seconds)
     and not exists (
       select 1 from public.jobs j
        where j.repository_id = c.repository_id
          and j.kind = 'rescan_' || c.stream
          and j.state in ('queued', 'running', 'retry_pending')
     )
   order by coalesce(c.last_rescan_at, c.backfill_done_at), c.repository_id, c.stream
   limit greatest(1, least(p_limit, 500));
$$;

revoke all on function public.streams_due_for_rescan(integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.streams_due_for_rescan(integer, integer, bigint) to service_role;
