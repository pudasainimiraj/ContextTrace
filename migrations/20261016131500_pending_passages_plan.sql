-- pending_passages: collect the repository's passages first, then look for missing vectors.
--
-- A SQL function with a SET clause is not inlined and is planned with its parameters
-- unknown. For the former single query the planner expected about an eighth of the table
-- to match the repository and walked the passages in passage_id order until it had p_limit
-- hits; for a small repository whose passages are all embedded that was the whole table,
-- 6 to 8 seconds once 70,000 passages were stored (2026-10-16), beyond the 8-second
-- statement timeout. MATERIALIZED pins the first step to the repository index; the ids
-- are then checked against passage_embeddings and only the chosen rows fetch their text.
-- Same rows, same order, same grants (create or replace keeps them).

create or replace function public.pending_passages(p_repository_id bigint, p_limit integer)
returns table (passage_id text, text text, token_count integer, content_hash text)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as materialized (
    select p.passage_id, p.content_hash
      from public.passages p
     where p.repository_id = p_repository_id
  ),
  pending as (
    select c.passage_id
      from candidates c
      left join public.passage_embeddings e on e.passage_id = c.passage_id
     where e.passage_id is null
        or e.content_hash <> c.content_hash
        or e.model <> '@cf/baai/bge-small-en-v1.5'
        or e.pooling <> 'cls'
        or e.dims <> 384
     order by c.passage_id
     limit p_limit
  )
  select p.passage_id, p.text, p.token_count, p.content_hash
    from pending n
    join public.passages p on p.passage_id = n.passage_id
   order by p.passage_id;
$$;
