-- Add is_public flag to checkin_events.
-- When true (default) the event appears on the public QR page (/events).
-- When false only superadmins and the event's direct scope can see it.
-- Superadmins can toggle this at event-creation time; regular admins cannot.

ALTER TABLE public.checkin_events
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

-- Recreate create_checkin_event to accept p_is_public.
-- Drop the old signature first (PostgreSQL does not support altering function params).
DROP FUNCTION IF EXISTS public.create_checkin_event(text,text,text,text,text,text,timestamptz,timestamptz,int,int,text[],text[],text,double precision,double precision,int,jsonb,text,text,text,text);

CREATE OR REPLACE FUNCTION public.create_checkin_event(
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
  p_created_by_name          text,
  p_is_public                boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id uuid;
  v_pin_hash text := null;
BEGIN
  IF p_pin_plain IS NOT NULL THEN
    v_pin_hash := extensions.crypt(p_pin_plain, extensions.gen_salt('bf', 10));
  END IF;

  INSERT INTO public.checkin_events (
    name, event_type, scope_level, scope_church_id, scope_church_name, venue_name,
    starts_at, ends_at, grace_period_min, auto_checkout_min,
    allowed_check_in_methods, allowed_roles,
    geofence_type, geofence_center_lat, geofence_center_lng, geofence_radius_m, geofence_polygon,
    pin_hash, pin_set_at, qr_secret,
    created_by_id, created_by_name, is_public
  ) VALUES (
    p_name, p_event_type, p_scope_level, p_scope_church_id, p_scope_church_name, p_venue_name,
    p_starts_at, p_ends_at, p_grace_period_min, p_auto_checkout_min,
    p_allowed_check_in_methods, p_allowed_roles,
    p_geofence_type, p_geofence_center_lat, p_geofence_center_lng, p_geofence_radius_m, p_geofence_polygon,
    v_pin_hash, CASE WHEN p_pin_plain IS NOT NULL THEN now() ELSE null END, decode(p_qr_secret_hex, 'hex'),
    p_created_by_id, p_created_by_name, p_is_public
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_checkin_event(text,text,text,text,text,text,timestamptz,timestamptz,int,int,text[],text[],text,double precision,double precision,int,jsonb,text,text,text,text,boolean)
  TO anon, authenticated;
