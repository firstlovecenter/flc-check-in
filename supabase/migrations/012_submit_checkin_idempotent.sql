-- 012_submit_checkin_idempotent.sql
--
-- Two related fixes for the "device used by another user" complaint on retry:
--
--   1. submit_checkin now short-circuits with the EXISTING record if the
--      caller (same member_id, same event) already has one. Returns
--      `ok: true` with reason 'already_checked_in'. This makes retries
--      idempotent — a user who tapped twice (or whose first response was
--      lost in transit) gets a clean success instead of a confusing
--      "already_checked_in" error.
--
--   2. claim_device_for_event becomes idempotent for the user's OWN prior
--      success: if the (event, member) pair already has a checkin_record,
--      we treat the device claim as satisfied regardless of which
--      fingerprint is currently presented. This prevents the
--      "device_already_used" branch from firing on a retry after a
--      successful first attempt where the second submission happened to
--      compute a different fingerprint (e.g. camera permission changed
--      the media-device signal).
--
-- The proxy-prevention rule is preserved for the case it was designed to
-- catch: a DIFFERENT member trying to check in with a device that's
-- already bound to someone else.

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
  v_self_checked_in boolean;
begin
  -- Idempotency: if THIS member already has a record on this event, the
  -- claim is considered satisfied regardless of fingerprint changes.
  select exists (
    select 1 from public.checkin_records
     where event_id = p_event_id and member_id = p_member_id
  ) into v_self_checked_in;

  if v_self_checked_in then
    -- Keep the device→member mapping up to date for risk-flag computation.
    insert into public.checkin_devices (event_id, device_fingerprint, member_id)
      values (p_event_id, p_fingerprint, p_member_id)
      on conflict (event_id, device_fingerprint) do nothing;
    return true;
  end if;

  -- Normal first-write-wins claim.
  insert into public.checkin_devices (event_id, device_fingerprint, member_id)
    values (p_event_id, p_fingerprint, p_member_id)
    on conflict (event_id, device_fingerprint) do nothing;

  select member_id into v_existing
    from public.checkin_devices
   where event_id = p_event_id and device_fingerprint = p_fingerprint;

  return v_existing = p_member_id;
end;
$$;


-- Patch submit_checkin to short-circuit when the member already has a
-- record on this event. We do this immediately after the event/status/
-- time-window checks (which need to fail for paused/ended/etc. events
-- regardless of prior records) and BEFORE any expensive verification.
--
-- Because we re-declare the whole function, this also picks up the
-- normalised order with the new check inserted.

create or replace function public.submit_checkin(
  p_event_id        uuid,
  p_member_id       text,
  p_member_name     text,
  p_member_role     text,
  p_member_unit     text,
  p_method          text,
  p_lat             double precision,
  p_lng             double precision,
  p_fingerprint     text,
  p_qr_token        text default null,
  p_pin_plain       text default null
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
  v_existing       public.checkin_records%rowtype;
begin
  -- 1. Fetch event
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- 2. Status and time window
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

  -- 2b. Idempotent early-return: if this member already has a record on
  -- this event, hand back the existing one and mark it ok. Prevents the
  -- usual "already_checked_in"/"device_already_used" confusion on a
  -- retry after a successful first attempt whose response was lost.
  select * into v_existing
    from public.checkin_records
   where event_id = p_event_id and member_id = p_member_id;
  if found then
    return jsonb_build_object(
      'ok',     true,
      'reason', 'already_checked_in',
      'record', jsonb_build_object(
        'id',      v_existing.id,
        'is_late', v_existing.is_late,
        'method',  v_existing.method
      )
    );
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
    return jsonb_build_object('ok', false, 'reason', 'unsupported_method');
  end if;

  -- 5. Geofence
  v_in_fence := public.point_in_event_geofence(p_event_id, p_lat, p_lng);
  if not v_in_fence then
    return jsonb_build_object('ok', false, 'reason', 'outside_fence');
  end if;

  -- 6. Device fingerprint claim — skipped for MANUAL.
  if p_method <> 'MANUAL' then
    v_device_ok := public.claim_device_for_event(p_event_id, p_fingerprint, p_member_id);
    if not v_device_ok then
      return jsonb_build_object('ok', false, 'reason', 'device_already_used');
    end if;
  end if;

  -- 7. Late detection
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
    -- Race: another connection inserted the same (event_id, member_id)
    -- record between our early-return check and this insert. Treat as
    -- idempotent success rather than failure.
    select * into v_existing
      from public.checkin_records
     where event_id = p_event_id and member_id = p_member_id;
    if found then
      return jsonb_build_object(
        'ok',     true,
        'reason', 'already_checked_in',
        'record', jsonb_build_object(
          'id',      v_existing.id,
          'is_late', v_existing.is_late,
          'method',  v_existing.method
        )
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'already_checked_in');
  when others then
    return jsonb_build_object('ok', false, 'reason', 'server_error', 'detail', sqlerrm);
end;
$$;
