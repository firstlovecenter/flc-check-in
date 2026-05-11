-- FLC Check-In — Phase 1 schema
-- Apply via Supabase SQL editor or `supabase db push`.
-- Idempotent where possible: safe to re-run during development.
--
-- RLS is intentionally OFF for v1. Atomicity guarantees come from the
-- security-definer RPC functions defined at the bottom of this file.

-- pgcrypto must live in the `extensions` schema (Supabase convention) so the
-- security-definer RPCs can resolve crypt()/gen_salt() via search_path.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ─── 1. member_profiles ─────────────────────────────────────────────────────
-- Local cache of leader identity for fast joins. id matches the FLC member id
-- (uuid) carried by the auth JWT.
create table if not exists public.member_profiles (
  id              uuid primary key,
  email           text,
  first_name      text,
  last_name       text,
  phone           text,
  roles           text[] not null default '{}',
  bacenta_id      text, bacenta_name      text,
  governorship_id text, governorship_name text,
  council_id      text, council_name      text,
  stream_id       text, stream_name       text,
  campus_id       text, campus_name       text,
  oversight_id    text, oversight_name    text,
  denomination_id text, denomination_name text,
  updated_at      timestamptz not null default now()
);

create index if not exists member_profiles_bacenta_idx      on public.member_profiles (bacenta_id);
create index if not exists member_profiles_governorship_idx on public.member_profiles (governorship_id);
create index if not exists member_profiles_council_idx      on public.member_profiles (council_id);
create index if not exists member_profiles_stream_idx       on public.member_profiles (stream_id);
create index if not exists member_profiles_campus_idx       on public.member_profiles (campus_id);
create index if not exists member_profiles_oversight_idx    on public.member_profiles (oversight_id);

-- ─── 2. checkin_events ──────────────────────────────────────────────────────
create table if not exists public.checkin_events (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  event_type                  text,
  status                      text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'PAUSED', 'ENDED')),
  scope_level                 text not null
    check (scope_level in ('bacenta','governorship','council','stream','campus','oversight','denomination')),
  scope_church_id             text not null,
  scope_church_name           text not null,
  starts_at                   timestamptz not null,
  ends_at                     timestamptz not null,
  grace_period_min            int  not null default 15,
  auto_checkout_min           int  not null default 0,
  allowed_check_in_methods    text[] not null
    check (allowed_check_in_methods <@ array['QR','PIN','MANUAL','FACE_ID']),
  allowed_roles               text[] not null,
  geofence_type               text not null check (geofence_type in ('circle','polygon')),
  geofence_center_lat         double precision,
  geofence_center_lng         double precision,
  geofence_radius_m           int,
  geofence_polygon            jsonb,
  pin_hash                    text,
  pin_set_at                  timestamptz,
  qr_secret                   bytea not null,
  created_by_id               uuid not null references public.member_profiles(id),
  created_by_name             text,
  created_at                  timestamptz not null default now(),
  check (
    (geofence_type = 'circle'  and geofence_center_lat is not null and geofence_center_lng is not null and geofence_radius_m is not null)
    or
    (geofence_type = 'polygon' and geofence_polygon is not null)
  ),
  check (ends_at > starts_at)
);

create index if not exists checkin_events_status_ends_at_idx on public.checkin_events (status, ends_at);
create index if not exists checkin_events_scope_idx          on public.checkin_events (scope_level, scope_church_id);

-- ─── 3. checkin_records ─────────────────────────────────────────────────────
create table if not exists public.checkin_records (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references public.checkin_events(id) on delete cascade,
  member_id           uuid not null references public.member_profiles(id),
  member_name         text,
  member_role         text,
  member_unit_name    text,
  checked_in_at       timestamptz not null default now(),
  checked_out_at      timestamptz,
  auto_checked_out    boolean not null default false,
  is_late             boolean not null default false,
  method              text not null check (method in ('QR','PIN','MANUAL','FACE_ID')),
  geo_verified        boolean not null,
  check_in_lat        double precision,
  check_in_lng        double precision,
  device_fingerprint  text not null,
  manual_reason       text,
  verified_by         text,
  unique (event_id, member_id)
);

create index if not exists checkin_records_event_idx        on public.checkin_records (event_id);
create index if not exists checkin_records_member_idx       on public.checkin_records (member_id, checked_in_at desc);

-- ─── 4. checkin_attempts (PIN rate-limiting) ────────────────────────────────
create table if not exists public.checkin_attempts (
  id              bigserial primary key,
  event_id        uuid not null references public.checkin_events(id) on delete cascade,
  member_id       uuid not null,
  attempted_at    timestamptz not null default now(),
  success         boolean not null,
  lockout_until   timestamptz
);

create index if not exists checkin_attempts_lookup_idx
  on public.checkin_attempts (event_id, member_id, attempted_at desc);

