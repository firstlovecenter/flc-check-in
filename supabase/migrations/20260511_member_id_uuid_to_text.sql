-- Migration: change all member-identity ID columns from uuid to text
--
-- FLC member graph IDs are MongoDB ObjectIds (24-char hex), not UUIDs.
-- The initial schema used `uuid` for member_profiles.id and all columns
-- that reference it, causing Postgres to reject every bulk upsert with:
--   invalid input syntax for type uuid: "67f870ab7c4b7c59d52c667c"
--
-- Apply in Supabase SQL editor.

-- ─── 1. Drop foreign-key constraints that point at member_profiles.id ───────
alter table public.checkin_events  drop constraint if exists checkin_events_created_by_id_fkey;
alter table public.checkin_records drop constraint if exists checkin_records_member_id_fkey;

-- ─── 2. Change member_profiles.id (PK) to text ───────────────────────────────
-- Postgres requires the PK to be dropped before altering the column type,
-- then recreated.
alter table public.member_profiles drop constraint if exists member_profiles_pkey;
alter table public.member_profiles alter column id type text using id::text;
alter table public.member_profiles add primary key (id);

-- ─── 3. Change all referencing member_id / created_by_id columns to text ────
alter table public.checkin_events  alter column created_by_id type text using created_by_id::text;
alter table public.checkin_records alter column member_id     type text using member_id::text;
alter table public.checkin_attempts alter column member_id    type text using member_id::text;
alter table public.checkin_devices  alter column member_id    type text using member_id::text;

-- ─── 4. Recreate foreign-key constraints ─────────────────────────────────────
alter table public.checkin_events
  add constraint checkin_events_created_by_id_fkey
  foreign key (created_by_id) references public.member_profiles(id);

alter table public.checkin_records
  add constraint checkin_records_member_id_fkey
  foreign key (member_id) references public.member_profiles(id);

-- ─── 5. Recreate claim_device_for_event with text member_id ──────────────────
-- Must drop old uuid-signature version first (Postgres overloads by signature).
drop function if exists public.claim_device_for_event(uuid, text, uuid);

