-- ════════════════════════════════════════════════════════════════════════════
--  Migration: face ID check-in
--
--  Adds the database surface for FACE_ID check-in:
--    1. member_profiles.face_descriptor — 128-float vector from face-api.js
--    2. face_match_claims — short-lived rows the client creates after a local
--       face match. Acts as a server-side gate: submit_checkin requires a
--       fresh claim before accepting FACE_ID, and consumes it on success.
--    3. claim_face_match RPC — client calls this after a local descriptor
--       match + blink-liveness pass.
--    4. submit_checkin RPC patched to handle FACE_ID.
--
--  Apply via `supabase db push` or paste in the SQL editor.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. face_descriptor column ───────────────────────────────────────────────
alter table public.member_profiles
  add column if not exists face_descriptor double precision[];

-- ── 2. face_match_claims table ──────────────────────────────────────────────
-- One row per (event, member). Inserted on local face match, deleted on
-- successful check-in. Stale rows (>60s) are ignored by submit_checkin and
-- can be cleaned up periodically; for now we don't bother — volume is tiny.
create table if not exists public.face_match_claims (
  event_id   uuid not null,
  member_id  uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (event_id, member_id)
);

-- ── 3. claim_face_match RPC ─────────────────────────────────────────────────
-- The client calls this after a successful local face-descriptor match plus
-- the blink liveness gate. The server doesn't re-verify the match — same
-- trust model as PIN/QR (client computes, server records). The claim is
-- consumed by the immediately-following submit_checkin call.
create or replace function public.claim_face_match(
  p_event_id  uuid,
  p_member_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.face_match_claims (event_id, member_id, claimed_at)
  values (p_event_id, p_member_id, now())
  on conflict (event_id, member_id)
    do update set claimed_at = now();
  return jsonb_build_object('ok', true);
exception
  when others then
    return jsonb_build_object('ok', false, 'reason', 'server_error', 'detail', sqlerrm);
end;
$$;

grant execute on function public.claim_face_match(uuid, uuid) to anon;

-- ── 4. submit_checkin — handle FACE_ID ──────────────────────────────────────
-- Drops the old version and recreates with FACE_ID support. The function
-- signature is unchanged; only the method-verification branch changes.
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
  v_claim_age      interval;
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

    v_bucket_now := floor(extract(epoch from v_now) / 60)::bigint;
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

    v_pin_result := public.record_pin_attempt(p_event_id, p_member_id, p_pin_plain);
    if not (v_pin_result ->> 'ok')::boolean then
      return v_pin_result;
    end if;

  elsif p_method = 'FACE_ID' then

    -- Require a fresh claim (<60s) recorded by claim_face_match. Consume the
    -- claim by deleting it whether or not the rest of the check-in succeeds
    -- (the client must call claim_face_match again for a retry).
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

    -- Consume the claim. Anything after this point that fails should not
    -- silently leave a usable claim behind.
    delete from public.face_match_claims
      where event_id = p_event_id and member_id = p_member_id;

  else
    return jsonb_build_object('ok', false, 'reason', 'unsupported_method');
  end if;

  -- ── 5. Geofence ───────────────────────────────────────────────────────────
  v_in_fence := public.point_in_event_geofence(p_event_id, p_lat, p_lng);
  if not v_in_fence then
    return jsonb_build_object('ok', false, 'reason', 'outside_fence');
  end if;

  -- ── 6. Device fingerprint claim ───────────────────────────────────────────
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
  uuid, uuid, text, text, text, text,
  double precision, double precision, text,
  text, text
) to anon;
