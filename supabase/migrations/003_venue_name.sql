-- ════════════════════════════════════════════════════════════════════════════
--  Add venue_name to checkin_events
--
--  Run in Supabase SQL Editor. Idempotent — safe to re-run.
--  After running this, the app's Create Event / Edit Event forms will
--  include a "Venue / Location name" field (e.g. "First Love Center").
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Add column ──────────────────────────────────────────────────────────
alter table public.checkin_events
  add column if not exists venue_name text;


-- ─── 2. Replace create_checkin_event with updated signature ─────────────────
--  Old signature (20 params — drop by exact type list)
drop function if exists public.create_checkin_event(
  text, text, text, text, text,
  timestamptz, timestamptz, int, int,
  text[], text[],
  text, double precision, double precision, int, jsonb,
  text, text, text, text
);

create or replace function public.create_checkin_event(
  p_name                     text,
  p_event_type               text,
  p_scope_level              text,
  p_scope_church_id          text,
  p_scope_church_name        text,
  p_venue_name               text,
  p_starts_at                timestamptz,
  p_ends_at                  timestamptz,
  p_grace_period_min         int,
  p_auto_checkout_min        int,
  p_allowed_check_in_methods text[],
  p_allowed_roles            text[],
  p_geofence_type            text,
  p_geofence_center_lat      double precision,
  p_geofence_center_lng      double precision,
  p_geofence_radius_m        int,
  p_geofence_polygon         jsonb,
  p_pin_plain                text,
  p_qr_secret_hex            text,
  p_created_by_id            text,
  p_created_by_name          text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id       uuid;
  v_pin_hash text := null;
begin
  if p_pin_plain is not null then
    v_pin_hash := extensions.crypt(p_pin_plain, extensions.gen_salt('bf', 10));
  end if;

  insert into public.checkin_events (
    name, event_type, scope_level, scope_church_id, scope_church_name, venue_name,
    starts_at, ends_at, grace_period_min, auto_checkout_min,
    allowed_check_in_methods, allowed_roles,
    geofence_type, geofence_center_lat, geofence_center_lng, geofence_radius_m, geofence_polygon,
    pin_hash, pin_set_at, qr_secret,
    created_by_id, created_by_name
  ) values (
    p_name, p_event_type, p_scope_level, p_scope_church_id, p_scope_church_name, p_venue_name,
    p_starts_at, p_ends_at, p_grace_period_min, p_auto_checkout_min,
    p_allowed_check_in_methods, p_allowed_roles,
    p_geofence_type, p_geofence_center_lat, p_geofence_center_lng, p_geofence_radius_m, p_geofence_polygon,
    v_pin_hash, case when p_pin_plain is not null then now() else null end, decode(p_qr_secret_hex, 'hex'),
    p_created_by_id, p_created_by_name
  ) returning id into v_id;

  return v_id;
end;
$$;

-- ─── 3. Re-grant execute to anon ────────────────────────────────────────────
grant execute on function public.create_checkin_event(
  text, text, text, text, text, text,
  timestamptz, timestamptz, int, int,
  text[], text[],
  text, double precision, double precision, int, jsonb,
  text, text, text, text
) to anon;