create or replace function public.claim_device_for_event(
  p_event_id     uuid,
  p_fingerprint  text,
  p_member_id    text
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existing text;
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

grant execute on function public.claim_device_for_event(uuid, text, text) to anon;

-- ─── 6. Recreate submit_checkin with text member_id ──────────────────────────
-- Drop old uuid-signature version.
drop function if exists public.submit_checkin(uuid, uuid, text, text, text, text, double precision, double precision, text, text, text);

create or replace function public.submit_checkin(
  p_event_id     uuid,
  p_member_id    text,
  p_member_name  text,
  p_member_role  text,
  p_member_unit  text,
  p_method       text,
  p_lat          double precision,
  p_lng          double precision,
  p_fingerprint  text,
  p_qr_token     text default null,
  p_pin_plain    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_event          public.checkin_events%rowtype;
  v_now            timestamptz := now();
  v_bucket_now     bigint;
  v_parts          text[];
  v_token_event_id text;
  v_token_bucket   bigint;
  v_token_sig_hex  text;
  v_expected_sig   bytea;
  v_otp_hmac       bytea;
  v_otp_int        bigint;
  v_otp_cur        text;
  v_otp_prev       text;
  v_in_fence       boolean;
  v_device_ok      boolean;
  v_is_late        boolean;
  v_record_id      uuid;
begin

  -- ── 1. Fetch event ────────────────────────────────────────────────────────
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- ── 2. Status and time window ─────────────────────────────────────────────
  if v_event.status = 'PAUSED' then
    return jsonb_build_object('ok', false, 'reason', 'event_paused');
  end if;

  if v_event.status = 'ENDED' then
    return jsonb_build_object('ok', false, 'reason', 'event_ended');
  end if;

  if v_now < v_event.starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;

  if v_now > v_event.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'event_ended');
  end if;

  -- ── 3. Method allowed ─────────────────────────────────────────────────────
  if not (p_method = any(v_event.allowed_check_in_methods)) then
    return jsonb_build_object('ok', false, 'reason', 'method_not_allowed');
  end if;

  -- Compute current 15-second bucket (PIN) — QR still uses its own 60-second bucket
  v_bucket_now := floor(extract(epoch from v_now) / 15)::bigint;

  -- ── 4. Method-specific verification ──────────────────────────────────────
  if p_method = 'QR' then

    if p_qr_token is null then
      return jsonb_build_object('ok', false, 'reason', 'missing_qr_token');
    end if;

    -- Token format: 'eventId:bucket:sigHex'
    v_parts := string_to_array(p_qr_token, ':');
    if array_length(v_parts, 1) <> 3 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_qr_token');
    end if;

    v_token_event_id := v_parts[1];
    v_token_bucket   := v_parts[2]::bigint;
    v_token_sig_hex  := lower(v_parts[3]);

    if v_token_event_id <> p_event_id::text then
      return jsonb_build_object('ok', false, 'reason', 'invalid_qr_token');
    end if;

    if v_token_bucket <> v_bucket_now and v_token_bucket <> (v_bucket_now - 1) then
      return jsonb_build_object('ok', false, 'reason', 'qr_expired');
    end if;

    v_expected_sig := extensions.hmac(
      convert_to(v_token_event_id || ':' || v_token_bucket::text, 'UTF8'),
      v_event.qr_secret,
      'sha256'
    );

    if encode(v_expected_sig, 'hex') <> v_token_sig_hex then
      return jsonb_build_object('ok', false, 'reason', 'invalid_qr_token');
    end if;

  elsif p_method = 'PIN' then

    if p_pin_plain is null then
      return jsonb_build_object('ok', false, 'reason', 'missing_pin');
    end if;

    -- Derive rotating OTP: HMAC-SHA256(qr_secret, "eventId:bucket")
    -- Last 4 bytes → unsigned 32-bit → mod 1,000,000 → zero-padded 6 digits.
    -- Accept current or previous bucket for smooth rotation at boundaries.

    v_otp_hmac := extensions.hmac(
      convert_to(p_event_id::text || ':' || v_bucket_now::text, 'UTF8'),
      v_event.qr_secret, 'sha256'
    );
    v_otp_int  := (('x' || right(encode(v_otp_hmac, 'hex'), 8))::bit(32)::int4::bigint
                   + 4294967296) % 4294967296 % 1000000;
    v_otp_cur  := lpad(v_otp_int::text, 6, '0');

    v_otp_hmac := extensions.hmac(
      convert_to(p_event_id::text || ':' || (v_bucket_now - 1)::text, 'UTF8'),
      v_event.qr_secret, 'sha256'
    );
    v_otp_int  := (('x' || right(encode(v_otp_hmac, 'hex'), 8))::bit(32)::int4::bigint
                   + 4294967296) % 4294967296 % 1000000;
    v_otp_prev := lpad(v_otp_int::text, 6, '0');

    if p_pin_plain <> v_otp_cur and p_pin_plain <> v_otp_prev then
      return jsonb_build_object('ok', false, 'reason', 'wrong_pin');
    end if;

  else
    return jsonb_build_object('ok', false, 'reason', 'unsupported_method');
  end if;

  -- ── 5. Geofence ───────────────────────────────────────────────────────────
  v_in_fence := public.point_in_event_geofence(p_event_id, p_lat, p_lng);
  if not v_in_fence then
    return jsonb_build_object('ok', false, 'reason', 'outside_fence');
  end if;

  -- ── 6. Device fingerprint claim ───────────────────────────────────────────
  -- MANUAL check-ins are performed by an admin on a shared kiosk device for
  -- multiple members — skip the per-device lock so one device can check in
  -- the whole room. QR and PIN are self-service and must be strictly one
  -- device per member per event.
  if p_method <> 'MANUAL' then
    v_device_ok := public.claim_device_for_event(p_event_id, p_fingerprint, p_member_id);
    if not v_device_ok then
      return jsonb_build_object('ok', false, 'reason', 'device_already_used');
    end if;
  end if;

  -- ── 7. Late detection ─────────────────────────────────────────────────────
  v_is_late := v_now > (v_event.starts_at + (v_event.grace_period_min * interval '1 minute'));

  -- ── 8. Insert check-in record ─────────────────────────────────────────────
  insert into public.checkin_records (
    event_id, member_id, member_name, member_role, member_unit_name,
    method, geo_verified, check_in_lat, check_in_lng,
    device_fingerprint, is_late
  ) values (
    p_event_id, p_member_id, p_member_name, p_member_role, p_member_unit,
    p_method, true, p_lat, p_lng, p_fingerprint, v_is_late
  )
  returning id into v_record_id;

  return jsonb_build_object(
    'ok', true,
    'record', jsonb_build_object(
      'id',      v_record_id,
      'is_late', v_is_late,
      'method',  p_method
    )
  );

exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already_checked_in');
  when others then
    return jsonb_build_object('ok', false, 'reason', 'server_error', 'detail', sqlerrm);

end;
$$;

grant execute on function public.submit_checkin(
  uuid, text, text, text, text, text,
  double precision, double precision, text,
  text, text
) to anon;

-- ─── 7. Recreate create_checkin_event with text created_by_id ────────────────
drop function if exists public.create_checkin_event(text,text,text,text,text,timestamptz,timestamptz,int,int,text[],text[],text,double precision,double precision,int,jsonb,text,text,uuid,text);

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
  p_created_by_id            text,
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

grant execute on function public.create_checkin_event(
  text,text,text,text,text,
  timestamptz,timestamptz,int,int,
  text[],text[],
  text,double precision,double precision,int,jsonb,
  text,text,text,text
) to anon;
