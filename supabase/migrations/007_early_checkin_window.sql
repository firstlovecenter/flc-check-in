-- Migration 007: early check-in window
-- Allow members to check in up to 1 hour before an event's scheduled start
-- time. The server is the sole enforcer — no client-side timing gate is
-- authoritative. is_late is still computed relative to starts_at so early
-- arrivals are never marked late.

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
  v_qr_bucket_now  bigint;
  v_pin_bucket_now bigint;
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
  v_claim_age      interval;
begin
  -- 1. Fetch event
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- 2. Status and time window
  --    Check-in opens 1 hour before starts_at and closes at ends_at.
  if v_event.status = 'PAUSED' then
    return jsonb_build_object('ok', false, 'reason', 'event_paused');
  end if;
  if v_event.status = 'ENDED' then
    return jsonb_build_object('ok', false, 'reason', 'event_ended');
  end if;
  if v_now < (v_event.starts_at - interval '1 hour') then
    return jsonb_build_object(
      'ok',         false,
      'reason',     'not_started',
      'opens_at',   (v_event.starts_at - interval '1 hour')
    );
  end if;
  if v_now > v_event.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'event_ended');
  end if;

  -- 3. Method allowed
  if not (p_method = any(v_event.allowed_check_in_methods)) then
    return jsonb_build_object('ok', false, 'reason', 'method_not_allowed');
  end if;

  -- 4. Method-specific verification
  if p_method = 'QR' then
    if p_qr_token is null then
      return jsonb_build_object('ok', false, 'reason', 'missing_qr_token');
    end if;

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

    v_qr_bucket_now := floor(extract(epoch from v_now) / 60)::bigint;
    if v_token_bucket <> v_qr_bucket_now and v_token_bucket <> (v_qr_bucket_now - 1) then
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

    v_pin_bucket_now := floor(extract(epoch from v_now) / 15)::bigint;

    v_otp_hmac := extensions.hmac(
      convert_to(p_event_id::text || ':' || v_pin_bucket_now::text, 'UTF8'),
      v_event.qr_secret, 'sha256'
    );
    v_otp_int := (('x' || right(encode(v_otp_hmac, 'hex'), 8))::bit(32)::int4::bigint
                  + 4294967296) % 4294967296 % 1000000;
    v_otp_cur := lpad(v_otp_int::text, 6, '0');

    v_otp_hmac := extensions.hmac(
      convert_to(p_event_id::text || ':' || (v_pin_bucket_now - 1)::text, 'UTF8'),
      v_event.qr_secret, 'sha256'
    );
    v_otp_int := (('x' || right(encode(v_otp_hmac, 'hex'), 8))::bit(32)::int4::bigint
                  + 4294967296) % 4294967296 % 1000000;
    v_otp_prev := lpad(v_otp_int::text, 6, '0');

    if p_pin_plain <> v_otp_cur and p_pin_plain <> v_otp_prev then
      return jsonb_build_object('ok', false, 'reason', 'wrong_pin');
    end if;

  elsif p_method = 'FACE_ID' then
    -- Require a fresh claim (<60s). Consume it whether or not the rest of
    -- the check-in succeeds (the client must call claim_face_match again
    -- to retry).
    select v_now - claimed_at into v_claim_age
      from public.face_match_claims
     where event_id = p_event_id and member_id = p_member_id;

    if v_claim_age is null then
      return jsonb_build_object('ok', false, 'reason', 'face_match_required');
    end if;

    if v_claim_age > interval '60 seconds' then
      delete from public.face_match_claims
       where event_id = p_event_id and member_id = p_member_id;
      return jsonb_build_object('ok', false, 'reason', 'face_match_expired');
    end if;

    delete from public.face_match_claims
     where event_id = p_event_id and member_id = p_member_id;

  else
    -- MANUAL goes through submit_manual_check_in (direct insert by admin) — never
    -- through this RPC. Any other method is unknown.
    return jsonb_build_object('ok', false, 'reason', 'unsupported_method');
  end if;

  -- 5. Geofence
  v_in_fence := public.point_in_event_geofence(p_event_id, p_lat, p_lng);
  if not v_in_fence then
    return jsonb_build_object('ok', false, 'reason', 'outside_fence');
  end if;

  -- 6. Device fingerprint claim — skipped for MANUAL (admin shared kiosk).
  if p_method <> 'MANUAL' then
    v_device_ok := public.claim_device_for_event(p_event_id, p_fingerprint, p_member_id);
    if not v_device_ok then
      return jsonb_build_object('ok', false, 'reason', 'device_already_used');
    end if;
  end if;

  -- 7. Late detection — relative to starts_at, not the early window.
  --    Someone checking in before starts_at is never late.
  v_is_late := v_now > (v_event.starts_at + (v_event.grace_period_min * interval '1 minute'));

  -- 8. Insert record
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
