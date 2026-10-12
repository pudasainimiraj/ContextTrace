-- Background work per repository, with audit and error fields. State changes are
-- validated by jobs_before_write and recorded in job_transitions by jobs_after_write.
-- States: queued -> running -> succeeded | failed | cancelled; failed -> queued retries.
create table public.jobs (
  id            bigint generated always as identity primary key,
  repository_id bigint not null references public.repositories (id) on delete cascade,
  kind          text not null,              -- e.g. fetch_issues, fetch_discussions, chunk_passages
  state         text not null default 'queued'
                check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt       integer not null default 0, -- how many times the job entered running
  -- error fields: required when failed, cleared when the job is queued again
  error_code    text,
  error_message text,
  -- audit fields
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  constraint jobs_failed_has_error check (state <> 'failed' or error_message is not null)
);

create index jobs_repository_id_state_idx on public.jobs (repository_id, state);

-- Audit log: one row per state change, including the initial queued state.
create table public.job_transitions (
  id         bigint generated always as identity primary key,
  job_id     bigint not null references public.jobs (id) on delete cascade,
  from_state text,                          -- null for the initial row
  to_state   text not null,
  note       text,                          -- the error message when a job fails
  created_at timestamptz not null default now()
);

create index job_transitions_job_id_idx on public.job_transitions (job_id, id);

-- Where incremental fetching left off, per repository and stream.
create table public.stream_checkpoints (
  repository_id bigint not null references public.repositories (id) on delete cascade,
  stream        text not null,              -- issues, pull_requests, discussions
  cursor        text,                       -- opaque position: a GraphQL endCursor or a REST "since" value
  last_item_at  timestamptz,                -- updated_at of the newest item seen
  job_id        bigint references public.jobs (id) on delete set null, -- job that wrote the checkpoint
  updated_at    timestamptz not null default now(),
  primary key (repository_id, stream)
);

-- Validate the transition and keep the audit and error fields consistent.
create function public.jobs_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'queued' then
      raise exception 'a new job must start as queued, not %', new.state
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  new.updated_at := now();
  if new.state = old.state then
    return new;
  end if;

  if (old.state, new.state) not in (
    ('queued', 'running'), ('queued', 'cancelled'),
    ('running', 'succeeded'), ('running', 'failed'), ('running', 'cancelled'),
    ('failed', 'queued')
  ) then
    raise exception 'invalid job state transition: % -> %', old.state, new.state
      using errcode = 'check_violation';
  end if;

  case new.state
    when 'running' then
      new.attempt := old.attempt + 1;
      new.started_at := now();
      new.finished_at := null;
    when 'queued' then
      new.error_code := null;
      new.error_message := null;
      new.started_at := null;
      new.finished_at := null;
    else
      new.finished_at := now();
  end case;
  return new;
end;
$$;

-- Record the change after the row exists, so the foreign key holds.
create function public.jobs_after_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.job_transitions (job_id, from_state, to_state)
    values (new.id, null, new.state);
  elsif new.state <> old.state then
    insert into public.job_transitions (job_id, from_state, to_state, note)
    values (new.id, old.state, new.state, case when new.state = 'failed' then new.error_message end);
  end if;
  return null;
end;
$$;

create trigger jobs_before_write
  before insert or update on public.jobs
  for each row execute function public.jobs_before_write();

create trigger jobs_after_write
  after insert or update on public.jobs
  for each row execute function public.jobs_after_write();

create function public.stream_checkpoints_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger stream_checkpoints_touch
  before update on public.stream_checkpoints
  for each row execute function public.stream_checkpoints_touch();

-- Only the Worker, which uses the secret key (service_role), may touch these tables.
-- RLS is on with no policies, so anon and authenticated clients get nothing.
alter table public.jobs enable row level security;
alter table public.job_transitions enable row level security;
alter table public.stream_checkpoints enable row level security;
grant select, insert, update, delete on table public.jobs, public.job_transitions, public.stream_checkpoints to service_role;
grant usage, select on sequence public.jobs_id_seq, public.job_transitions_id_seq to service_role;
revoke all on table public.jobs, public.job_transitions, public.stream_checkpoints from anon, authenticated;
revoke all on sequence public.jobs_id_seq, public.job_transitions_id_seq from anon, authenticated;
revoke execute on function public.jobs_before_write(), public.jobs_after_write(), public.stream_checkpoints_touch() from public, anon, authenticated;
