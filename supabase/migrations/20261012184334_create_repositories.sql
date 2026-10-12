-- Repositories registered for tracing. Keyed by GitHub's numeric repository id,
-- which is stable across renames and transfers. full_name is the last canonical
-- "owner/name" seen from GitHub and is refreshed on every submission. It is
-- deliberately not unique: a renamed repository's old name can later belong to a
-- different repository with a different id, and both rows must coexist.
create table public.repositories (
  id               bigint      primary key,
  owner            text        not null,
  name             text        not null,
  full_name        text        not null,
  status           text        not null default 'registered',
  submission_count integer     not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index repositories_full_name_idx on public.repositories (full_name);

-- Only the Worker, which uses the secret key (service_role), may touch this table.
-- RLS is on with no policies, so anon and authenticated clients get nothing.
alter table public.repositories enable row level security;
grant select, insert, update, delete on table public.repositories to service_role;
revoke all on table public.repositories from anon, authenticated;

-- One atomic upsert. A repeated submission refreshes the name columns and bumps
-- submission_count instead of inserting a second row, so a concurrent double
-- submit yields exactly one row with submission_count = 1.
create function public.register_repository(
  p_id        bigint,
  p_owner     text,
  p_name      text,
  p_full_name text
)
returns setof public.repositories
language sql
security invoker
set search_path = ''
as $$
  insert into public.repositories as r (id, owner, name, full_name)
  values (p_id, p_owner, p_name, p_full_name)
  on conflict (id) do update set
    owner            = excluded.owner,
    name             = excluded.name,
    full_name        = excluded.full_name,
    updated_at       = now(),
    submission_count = r.submission_count + 1
  returning r.*;
$$;

revoke execute on function public.register_repository(bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.register_repository(bigint, text, text, text) to service_role;
