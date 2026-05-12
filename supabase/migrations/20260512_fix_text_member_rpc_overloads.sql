-- Migration: remove UUID member-id RPC overloads
--
-- Member IDs come from the FLC graph as text ObjectIds. Earlier migrations
-- converted the tables to text, but later RPC migrations recreated UUID
-- overloads. PostgREST cannot choose between submit_checkin(text) and
-- submit_checkin(uuid), so check-in requests fail before reaching PL/pgSQL.

drop function if exists public.submit_checkin(
  uuid, uuid, text, text, text, text,
  double precision, double precision, text,
  text, text
);

drop function if exists public.claim_face_match(uuid, uuid);
drop function if exists public.record_pin_attempt(uuid, uuid, text);
drop function if exists public.report_member_location(uuid, uuid, double precision, double precision);

alter table if exists public.face_match_claims
  drop constraint if exists face_match_claims_pkey;

alter table if exists public.face_match_claims
  alter column member_id type text using member_id::text;

alter table if exists public.face_match_claims
  add constraint face_match_claims_pkey primary key (event_id, member_id);

create or replace function public.claim_face_match(
  p_event_id  uuid,
  p_member_id text
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

grant execute on function public.claim_face_match(uuid, text) to anon;

create or replace function public.record_pin_attempt(
  p_event_id   uuid,
  p_member_id  text,
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
    return jsonb_build_object(
      'ok', false,
      'reason', 'locked_out',
      'lockout_until', now() + interval '15 minutes'
    );
  end if;

  insert into public.checkin_attempts (event_id, member_id, success)
    values (p_event_id, p_member_id, false);

  v_attempts_left := 5 - (v_attempts_in_win + 1);
  return jsonb_build_object(
    'ok', false,
    'reason', 'wrong_pin',
    'attempts_left', v_attempts_left
  );
end;
$$;

grant execute on function public.record_pin_attempt(uuid, text, text) to anon;

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

  if v_now < v_event.starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;

  if v_now > v_event.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'event_ended');
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
      v_event.qr_secret,
      'sha256'
    );
    v_otp_int := (('x' || right(encode(v_otp_hmac, 'hex'), 8))::bit(32)::int4::bigint
                  + 4294967296) % 4294967296 % 1000000;
    v_otp_cur := lpad(v_otp_int::text, 6, '0');

    v_otp_hmac := extensions.hmac(
      convert_to(p_event_id::text || ':' || (v_pin_bucket_now - 1)::text, 'UTF8'),
      v_event.qr_secret,
      'sha256'
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
    v_device_ok := public.claim_device_for_event(p_event_id, p_fingerprint, p_member_id);
    if not v_device_ok then
      return jsonb_build_object('ok', false, 'reason', 'device_already_used');
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
      'id', v_record_id,
      'is_late', v_is_late,
      'method', p_method
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

create or replace function public.report_member_location(
  p_event_id  uuid,
  p_member_id text,
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
       set checked_out_at = now(),
           auto_checked_out = true
     where event_id = p_event_id
       and member_id = p_member_id
       and checked_out_at is null;

    if found then
      v_was_checked_out := true;
    end if;
  end if;

  return jsonb_build_object('inside_fence', v_inside, 'checked_out', v_was_checked_out);
end;
$$;

grant execute on function public.report_member_location(
  uuid, text, double precision, double precision
) to anon;
