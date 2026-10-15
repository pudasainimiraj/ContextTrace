-- Reconciliation for the cron trigger. Returns every job that needs a fresh queue
-- message: running jobs whose lease expired (moved to retry_pending, or failed once
-- attempt reaches p_max_attempts), retry_pending jobs that became due more than
-- p_grace_seconds ago, and queued jobs untouched for longer than p_grace_seconds.
-- Jobs it fails are returned too, so the caller can report them. p_repository_id
-- limits the sweep to one repository.
create function public.reconcile_jobs(
  p_max_attempts  integer,
  p_grace_seconds integer,
  p_repository_id bigint default null
)
returns setof public.jobs
language sql
security invoker
set search_path = ''
as $$
  with expired as (
    update public.jobs
       set state           = case when attempt >= p_max_attempts then 'failed' else 'retry_pending' end,
           error_code      = 'lease_expired',
           error_message   = 'lease expired without a result',
           next_attempt_at = case when attempt >= p_max_attempts then null else now() end
     where state = 'running'
       and lease_until < now()
       and (p_repository_id is null or repository_id = p_repository_id)
     returning *
  )
  select * from expired
  union all
  select * from public.jobs
   where (p_repository_id is null or repository_id = p_repository_id)
     and ((state = 'retry_pending' and next_attempt_at < now() - make_interval(secs => p_grace_seconds))
       or (state = 'queued' and updated_at < now() - make_interval(secs => p_grace_seconds)));
$$;

revoke execute on function public.reconcile_jobs(integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.reconcile_jobs(integer, integer, bigint) to service_role;