-- ─── 5. checkin_devices (one device per member per event) ───────────────────
create table if not exists public.checkin_devices (
  event_id            uuid not null references public.checkin_events(id) on delete cascade,
  device_fingerprint  text not null,
  member_id           uuid not null,
  first_seen_at       timestamptz not null default now(),
  primary key (event_id, device_fingerprint)
);

-- ─── RLS off (v1 enforces via security-definer RPCs) ────────────────────────
alter table public.member_profiles    disable row level security;
alter table public.checkin_events     disable row level security;
alter table public.checkin_records    disable row level security;
alter table public.checkin_attempts   disable row level security;
alter table public.checkin_devices    disable row level security;


-- ════════════════════════════════════════════════════════════════════════════
--  RPC: record_pin_attempt(event_id, member_id, plain_pin) -> jsonb
--  Atomic PIN check with rate-limiting:
--    - if a non-expired lockout exists, reject
--    - else verify hash via pgcrypto crypt()
--    - on failure: insert attempt; if 5 fails in last 10 min → set 15-min lockout
--    - on success: insert success row; clear active lockouts for this member+event
-- ════════════════════════════════════════════════════════════════════════════
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

  -- Active lockout?
  select max(lockout_until) into v_lockout_until
    from public.checkin_attempts
   where event_id = p_event_id
     and member_id = p_member_id
     and lockout_until is not null
     and lockout_until > now();
  if v_lockout_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'locked_out', 'lockout_until', v_lockout_until);
  end if;

  -- Verify PIN (crypt returns the same hash if pin_plain matches)
  v_match := (extensions.crypt(p_pin_plain, v_event.pin_hash) = v_event.pin_hash);

  if v_match then
    insert into public.checkin_attempts (event_id, member_id, success)
      values (p_event_id, p_member_id, true);
    return jsonb_build_object('ok', true);
  end if;

  -- Failure: count failures in the last 10 minutes
  select count(*) into v_attempts_in_win
    from public.checkin_attempts
   where event_id = p_event_id
     and member_id = p_member_id
     and success = false
     and attempted_at > now() - interval '10 minutes';

  -- The current failure brings the count to (v_attempts_in_win + 1)
  if v_attempts_in_win + 1 >= 5 then
    insert into public.checkin_attempts (event_id, member_id, success, lockout_until)
      values (p_event_id, p_member_id, false, now() + interval '15 minutes');
    return jsonb_build_object(
      'ok', false,
      'reason', 'locked_out',
      'lockout_until', now() + interval '15 minutes'
    );
  else
    insert into public.checkin_attempts (event_id, member_id, success)
      values (p_event_id, p_member_id, false);
    v_attempts_left := 5 - (v_attempts_in_win + 1);
    return jsonb_build_object(
      'ok', false,
      'reason', 'wrong_pin',
      'attempts_left', v_attempts_left
    );
  end if;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  RPC: claim_device_for_event(event_id, fingerprint, member_id) -> boolean
