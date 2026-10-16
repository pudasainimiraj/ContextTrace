-- Plan the per-repository read functions with their actual arguments.
--
-- These functions carry `set search_path = ''`, so Postgres never inlines them, and as SQL
-- functions they were planned with unknown parameters. With 70,000 passages across eight
-- repositories (2026-10-16) the generic plans estimated an eighth of the table per call and
-- chose full scans and hash joins: pending_passages took 6 to 8 seconds for a 24-passage
-- repository (past the 8-second statement timeout, which parked production embed jobs and
-- failed the live tests), keyword search 0.5 seconds, embedding_stats 3 seconds. As plpgsql
-- with plan_cache_mode = force_custom_plan each call is planned for its repository: the
-- same calls take about a millisecond for a small repository, and the large ones get the
-- hash plans they need. Bodies are unchanged apart from qualifying `score`, which would
-- otherwise clash with the OUT column. create or replace keeps the grants.

create or replace function public.pending_passages(p_repository_id bigint, p_limit integer)
returns table (passage_id text, text text, token_count integer, content_hash text)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  return query
  select p.passage_id, p.text, p.token_count, p.content_hash
    from public.passages p
    left join public.passage_embeddings e on e.passage_id = p.passage_id
   where p.repository_id = p_repository_id
     and (e.passage_id is null
          or e.content_hash <> p.content_hash
          or e.model <> '@cf/baai/bge-small-en-v1.5'
          or e.pooling <> 'cls'
          or e.dims <> 384)
   order by p.passage_id
   limit p_limit;
end;
$$;

create or replace function public.embedding_stats(p_repository_id bigint)
returns table (passages bigint, embedded bigint, pending bigint, oversized bigint, empty bigint,
               texts bigint, tokens bigint, billed_tokens bigint, neurons_estimated numeric)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  return query
  select
    (select count(*) from public.passages p where p.repository_id = p_repository_id),
    (select count(*) from public.passages p
       join public.passage_embeddings e on e.passage_id = p.passage_id and e.content_hash = p.content_hash
      where p.repository_id = p_repository_id),
    (select count(*) from public.passages p
       left join public.passage_embeddings e on e.passage_id = p.passage_id
      where p.repository_id = p_repository_id
        and (e.passage_id is null or e.content_hash <> p.content_hash)
        and p.token_count <= 512 and length(btrim(p.text)) > 0),
    (select count(*) from public.passages p where p.repository_id = p_repository_id and p.token_count > 512),
    (select count(*) from public.passages p where p.repository_id = p_repository_id and length(btrim(p.text)) = 0),
    (select coalesce(sum(u.texts), 0) from public.embedding_usage u where u.repository_id = p_repository_id),
    (select coalesce(sum(u.tokens), 0) from public.embedding_usage u where u.repository_id = p_repository_id),
    (select coalesce(sum(u.billed_tokens), 0) from public.embedding_usage u where u.repository_id = p_repository_id),
    (select coalesce(sum(u.neurons_estimated), 0) from public.embedding_usage u where u.repository_id = p_repository_id);
end;
$$;

create or replace function public.dirty_documents(p_repository_id bigint, p_transform_version text, p_limit integer)
returns table (number integer)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  return query
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
end;
$$;

create or replace function public.search_passages_keyword(p_repository_id bigint, p_query text, p_limit integer)
returns table (passage_id text, document_id text, score real)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  return query
  with q as (
    select pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, p_query) as tsq
  )
  select p.passage_id,
         p.document_id,
         pg_catalog.ts_rank_cd(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, p.text), q.tsq)::real
    from public.passages p, q
   where p.repository_id = p_repository_id
     and pg_catalog.numnode(q.tsq) > 0
     and pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, p.text) @@ q.tsq
   order by 3 desc, p.passage_id
   limit greatest(1, least(p_limit, 50));
end;
$$;
