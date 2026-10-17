create extension if not exists vector with schema extensions;

-- One vector per passage, pinned to a single model, pooling and dimension by CHECK so no
-- other model can ever be mixed into this table. content_hash and token_count are copied
-- from the passage at embedding time; a passage whose hash moved on is re-embedded.
create table public.passage_embeddings (
  passage_id      text        primary key references public.passages (passage_id) on delete cascade,
  repository_id   bigint      not null references public.repositories (id) on delete cascade,
  model           text        not null,
  pooling         text        not null,
  dims            integer     not null,
  content_hash    text        not null,
  token_count     integer     not null,           -- model input length, as passages.token_count
  embedding       extensions.vector(384) not null,
  embedded_by_job bigint      references public.jobs (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint passage_embeddings_pinned_model
    check (model = '@cf/baai/bge-small-en-v1.5' and pooling = 'cls' and dims = 384)
);

create index passage_embeddings_repository_idx on public.passage_embeddings (repository_id);
create index passage_embeddings_embedding_idx
  on public.passage_embeddings using hnsw (embedding extensions.vector_cosine_ops);

-- Metering: one row per embed_passages run that made at least one model call. tokens is
-- the sum of the passages' own model input lengths; billed_tokens is what Workers AI
-- reported (it meters every text in a batch at the batch's longest text).
create table public.embedding_usage (
  id                bigint generated always as identity primary key,
  job_id            bigint references public.jobs (id) on delete set null,
  repository_id     bigint not null references public.repositories (id) on delete cascade,
  model             text not null,
  batches           integer not null,
  texts             integer not null,
  tokens            integer not null,
  billed_tokens     integer not null,
  neurons_estimated numeric(12, 4) not null,       -- billed_tokens * 1841 / 1e6
  duration_ms       integer not null,              -- wall time inside the model calls
  created_at        timestamptz not null default now()
);
create index embedding_usage_repository_idx on public.embedding_usage (repository_id, created_at);

-- Passages that need (re)embedding, in a deterministic order. The model/pooling/dims
-- predicates cannot be true given the CHECK; they keep a future relaxation correct.
create function public.pending_passages(p_repository_id bigint, p_limit integer)
returns table (passage_id text, text text, token_count integer, content_hash text)
language sql
stable
security invoker
set search_path = ''
as $$
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
$$;

-- Batch upsert keyed by passage_id; the jsonb array's text form is pgvector input.
create function public.upsert_passage_embeddings(p_rows jsonb)
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
  return query select v_inserted, v_updated;
end;
$$;

-- Counts for the stats route, the acceptance check and the benchmark.
create function public.embedding_stats(p_repository_id bigint)
returns table (passages bigint, embedded bigint, pending bigint, oversized bigint, empty bigint,
               texts bigint, tokens bigint, billed_tokens bigint, neurons_estimated numeric)
language sql
stable
security invoker
set search_path = ''
as $$
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
$$;

alter table public.passage_embeddings enable row level security;
alter table public.embedding_usage enable row level security;
grant select, insert, update, delete on table public.passage_embeddings, public.embedding_usage to service_role;
grant usage, select on sequence public.embedding_usage_id_seq to service_role;
revoke all on table public.passage_embeddings, public.embedding_usage from anon, authenticated;
revoke all on sequence public.embedding_usage_id_seq from anon, authenticated;
revoke execute on function public.pending_passages(bigint, integer), public.upsert_passage_embeddings(jsonb),
  public.embedding_stats(bigint) from public, anon, authenticated;
grant execute on function public.pending_passages(bigint, integer), public.upsert_passage_embeddings(jsonb),
  public.embedding_stats(bigint) to service_role;
