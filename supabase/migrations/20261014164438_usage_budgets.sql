-- CT-37: usage budgets with atomic reservations.
--
-- Every metered call reserves against a budget row before it acts, so the service cannot
-- spend past 80% of a free allowance. Rows are keyed by scope and resource: production uses
-- the scope 'global'; tests seed their own scope so parallel files never share a row.
--
-- period   hour | day | month: `used` resets when the window that started at window_start
--          has passed (UTC boundaries). gauge: `used` is a measured value (storage) set by
--          the cron; it never resets.
-- unit     ai_neurons_milli: thousandths of a Workers AI neuron (1 input token = 1.841)
--          github_requests_*: REST requests (auth: with a token, anon: without)
--          queue_ops: Queue operations (a message costs about 3: write, read, delete)
--          searches, registrations: API calls accepted
--          db_egress_bytes: bytes read from Supabase, best effort (Content-Length)
--          storage_bytes: pg_database_size

create table public.usage_budgets (
  scope        text        not null default 'global',
  resource     text        not null,
  period       text        not null check (period in ('hour', 'day', 'month', 'gauge')),
  limit_amount bigint      not null check (limit_amount >= 0),
  used         bigint      not null default 0 check (used >= 0),
  window_start timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (scope, resource)
);

alter table public.usage_budgets enable row level security;
grant select, insert, update, delete on table public.usage_budgets to service_role;
revoke all on table public.usage_budgets from anon, authenticated;

-- 80% of the free allowances (Workers AI 10,000 neurons/day; GitHub 5,000/h with a token,
-- 60/h without; Queues 10,000 operations/day; Supabase 500 MB and 5 GB egress/month).
insert into public.usage_budgets (scope, resource, period, limit_amount, window_start) values
  ('global', 'ai_neurons_milli',     'day',   8000000,    date_trunc('day', now())),
  ('global', 'github_requests_auth', 'hour',  4000,       date_trunc('hour', now())),
  ('global', 'github_requests_anon', 'hour',  48,         date_trunc('hour', now())),
  ('global', 'queue_ops',            'day',   8000,       date_trunc('day', now())),
  ('global', 'searches',             'day',   20000,      date_trunc('day', now())),
  ('global', 'registrations',        'day',   50,         date_trunc('day', now())),
  ('global', 'db_egress_bytes',      'month', 4000000000, date_trunc('month', now())),
  ('global', 'storage_bytes',        'gauge', 400000000,  now());

create or replace function public.budget_window_start(p_window text, p_at timestamptz)
returns timestamptz
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_window
    when 'hour'  then date_trunc('hour', p_at at time zone 'UTC') at time zone 'UTC'
    when 'day'   then date_trunc('day', p_at at time zone 'UTC') at time zone 'UTC'
    when 'month' then date_trunc('month', p_at at time zone 'UTC') at time zone 'UTC'
    else p_at
  end;
$$;

create or replace function public.budget_window_end(p_window text, p_start timestamptz)
returns timestamptz
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_window
    when 'hour'  then p_start + interval '1 hour'
    when 'day'   then p_start + interval '1 day'
    when 'month' then p_start + interval '1 month'
    else null
  end;
$$;

-- One row lock per reservation: concurrent callers serialise on the resource, and the one
-- that would cross the limit is refused with the usage unchanged. A window that has passed
-- is reset before the check, and window_start always lands on the current window's UTC
-- boundary. Returns the decision, the new usage and when the window ends.
create or replace function public.reserve_budget(p_scope text, p_resource text, p_amount bigint)
returns table (allowed boolean, used bigint, limit_amount bigint, resets_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r         public.usage_budgets%rowtype;
  v_start   timestamptz;
  v_allowed boolean;
begin
  if p_amount < 0 then
    raise exception 'a reservation cannot be negative (% for %)', p_amount, p_resource using errcode = 'check_violation';
  end if;
  select * into r from public.usage_budgets b where b.scope = p_scope and b.resource = p_resource for update;
  if not found then
    raise exception 'unknown budget %/%', p_scope, p_resource using errcode = 'no_data_found';
  end if;
  if r.period <> 'gauge' then
    v_start := public.budget_window_start(r.period, now());
    if r.window_start < v_start then
      r.used := 0;
    end if;
    r.window_start := v_start;
  end if;
  v_allowed := r.used + p_amount <= r.limit_amount;
  if v_allowed then
    r.used := r.used + p_amount;
  end if;
  update public.usage_budgets b
     set used = r.used, window_start = r.window_start, updated_at = now()
   where b.scope = p_scope and b.resource = p_resource;
  return query select v_allowed, r.used, r.limit_amount, public.budget_window_end(r.period, r.window_start);
end;
$$;

-- Adjusts usage once the real cost is known (Workers AI reports its own token count), or
-- records a measured gauge. Never below zero; a passed window is reset first.
create or replace function public.settle_budget(p_scope text, p_resource text, p_delta bigint)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r       public.usage_budgets%rowtype;
  v_start timestamptz;
begin
  select * into r from public.usage_budgets b where b.scope = p_scope and b.resource = p_resource for update;
  if not found then
    raise exception 'unknown budget %/%', p_scope, p_resource using errcode = 'no_data_found';
  end if;
  if r.period <> 'gauge' then
    v_start := public.budget_window_start(r.period, now());
    if r.window_start < v_start then
      r.used := 0;
    end if;
    r.window_start := v_start;
  end if;
  r.used := greatest(0, r.used + p_delta);
  update public.usage_budgets b
     set used = r.used, window_start = r.window_start, updated_at = now()
   where b.scope = p_scope and b.resource = p_resource;
  return r.used;
end;
$$;

create or replace function public.set_budget_gauge(p_scope text, p_resource text, p_value bigint)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.usage_budgets b
     set used = greatest(0, p_value), window_start = now(), updated_at = now()
   where b.scope = p_scope and b.resource = p_resource and b.period = 'gauge';
$$;

-- The budgets as they stand now: a passed window reads as empty without being written.
create or replace function public.budget_status(p_scope text)
returns table (resource text, period text, used bigint, limit_amount bigint, window_start timestamptz, resets_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select b.resource,
         b.period,
         case when b.period <> 'gauge' and b.window_start < public.budget_window_start(b.period, now()) then 0 else b.used end,
         b.limit_amount,
         case when b.period = 'gauge' then b.window_start else public.budget_window_start(b.period, now()) end,
         public.budget_window_end(b.period, public.budget_window_start(b.period, now()))
    from public.usage_budgets b
   where b.scope = p_scope
   order by b.resource;
$$;

create or replace function public.database_size()
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.pg_database_size(pg_catalog.current_database());
$$;

revoke all on function public.budget_window_start(text, timestamptz), public.budget_window_end(text, timestamptz),
  public.reserve_budget(text, text, bigint), public.settle_budget(text, text, bigint), public.set_budget_gauge(text, text, bigint),
  public.budget_status(text), public.database_size() from public, anon, authenticated;
grant execute on function public.budget_window_start(text, timestamptz), public.budget_window_end(text, timestamptz),
  public.reserve_budget(text, text, bigint), public.settle_budget(text, text, bigint), public.set_budget_gauge(text, text, bigint),
  public.budget_status(text), public.database_size() to service_role;
