-- ════════════════════════════════════════════════════════════════════════════
--  Migration: submit_checkin RPC
--
--  Single server-side entry point for all member check-ins (QR and PIN).
--  Performs every validation atomically inside a security-definer function:
--    1. Event exists, is ACTIVE, and within its time window
--    2. The requested method is in allowed_check_in_methods
--    3. QR  → HMAC-SHA256 token verification via pgcrypto.hmac()
--       PIN → delegates to existing record_pin_attempt() RPC
--    4. Geofence check via point_in_event_geofence()
--    5. Device fingerprint claim via claim_device_for_event()
--    6. Late-arrival detection
--    7. INSERT into checkin_records (unique constraint handles double-submit)
--
--  Returns: jsonb { ok, reason?, record? }
--
--  Apply in Supabase SQL editor or via `supabase db push`.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.submit_checkin(
  p_event_id     uuid,
  p_member_id    uuid,
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
  v_pin_result     jsonb;
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

  -- ── 4. Method-specific verification ──────────────────────────────────────
  if p_method = 'QR' then

    if p_qr_token is null then
      return jsonb_build_object('ok', false, 'reason', 'missing_qr_token');
    end if;

    -- Token format: 'eventId:bucket:sigHex'
    -- UUIDs contain no colons, so string_to_array gives exactly 3 elements.
    v_parts := string_to_array(p_qr_token, ':');
    if array_length(v_parts, 1) <> 3 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_qr_token');
    end if;

    v_token_event_id := v_parts[1];
    v_token_bucket   := v_parts[2]::bigint;
    v_token_sig_hex  := lower(v_parts[3]);

    -- Event ID must match
    if v_token_event_id <> p_event_id::text then
      return jsonb_build_object('ok', false, 'reason', 'invalid_qr_token');
    end if;

    -- Bucket must be current or previous 60-second slot
    v_bucket_now := floor(extract(epoch from v_now) / 60)::bigint;
    if v_token_bucket <> v_bucket_now and v_token_bucket <> (v_bucket_now - 1) then
      return jsonb_build_object('ok', false, 'reason', 'qr_expired');
    end if;

    -- HMAC-SHA256: message = 'eventId:bucket', key = qr_secret (bytea)
    -- Client uses crypto.subtle with the same raw bytes → results must match.
    v_expected_sig := extensions.hmac(
      convert_to(v_token_event_id || ':' || v_token_bucket::text, 'UTF8'),
      v_event.qr_secret,
      'sha256'
    );

    if encode(v_expected_sig, 'hex') <> v_token_sig_hex then
      return jsonb_build_object('ok', false, 'reason', 'invalid_qr_token');
    end if;

  elsif p_method = 'PIN' then

    -- Delegate entirely to the existing PIN RPC (rate-limiting included)
    v_pin_result := public.record_pin_attempt(p_event_id, p_member_id, p_pin_plain);
    if not (v_pin_result ->> 'ok')::boolean then
      return v_pin_result;
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

-- Grant execute to the anon role (same as all other RPCs in this schema)
grant execute on function public.submit_checkin(
  uuid, uuid, text, text, text, text,
  double precision, double precision, text,
  text, text
) to anon;
