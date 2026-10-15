-- CT-41: retention, removal of unreachable repositories, and a tombstone status.
--
-- removed: the repository's data is gone (30 days after GitHub stopped serving it, or by an
-- operator); the row stays so a resubmission re-registers cleanly and the API can say why
-- there is nothing to search.

alter table public.repositories drop constraint repositories_status_check;
alter table public.repositories
  add constraint repositories_status_check
    check (status in ('registered', 'searchable_partial', 'searchable', 'inaccessible', 'removed'));

-- Finished jobs older than the cutoff, keeping the newest finished job per repository and
-- kind so the coverage view can always show the last run. Transitions cascade.
create or replace function public.purge_job_history(p_days integer, p_repository_id bigint default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  with keep as (
    select distinct on (j.repository_id, j.kind) j.id
      from public.jobs j
     where j.state in ('succeeded', 'failed', 'cancelled')
     order by j.repository_id, j.kind, j.id desc
  ),
  gone as (
    delete from public.jobs j
     where j.state in ('succeeded', 'failed', 'cancelled')
       and (p_repository_id is null or j.repository_id = p_repository_id)
       and coalesce(j.finished_at, j.updated_at) < now() - make_interval(days => p_days)
       and j.id not in (select id from keep)
    returning j.id
  )
  select count(*) into v_count from gone;
  return v_count;
end;
$$;

create or replace function public.purge_embedding_usage(p_days integer, p_repository_id bigint default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.embedding_usage u
     where (p_repository_id is null or u.repository_id = p_repository_id)
       and u.created_at < now() - make_interval(days => p_days)
    returning u.id
  )
  select count(*) into v_count from gone;
  return v_count;
end;
$$;

-- Everything the repository holds goes (sources cascade to passages and vectors); open jobs
-- are cancelled; the row becomes a tombstone.
create or replace function public.remove_repository(p_repository_id bigint, p_reason text)
returns table (sources integer, documents integer, passages integer, vectors integer, jobs_cancelled integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sources   integer;
  v_documents integer;
  v_passages  integer;
  v_vectors   integer;
  v_jobs      integer;
begin
  select count(*) into v_sources   from public.sources s where s.repository_id = p_repository_id;
  select count(*) into v_documents from public.documents d where d.repository_id = p_repository_id;
  select count(*) into v_passages  from public.passages p where p.repository_id = p_repository_id;
  select count(*) into v_vectors   from public.passage_embeddings e where e.repository_id = p_repository_id;

  update public.jobs j set state = 'cancelled'
   where j.repository_id = p_repository_id and j.state in ('queued', 'retry_pending', 'running');
  get diagnostics v_jobs = row_count;

  delete from public.sources s where s.repository_id = p_repository_id;
  delete from public.documents d where d.repository_id = p_repository_id;
  delete from public.stream_checkpoints c where c.repository_id = p_repository_id;
  delete from public.embedding_usage u where u.repository_id = p_repository_id;
  update public.repositories r
     set status = 'removed', last_error = left(p_reason, 500), status_changed_at = now(), updated_at = now()
   where r.id = p_repository_id;

  return query select v_sources, v_documents, v_passages, v_vectors, v_jobs;
end;
$$;

-- Repositories that GitHub stopped serving longer ago than the retention window.
create or replace function public.stale_inaccessible_repositories(p_days integer, p_repository_id bigint default null)
returns setof bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id from public.repositories r
   where r.status = 'inaccessible'
     and (p_repository_id is null or r.id = p_repository_id)
     and r.status_changed_at < now() - make_interval(days => p_days)
   order by r.status_changed_at;
$$;

-- A removed repository keeps its status until it is registered again.
create or replace function public.refresh_repository_status(p_repository_id bigint, p_transform_version text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status       text;
  v_new          text;
  v_vectors      boolean;
  v_streams_done boolean;
  v_pending      boolean;
  v_dirty        boolean;
begin
  select status into v_status from public.repositories where id = p_repository_id for update;
  if v_status is null or v_status in ('inaccessible', 'removed') then
    return v_status;
  end if;

  select exists (select 1 from public.passage_embeddings e where e.repository_id = p_repository_id) into v_vectors;
  if not v_vectors then
    return v_status;
  end if;

  select count(*) = 3 into v_streams_done
    from public.stream_checkpoints c
   where c.repository_id = p_repository_id
     and c.stream in ('issues', 'issue_comments', 'review_comments')
     and c.backfill_done_at is not null;
  select exists (
    select 1 from public.passages p
     where p.repository_id = p_repository_id
       and p.index_state = 'pending_index'
       and btrim(p.text) <> ''
       and p.token_count <= 512
  ) into v_pending;
  select exists (select 1 from public.dirty_documents(p_repository_id, p_transform_version, 1)) into v_dirty;

  v_new := case
    when v_status = 'searchable' then 'searchable'
    when v_streams_done and not v_pending and not v_dirty then 'searchable'
    else 'searchable_partial'
  end;
  if v_new <> v_status then
    update public.repositories
       set status = v_new, status_changed_at = now(), updated_at = now()
     where id = p_repository_id;
  end if;
  return v_new;
end;
$$;

revoke all on function public.purge_job_history(integer, bigint), public.purge_embedding_usage(integer, bigint),
  public.remove_repository(bigint, text), public.stale_inaccessible_repositories(integer, bigint) from public, anon, authenticated;
grant execute on function public.purge_job_history(integer, bigint), public.purge_embedding_usage(integer, bigint),
  public.remove_repository(bigint, text), public.stale_inaccessible_repositories(integer, bigint) to service_role;
