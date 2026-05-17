-- 010_geo_checkout_grace.sql
--
-- Add a grace period for geo-based auto-checkout. Before this migration,
-- `report_member_location` checked the member out the instant their GPS
-- showed them outside the fence — a single bad reading (or stepping out
-- for a bathroom break) ended their attendance.
--
-- Policy: member must be continuously outside the fence for >= 20 minutes
-- before the system auto-checks them out. A single "inside" reading resets
-- the grace timer.
--
-- Implementation:
--   1. Add outside_since column to checkin_records.
--   2. Rewrite report_member_location:
--        - If inside  → clear outside_since (back in the fence).
--        - If outside → set outside_since to now() the first time we see
--          them out; on subsequent "outside" reports, check if the grace
--          period has elapsed and check them out if so.
--   3. Return enough info for the client to render a "you appear to be
--      outside the fence; you'll be checked out in N minutes" notice.

alter table public.checkin_records
  add column if not exists outside_since timestamptz;

-- Grace period — exposed as a constant in the function body so admins
-- can adjust by replacing the function. If the rule ever needs to be
-- per-event, promote this to a column on checkin_events.
create or replace function public.report_member_location(
  p_event_id  uuid,
  p_member_id text,
  p_lat       double precision,
  p_lng       double precision
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inside         boolean;
  v_grace_minutes  int := 20;
  v_outside_since  timestamptz;
  v_was_checked_out boolean := false;
  v_minutes_left   int;
begin
  v_inside := public.point_in_event_geofence(p_event_id, p_lat, p_lng);

  if v_inside then
    -- Back inside: clear any pending outside-timer.
    update public.checkin_records
       set outside_since = null
     where event_id = p_event_id
       and member_id = p_member_id
       and checked_out_at is null
       and outside_since is not null;
    return jsonb_build_object('inside_fence', true, 'checked_out', false);
  end if;

  -- Outside the fence. Read the existing outside_since (if any).
  select outside_since into v_outside_since
    from public.checkin_records
   where event_id = p_event_id
     and member_id = p_member_id
     and checked_out_at is null
   limit 1;

  if v_outside_since is null then
    -- First "outside" reading — start the grace timer.
    update public.checkin_records
       set outside_since = now()
     where event_id = p_event_id
       and member_id = p_member_id
       and checked_out_at is null;
    return jsonb_build_object(
      'inside_fence', false,
      'checked_out', false,
      'outside_since', now(),
      'minutes_left', v_grace_minutes
    );
  end if;

  -- Already outside — check if the grace period has elapsed.
  if now() - v_outside_since >= make_interval(mins => v_grace_minutes) then
    update public.checkin_records
       set checked_out_at  = now(),
           auto_checked_out = true
     where event_id = p_event_id
       and member_id = p_member_id
       and checked_out_at is null;
    if found then v_was_checked_out := true; end if;
    return jsonb_build_object('inside_fence', false, 'checked_out', v_was_checked_out);
  end if;

  -- Still within grace period.
  v_minutes_left := greatest(
    0,
    v_grace_minutes - floor(extract(epoch from (now() - v_outside_since)) / 60)::int
  );
  return jsonb_build_object(
    'inside_fence', false,
    'checked_out', false,
    'outside_since', v_outside_since,
    'minutes_left', v_minutes_left
  );
end;
$$;
