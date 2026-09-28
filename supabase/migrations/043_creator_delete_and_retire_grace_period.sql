-- 043: Creator-owned deletes, retire grace period / auto-checkout, add rate RPC.
--
-- ── 1. delete_event was BROKEN by migration 041 ─────────────────────────────
-- It authorised against `public.superadmins`, which 041 dropped, so every call
-- would fail at runtime. Rewritten with graph-derived authorisation:
--
--   • the event's CREATOR may delete it (created_by_id matches the caller), and
--   • denomination admins may delete any event — the former superadmin rule,
--     now read from member_profiles.roles instead of an allowlist.
--
-- Email is kept as a secondary identity resolver for accounts whose auth id
-- differs from their graph member id, the same bridge
-- resolve_event_snapshot_member uses. Dependent rows go via existing CASCADEs.
--
-- ── 2. Grace period and auto-checkout retired ───────────────────────────────
-- Attendance is binary (migration 028): a checkin_records row means Present, no
-- row means Absent. `is_late` was grace_period_min's only consumer and nothing
-- reads is_late — it is absent from CHECKIN_RECORD_COLUMNS and from every
-- screen. So every check-in did interval arithmetic to populate a dead column.
--
-- 043b writes is_late = false. The COLUMNS stay on both tables: historical rows
-- keep their values, and older deployed clients still send the create params.
-- They are simply no longer read, derived from, or offered in the UI.
--
-- ── 3. get_event_checkin_rate ───────────────────────────────────────────────
-- "42 present" does not answer the question asked during a service, which is
-- "are people still arriving?". Backed by checkin_records_event_time_idx
-- (event_id, checked_in_at desc) from migration 032.

