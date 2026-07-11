-- 029: Snapshot-based event entry gate + check-in eligibility enforcement.
--
-- Leaders opening a live event should be routed to check-in before any
-- dashboard fan-out. Eligibility is derived from event_scope_members +
-- member_profiles.roles (written at event creation), not a live graph probe.

-- Resolve the snapshotted graph member id for a caller. Matches direct id,
-- auth-profile id, or email bridge across member_profiles rows.
create or replace function public.resolve_event_snapshot_member(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null
)
returns table (
  snapshot_member_id text,
  profile_roles      text[]
)
language sql
security definer
set search_path = public
as $$
  select
    esm.member_id,
    coalesce(p_graph.roles, array[]::text[])
  from public.event_scope_members esm
  join public.member_profiles p_graph on p_graph.id = esm.member_id
  where esm.event_id = p_event_id
    and (
      esm.member_id = any(coalesce(p_member_ids, array[]::text[]))
      or (
        p_email is not null
        and lower(coalesce(p_graph.email, '')) = lower(p_email)
      )
      or exists (
        select 1
        from unnest(coalesce(p_member_ids, array[]::text[])) as mid(member_id)
        join public.member_profiles p_auth on p_auth.id = mid.member_id
        where p_email is not null
          and lower(coalesce(p_auth.email, '')) = lower(p_email)
      )
    )
  order by esm.member_id
  limit 1;
$$;

create or replace function public.roles_overlap_allowed(
  p_profile_roles text[],
  p_allowed_roles text[]
)
returns boolean
language sql
immutable
as $$
  select coalesce(
    exists (
      select 1
      from unnest(coalesce(p_profile_roles, array[]::text[])) as r(role)
      where r.role = any(coalesce(p_allowed_roles, array[]::text[]))
    ),
    false
  );
$$;

create or replace function public.member_eligible_for_event_checkin(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event            public.checkin_events%rowtype;
  v_snapshot_id      text;
  v_profile_roles    text[];
  v_email            text;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return false;
  end if;

  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  if v_email is null then
    select lower(email) into v_email
    from public.member_profiles
    where id = any(coalesce(p_member_ids, array[]::text[]))
      and email is not null
    limit 1;
  end if;

  select snapshot_member_id, profile_roles
    into v_snapshot_id, v_profile_roles
    from public.resolve_event_snapshot_member(p_event_id, p_member_ids, v_email);

  if v_snapshot_id is null then
    return false;
  end if;

  if v_event.scope_level = 'special_group' then
    return true;
  end if;

  return public.roles_overlap_allowed(v_profile_roles, v_event.allowed_roles);
end;
$$;

create or replace function public.get_event_entry_state(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event            public.checkin_events%rowtype;
  v_now              timestamptz := now();
  v_snapshot_id      text;
  v_profile_roles    text[];
  v_in_snapshot      boolean := false;
  v_role_eligible    boolean := false;
  v_eligible         boolean := false;
  v_checked_in       boolean := false;
  v_checkin_open     boolean := false;
  v_ids              text[];
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_checkin_open :=
    v_event.status = 'ACTIVE'
    and v_now >= (v_event.starts_at - interval '1 hour')
    and v_now <= v_event.ends_at;

  select snapshot_member_id, profile_roles
    into v_snapshot_id, v_profile_roles
    from public.resolve_event_snapshot_member(p_event_id, p_member_ids, p_email);

  v_in_snapshot := v_snapshot_id is not null;

  if v_in_snapshot then
    if v_event.scope_level = 'special_group' then
      v_role_eligible := true;
    else
      v_role_eligible := public.roles_overlap_allowed(v_profile_roles, v_event.allowed_roles);
    end if;
  end if;

  v_eligible := v_in_snapshot and v_role_eligible;

  v_ids := coalesce(p_member_ids, array[]::text[]);
  if v_snapshot_id is not null then
    v_ids := v_ids || array[v_snapshot_id];
  end if;

  select exists (
    select 1
    from public.checkin_records cr
    where cr.event_id = p_event_id
      and cr.member_id = any(v_ids)
  ) into v_checked_in;

  return jsonb_build_object(
    'found', true,
    'event_status', v_event.status,
    'scope_level', v_event.scope_level,
    'allowed_roles', coalesce(v_event.allowed_roles, array[]::text[]),
    'checkin_open', v_checkin_open,
    'snapshot_member_id', v_snapshot_id,
    'in_snapshot', v_in_snapshot,
    'role_eligible', v_role_eligible,
    'eligible_for_checkin', v_eligible,
    'already_checked_in', v_checked_in
  );
end;
$$;

grant execute on function public.resolve_event_snapshot_member(uuid, text[], text) to anon, authenticated;
grant execute on function public.roles_overlap_allowed(text[], text[]) to anon, authenticated;
grant execute on function public.member_eligible_for_event_checkin(uuid, text[], text) to anon, authenticated;
grant execute on function public.get_event_entry_state(uuid, text[], text) to anon, authenticated;

-- Enforce snapshot eligibility on self-service check-in (after idempotent hit).
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

  if not public.member_eligible_for_event_checkin(
    p_event_id,
    array[p_member_id],
    null
  ) then
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
