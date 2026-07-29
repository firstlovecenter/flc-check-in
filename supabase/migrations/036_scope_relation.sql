-- 036: Answer "where does this hat sit relative to this event?" server-side.
--
-- The client now acts as ONE (role, church) pair at a time. Capability follows
-- from where that hat sits relative to the event: at it, above it, below it, or
-- somewhere else entirely. See src/utils/eventCaps.ts.
--
-- Why this belongs on the server
-- -----------------------------
-- The alternative was fetching the event's ancestor chain from Neo4j on every
-- event open, which would undo the round-trip savings of open_checkin. The
-- church_hierarchy cache already holds the tree; a bounded recursive walk over
-- it costs microseconds.
--
-- Why it reports `verified`
-- -------------------------
-- church_hierarchy is an opportunistic cache and can be incomplete — migration
-- 034 deliberately emptied its parent links to purge fabricated ones. When the
-- walk cannot reach the hat's level, containment is genuinely unknown.
--
-- Failing closed there would strip supervisors of access mid-service. Failing
-- open would hand management of an event to someone who may not own it. So we
-- do neither: an unverified ancestor keeps VISIBILITY and loses MANAGEMENT.
-- That is still strictly tighter than the old client rule, which granted
-- management to anyone holding any higher role anywhere, with no containment
-- check at all. As the cache refills, unverified answers become verified ones.

