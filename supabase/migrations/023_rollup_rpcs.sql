-- 023: Server-side rollups.
--
-- Replaces the fetch-all-rows-then-reduce-in-JS client paths:
--   • listDefaulted        → get_defaulted_profiles (NOT EXISTS anti-join)
--   • getRiskyCheckIns     → get_risky_checkin_member_ids (GROUP BY/HAVING)
--   • getAttendanceStats   → get_member_attendance_stats (aggregates)
--   • listSpecialGroups    → special_groups_with_counts view (LEFT JOIN count)
--
-- get_defaulted_profiles deliberately returns an explicit column list rather
-- than SETOF member_profiles: it must keep working after 024 revokes anon
-- SELECT on member_profiles.face_descriptor (invoker-rights function reading
-- a revoked column would fail; a security-definer one would leak it).

-- Profiles from the candidate set that have NO checkin_record for the event.
-- The candidate list is passed in because eligibility (scope snapshot vs live
-- graph fallback vs allowed_roles) is resolved by the client pipeline.
create or replace function public.get_defaulted_profiles(p_event_id uuid, p_member_ids text[])
returns table (
  id text, email text, title text, first_name text, last_name text,
  phone text, picture_url text, roles text[],
  bacenta_id text, bacenta_name text,
  governorship_id text, governorship_name text,
  council_id text, council_name text,
  stream_id text, stream_name text,
  campus_id text, campus_name text,
  oversight_id text, oversight_name text,
  denomination_id text, denomination_name text,
  scope_ids jsonb, updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    p.id, p.email, p.title, p.first_name, p.last_name,
    p.phone, p.picture_url, p.roles,
    p.bacenta_id, p.bacenta_name,
    p.governorship_id, p.governorship_name,
    p.council_id, p.council_name,
    p.stream_id, p.stream_name,
    p.campus_id, p.campus_name,
    p.oversight_id, p.oversight_name,
    p.denomination_id, p.denomination_name,
    p.scope_ids, p.updated_at
  from public.member_profiles p
  where p.id = any (p_member_ids)
    and not exists (
      select 1 from public.checkin_records r
      where r.event_id = p_event_id and r.member_id = p.id
    );
$$;

-- Members whose device fingerprint appears on more than one non-MANUAL
-- check-in for the event.
create or replace function public.get_risky_checkin_member_ids(p_event_id uuid)
returns setof text
language sql
stable
set search_path = public
as $$
  select r.member_id
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

-- Lifetime attendance aggregates for one member.
create or replace function public.get_member_attendance_stats(p_member_id text)
returns table (
  scoped_count int,
  attended_count int,
  late_count int,
  last_check_in timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    (select count(*)::int from public.event_scope_members s where s.member_id = p_member_id),
    (select count(*)::int from public.checkin_records r where r.member_id = p_member_id),
    (select count(*)::int from public.checkin_records r where r.member_id = p_member_id and r.is_late),
    (select max(r.checked_in_at) from public.checkin_records r where r.member_id = p_member_id);
$$;

-- Special groups with their member counts in one query.
-- security_invoker so the view respects the underlying tables' RLS/grants
-- (a plain view would execute as its owner and bypass them).
create or replace view public.special_groups_with_counts
with (security_invoker = true) as
select
  g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at,
  coalesce(c.cnt, 0)::int as member_count
from public.special_groups g
left join (
  select group_id, count(*) as cnt
  from public.special_group_members
  group by group_id
) c on c.group_id = g.id;
