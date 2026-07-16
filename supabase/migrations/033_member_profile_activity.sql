-- Track current Hineni eligibility from Graph leader/admin relationships
-- without deleting local identity or historical check-in data.

alter table public.member_profiles
  add column if not exists is_active boolean not null default true;

create index if not exists member_profiles_active_idx
  on public.member_profiles (is_active)
  where is_active;

comment on column public.member_profiles.is_active is
  'True while the source Graph Member has a current Hineni leader/admin relationship. Ineligible rows are retained for attendance history.';

-- Migration 024 uses a column allow-list for anon reads.
grant select (is_active) on public.member_profiles to anon, authenticated;

-- Reconcile members without current leader/admin relationships atomically. Past event snapshots
-- remain intact for reports; open/future snapshots are pruned so inactive
-- members cannot check in and no longer inflate current attendance totals.
create or replace function public.reconcile_inactive_member_profiles(p_member_ids text[])
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  if coalesce(array_length(p_member_ids, 1), 0) = 0 then
    return 0;
  end if;

  update public.member_profiles
     set is_active = false,
         updated_at = now()
   where id = any(p_member_ids)
     and is_active;
  get diagnostics v_updated = row_count;

  delete from public.event_scope_members esm
   using public.checkin_events e
   where esm.event_id = e.id
     and esm.member_id = any(p_member_ids)
     and e.status <> 'ENDED';

  return v_updated;
end;
$$;

grant execute on function public.reconcile_inactive_member_profiles(text[]) to anon, authenticated;

-- Existing entry-gate callers all flow through this resolver. Requiring the
-- cached Graph profile to be active closes both self-check-in and email-bridge
-- paths without rewriting the larger submit_checkin function.
create or replace function public.resolve_event_snapshot_member(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null
)
returns table (
  snapshot_member_id text,
  profile_roles      text[]
)
language sql
security definer
set search_path = public
as $$
  select
    esm.member_id,
    coalesce(p_graph.roles, array[]::text[])
  from public.event_scope_members esm
  join public.member_profiles p_graph on p_graph.id = esm.member_id
  where esm.event_id = p_event_id
    and p_graph.is_active
    and (
      esm.member_id = any(coalesce(p_member_ids, array[]::text[]))
      or (
        p_email is not null
        and lower(coalesce(p_graph.email, '')) = lower(p_email)
      )
      or exists (
        select 1
        from unnest(coalesce(p_member_ids, array[]::text[])) as mid(member_id)
        join public.member_profiles p_auth on p_auth.id = mid.member_id
        where p_email is not null
          and lower(coalesce(p_auth.email, '')) = lower(p_email)
      )
    )
  order by esm.member_id
  limit 1;
$$;
