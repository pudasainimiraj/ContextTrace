-- retry_pending: the last attempt hit a transient error and the job waits for its
-- backoff. A delayed queue message, or the reconciliation cron, brings it back through
-- claim_job once next_attempt_at has passed.
alter table public.jobs
  add column next_attempt_at timestamptz,
  drop constraint jobs_state_check,
  add constraint jobs_state_check
    check (state in ('queued', 'running', 'retry_pending', 'succeeded', 'failed', 'cancelled')),
  drop constraint jobs_failed_has_error,
  add constraint jobs_failed_has_error
    check (state not in ('failed', 'retry_pending') or error_message is not null),
  add constraint jobs_retry_has_next_attempt
    check (state <> 'retry_pending' or next_attempt_at is not null);

create or replace function public.jobs_before_write()
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
    ('running', 'succeeded'), ('running', 'failed'), ('running', 'cancelled'), ('running', 'retry_pending'),
    ('retry_pending', 'running'), ('retry_pending', 'cancelled'),
    ('failed', 'queued')
  ) then
    raise exception 'invalid job state transition: % -> %', old.state, new.state
      using errcode = 'check_violation';
  end if;

  case new.state
    when 'running' then
      -- a new attempt starts clean; a later failure sets the error fields again
      new.attempt := old.attempt + 1;
      new.started_at := now();
      new.finished_at := null;
      new.next_attempt_at := null;
      new.error_code := null;
      new.error_message := null;
    when 'queued' then
      new.error_code := null;
      new.error_message := null;
      new.started_at := null;
      new.finished_at := null;
      new.next_attempt_at := null;
      new.lease_owner := null;
      new.lease_until := null;
    when 'retry_pending' then
      -- error fields and next_attempt_at come from the update; the lease is released
      new.finished_at := null;
      new.lease_owner := null;
      new.lease_until := null;
    else
      new.finished_at := now();
      new.next_attempt_at := null;
      new.lease_owner := null;
      new.lease_until := null;
  end case;
  return new;
end;
$$;

create or replace function public.jobs_after_write()
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
    values (new.id, old.state, new.state,
            case when new.state in ('failed', 'retry_pending') then new.error_message end);
  end if;
  return null;
end;
$$;

-- A queued or retry_pending job can be (re)enqueued.
create or replace function public.enqueue_job(p_job_id bigint)
returns setof public.jobs
language sql
security invoker
set search_path = ''
as $$
  update public.jobs
     set generation = generation + 1
   where id = p_job_id and state in ('queued', 'retry_pending')
  returning *;
$$;

-- A retry_pending job can be claimed once its backoff has passed.
create or replace function public.claim_job(
  p_job_id        bigint,
  p_generation    integer,
  p_owner         text,
  p_lease_seconds integer
)
returns setof public.jobs
language sql
security invoker
set search_path = ''
as $$
  update public.jobs as j
     set state       = 'running',
         lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempt     = case when j.state = 'running' and j.lease_owner is distinct from p_owner
                            then j.attempt + 1 else j.attempt end,
         started_at  = case when j.state = 'running' and j.lease_owner is distinct from p_owner
                            then now() else j.started_at end
   where j.id = p_job_id
     and j.generation = p_generation
     and (j.state = 'queued'
          or (j.state = 'retry_pending' and j.next_attempt_at <= now())
          or (j.state = 'running' and (j.lease_owner = p_owner or j.lease_until < now())))
  returning j.*;
$$;
