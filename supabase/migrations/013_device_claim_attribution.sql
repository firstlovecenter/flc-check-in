-- 013_device_claim_attribution.sql
--
-- Return WHICH user originally claimed a device so the UI can show a
-- specific "Device already used by {name}" message instead of the generic
-- "by another leader." Helps an admin (or the user themselves) diagnose
-- shared-device situations on the spot.
--
-- Change shape:
--   claim_device_for_event(uuid, text, text) returns jsonb
--     ok: true | false
--     when ok=false also:
--       claimed_by_member_id: text
--       claimed_by_name: text     -- best-effort from checkin_records.member_name,
--                                    falling back to member_profiles, then null
--
-- submit_checkin propagates these fields when claim fails.

-- Drop the boolean-returning version first since postgres can't change
-- return type via create-or-replace.
drop function if exists public.claim_device_for_event(uuid, text, text);

create or replace function public.claim_device_for_event(
  p_event_id     uuid,
  p_fingerprint  text,
  p_member_id    text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existing       text;
  v_self_checked_in boolean;
  v_name           text;
begin
  -- Idempotency: if THIS member already has a record on this event, the
  -- claim is considered satisfied regardless of fingerprint changes.
  select exists (
    select 1 from public.checkin_records
     where event_id = p_event_id and member_id = p_member_id
  ) into v_self_checked_in;

  if v_self_checked_in then
    insert into public.checkin_devices (event_id, device_fingerprint, member_id)
      values (p_event_id, p_fingerprint, p_member_id)
      on conflict (event_id, device_fingerprint) do nothing;
    return jsonb_build_object('ok', true);
  end if;

  -- Normal first-write-wins claim.
  insert into public.checkin_devices (event_id, device_fingerprint, member_id)
    values (p_event_id, p_fingerprint, p_member_id)
    on conflict (event_id, device_fingerprint) do nothing;

  select member_id into v_existing
    from public.checkin_devices
   where event_id = p_event_id and device_fingerprint = p_fingerprint;

  if v_existing = p_member_id then
    return jsonb_build_object('ok', true);
  end if;

  -- Conflict: another member already owns this fingerprint on this event.
  -- Best-effort name lookup: first try the checkin_records row for this
  -- event (richest context — they used the device for THIS event), then
  -- fall back to the member_profiles row.
  select member_name into v_name
    from public.checkin_records
   where event_id = p_event_id and member_id = v_existing
   limit 1;

  if v_name is null then
    select coalesce(
      nullif(trim(coalesce(title, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''),
      email
    )
      into v_name
      from public.member_profiles
     where id = v_existing;
  end if;

  return jsonb_build_object(
    'ok',                    false,
    'claimed_by_member_id',  v_existing,
    'claimed_by_name',       v_name
  );
end;
$$;


-- Patch submit_checkin to consume the JSONB return shape and propagate
-- the attribution fields back to the caller.

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
  v_device_claim   jsonb;
  v_is_late        boolean;
  v_record_id      uuid;
  v_claim_age      interval;
  v_existing       public.checkin_records%rowtype;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

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

  -- Idempotent early return when the same member already checked in.
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

  if not (p_method = any(v_event.allowed_check_in_methods)) then
    return jsonb_build_object('ok', false, 'reason', 'method_not_allowed');
  end if;

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

  v_in_fence := public.point_in_event_geofence(p_event_id, p_lat, p_lng);
  if not v_in_fence then
    return jsonb_build_object('ok', false, 'reason', 'outside_fence');
  end if;

  if p_method <> 'MANUAL' then
    v_device_claim := public.claim_device_for_event(p_event_id, p_fingerprint, p_member_id);
    if not coalesce((v_device_claim->>'ok')::boolean, false) then
      return jsonb_build_object(
        'ok',                   false,
        'reason',               'device_already_used',
        'claimed_by_member_id', v_device_claim->>'claimed_by_member_id',
        'claimed_by_name',      v_device_claim->>'claimed_by_name'
      );
    end if;
  end if;

  v_is_late := v_now > (v_event.starts_at + (v_event.grace_period_min * interval '1 minute'));

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
