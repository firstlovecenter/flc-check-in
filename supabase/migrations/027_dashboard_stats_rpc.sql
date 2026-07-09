-- 027: Dashboard summary aggregates.
--
-- Monitoring dashboards should not download every checkin_records row every
-- few seconds. These RPCs keep the hot-path counters inside Postgres.
--
-- Only two attendance metrics exist: attended (has a check-in record) and
-- absent (expected but no record). Nothing else is computed or returned.

-- Signature/behavior changed — must drop before recreate.
drop function if exists public.get_event_dashboard_stats(uuid, text[], int, boolean, text[]);
drop function if exists public.get_event_dashboard_stats(uuid, text[], int, text[], boolean, text[]);

-- Both metrics are computed over ONE population so the dashboard headline
-- always matches the drill-down lists:
--   • p_member_ids set   → exactly those members (drill-down / viewer slice).
--   • p_member_ids null  → the event-scope snapshot, filtered by
--     p_allowed_roles against member_profiles.roles — the same definition
--     the client uses to build its "eligible" list.
-- p_total_expected is legacy (older deployed clients still pass it) and is
-- ignored: the denominator is always the population size.
create or replace function public.get_event_dashboard_stats(
  p_event_id uuid,
  p_member_ids text[] default null,
  p_total_expected int default null,
  p_allowed_roles text[] default null,
  p_not_started boolean default false,
  p_viewer_member_ids text[] default '{}'
)
returns table (
  attended int,
  absent int,
  viewer_checked_in boolean,
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with population as (
    select distinct u.member_id
    from unnest(coalesce(p_member_ids, '{}')) as u(member_id)
    where p_member_ids is not null and array_length(p_member_ids, 1) is not null
    union all
    select m.member_id
    from public.event_scope_members m
    where (p_member_ids is null or array_length(p_member_ids, 1) is null)
      and m.event_id = p_event_id
      and (
        p_allowed_roles is null
        or exists (
          select 1 from public.member_profiles p
          where p.id = m.member_id
            and p.roles && p_allowed_roles
        )
      )
  ),
  counts as (
    select
      count(*)::int as total,
      count(*) filter (where exists (
        select 1 from public.checkin_records r
        where r.event_id = p_event_id
          and r.member_id = pop.member_id
      ))::int as attended
    from population pop
  )
  select
    counts.attended,
    case
      when p_not_started then 0
      else greatest(0, counts.total - counts.attended)
    end as absent,
    exists (
      select 1
      from public.checkin_records r
      where r.event_id = p_event_id
        and r.member_id = any(coalesce(p_viewer_member_ids, '{}'))
    ) as viewer_checked_in,
    now() as updated_at
  from counts;
$$;

create or replace function public.get_risky_checkin_count(p_event_id uuid)
returns int
language sql
stable
set search_path = public
as $$
  select count(distinct r.member_id)::int
  from public.checkin_records r
  where r.event_id = p_event_id
    and r.method <> 'MANUAL'
    and coalesce(r.device_fingerprint, '') <> ''
    and r.device_fingerprint in (
      select r2.device_fingerprint
      from public.checkin_records r2
      where r2.event_id = p_event_id
        and r2.method <> 'MANUAL'
        and coalesce(r2.device_fingerprint, '') <> ''
      group by r2.device_fingerprint
      having count(*) > 1
    );
$$;

grant execute on function
  public.get_event_dashboard_stats(uuid, text[], int, text[], boolean, text[]),
  public.get_risky_checkin_count(uuid)
  to anon, authenticated;
