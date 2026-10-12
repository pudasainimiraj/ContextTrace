-- Each enqueue bumps generation, and the queue message carries the value it was sent
-- with, so a consumer can tell a stale duplicate from the current delivery.
alter table public.jobs add column generation integer not null default 0;

-- Only a queued job can be enqueued; returns no row otherwise.
create function public.enqueue_job(p_job_id bigint)
returns setof public.jobs
language sql
security invoker
set search_path = ''
as $$
  update public.jobs
     set generation = generation + 1
   where id = p_job_id and state = 'queued'
  returning *;
$$;

revoke execute on function public.enqueue_job(bigint) from public, anon, authenticated;
grant execute on function public.enqueue_job(bigint) to service_role;
