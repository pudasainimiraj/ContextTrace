-- Vector search over one repository's passages, cosine metric, served by the HNSW index
-- created in CT-23 (passage_embeddings_embedding_idx, vector_cosine_ops). The repository
-- filter is applied inside the index scan; the iterative scan keeps pulling candidates until
-- p_limit rows pass it, so a filtered query never comes back short. The operator is
-- schema-qualified because search_path is empty inside the function.
create function public.search_passages(p_repository_id bigint, p_query extensions.vector(384), p_limit integer)
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
     order by e.embedding operator(extensions.<=>) p_query
     limit p_limit;
end;
$$;

revoke execute on function public.search_passages(bigint, extensions.vector(384), integer) from public, anon, authenticated;
grant execute on function public.search_passages(bigint, extensions.vector(384), integer) to service_role;
