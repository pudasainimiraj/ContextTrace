-- CT-40: the semantic search clamps its own limit, so no caller can ask for more than the
-- evidence cards ever show (the API caps limit at 10 as well).
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
     limit least(greatest(coalesce(p_limit, 1), 1), 10);
end;
$$;
