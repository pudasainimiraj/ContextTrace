-- Threads that need (re)transformation: an opening row exists and either no documents row
-- exists, the transform version changed, or a source row was fetched after the last
-- transform. Ordered by number so a page-limited run makes steady progress.
create function public.dirty_documents(p_repository_id bigint, p_transform_version text, p_limit integer)
returns table (number integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.number
    from public.sources s
    left join public.documents d
      on d.repository_id = s.repository_id and d.number = s.number
   where s.repository_id = p_repository_id
   group by s.number, d.transform_version, d.sources_fetched_at
  having bool_or(s.type in ('issue', 'pull_request'))
     and (d.sources_fetched_at is null
          or d.transform_version is distinct from p_transform_version
          or max(s.fetched_at) > d.sources_fetched_at)
   order by s.number
   limit p_limit;
$$;

-- Writes a batch of documents and their passages in one transaction. A passage whose
-- content and metadata are unchanged is left untouched (updated_at keeps its value);
-- passages of these documents that were not produced this time are removed. Returns
-- how many rows were inserted, updated, unchanged and removed.
create function public.sync_passages(p_documents jsonb, p_passages jsonb)
returns table (documents integer, inserted integer, updated integer, unchanged integer, removed integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_documents integer;
  v_inserted  integer;
  v_updated   integer;
  v_total     integer;
  v_removed   integer;
begin
  insert into public.documents as d
    (document_id, repository_id, type, number, title, transform_version, sources_fetched_at, transformed_at)
  select document_id, repository_id, type, number, title, transform_version, sources_fetched_at, now()
    from jsonb_to_recordset(p_documents) as r(
      document_id text, repository_id bigint, type text, number integer, title text,
      transform_version text, sources_fetched_at timestamptz)
  on conflict (document_id) do update set
    type               = excluded.type,
    title              = excluded.title,
    transform_version  = excluded.transform_version,
    sources_fetched_at = excluded.sources_fetched_at,
    transformed_at     = now();
  get diagnostics v_documents = row_count;

  with incoming as (
    select * from jsonb_to_recordset(p_passages) as r(
      passage_id text, document_id text, repository_id bigint, source_type text, source_github_id bigint,
      chunk_index integer, chunk_count integer, token_count integer, tokenizer text, locator text,
      author text, created_at timestamptz, source_url text, text text, text_kind text,
      content_hash text, transform_version text)
  ),
  upserted as (
    insert into public.passages as p (
      passage_id, document_id, repository_id, source_type, source_github_id, chunk_index, chunk_count,
      token_count, tokenizer, locator, author, created_at, source_url, text, text_kind, content_hash,
      transform_version)
    select passage_id, document_id, repository_id, source_type, source_github_id, chunk_index, chunk_count,
           token_count, tokenizer, locator, author, created_at, source_url, text, text_kind, content_hash,
           transform_version
      from incoming
    on conflict (passage_id) do update set
      -- document_id, repository_id, source_type, source_github_id and chunk_index are encoded in the id
      chunk_count       = excluded.chunk_count,
      token_count       = excluded.token_count,
      tokenizer         = excluded.tokenizer,
      locator           = excluded.locator,
      author            = excluded.author,
      created_at        = excluded.created_at,
      source_url        = excluded.source_url,
      text              = excluded.text,
      text_kind         = excluded.text_kind,
      content_hash      = excluded.content_hash,
      transform_version = excluded.transform_version,
      updated_at        = now()
    where (p.content_hash, p.chunk_count, p.token_count, p.tokenizer, p.locator, p.author, p.created_at,
           p.source_url, p.text_kind, p.transform_version)
          is distinct from
          (excluded.content_hash, excluded.chunk_count, excluded.token_count, excluded.tokenizer, excluded.locator,
           excluded.author, excluded.created_at, excluded.source_url, excluded.text_kind, excluded.transform_version)
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated
    from upserted;
  select count(*) into v_total from jsonb_array_elements(p_passages);

  with keep as (
    select passage_id from jsonb_to_recordset(p_passages) as r(passage_id text)
  ),
  gone as (
    delete from public.passages p
     where p.document_id in (select document_id from jsonb_to_recordset(p_documents) as d(document_id text))
       and not exists (select 1 from keep where keep.passage_id = p.passage_id)
    returning 1
  )
  select count(*) into v_removed from gone;

  return query select v_documents, v_inserted, v_updated, v_total - v_inserted - v_updated, v_removed;
end;
$$;

revoke execute on function public.dirty_documents(bigint, text, integer) from public, anon, authenticated;
grant execute on function public.dirty_documents(bigint, text, integer) to service_role;
revoke execute on function public.sync_passages(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sync_passages(jsonb, jsonb) to service_role;
