-- 027: Dashboard summary aggregates.
--
-- Monitoring dashboards should not download every checkin_records row every
-- few seconds. These RPCs keep the hot-path counters inside Postgres.
--
-- Only two attendance metrics exist: attended (has a check-in record) and
-- absent (expected but no record). Nothing else is computed or returned.

-- Return type changed (dropped still_in/left_count/total/pct) — must drop
-- before recreate; `create or replace` cannot change a return type.
drop function if exists public.get_event_dashboard_stats(uuid, text[], int, boolean, text[]);

create or replace function public.get_event_dashboard_stats(
  p_event_id uuid,
  p_member_ids text[] default null,
  p_total_expected int default null,
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
  with counts as (
    select
      coalesce(p_total_expected, coalesce(array_length(p_member_ids, 1), 0))::int as total,
      count(distinct r.member_id)::int as attended
    from public.checkin_records r
    where r.event_id = p_event_id
      and (
        case
          when p_member_ids is not null and array_length(p_member_ids, 1) is not null
            then r.member_id = any(p_member_ids)
          -- Whole-event count: restrict to the event-scope snapshot so the
          -- numerator matches the p_total_expected denominator (both come
          -- from event_scope_members). Legacy events without a snapshot
          -- count every record.
          when exists (
            select 1 from public.event_scope_members m
            where m.event_id = p_event_id
          )
            then exists (
              select 1 from public.event_scope_members m
              where m.event_id = p_event_id and m.member_id = r.member_id
            )
          else true
        end
      )
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
  public.get_event_dashboard_stats(uuid, text[], int, boolean, text[]),
  public.get_risky_checkin_count(uuid)
  to anon, authenticated;
