-- CT-30: keyword baseline next to the vector index.
--
-- Full-text search over passages.text with the built-in english configuration, through an
-- expression index so the passages row and the API's select("*") stay unchanged. The
-- function mirrors search_passages (same arguments and columns) but ranks by ts_rank_cd
-- and does not require an embedding, so passages still waiting for their vector are
-- already findable by the words they contain.

create index passages_text_fts_idx on public.passages
  using gin (pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, text));

create or replace function public.search_passages_keyword(
  p_repository_id bigint,
  p_query text,
  p_limit integer
) returns table (passage_id text, document_id text, score real)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, p_query) as tsq
  )
  select p.passage_id,
         p.document_id,
         pg_catalog.ts_rank_cd(pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, p.text), q.tsq)::real as score
    from public.passages p, q
   where p.repository_id = p_repository_id
     and pg_catalog.numnode(q.tsq) > 0
     and pg_catalog.to_tsvector('pg_catalog.english'::pg_catalog.regconfig, p.text) @@ q.tsq
   order by score desc, p.passage_id
   limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.search_passages_keyword(bigint, text, integer) from public, anon, authenticated;
grant execute on function public.search_passages_keyword(bigint, text, integer) to service_role;