--  Returns true if this fingerprint is now bound to this member (newly bound
--  OR was already bound to the same member). False if a different member
--  already owns this fingerprint for this event.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.claim_device_for_event(
  p_event_id     uuid,
  p_fingerprint  text,
  p_member_id    uuid
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existing uuid;
begin
  insert into public.checkin_devices (event_id, device_fingerprint, member_id)
    values (p_event_id, p_fingerprint, p_member_id)
    on conflict (event_id, device_fingerprint) do nothing;

  select member_id into v_existing
    from public.checkin_devices
   where event_id = p_event_id and device_fingerprint = p_fingerprint;

  return v_existing = p_member_id;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  Helper: point_in_polygon(lng, lat, polygon_jsonb) -> boolean
--  Ray-casting algorithm. Polygon is a JSON array of [lat, lng] pairs.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.point_in_polygon(
  p_lat double precision,
  p_lng double precision,
  p_polygon jsonb
) returns boolean
language plpgsql
immutable
as $$
declare
  v_n int;
  v_inside boolean := false;
  v_i int := 0;
  v_j int;
  v_xi double precision; v_yi double precision;
  v_xj double precision; v_yj double precision;
begin
  v_n := jsonb_array_length(p_polygon);
  if v_n < 3 then return false; end if;
  v_j := v_n - 1;
  while v_i < v_n loop
    v_yi := (p_polygon -> v_i ->> 0)::double precision;  -- lat
    v_xi := (p_polygon -> v_i ->> 1)::double precision;  -- lng
    v_yj := (p_polygon -> v_j ->> 0)::double precision;
    v_xj := (p_polygon -> v_j ->> 1)::double precision;
    if ((v_yi > p_lat) <> (v_yj > p_lat))
       and (p_lng < (v_xj - v_xi) * (p_lat - v_yi) / nullif((v_yj - v_yi), 0) + v_xi) then
      v_inside := not v_inside;
    end if;
    v_j := v_i;
    v_i := v_i + 1;
  end loop;
  return v_inside;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  Helper: haversine_meters(lat1, lng1, lat2, lng2) -> double precision
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.haversine_meters(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
) returns double precision
language plpgsql
immutable
as $$
declare
  r constant double precision := 6371000;  -- Earth radius in metres
  d_lat double precision;
  d_lng double precision;
  a double precision;
begin
  d_lat := radians(p_lat2 - p_lat1);
  d_lng := radians(p_lng2 - p_lng1);
  a := sin(d_lat / 2) ^ 2
     + cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(d_lng / 2) ^ 2;
  return r * 2 * atan2(sqrt(a), sqrt(1 - a));
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  Helper: point_in_event_geofence(event_id, lat, lng) -> boolean
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.point_in_event_geofence(
  p_event_id uuid, p_lat double precision, p_lng double precision
) returns boolean
language plpgsql
stable
as $$
declare
  v_event public.checkin_events%rowtype;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then return false; end if;
  if v_event.geofence_type = 'circle' then
    return public.haversine_meters(
      v_event.geofence_center_lat, v_event.geofence_center_lng, p_lat, p_lng
    ) <= v_event.geofence_radius_m;
  elsif v_event.geofence_type = 'polygon' then
    return public.point_in_polygon(p_lat, p_lng, v_event.geofence_polygon);
  end if;
  return false;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  RPC: report_member_location(event_id, member_id, lat, lng) -> jsonb
--  Heartbeat from a checked-in leader. If they've left the geofence, mark
--  their record as auto-checked-out. Returns { inside_fence, checked_out }.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.report_member_location(
  p_event_id  uuid,
  p_member_id uuid,
  p_lat       double precision,
  p_lng       double precision
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inside boolean;
  v_was_checked_out boolean := false;
begin
  v_inside := public.point_in_event_geofence(p_event_id, p_lat, p_lng);

  if not v_inside then
    update public.checkin_records
       set checked_out_at  = now(),
           auto_checked_out = true
     where event_id = p_event_id
       and member_id = p_member_id
       and checked_out_at is null;
    if found then v_was_checked_out := true; end if;
  end if;

  return jsonb_build_object('inside_fence', v_inside, 'checked_out', v_was_checked_out);
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  RPC: auto_checkout_expired_events() -> int
--  Called by the Supabase Edge Function on a schedule (every minute).
--  For ACTIVE events past ends_at:
--    1. Auto-check-out every still-open record
--    2. Flip event status to ENDED
--  Returns the number of records that were auto-closed.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.auto_checkout_expired_events()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  with closed as (
    update public.checkin_records cr
       set checked_out_at  = now(),
           auto_checked_out = true
      from public.checkin_events ce
     where cr.event_id = ce.id
       and ce.status = 'ACTIVE'
       and ce.ends_at <= now()
       and cr.checked_out_at is null
    returning cr.id
  )
  select count(*) into v_count from closed;

  update public.checkin_events
     set status = 'ENDED'
   where status = 'ACTIVE'
     and ends_at <= now();

  return v_count;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  RPC: create_checkin_event(...) -> uuid
--  Wraps the insert so the PIN can be hashed server-side via crypt().
--  If p_pin_plain is null, no PIN is set (event must allow other methods).
-- ════════════════════════════════════════════════════════════════════════════
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


-- ════════════════════════════════════════════════════════════════════════════
--  RPC: reset_event_pin(event_id, plain_pin) -> void
--  Re-hashes a new PIN for the event and clears any active lockouts.
-- ════════════════════════════════════════════════════════════════════════════
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

  -- Clear active lockouts so the new PIN is immediately usable.
  update public.checkin_attempts
     set lockout_until = null
   where event_id = p_event_id
     and lockout_until is not null
     and lockout_until > now();
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- Permissions
-- ════════════════════════════════════════════════════════════════════════════
-- RLS is OFF for v1. Grant table access to the anon role used by the
-- @supabase/supabase-js client (publishable key).
grant usage on schema public to anon;
grant select, insert, update, delete on
  public.member_profiles, public.checkin_events, public.checkin_records,
  public.checkin_attempts, public.checkin_devices to anon;
grant usage, select on sequence public.checkin_attempts_id_seq to anon;
grant execute on function
  public.record_pin_attempt(uuid, uuid, text),
  public.claim_device_for_event(uuid, text, uuid),
  public.report_member_location(uuid, uuid, double precision, double precision),
  public.auto_checkout_expired_events(),
  public.create_checkin_event(text, text, text, text, text, timestamptz, timestamptz, int, int, text[], text[], text, double precision, double precision, int, jsonb, text, text, uuid, text),
  public.reset_event_pin(uuid, text),
  public.point_in_event_geofence(uuid, double precision, double precision),
  public.haversine_meters(double precision, double precision, double precision, double precision),
  public.point_in_polygon(double precision, double precision, jsonb)
  to anon;
