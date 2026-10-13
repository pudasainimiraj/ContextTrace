-- Two-phase indexing. A passage is written as pending_index by the transform, its vector is
-- stored, and only then is it marked active, in the same transaction as the vector. Search
-- returns active passages only, so a passage whose vector failed to store, or whose text
-- changed after it was embedded, is never served from a stale or missing vector.
alter table public.passages
  add column index_state text not null default 'pending_index'
  check (index_state in ('pending_index', 'active'));

create index passages_index_state_idx on public.passages (repository_id, index_state);

-- Passages already embedded for their current text are active.
update public.passages p
   set index_state = 'active'
  from public.passage_embeddings e
 where e.passage_id = p.passage_id
   and e.content_hash = p.content_hash;

-- sync_passages: a passage whose content changed goes back to pending_index.
create or replace function public.sync_passages(p_documents jsonb, p_passages jsonb)
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
      index_state       = case when p.content_hash is distinct from excluded.content_hash
                               then 'pending_index' else p.index_state end,
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

-- upsert_passage_embeddings: the passages whose current text was just embedded become
-- active in the same transaction. A passage whose text changed in between keeps pending.
create or replace function public.upsert_passage_embeddings(p_rows jsonb)
returns table (inserted integer, updated integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
  v_updated  integer;
begin
  with incoming as (
    select * from jsonb_to_recordset(p_rows) as r(
      passage_id text, repository_id bigint, model text, pooling text, dims integer,
      content_hash text, token_count integer, embedding jsonb, embedded_by_job bigint)
  ),
  upserted as (
    insert into public.passage_embeddings as e
      (passage_id, repository_id, model, pooling, dims, content_hash, token_count, embedding, embedded_by_job)
    select passage_id, repository_id, model, pooling, dims, content_hash, token_count,
           (embedding::text)::extensions.vector(384), embedded_by_job
      from incoming
    on conflict (passage_id) do update set
      model = excluded.model, pooling = excluded.pooling, dims = excluded.dims,
      content_hash = excluded.content_hash, token_count = excluded.token_count,
      embedding = excluded.embedding, embedded_by_job = excluded.embedded_by_job,
      updated_at = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated from upserted;

  update public.passages p
     set index_state = 'active'
    from jsonb_to_recordset(p_rows) as r(passage_id text, content_hash text)
   where p.passage_id = r.passage_id
     and p.content_hash = r.content_hash;

  return query select v_inserted, v_updated;
end;
$$;

-- search_passages: active passages only.
create or replace function public.search_passages(p_repository_id bigint, p_query extensions.vector(384), p_limit integer)
returns table (passage_id text, document_id text, score real)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform set_config('hnsw.ef_search', '200', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  return query
    select e.passage_id, p.document_id, (1 - (e.embedding operator(extensions.<=>) p_query))::real as score
      from public.passage_embeddings e
      join public.passages p on p.passage_id = e.passage_id
     where e.repository_id = p_repository_id
       and p.index_state = 'active'
     order by e.embedding operator(extensions.<=>) p_query
     limit p_limit;
end;
$$;
