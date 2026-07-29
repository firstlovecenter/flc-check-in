-- 040: A scope must see events ABOVE it, not just below.
--
-- Migration 039 moved the scope fan-out server-side but walked DESCENDANTS
-- only. That lost the ancestor direction, which the original buildScopeOrFilter
-- had and documented:
--
--     "the ANCESTOR chain of each of those churches — a leader inside a stream
--      is an expected attendee of that stream's events, so events at ancestor
--      scopes of the church they lead are visible."
--
-- Symptom: a stream admin saw only their own stream event and missed the
-- campus-level event they were an attendee of — the mirror image of the bug 039
-- fixed. It only became visible because the app now defaults to ONE focused
-- role instead of a union of all of them, so the focused path became the path
-- everyone hits.
--
-- Correct visibility for a focused scope is three-way:
--   • the scope itself
--   • its DESCENDANTS  — things it oversees
--   • its ANCESTORS    — events it is an expected attendee of
--
-- Both walks are bounded at depth 10; the tree is at most 7 levels deep, so the
-- guard is purely a cycle brake.

create or replace function public.list_events_for_scope(
  p_level                 text,
  p_id                    text,
  p_statuses              text[] default null,
  p_exclude_special_group boolean default true,
  p_limit                 int     default 200
)
returns table (
  id uuid, name text, event_type text, status text,
  scope_level text, scope_church_id text, scope_church_name text,
  venue_name text, starts_at timestamptz, ends_at timestamptz,
  grace_period_min int, auto_checkout_min int,
  allowed_check_in_methods text[], allowed_roles text[],
  geofence_type text, geofence_center_lat double precision,
  geofence_center_lng double precision, geofence_radius_m int,
  created_by_id text, created_by_name text, created_at timestamptz,
  series_id uuid, series_index int, is_public boolean,
  descendants_resolved boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive
  desc_scopes as materialized (
    select d.level, d.id from public.get_descendant_scopes(p_level, p_id) d
  ),
  -- Self + every ancestor, walked through church_hierarchy parent links.
  anc as (
    select h.id, h.level, h.parent_id, 0 as depth
      from public.church_hierarchy h
     where h.id = p_id and h.level = p_level
    union all
    select p.id, p.level, p.parent_id, a.depth + 1
      from public.church_hierarchy p
      join anc a on p.id = a.parent_id
     where a.depth < 10
  ),
  scope_set as (
    select level, id from desc_scopes
    union
    select level, id from anc
    union
    -- Unconditional: guarantees the focused scope survives a cold cache, where
    -- neither walk can return anything.
    select p_level, p_id
  )
  select
    e.id, e.name, e.event_type, e.status,
    e.scope_level, e.scope_church_id, e.scope_church_name,
    e.venue_name, e.starts_at, e.ends_at,
    e.grace_period_min, e.auto_checkout_min,
    e.allowed_check_in_methods, e.allowed_roles,
    e.geofence_type, e.geofence_center_lat,
    e.geofence_center_lng, e.geofence_radius_m,
    e.created_by_id, e.created_by_name, e.created_at,
    e.series_id, e.series_index, e.is_public,
    (select count(*) > 0 from desc_scopes) as descendants_resolved
  from public.checkin_events e
  join scope_set s
    on s.level = e.scope_level and s.id = e.scope_church_id
  where (not p_exclude_special_group or e.scope_level <> 'special_group')
    and (p_statuses is null or e.status = any(p_statuses))
  order by e.starts_at desc
  limit greatest(p_limit, 1);
$$;

-- NOTE: qr_secret is deliberately absent from the projection. See migration 038 —
-- shipping it with an event listing lets any client mint valid rotating codes.

grant execute on function
  public.list_events_for_scope(text, text, text[], boolean, int)
  to anon, authenticated;
