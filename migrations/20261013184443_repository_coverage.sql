-- CT-33: one read of everything the coverage report needs for a repository.
create or replace function public.repository_coverage(p_repository_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'sources', (
      select coalesce(jsonb_object_agg(t.type, t.n), '{}'::jsonb)
        from (select s.type, count(*) as n from public.sources s where s.repository_id = p_repository_id group by s.type) t
    ),
    'documents', (select count(*) from public.documents d where d.repository_id = p_repository_id),
    'passages', (select count(*) from public.passages p where p.repository_id = p_repository_id),
    'embedded', (select count(*) from public.passages p where p.repository_id = p_repository_id and p.index_state = 'active'),
    'pending', (
      select count(*) from public.passages p
       where p.repository_id = p_repository_id
         and p.index_state = 'pending_index'
         and btrim(p.text) <> ''
         and p.token_count <= 512
    ),
    'jobs', (
      select coalesce(jsonb_object_agg(j.state, j.n), '{}'::jsonb)
        from (
          select j.state, count(*) as n from public.jobs j
           where j.repository_id = p_repository_id and j.state in ('queued', 'running', 'retry_pending', 'failed')
           group by j.state
        ) j
    ),
    'streams', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.stream), '[]'::jsonb)
        from public.stream_checkpoints c where c.repository_id = p_repository_id
    )
  );
$$;

revoke all on function public.repository_coverage(bigint) from public, anon, authenticated;
grant execute on function public.repository_coverage(bigint) to service_role;
