-- CT-32: durable per-stream cursors for a newest-first head pass, a low-priority historical
-- backfill and incremental syncs.
--
-- cursor           next page of the descending (newest first) listing that the backfill
--                  continues; null once the listing reached the end
-- sync_cursor      next page of an ascending `since` listing that a sync left unfinished
-- last_item_at     updated_at high-water mark: the newest item a head or sync run has seen;
--                  the next sync lists since this time. The backfill never moves it.
-- head_done_at     when the head pass finished (from then on fetch_* jobs run as syncs)
-- backfill_done_at when the backfill reached the end of the listing
-- last_synced_at   when a head or sync run last completed
-- pages_fetched, items_fetched: coverage counters over every run of the stream

alter table public.stream_checkpoints
  add column sync_cursor      text,
  add column head_done_at     timestamptz,
  add column backfill_done_at timestamptz,
  add column last_synced_at   timestamptz,
  add column pages_fetched    integer not null default 0,
  add column items_fetched    bigint  not null default 0;

-- Checkpoints written before this migration come from a single ascending listing: a
-- completed one counts as head and backfill done; an unfinished one keeps its cursor.
update public.stream_checkpoints
   set head_done_at     = updated_at,
       backfill_done_at = case when cursor is null then updated_at end,
       last_synced_at   = case when cursor is null then updated_at end;

-- A stream is complete for the status once its backfill reached the end.
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
  if v_status is null or v_status = 'inaccessible' then
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
