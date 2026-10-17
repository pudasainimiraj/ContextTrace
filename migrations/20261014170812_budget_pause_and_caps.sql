-- CT-38: budget pauses are not attempts, and streams can be capped.
--
-- 1. A job parked because a budget refused its reservation (error_code budget_exhausted)
--    keeps its attempt count, so a daily pause can never exhaust MAX_ATTEMPTS.
-- 2. stream_checkpoints.capped_at records when a stream stopped at MAX_ITEMS_PER_STREAM;
--    the stream counts as complete, and coverage and search say that it was capped.

alter table public.stream_checkpoints add column capped_at timestamptz;

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
      -- error fields and next_attempt_at come from the update; the lease is released.
      -- A budget pause is not a failed attempt: the attempt that ran into it is given back.
      new.finished_at := null;
      new.lease_owner := null;
      new.lease_until := null;
      if new.error_code = 'budget_exhausted' then
        new.attempt := greatest(0, old.attempt - 1);
      end if;
    else
      new.finished_at := now();
      new.next_attempt_at := null;
      new.lease_owner := null;
      new.lease_until := null;
  end case;
  return new;
end;
$$;
