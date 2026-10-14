-- CT-34: incremental sync support.
--
-- 1. sources.seen_at records every time a fetch returned the row, while fetched_at now moves
--    only when the row's content changed. dirty_documents keys on fetched_at, so a sync that
--    re-reads unchanged items (the overlap window, or an issue whose updated_at moved because
--    a comment was added) no longer dirties a thread; nothing is re-transformed or re-embedded.
-- 2. streams_due_for_sync lists the streams the cron should sync now.

alter table public.sources add column seen_at timestamptz not null default now();
update public.sources set seen_at = fetched_at;

create or replace function public.upsert_sources(p_rows jsonb)
returns table (inserted integer, updated integer, unchanged integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
  v_updated  integer;
  v_total    integer;
begin
  with incoming as (
    select *
      from jsonb_to_recordset(p_rows) as r(
        repository_id  bigint,
        type           text,
        github_id      bigint,
        number         integer,
        node_id        text,
        title          text,
        author         text,
        body           text,
        state          text,
        html_url       text,
        api_url        text,
        path           text,
        line           integer,
        in_reply_to_id bigint,
        created_at     timestamptz,
        updated_at     timestamptz,
        closed_at      timestamptz,
        fetched_by_job bigint
      )
  ),
  upserted as (
    insert into public.sources as s (
      repository_id, type, github_id, number, node_id, title, author, body, state,
      html_url, api_url, path, line, in_reply_to_id, created_at, updated_at, closed_at,
      fetched_by_job
    )
    select repository_id, type, github_id, number, node_id, title, author, body, state,
           html_url, api_url, path, line, in_reply_to_id, created_at, updated_at, closed_at,
           fetched_by_job
      from incoming
    on conflict (repository_id, type, github_id) do update set
      number         = excluded.number,
      node_id        = excluded.node_id,
      title          = excluded.title,
      author         = excluded.author,
      body           = excluded.body,
      state          = excluded.state,
      html_url       = excluded.html_url,
      api_url        = excluded.api_url,
      path           = excluded.path,
      line           = excluded.line,
      in_reply_to_id = excluded.in_reply_to_id,
      updated_at     = excluded.updated_at,
      closed_at      = excluded.closed_at,
      seen_at        = now(),
      -- content changed: the thread becomes dirty; otherwise fetched_at and the job stay
      fetched_at     = case
                         when (s.number, s.node_id, s.title, s.author, s.body, s.state, s.html_url, s.api_url, s.path, s.line, s.in_reply_to_id, s.closed_at)
                              is distinct from
                              (excluded.number, excluded.node_id, excluded.title, excluded.author, excluded.body, excluded.state, excluded.html_url, excluded.api_url, excluded.path, excluded.line, excluded.in_reply_to_id, excluded.closed_at)
                         then now() else s.fetched_at end,
      fetched_by_job = case
                         when (s.number, s.node_id, s.title, s.author, s.body, s.state, s.html_url, s.api_url, s.path, s.line, s.in_reply_to_id, s.closed_at)
                              is distinct from
                              (excluded.number, excluded.node_id, excluded.title, excluded.author, excluded.body, excluded.state, excluded.html_url, excluded.api_url, excluded.path, excluded.line, excluded.in_reply_to_id, excluded.closed_at)
                         then excluded.fetched_by_job else s.fetched_by_job end
    where excluded.updated_at >= s.updated_at
    -- now() is fixed for the statement, so fetched_at = now() marks the rows written just now
    returning (xmax = 0) as was_inserted, (s.fetched_at = now()) as was_fetched
  )
  select count(*) filter (where was_inserted), count(*) filter (where was_fetched and not was_inserted)
    into v_inserted, v_updated
    from upserted;
  select count(*) into v_total from jsonb_array_elements(p_rows);
  return query select v_inserted, v_updated, v_total - v_inserted - v_updated;
end;
$$;

-- Streams whose last completed head or sync run is older than the interval, for searchable
-- repositories, with no fetch job already waiting or running and no sync left unfinished.
-- p_repository_id narrows the listing to one repository (tests and manual runs).
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
     and c.sync_cursor is null
     and (c.last_synced_at is null or c.last_synced_at < now() - make_interval(secs => p_interval_seconds))
     and not exists (
       select 1 from public.jobs j
        where j.repository_id = c.repository_id
          and j.kind = 'fetch_' || c.stream
          and j.state in ('queued', 'running', 'retry_pending')
     )
   order by c.last_synced_at nulls first, c.repository_id, c.stream
   limit greatest(1, least(p_limit, 500));
$$;

revoke all on function public.streams_due_for_sync(integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.streams_due_for_sync(integer, integer, bigint) to service_role;
