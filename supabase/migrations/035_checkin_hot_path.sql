-- 035: Make the check-in hot path O(1) instead of O(event scope size).
--
-- ════════════════════════════════════════════════════════════════════════════
--  1. THE PERFORMANCE BUG
-- ════════════════════════════════════════════════════════════════════════════
-- resolve_event_snapshot_member (migration 029) filtered with:
--
--     where esm.event_id = p_event_id
--       and ( esm.member_id = any(p_member_ids)
--             or <email match on the joined profile>
--             or <an EXISTS subquery> )
--
-- The OR prevents the planner from using the event_scope_members primary key
-- to jump straight to the caller's row. It walks EVERY scope member of the
-- event, joins member_profiles for each, evaluates the predicate, sorts, and
-- takes one row.
--
-- That function sits on the two hottest paths in the app: get_event_entry_state
-- (every event open) and submit_checkin (every submission). On a 5,000-member
-- event that is 5,000 row touches per check-in. Fifty people checking in at
-- once is a quarter of a million.
--
-- There was also no index supporting the email branch — lower(email) is not
-- sargable against a plain column index, so that path was a sequential scan of
-- the whole member_profiles table.
--
-- ════════════════════════════════════════════════════════════════════════════
--  2. THE CORRECTNESS BUG (more serious than the performance one)
-- ════════════════════════════════════════════════════════════════════════════
-- The third OR branch was:
--
--     or exists (
--       select 1 from unnest(p_member_ids) as mid(member_id)
--       join member_profiles p_auth on p_auth.id = mid.member_id
--       where p_email is not null and lower(p_auth.email) = lower(p_email))
--
-- That subquery does not reference `esm` at all. It is uncorrelated: when it
-- is true it is true for EVERY row of the event scope. Combined with
-- `order by esm.member_id limit 1`, the function then returned whichever
-- scope member sorts first alphabetically — NOT the caller.
--
-- Consequences when it fired (caller passes an email that matches one of their
-- own profile rows — the normal case from loadEventEntryState, which always
-- sends user.email):
--   • get_event_entry_state reported a snapshot_member_id belonging to someone
--     else, and evaluated role eligibility against THAT person's roles.
--   • submit_checkin's eligibility gate could therefore pass or fail on a
--     stranger's roles rather than the caller's.
--
-- The rewrite resolves the email bridge the way it was evidently intended:
-- email → member id (indexed), then probe the snapshot for that id.
--
-- ════════════════════════════════════════════════════════════════════════════
--  3. WHAT ELSE CHANGES
-- ════════════════════════════════════════════════════════════════════════════
-- submit_checkin re-read rows it already had in memory: the event was fetched
-- once at the top, then again inside member_eligible_for_event_checkin, then a
-- third time inside point_in_event_geofence; claim_device_for_event re-queried
-- checkin_records for an existing record the function had already proven absent.
-- All of that is now inlined against values already in scope.
--
-- Behaviour is otherwise identical — same reason codes, same order of checks,
-- same idempotency semantics.


--  4. THE is_active GATE (added by migration 033, MUST be preserved)
-- ════════════════════════════════════════════════════════════════════════════
-- migration 033 (member_profile_activity) added `and p_graph.is_active` so a
-- member who no longer holds a Graph leader/admin relationship cannot check in,
-- while their profile and attendance history are retained. Both probes below
-- carry it. Dropping it silently re-enables self-check-in for deactivated
-- members the moment anyone is marked inactive.


-- ─── Index for the email bridge ─────────────────────────────────────────────
-- CONCURRENTLY is omitted because Supabase runs migrations inside a
-- transaction. On a large member_profiles this briefly locks writes; run
-- off-peak.
create index if not exists member_profiles_lower_email_idx
  on public.member_profiles (lower(email))
  where email is not null;


