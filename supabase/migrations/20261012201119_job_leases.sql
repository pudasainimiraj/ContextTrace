-- Leases: a claimed job belongs to one owner until lease_until. A claim is atomic,
-- idempotent for the same owner and generation, and returns no row for a stale or
-- duplicate delivery. The trigger clears the lease whenever a job leaves running.
alter table public.jobs
  add column lease_owner text,
  add column lease_until timestamptz;

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
      new.lease_owner := null;
      new.lease_until := null;
    else
      new.finished_at := now();
      new.lease_owner := null;
      new.lease_until := null;
  end case;
  return new;
end;
$$;

-- Atomic claim for a delivered message. Succeeds when the generation matches and the
-- job is queued, already leased by the same owner (a redelivery; the lease is extended),
-- or leased by an owner whose lease has expired (a takeover, counted as a new attempt).
-- Returns no row otherwise, so a duplicate or stale delivery does no work.
create function public.claim_job(
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
          or (j.state = 'running' and (j.lease_owner = p_owner or j.lease_until < now())))
  returning j.*;
$$;

revoke execute on function public.claim_job(bigint, integer, text, integer) from public, anon, authenticated;
grant execute on function public.claim_job(bigint, integer, text, integer) to service_role;