create or replace function public.event_scope_relation(
  p_event_id  uuid,
  p_hat_level text,
  p_hat_id    text,
  p_in_snapshot boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_levels        text[] := array['bacenta','governorship','council','stream','campus','oversight','denomination'];
  v_event_level   text;
  v_event_church  text;
  v_event_idx     int;
  v_hat_idx       int;
  v_found         boolean := false;
  v_max_reached   int := -1;
begin
  if p_hat_level is null or p_hat_id is null then
    return jsonb_build_object('relation', 'unrelated', 'verified', true);
  end if;

  select scope_level, scope_church_id
    into v_event_level, v_event_church
    from public.checkin_events
   where id = p_event_id;

  if v_event_level is null then
    return jsonb_build_object('relation', 'unrelated', 'verified', true);
  end if;

  -- Special-group events sit outside the church tree. Membership in the
  -- snapshot is the only meaningful relation there.
  if v_event_level = 'special_group' then
    return jsonb_build_object(
      'relation', case when p_in_snapshot then 'exact' else 'unrelated' end,
      'verified', true
    );
  end if;

  if p_hat_level = v_event_level and p_hat_id = v_event_church then
    return jsonb_build_object('relation', 'exact', 'verified', true);
  end if;

  v_event_idx := array_position(v_levels, v_event_level);
  v_hat_idx   := array_position(v_levels, p_hat_level);

  if v_event_idx is null or v_hat_idx is null then
    return jsonb_build_object('relation', 'unrelated', 'verified', true);
  end if;

  -- ── Hat BELOW the event: the viewer is an attendee ────────────────────────
  -- Presence in event_scope_members is proof of containment: the snapshot was
  -- built from everyone structurally within the event's scope at creation.
  -- No hierarchy walk needed, and it stays correct even when the cache is cold.
  if v_hat_idx < v_event_idx then
    if p_in_snapshot then
      return jsonb_build_object('relation', 'descendant', 'verified', true);
    end if;
    -- Not in the snapshot — walk up from the hat's own church instead.
    with recursive up as (
      select h.id, h.level, h.parent_id, 0 as depth
        from public.church_hierarchy h
       where h.id = p_hat_id and h.level = p_hat_level
      union all
      select p.id, p.level, p.parent_id, u.depth + 1
        from public.church_hierarchy p
        join up u on p.id = u.parent_id
       where u.depth < 10
    )
    select bool_or(up.id = v_event_church and up.level = v_event_level),
           coalesce(max(array_position(v_levels, up.level)), -1)
      into v_found, v_max_reached
      from up;

    if coalesce(v_found, false) then
      return jsonb_build_object('relation', 'descendant', 'verified', true);
    end if;
    -- Walked past the event's level without finding it → definitively outside.
    if v_max_reached >= v_event_idx then
      return jsonb_build_object('relation', 'unrelated', 'verified', true);
    end if;
    return jsonb_build_object('relation', 'unrelated', 'verified', false);
  end if;

  -- ── Hat ABOVE the event: the viewer may be supervising ────────────────────
  with recursive up as (
    select h.id, h.level, h.parent_id, 0 as depth
      from public.church_hierarchy h
     where h.id = v_event_church and h.level = v_event_level
    union all
    select p.id, p.level, p.parent_id, u.depth + 1
      from public.church_hierarchy p
      join up u on p.id = u.parent_id
     where u.depth < 10
  )
  select bool_or(up.id = p_hat_id and up.level = p_hat_level),
         coalesce(max(array_position(v_levels, up.level)), -1)
    into v_found, v_max_reached
    from up;

  if coalesce(v_found, false) then
    return jsonb_build_object('relation', 'ancestor', 'verified', true);
  end if;

  -- The walk reached the hat's level (or higher) without hitting it — the hat
  -- is on a different branch. Definitive.
  if v_max_reached >= v_hat_idx then
    return jsonb_build_object('relation', 'unrelated', 'verified', true);
  end if;

  -- The chain broke before we could tell. Preserve visibility, withhold
  -- management, and let the cache heal.
  return jsonb_build_object('relation', 'ancestor', 'verified', false);
end;
$$;

grant execute on function public.event_scope_relation(uuid, text, text, boolean) to anon, authenticated;


-- ─── Fold the relation into the two entry RPCs ──────────────────────────────
-- Both gain optional hat parameters.
--
-- The DROPs below are load-bearing. CREATE OR REPLACE cannot ADD parameters to
-- an existing function — Postgres treats a different parameter list as a
-- different function and creates an OVERLOAD. With both a 3-arg and a 5-arg
-- version present, a 3-arg call becomes ambiguous and fails outright:
--   ERROR: function get_event_entry_state(uuid, text[], text) is not unique
-- Dropping the old signature first is what makes this a replacement rather
-- than an ambiguous pair.
--
-- Because the new parameters carry defaults, callers passing only three
-- arguments still work against the 5-arg version — so an older deployed client
-- keeps functioning through the rollout.
drop function if exists public.get_event_entry_state(uuid, text[], text);
drop function if exists public.open_checkin(uuid, text[], text);

create or replace function public.get_event_entry_state(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null,
  p_hat_level  text default null,
  p_hat_id     text default null
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
  v_in_snapshot   boolean := false;
  v_role_eligible boolean := false;
  v_eligible      boolean := false;
  v_checked_in    boolean := false;
  v_checkin_open  boolean := false;
  v_ids           text[];
  v_relation      jsonb;
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
    select 1 from public.checkin_records cr
     where cr.event_id = p_event_id and cr.member_id = any(v_ids)
  ) into v_checked_in;

  v_relation := public.event_scope_relation(p_event_id, p_hat_level, p_hat_id, v_in_snapshot);

  return jsonb_build_object(
    'found', true,
    'event_status', v_event.status,
    'scope_level', v_event.scope_level,
    'scope_church_id', v_event.scope_church_id,
    'scope_church_name', v_event.scope_church_name,
    'allowed_roles', coalesce(v_event.allowed_roles, array[]::text[]),
    'checkin_open', v_checkin_open,
    'snapshot_member_id', v_snapshot_id,
    'in_snapshot', v_in_snapshot,
    'role_eligible', v_role_eligible,
    'eligible_for_checkin', v_eligible,
    'already_checked_in', v_checked_in,
    'scope_relation', v_relation->>'relation',
    'scope_relation_verified', (v_relation->>'verified')::boolean
  );
end;
$$;

grant execute on function public.get_event_entry_state(uuid, text[], text, text, text) to anon, authenticated;


create or replace function public.open_checkin(
  p_event_id   uuid,
  p_member_ids text[],
  p_email      text default null,
  p_hat_level  text default null,
  p_hat_id     text default null
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
  v_relation      jsonb;
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

  v_relation := public.event_scope_relation(p_event_id, p_hat_level, p_hat_id, v_in_snapshot);

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
      'event_status',            v_event.status,
      'scope_level',             v_event.scope_level,
      'scope_church_id',         v_event.scope_church_id,
      'scope_church_name',       v_event.scope_church_name,
      'allowed_roles',           coalesce(v_event.allowed_roles, array[]::text[]),
      'checkin_open',            v_event.status = 'ACTIVE'
                                 and v_now >= (v_event.starts_at - interval '1 hour')
                                 and v_now <= v_event.ends_at,
      'snapshot_member_id',      v_snapshot_id,
      'in_snapshot',             v_in_snapshot,
      'role_eligible',           v_eligible,
      'eligible_for_checkin',    v_eligible,
      'already_checked_in',      v_record.id is not null,
      'scope_relation',          v_relation->>'relation',
      'scope_relation_verified', (v_relation->>'verified')::boolean
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

grant execute on function public.open_checkin(uuid, text[], text, text, text) to anon, authenticated;