-- ─── resolve_event_snapshot_member: two indexed probes, no scan ─────────────
create or replace function public.resolve_event_snapshot_member(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null
)
returns table (
  snapshot_member_id text,
  profile_roles      text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    text;
  v_roles text[];
  v_email text;
begin
  -- Probe 1: direct id hit. Uses the (event_id, member_id) primary key, so
  -- this is an index scan of a couple of rows regardless of scope size.
  -- Virtually every real call resolves here.
  select esm.member_id, coalesce(mp.roles, array[]::text[])
    into v_id, v_roles
    from public.event_scope_members esm
    join public.member_profiles mp on mp.id = esm.member_id
   where esm.event_id = p_event_id
     and mp.is_active
     and esm.member_id = any(coalesce(p_member_ids, array[]::text[]))
   order by esm.member_id
   limit 1;

  if v_id is not null then
    snapshot_member_id := v_id;
    profile_roles      := v_roles;
    return next;
    return;
  end if;

  -- Probe 2: the email bridge, for accounts whose auth id differs from their
  -- graph member id. Resolve the email to member ids FIRST (indexed by
  -- member_profiles_lower_email_idx), then probe the snapshot by primary key.
  -- This is what the old uncorrelated EXISTS branch was trying to express.
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');

  if v_email is null then
    -- No email supplied — fall back to the email on the caller's own profile,
    -- matching the old behaviour of member_eligible_for_event_checkin.
    select lower(mp.email) into v_email
      from public.member_profiles mp
     where mp.id = any(coalesce(p_member_ids, array[]::text[]))
       and mp.email is not null
     limit 1;
  end if;

  if v_email is null then
    return;
  end if;

  select esm.member_id, coalesce(mp.roles, array[]::text[])
    into v_id, v_roles
    from public.member_profiles mp
    join public.event_scope_members esm
      on esm.event_id = p_event_id and esm.member_id = mp.id
   where lower(mp.email) = v_email
     and mp.is_active
   order by esm.member_id
   limit 1;

  if v_id is null then
    return;
  end if;

  snapshot_member_id := v_id;
  profile_roles      := v_roles;
  return next;
end;
$$;


-- ─── submit_checkin: one event read, everything inlined ────────────────────
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
  -- 1. Event — read ONCE. Everything below uses v_event.
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- 2. Status and time window.
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

  -- 3. Idempotent early return — a retry after a lost response is a success,
  --    not a "you already checked in" error.
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

  -- 4. Snapshot eligibility. Resolved once here rather than via
  --    member_eligible_for_event_checkin, which would re-read the event row.
  select snapshot_member_id, profile_roles
    into v_snapshot_id, v_profile_roles
    from public.resolve_event_snapshot_member(p_event_id, array[p_member_id], null);

  if v_snapshot_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;

  -- Special-group membership IS eligibility; roles are irrelevant there.
  v_eligible := v_event.scope_level = 'special_group'
                or public.roles_overlap_allowed(v_profile_roles, v_event.allowed_roles);
  if not v_eligible then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;

  -- 5. Method allowed for this event.
  if not (p_method = any(v_event.allowed_check_in_methods)) then
    return jsonb_build_object('ok', false, 'reason', 'method_not_allowed');
  end if;

  -- 6. Method-specific verification.
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

  -- 7. Geofence — inlined. point_in_event_geofence would re-select the event
  --    row we already hold.
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

  -- 8. Device claim — inlined. claim_device_for_event's first act is to check
  --    whether this member already has a record on this event; step 3 above
  --    has already proven they do not, so that query is pure waste here.
  --    (The standalone function is left in place for any other caller.)
  if p_method <> 'MANUAL' then
    insert into public.checkin_devices (event_id, device_fingerprint, member_id)
      values (p_event_id, p_fingerprint, p_member_id)
      on conflict (event_id, device_fingerprint) do nothing;

    select member_id into v_device_owner
      from public.checkin_devices
     where event_id = p_event_id and device_fingerprint = p_fingerprint;

    if v_device_owner is distinct from p_member_id then
      -- Best-effort attribution so the UI can name who holds the device.
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

  -- 9. Late detection + insert.
  v_is_late := v_now > (v_event.starts_at + (v_event.grace_period_min * interval '1 minute'));

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
    -- Race: a concurrent connection inserted the same (event_id, member_id)
    -- between step 3 and step 9. Idempotent success, not a failure.
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
$$;


-- ─── open_checkin: the whole check-in screen load in one round trip ─────────
-- The client used to make three sequential calls to render the check-in
-- screen: get_event_entry_state, then getEvent, then getMyRecord. On a phone
-- on venue wifi that is three full latency round trips before the scanner
-- appears — and three PostgREST connections per attendee, which is what
-- actually saturates a small instance when a crowd arrives at once.
--
-- Returns everything the screen needs. qr_secret is deliberately EXCLUDED:
-- the check-in screen never needs it (the server verifies the PIN/QR), and
-- shipping it would let any client mint valid codes for the event.
create or replace function public.open_checkin(
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
  v_event         public.checkin_events%rowtype;
  v_now           timestamptz := now();
  v_snapshot_id   text;
  v_profile_roles text[];
  v_record        public.checkin_records%rowtype;
  v_ids           text[];
  v_eligible      boolean := false;
  v_in_snapshot   boolean := false;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select snapshot_member_id, profile_roles
    into v_snapshot_id, v_profile_roles
    from public.resolve_event_snapshot_member(p_event_id, p_member_ids, p_email);

  v_in_snapshot := v_snapshot_id is not null;
  if v_in_snapshot then
    v_eligible := v_event.scope_level = 'special_group'
                  or public.roles_overlap_allowed(v_profile_roles, v_event.allowed_roles);
  end if;

  v_ids := coalesce(p_member_ids, array[]::text[]);
  if v_snapshot_id is not null then
    v_ids := v_ids || array[v_snapshot_id];
  end if;

  select * into v_record
    from public.checkin_records
   where event_id = p_event_id and member_id = any(v_ids)
   limit 1;

  return jsonb_build_object(
    'found', true,
    'event', jsonb_build_object(
      'id',                       v_event.id,
      'name',                     v_event.name,
      'event_type',               v_event.event_type,
      'status',                   v_event.status,
      'scope_level',              v_event.scope_level,
      'scope_church_id',          v_event.scope_church_id,
      'scope_church_name',        v_event.scope_church_name,
      'venue_name',               v_event.venue_name,
      'starts_at',                v_event.starts_at,
      'ends_at',                  v_event.ends_at,
      'grace_period_min',         v_event.grace_period_min,
      'allowed_check_in_methods', v_event.allowed_check_in_methods,
      'allowed_roles',            v_event.allowed_roles,
      'geofence_type',            v_event.geofence_type,
      'geofence_center_lat',      v_event.geofence_center_lat,
      'geofence_center_lng',      v_event.geofence_center_lng,
      'geofence_radius_m',        v_event.geofence_radius_m,
      'geofence_polygon',         v_event.geofence_polygon,
      'is_public',                v_event.is_public
    ),
    'entry', jsonb_build_object(
      'event_status',         v_event.status,
      'scope_level',          v_event.scope_level,
      'allowed_roles',        coalesce(v_event.allowed_roles, array[]::text[]),
      'checkin_open',         v_event.status = 'ACTIVE'
                              and v_now >= (v_event.starts_at - interval '1 hour')
                              and v_now <= v_event.ends_at,
      'snapshot_member_id',   v_snapshot_id,
      'in_snapshot',          v_in_snapshot,
      'role_eligible',        v_eligible,
      'eligible_for_checkin', v_eligible,
      'already_checked_in',   v_record.id is not null
    ),
    'record', case when v_record.id is null then null else jsonb_build_object(
      'id',            v_record.id,
      'member_id',     v_record.member_id,
      'method',        v_record.method,
      'checked_in_at', v_record.checked_in_at,
      'is_late',       v_record.is_late
    ) end
  );
end;
$$;

grant execute on function public.open_checkin(uuid, text[], text) to anon, authenticated;
