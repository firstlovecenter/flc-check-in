-- 039: Collapse scoped event listing from N HTTP requests to one.
--
-- The bug this fixes
-- ------------------
-- listAllEventsForFocusedScope expanded the focused scope to its full
-- descendant set on the CLIENT, then queried events through PostgREST with OR
-- filters batched 40 scopes at a time, 5 concurrent (SCOPE_OR_BATCH_SIZE /
-- BATCH_CONCURRENCY in supabaseCheckins.ts).
--
-- For a denomination-level focus that is ~3,000 scopes → ~77 HTTP requests in
-- ~16 sequential rounds, each carrying a 40-clause OR filter, to find a handful
-- of events. With a 12s bounded fetch and a retry, that either crawls or throws.
--
-- The user-visible symptom was counter-intuitive and hard to diagnose: a HIGHER
-- role saw FEWER events than a lower one. A stream focus expands to ~200 scopes
-- (6 batches) and completed; a denomination focus needed 77 and did not. So a
-- denomination admin could not see a stream event that a stream admin saw fine.
--
-- The join belongs in Postgres. get_descendant_scopes already computes the
-- subtree; joining checkin_events against it is one indexed pass — measured at
-- ~19ms for the full denomination subtree.
--
-- Two design notes
-- ----------------
-- 1. MATERIALIZED on the descendant CTE is deliberate. get_descendant_scopes is
--    a recursive walk referenced twice (to build the scope set, and to report
--    whether the cache resolved it). Without the hint the planner may inline it
--    and run the walk twice.
--
-- 2. `descendants_resolved` is returned so the UI can tell "no events" apart
--    from "sub-scopes not resolved yet". get_descendant_scopes returns NOTHING
--    when the hierarchy cache cannot prove the subtree is fully synced
--    (migration 022's completeness guard), and the focused scope is unioned in
--    unconditionally so a cold cache degrades to "your own scope's events"
--    rather than to an empty list. Silently showing fewer events is
--    indistinguishable from having none — which is exactly how this bug hid.

drop function if exists public.list_events_for_scope(text, text, text[], boolean, int);

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
  with desc_scopes as materialized (
    select d.level, d.id from public.get_descendant_scopes(p_level, p_id) d
  ),
  scope_set as (
    select level, id from desc_scopes
    union
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
