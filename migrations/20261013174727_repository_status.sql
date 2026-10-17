-- CT-31: repository status with a first-usable-batch transition.
--
-- registered          nothing searchable yet
-- searchable_partial  at least one passage vector is stored; extraction, transform or
--                     embedding is still running, so results carry a partial warning
-- searchable          every extraction stream completed its listing and no passage is
--                     dirty or waiting for a vector (sticky: a later sync does not revert it)
-- inaccessible        GitHub no longer serves the repository (set by the extractor)

alter table public.repositories
  add column status_changed_at timestamptz not null default now(),
  add column last_error text,
  add constraint repositories_status_check
    check (status in ('registered', 'searchable_partial', 'searchable', 'inaccessible'));

-- Recomputes the status from the stored data and returns it. Called by the embedding job
-- after its first stored batch (the partial transition) and at the end of each run.
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

  -- A stream's listing is complete once its checkpoint exists without a cursor.
  select count(*) = 3 into v_streams_done
    from public.stream_checkpoints c
   where c.repository_id = p_repository_id
     and c.stream in ('issues', 'issue_comments', 'review_comments')
     and c.cursor is null;
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

revoke all on function public.refresh_repository_status(bigint, text) from public, anon, authenticated;
grant execute on function public.refresh_repository_status(bigint, text) to service_role;

-- Repositories indexed before this migration get their status from the stored data.
select public.refresh_repository_status(r.id, '1') from public.repositories r;