create or replace function public.delete_event(
  p_event_id    uuid,
  p_admin_email text,
  p_member_id   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existed        integer;
  v_event_name     text;
  v_created_by     text;
  v_email          text := nullif(lower(trim(coalesce(p_admin_email, ''))), '');
  v_allowed        boolean := false;
  v_is_denom_admin boolean := false;
begin
  select name, created_by_id
    into v_event_name, v_created_by
    from public.checkin_events
   where id = p_event_id;

  if v_event_name is null then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- Creator check: direct id match, or via the email bridge.
  if p_member_id is not null and v_created_by is not null
     and v_created_by = p_member_id then
    v_allowed := true;
  elsif v_email is not null and v_created_by is not null then
    select true into v_allowed
      from public.member_profiles mp
     where mp.id = v_created_by
       and lower(mp.email) = v_email
     limit 1;
    v_allowed := coalesce(v_allowed, false);
  end if;

  -- Denomination admins may delete any event.
  if not v_allowed then
    select true into v_is_denom_admin
      from public.member_profiles mp
     where (
             (p_member_id is not null and mp.id = p_member_id)
             or (v_email is not null and lower(mp.email) = v_email)
           )
       and 'adminDenomination' = any(coalesce(mp.roles, array[]::text[]))
     limit 1;
    v_allowed := coalesce(v_is_denom_admin, false);
  end if;

  if not v_allowed then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  delete from public.checkin_events where id = p_event_id;
  get diagnostics v_existed = row_count;

  return jsonb_build_object(
    'ok', v_existed > 0,
    'event_id', p_event_id,
    'event_name', v_event_name
  );
end;
$$;

grant execute on function public.delete_event(uuid, text, text) to anon, authenticated;

create or replace function public.get_event_checkin_rate(
  p_event_id   uuid,
  p_window_min int default 5
)
returns table (recent int, window_min int)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::int as recent,
    greatest(p_window_min, 1) as window_min
  from public.checkin_records r
  where r.event_id = p_event_id
    and r.checked_in_at >= now() - (greatest(p_window_min, 1) * interval '1 minute');
$$;

grant execute on function public.get_event_checkin_rate(uuid, int) to anon, authenticated;

-- ── 043b: submit_checkin with is_late := false ─────────────────────────────
-- Originally applied to prod as a separate statement and never committed, so
-- the repo could not reproduce prod. Restored 2026-09-28 verbatim from
-- pg_get_functiondef on prod. Behaviour is identical to migration 035 apart
-- from the is_late line.
CREATE OR REPLACE FUNCTION public.submit_checkin(p_event_id uuid, p_member_id text, p_member_name text, p_member_role text, p_member_unit text, p_method text, p_lat double precision, p_lng double precision, p_fingerprint text, p_qr_token text DEFAULT NULL::text, p_pin_plain text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  v_is_late        boolean;
  v_record_id      uuid;
  v_claim_age      interval;
  v_existing       public.checkin_records%rowtype;
  v_snapshot_id    text;
  v_profile_roles  text[];
  v_eligible       boolean;
  v_device_owner   text;
  v_owner_name     text;
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
      'ok', false, 'reason', 'not_started',
      'opens_at', (v_event.starts_at - interval '1 hour')
    );
  end if;
  if v_now > v_event.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'event_ended');
  end if;

  select * into v_existing
    from public.checkin_records
   where event_id = p_event_id and member_id = p_member_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'reason', 'already_checked_in',
      'record', jsonb_build_object(
        'id', v_existing.id, 'is_late', v_existing.is_late, 'method', v_existing.method)
    );
  end if;

  select snapshot_member_id, profile_roles
    into v_snapshot_id, v_profile_roles
    from public.resolve_event_snapshot_member(p_event_id, array[p_member_id], null);

  if v_snapshot_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;

  v_eligible := v_event.scope_level = 'special_group'
                or public.roles_overlap_allowed(v_profile_roles, v_event.allowed_roles);
  if not v_eligible then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
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
      v_event.qr_secret, 'sha256'
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
      v_event.qr_secret, 'sha256');
    v_otp_int := (('x' || right(encode(v_otp_hmac, 'hex'), 8))::bit(32)::int4::bigint
                  + 4294967296) % 4294967296 % 1000000;
    v_otp_cur := lpad(v_otp_int::text, 6, '0');
    v_otp_hmac := extensions.hmac(
      convert_to(p_event_id::text || ':' || (v_pin_bucket_now - 1)::text, 'UTF8'),
      v_event.qr_secret, 'sha256');
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

  if v_event.geofence_type = 'circle' then
    v_in_fence := public.haversine_meters(
      v_event.geofence_center_lat, v_event.geofence_center_lng, p_lat, p_lng
    ) <= v_event.geofence_radius_m;
  elsif v_event.geofence_type = 'polygon' then
    v_in_fence := public.point_in_polygon(p_lat, p_lng, v_event.geofence_polygon);
  else
    v_in_fence := false;
  end if;
  if not v_in_fence then
    return jsonb_build_object('ok', false, 'reason', 'outside_fence');
  end if;

  if p_method <> 'MANUAL' then
    insert into public.checkin_devices (event_id, device_fingerprint, member_id)
      values (p_event_id, p_fingerprint, p_member_id)
      on conflict (event_id, device_fingerprint) do nothing;

    select member_id into v_device_owner
      from public.checkin_devices
     where event_id = p_event_id and device_fingerprint = p_fingerprint;

    if v_device_owner is distinct from p_member_id then
      select member_name into v_owner_name
        from public.checkin_records
       where event_id = p_event_id and member_id = v_device_owner
       limit 1;
      if v_owner_name is null then
        select coalesce(
                 nullif(trim(coalesce(title, '') || ' ' || coalesce(first_name, '')
                             || ' ' || coalesce(last_name, '')), ''),
                 email)
          into v_owner_name
          from public.member_profiles
         where id = v_device_owner;
      end if;
      return jsonb_build_object(
        'ok', false, 'reason', 'device_already_used',
        'claimed_by_member_id', v_device_owner,
        'claimed_by_name',      v_owner_name
      );
    end if;
  end if;

  -- Grace period retired: attendance is binary, and is_late has no consumer.
  v_is_late := false;

  insert into public.checkin_records (
    event_id, member_id, member_name, member_role, member_unit_name,
    method, geo_verified, check_in_lat, check_in_lng, device_fingerprint, is_late
  ) values (
    p_event_id, p_member_id, p_member_name, p_member_role, p_member_unit,
    p_method, true, p_lat, p_lng, p_fingerprint, v_is_late
  )
  returning id into v_record_id;

  return jsonb_build_object(
    'ok', true,
    'record', jsonb_build_object('id', v_record_id, 'is_late', v_is_late, 'method', p_method)
  );

exception
  when unique_violation then
    select * into v_existing
      from public.checkin_records
     where event_id = p_event_id and member_id = p_member_id;
    if found then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_checked_in',
        'record', jsonb_build_object(
          'id', v_existing.id, 'is_late', v_existing.is_late, 'method', v_existing.method)
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'already_checked_in');
  when others then
    return jsonb_build_object('ok', false, 'reason', 'server_error', 'detail', sqlerrm);
end;
$function$;
