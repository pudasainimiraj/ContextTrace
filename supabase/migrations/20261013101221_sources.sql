-- GitHub conversation source records: issues, pull requests and their comments, keyed
-- by GitHub's id within each type. Every row keeps its permalink, the API resource it
-- came from and the job that fetched it, so provenance can be verified later.
create table public.sources (
  repository_id  bigint      not null references public.repositories (id) on delete cascade,
  type           text        not null
                 check (type in ('issue', 'pull_request', 'issue_comment', 'review_comment')),
  github_id      bigint      not null,          -- GitHub's id within that type
  number         integer     not null,          -- the issue or pull request this record belongs to
  node_id        text,
  title          text,                          -- issues and pull requests only
  author         text,
  body           text,
  state          text,                          -- open or closed; issues and pull requests only
  html_url       text        not null,          -- permalink
  api_url        text        not null,          -- provenance: the REST resource
  path           text,                          -- review comments: file path
  line           integer,                       -- review comments: line in the diff
  in_reply_to_id bigint,                        -- review comments: parent comment
  created_at     timestamptz not null,          -- GitHub timestamps
  updated_at     timestamptz not null,
  closed_at      timestamptz,
  fetched_at     timestamptz not null default now(),
  fetched_by_job bigint      references public.jobs (id) on delete set null,
  primary key (repository_id, type, github_id)
);

create index sources_repository_number_idx on public.sources (repository_id, number, type);

-- Batch upsert from a jsonb array. A row never overwrites newer data already stored,
-- so an overlapping or stale page is harmless. Returns how many rows were inserted,
-- updated and left unchanged.
create function public.upsert_sources(p_rows jsonb)
returns table (inserted integer, updated integer, unchanged integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
  v_updated  integer;
  v_total    integer;
begin
  with incoming as (
    select *
      from jsonb_to_recordset(p_rows) as r(
        repository_id  bigint,
        type           text,
        github_id      bigint,
        number         integer,
        node_id        text,
        title          text,
        author         text,
        body           text,
        state          text,
        html_url       text,
        api_url        text,
        path           text,
        line           integer,
        in_reply_to_id bigint,
        created_at     timestamptz,
        updated_at     timestamptz,
        closed_at      timestamptz,
        fetched_by_job bigint
      )
  ),
  upserted as (
    insert into public.sources as s (
      repository_id, type, github_id, number, node_id, title, author, body, state,
      html_url, api_url, path, line, in_reply_to_id, created_at, updated_at, closed_at,
      fetched_by_job
    )
    select repository_id, type, github_id, number, node_id, title, author, body, state,
           html_url, api_url, path, line, in_reply_to_id, created_at, updated_at, closed_at,
           fetched_by_job
      from incoming
    on conflict (repository_id, type, github_id) do update set
      number         = excluded.number,
      node_id        = excluded.node_id,
      title          = excluded.title,
      author         = excluded.author,
      body           = excluded.body,
      state          = excluded.state,
      html_url       = excluded.html_url,
      api_url        = excluded.api_url,
      path           = excluded.path,
      line           = excluded.line,
      in_reply_to_id = excluded.in_reply_to_id,
      updated_at     = excluded.updated_at,
      closed_at      = excluded.closed_at,
      fetched_at     = now(),
      fetched_by_job = excluded.fetched_by_job
    where excluded.updated_at >= s.updated_at
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated
    from upserted;
  select count(*) into v_total from jsonb_array_elements(p_rows);
  return query select v_inserted, v_updated, v_total - v_inserted - v_updated;
end;
$$;

-- A job run records a summary of what it did (pages, records, bytes).
alter table public.jobs add column result jsonb;

alter table public.sources enable row level security;
grant select, insert, update, delete on table public.sources to service_role;
revoke all on table public.sources from anon, authenticated;
revoke execute on function public.upsert_sources(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_sources(jsonb) to service_role;
