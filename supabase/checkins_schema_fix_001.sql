-- Fix-up for the initial Phase 1 schema:
--   1. Disable RLS on all five tables (v1 is enforced via security-definer RPCs).
--   2. Move pgcrypto to the standard `extensions` schema and update RPC search_paths
--      so crypt()/gen_salt() resolve. Supabase installs pgcrypto into `extensions`,
--      not `public`.

-- ─── 1. RLS off ─────────────────────────────────────────────────────────────
alter table public.member_profiles    disable row level security;
alter table public.checkin_events     disable row level security;
alter table public.checkin_records    disable row level security;
alter table public.checkin_attempts   disable row level security;
alter table public.checkin_devices    disable row level security;

-- ─── 2. Make sure pgcrypto is in extensions schema and on search_path ──────
create schema if not exists extensions;
-- If pgcrypto was created into public by the original migration, drop and reinstall
-- it into extensions. Cascade is safe — only the FUNCTIONS get dropped, no data.
drop extension if exists pgcrypto cascade;
create extension if not exists pgcrypto with schema extensions;

-- ─── 3. Re-create the RPCs with `extensions` on the search_path ────────────
-- (overwrites the previous definitions with the same body, just adjusting search_path)

create or replace function public.record_pin_attempt(
  p_event_id   uuid,
  p_member_id  uuid,
  p_pin_plain  text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_event           public.checkin_events%rowtype;
  v_lockout_until   timestamptz;
  v_attempts_in_win int;
  v_attempts_left   int;
  v_match           boolean;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;
  if v_event.status <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'reason', 'event_not_active', 'status', v_event.status);
  end if;
  if v_event.pin_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'pin_not_set');
  end if;

  select max(lockout_until) into v_lockout_until
    from public.checkin_attempts
   where event_id = p_event_id
     and member_id = p_member_id
     and lockout_until is not null
     and lockout_until > now();
  if v_lockout_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'locked_out', 'lockout_until', v_lockout_until);
  end if;

  v_match := (extensions.crypt(p_pin_plain, v_event.pin_hash) = v_event.pin_hash);

  if v_match then
    insert into public.checkin_attempts (event_id, member_id, success)
      values (p_event_id, p_member_id, true);
    return jsonb_build_object('ok', true);
  end if;

  select count(*) into v_attempts_in_win
    from public.checkin_attempts
   where event_id = p_event_id
     and member_id = p_member_id
     and success = false
     and attempted_at > now() - interval '10 minutes';

  if v_attempts_in_win + 1 >= 5 then
    insert into public.checkin_attempts (event_id, member_id, success, lockout_until)
      values (p_event_id, p_member_id, false, now() + interval '15 minutes');
    return jsonb_build_object('ok', false, 'reason', 'locked_out',
                              'lockout_until', now() + interval '15 minutes');
  else
    insert into public.checkin_attempts (event_id, member_id, success)
      values (p_event_id, p_member_id, false);
    v_attempts_left := 5 - (v_attempts_in_win + 1);
    return jsonb_build_object('ok', false, 'reason', 'wrong_pin', 'attempts_left', v_attempts_left);
  end if;
end;
$$;


create or replace function public.create_checkin_event(
  p_name                     text,
  p_event_type               text,
  p_scope_level              text,
  p_scope_church_id          text,
  p_scope_church_name        text,
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
  p_created_by_id            uuid,
  p_created_by_name          text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_pin_hash text := null;
begin
  if p_pin_plain is not null then
    v_pin_hash := extensions.crypt(p_pin_plain, extensions.gen_salt('bf', 10));
  end if;

  insert into public.checkin_events (
    name, event_type, scope_level, scope_church_id, scope_church_name,
    starts_at, ends_at, grace_period_min, auto_checkout_min,
    allowed_check_in_methods, allowed_roles,
    geofence_type, geofence_center_lat, geofence_center_lng, geofence_radius_m, geofence_polygon,
    pin_hash, pin_set_at, qr_secret,
    created_by_id, created_by_name
  ) values (
    p_name, p_event_type, p_scope_level, p_scope_church_id, p_scope_church_name,
    p_starts_at, p_ends_at, p_grace_period_min, p_auto_checkout_min,
    p_allowed_check_in_methods, p_allowed_roles,
    p_geofence_type, p_geofence_center_lat, p_geofence_center_lng, p_geofence_radius_m, p_geofence_polygon,
    v_pin_hash, case when p_pin_plain is not null then now() else null end, decode(p_qr_secret_hex, 'hex'),
    p_created_by_id, p_created_by_name
  ) returning id into v_id;

  return v_id;
end;
$$;


create or replace function public.reset_event_pin(
  p_event_id uuid, p_pin_plain text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.checkin_events
     set pin_hash   = extensions.crypt(p_pin_plain, extensions.gen_salt('bf', 10)),
         pin_set_at = now()
   where id = p_event_id;

  update public.checkin_attempts
     set lockout_until = null
   where event_id = p_event_id
     and lockout_until is not null
     and lockout_until > now();
end;
$$;
