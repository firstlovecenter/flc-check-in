-- 047: Multi-church events, tree-accurate visibility, and profiles from the tree.
--
-- 1. Multi-church events (the bug)
-- --------------------------------
-- A superadmin could create one event for several churches (e.g. Accra AND
-- Outside Accra). The roster was built from all of them, but checkin_events
-- has room for ONE church, so only the first was stored — and every visibility
-- and access check used that one. Leaders of the other churches were on the
-- roster yet could not find the event (list_events_for_scope) and could be
-- refused as 'unrelated' (event_scope_relation).
--
-- event_scopes holds every church an event covers. checkin_events.scope_* stays
-- as the PRIMARY scope (kept in event_scopes by trigger) so existing columns,
-- indexes and older clients keep working; set_event_scopes adds the rest.
--
-- 2. Visibility rule
-- ------------------
-- A viewer acting as a church (a "hat") sees an event when EITHER
--   * any of the event's churches is the hat's church, an ancestor of it, or a
--     descendant of it (the existing rule, now over every church), OR
--   * the event's roster includes someone who serves at or below the hat's
--     church — an admin sees events that involve the leaders they oversee,
--     wherever the event happens to be anchored.
-- Ancestry comes from graph_churches (the synced portal tree, migration 046),
-- falling back to church_hierarchy only for a church the sync has not seen.
--
-- 3. member_profiles rebuilt from the tree
-- ----------------------------------------
-- refresh_member_profiles_from_graph replaces the browser-side "Sync all
-- members" (which paged ~23k members through the portal from one phone and
-- aborted on any dropped request). flc-tree-sync calls it after each apply.

-- ─── event_scopes ───────────────────────────────────────────────────────────
create table if not exists public.event_scopes (
  event_id          uuid not null references public.checkin_events(id) on delete cascade,
  scope_level       text not null,
  scope_church_id   text not null,
  scope_church_name text,
  is_primary        boolean not null default false,
  primary key (event_id, scope_level, scope_church_id)
);
create index if not exists event_scopes_church_idx on public.event_scopes (scope_church_id, scope_level);

alter table public.event_scopes enable row level security;
drop policy if exists anon_read_event_scopes on public.event_scopes;
create policy anon_read_event_scopes on public.event_scopes
  for select to anon, authenticated using (true);
revoke all on public.event_scopes from anon, authenticated;
grant select on public.event_scopes to anon, authenticated;
-- Writes go through the trigger and set_event_scopes only.

insert into public.event_scopes (event_id, scope_level, scope_church_id, scope_church_name, is_primary)
select id, scope_level, scope_church_id, scope_church_name, true from public.checkin_events
on conflict (event_id, scope_level, scope_church_id) do update set is_primary = true;

create or replace function public.sync_primary_event_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and old.scope_level is not distinct from new.scope_level
     and old.scope_church_id is not distinct from new.scope_church_id then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    delete from event_scopes where event_id = new.id and is_primary;
  end if;
  insert into event_scopes (event_id, scope_level, scope_church_id, scope_church_name, is_primary)
  values (new.id, new.scope_level, new.scope_church_id, new.scope_church_name, true)
  on conflict (event_id, scope_level, scope_church_id) do update set is_primary = true;
  return new;
end;
$$;

drop trigger if exists checkin_events_primary_scope on public.checkin_events;
create trigger checkin_events_primary_scope
  after insert or update of scope_level, scope_church_id on public.checkin_events
  for each row execute function public.sync_primary_event_scope();

-- Replace an event's additional churches. The primary (checkin_events.scope_*)
-- is always kept. For a multi-church event the display label becomes the
-- joined names, so lists stop showing only the first church.
create or replace function public.set_event_scopes(p_event_id uuid, p_scopes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level text;
  v_n     int;
  v_label text;
begin
  select scope_level into v_level from checkin_events where id = p_event_id;
  if v_level is null then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;
  if v_level = 'special_group' then
    return jsonb_build_object('ok', false, 'reason', 'special_group_event');
  end if;

  delete from event_scopes where event_id = p_event_id and not is_primary;
  insert into event_scopes (event_id, scope_level, scope_church_id, scope_church_name, is_primary)
  select p_event_id, x->>'level', x->>'id', nullif(x->>'name', ''), false
    from jsonb_array_elements(coalesce(p_scopes, '[]'::jsonb)) x
   where x->>'level' in ('bacenta','governorship','council','stream','campus','oversight','denomination')
     and coalesce(x->>'id', '') <> ''
  on conflict (event_id, scope_level, scope_church_id) do nothing;

  select count(*),
         string_agg(coalesce(scope_church_name, scope_church_id), ' + ' order by is_primary desc, scope_church_name)
    into v_n, v_label
    from event_scopes where event_id = p_event_id;
  if v_n > 1 then
    update checkin_events set scope_church_name = v_label where id = p_event_id;
  end if;
  return jsonb_build_object('ok', true, 'scopes', v_n);
end;
$$;
revoke execute on function public.set_event_scopes(uuid, jsonb) from public;
grant execute on function public.set_event_scopes(uuid, jsonb) to anon, authenticated, service_role;


-- ─── Scope expansion ────────────────────────────────────────────────────────
-- Self + descendants + ancestors of a church. From the synced tree when the
-- church is in it; otherwise the pre-046 church_hierarchy walk.
create or replace function public.scope_set_for(p_level text, p_id text)
returns table (level text, id text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_path text[];
begin
  select g.path into v_path from graph_churches g where g.id = p_id and g.removed_at is null;
  if v_path is not null and cardinality(v_path) > 0 then
    return query
      select c.level, c.id from graph_churches c
       where c.removed_at is null and c.path @> array[p_id]
      union
      select a.level, a.id from graph_churches a where a.id = any(v_path);
    return;
  end if;

  return query
    with recursive anc as (
      select h.id, h.level, h.parent_id, 0 as depth
        from church_hierarchy h where h.id = p_id and h.level = p_level
      union all
      select p.id, p.level, p.parent_id, a.depth + 1
        from church_hierarchy p join anc a on p.id = a.parent_id
       where a.depth < 10
    )
    select d.level, d.id from get_descendant_scopes(p_level, p_id) d
    union
    select anc.level, anc.id from anc
    union
    select p_level, p_id;
end;
$$;

-- Events whose roster includes someone serving at or below this church.
create or replace function public.events_with_roster_in_subtree(p_church_id text)
returns table (event_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct m.event_id
    from graph_churches gc
    join graph_servant_edges ge on ge.church_id = gc.id and ge.ended_at is null
    join event_scope_members m on m.member_id = ge.member_id
   where gc.removed_at is null
     and gc.path @> array[p_church_id];
$$;

revoke execute on function public.scope_set_for(text, text),
                           public.events_with_roster_in_subtree(text)
  from public, anon, authenticated;


-- ─── Listing ────────────────────────────────────────────────────────────────
-- Events visible to ANY of the given hats: [{ "level": "...", "id": "..." }].
create or replace function public.list_events_for_scopes(
  p_scopes                jsonb,
  p_statuses              text[]  default null,
  p_exclude_special_group boolean default true,
  p_limit                 integer default 200
)
returns table (
  id uuid, name text, event_type text, status text,
  scope_level text, scope_church_id text, scope_church_name text, venue_name text,
  starts_at timestamptz, ends_at timestamptz, grace_period_min integer, auto_checkout_min integer,
  allowed_check_in_methods text[], allowed_roles text[],
  geofence_type text, geofence_center_lat double precision, geofence_center_lng double precision,
  geofence_radius_m integer, created_by_id text, created_by_name text, created_at timestamptz,
  series_id uuid, series_index integer, is_public boolean, descendants_resolved boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with hats as (
    select x->>'level' as lvl, x->>'id' as hid
      from jsonb_array_elements(coalesce(p_scopes, '[]'::jsonb)) x
     where coalesce(x->>'id', '') <> '' and coalesce(x->>'level', '') <> ''
  ),
  sset as materialized (
    select distinct s.level, s.id from hats h cross join lateral scope_set_for(h.lvl, h.hid) s
  ),
  vis as (
    select es.event_id
      from event_scopes es join sset s on s.level = es.scope_level and s.id = es.scope_church_id
    union
    select r.event_id from hats h cross join lateral events_with_roster_in_subtree(h.hid) r
  )
  select
    e.id, e.name, e.event_type, e.status,
    e.scope_level, e.scope_church_id, e.scope_church_name, e.venue_name,
    e.starts_at, e.ends_at, e.grace_period_min, e.auto_checkout_min,
    e.allowed_check_in_methods, e.allowed_roles,
    e.geofence_type, e.geofence_center_lat, e.geofence_center_lng, e.geofence_radius_m,
    e.created_by_id, e.created_by_name, e.created_at,
    e.series_id, e.series_index, e.is_public,
    (select count(*) > (select count(*) from hats) from sset) as descendants_resolved
  from checkin_events e
  join vis on vis.event_id = e.id
  where (not p_exclude_special_group or e.scope_level <> 'special_group')
    and (p_statuses is null or e.status = any(p_statuses))
  order by e.starts_at desc
  limit greatest(p_limit, 1);
$$;
revoke execute on function public.list_events_for_scopes(jsonb, text[], boolean, integer) from public;
grant execute on function public.list_events_for_scopes(jsonb, text[], boolean, integer) to anon, authenticated;

-- Single-hat form, same signature and columns as migration 039's version.
create or replace function public.list_events_for_scope(
  p_level text, p_id text,
  p_statuses text[] default null,
  p_exclude_special_group boolean default true,
  p_limit integer default 200
)
returns table (
  id uuid, name text, event_type text, status text,
  scope_level text, scope_church_id text, scope_church_name text, venue_name text,
  starts_at timestamptz, ends_at timestamptz, grace_period_min integer, auto_checkout_min integer,
  allowed_check_in_methods text[], allowed_roles text[],
  geofence_type text, geofence_center_lat double precision, geofence_center_lng double precision,
  geofence_radius_m integer, created_by_id text, created_by_name text, created_at timestamptz,
  series_id uuid, series_index integer, is_public boolean, descendants_resolved boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select * from list_events_for_scopes(
    jsonb_build_array(jsonb_build_object('level', p_level, 'id', p_id)),
    p_statuses, p_exclude_special_group, p_limit);
$$;


-- ─── Access: where does the viewer's hat sit relative to the event? ─────────
-- Keep the pre-047 implementation as the fallback for churches the tree sync
-- has not seen. It is internal: callers use event_scope_relation.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'event_scope_relation_legacy') then
    alter function public.event_scope_relation(uuid, text, text, boolean)
      rename to event_scope_relation_legacy;
  end if;
end $$;
revoke execute on function public.event_scope_relation_legacy(uuid, text, text, boolean)
  from public, anon, authenticated;

create or replace function public.event_scope_relation(
  p_event_id    uuid,
  p_hat_level   text,
  p_hat_id      text,
  p_in_snapshot boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_level     text;
  v_hat_path  text[];
  v_all_known boolean;
begin
  if p_hat_level is null or p_hat_id is null then
    return jsonb_build_object('relation', 'unrelated', 'verified', true);
  end if;

  select scope_level into v_level from checkin_events where id = p_event_id;
  if v_level is null then
    return jsonb_build_object('relation', 'unrelated', 'verified', true);
  end if;
  if v_level = 'special_group' then
    return jsonb_build_object('relation',
      case when p_in_snapshot then 'exact' else 'unrelated' end, 'verified', true);
  end if;

  -- The hat IS one of the event's churches.
  if exists (select 1 from event_scopes
              where event_id = p_event_id and scope_level = p_hat_level and scope_church_id = p_hat_id) then
    return jsonb_build_object('relation', 'exact', 'verified', true);
  end if;

  select path into v_hat_path from graph_churches where id = p_hat_id and removed_at is null;
  select bool_and(g.id is not null) into v_all_known
    from event_scopes es
    left join graph_churches g on g.id = es.scope_church_id and g.removed_at is null
   where es.event_id = p_event_id;

  if v_hat_path is null or not coalesce(v_all_known, false) then
    return event_scope_relation_legacy(p_event_id, p_hat_level, p_hat_id, p_in_snapshot);
  end if;

  -- The hat CONTAINS one of the event's churches: supervising.
  if exists (select 1 from event_scopes es join graph_churches g on g.id = es.scope_church_id
              where es.event_id = p_event_id and p_hat_id = any(g.path)) then
    return jsonb_build_object('relation', 'ancestor', 'verified', true);
  end if;

  -- The hat sits INSIDE one of the event's churches, or people the hat
  -- oversees are on the roster: attending / sees its own slice.
  if p_in_snapshot
     or exists (select 1 from event_scopes es
                 where es.event_id = p_event_id and es.scope_church_id = any(v_hat_path))
     or exists (select 1 from events_with_roster_in_subtree(p_hat_id) r where r.event_id = p_event_id) then
    return jsonb_build_object('relation', 'descendant', 'verified', true);
  end if;

  return jsonb_build_object('relation', 'unrelated', 'verified', true);
end;
$$;
grant execute on function public.event_scope_relation(uuid, text, text, boolean) to anon, authenticated;


-- ─── Roster audit over every church of the event ────────────────────────────
create or replace function public.graph_roster_diff(p_event_id uuid)
returns table (member_id text, status text, name text)
language sql
stable
security definer
set search_path = public
as $$
  with tree as (
    select distinct s.member_id
      from event_scopes es
      cross join lateral graph_subtree_servants(es.scope_church_id) s
     where es.event_id = p_event_id and es.scope_level <> 'special_group'
  ),
  roster as (
    select distinct esm.member_id from event_scope_members esm where esm.event_id = p_event_id
  )
  select coalesce(t.member_id, r.member_id),
         case when r.member_id is null then 'missing_from_roster' else 'not_in_tree' end,
         nullif(trim(coalesce(m.first_name, '') || ' ' || coalesce(m.last_name, '')), '')
    from tree t
    full join roster r on r.member_id = t.member_id
    left join graph_members m on m.id = coalesce(t.member_id, r.member_id)
   where t.member_id is null or r.member_id is null;
$$;


-- ─── member_profiles from the tree ──────────────────────────────────────────
-- Structural roles (leader<Level>/admin<Level>) and scope chains are replaced
-- by the tree's exact edges; any other roles already on the row (arrivals,
-- teller, … from the JWT) are kept. Deputies are leaders, as in the portal.
-- Rows keyed by an auth id that differs from the graph id are refreshed via
-- email. Active rows with no current edge are marked inactive — never deleted.
create or replace function public.refresh_member_profiles_from_graph()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_levels      text[] := array['bacenta','governorship','council','stream','campus','oversight','denomination'];
  v_structural  text   := '^(leader|admin)(Bacenta|Governorship|Council|Stream|Campus|Oversight|Denomination)$';
  v_upserted    int;
  v_bridged     int;
  v_deactivated int;
begin
  if not exists (select 1 from graph_sync_runs where status = 'ok') then
    return jsonb_build_object('ok', false, 'reason', 'no_graph_snapshot');
  end if;

  drop table if exists _chains;
  create temp table _chains on commit drop as
  select distinct on (member_id, src, level, church_id) *
    from (
      select e.member_id,
             case when e.edge_type = 'IS_ADMIN_FOR' then 'admin' else 'leader' end as src,
             e.level, e.church_id,
             array_position(v_levels, e.level) as lvl_rank,
             (select jsonb_object_agg(a.level, jsonb_build_object('id', a.id, 'name', a.name))
                from unnest(c.path) as p(cid) join graph_churches a on a.id = p.cid) as path
        from graph_servant_edges e
        join graph_churches c on c.id = e.church_id and c.removed_at is null
       where e.ended_at is null
    ) x
   order by member_id, src, level, church_id;

  drop table if exists _agg;
  create temp table _agg on commit drop as
  select member_id,
         array_agg(distinct src || initcap(level)) as roles,
         jsonb_agg(jsonb_build_object('source', src, 'level', level, 'path', path)
                   order by lvl_rank, (src = 'admin'), church_id) as scope_paths,
         (array_agg(path order by lvl_rank, (src = 'admin'), church_id))[1] as pp
    from _chains group by member_id;

  drop table if exists _ids;
  create temp table _ids on commit drop as
  select member_id, jsonb_object_agg(lvl, ids) as scope_ids
    from (select c.member_id, kv.key as lvl, jsonb_agg(distinct kv.value->>'id') as ids
            from _chains c cross join lateral jsonb_each(c.path) kv group by 1, 2) y
   group by member_id;

  insert into member_profiles as p (
    id, email, title, first_name, last_name, phone, picture_url, roles, is_active,
    bacenta_id, bacenta_name, governorship_id, governorship_name, council_id, council_name,
    stream_id, stream_name, campus_id, campus_name, oversight_id, oversight_name,
    denomination_id, denomination_name, scope_ids, scope_paths, updated_at)
  select m.id, m.email, m.title, m.first_name, m.last_name, m.phone, m.picture_url, a.roles, true,
         a.pp->'bacenta'->>'id',      a.pp->'bacenta'->>'name',
         a.pp->'governorship'->>'id', a.pp->'governorship'->>'name',
         a.pp->'council'->>'id',      a.pp->'council'->>'name',
         a.pp->'stream'->>'id',       a.pp->'stream'->>'name',
         a.pp->'campus'->>'id',       a.pp->'campus'->>'name',
         a.pp->'oversight'->>'id',    a.pp->'oversight'->>'name',
         a.pp->'denomination'->>'id', a.pp->'denomination'->>'name',
         i.scope_ids, a.scope_paths, now()
    from _agg a
    join graph_members m on m.id = a.member_id
    left join _ids i on i.member_id = a.member_id
  on conflict (id) do update set
    email       = coalesce(excluded.email, p.email),
    title       = coalesce(excluded.title, p.title),
    first_name  = coalesce(excluded.first_name, p.first_name),
    last_name   = coalesce(excluded.last_name, p.last_name),
    phone       = coalesce(excluded.phone, p.phone),
    picture_url = coalesce(excluded.picture_url, p.picture_url),
    roles       = array(select distinct r from unnest(
                    excluded.roles || coalesce(array(select x from unnest(p.roles) x where x !~ v_structural), '{}')) r),
    is_active   = true,
    bacenta_id = excluded.bacenta_id,           bacenta_name = excluded.bacenta_name,
    governorship_id = excluded.governorship_id, governorship_name = excluded.governorship_name,
    council_id = excluded.council_id,           council_name = excluded.council_name,
    stream_id = excluded.stream_id,             stream_name = excluded.stream_name,
    campus_id = excluded.campus_id,             campus_name = excluded.campus_name,
    oversight_id = excluded.oversight_id,       oversight_name = excluded.oversight_name,
    denomination_id = excluded.denomination_id, denomination_name = excluded.denomination_name,
    scope_ids   = excluded.scope_ids,
    scope_paths = excluded.scope_paths,
    updated_at  = now();
  get diagnostics v_upserted = row_count;

  -- Auth-id rows for the same person (auth and graph ids can differ).
  update member_profiles p set
    roles       = array(select distinct r from unnest(
                    a.roles || coalesce(array(select x from unnest(p.roles) x where x !~ v_structural), '{}')) r),
    is_active   = true,
    bacenta_id = a.pp->'bacenta'->>'id',           bacenta_name = a.pp->'bacenta'->>'name',
    governorship_id = a.pp->'governorship'->>'id', governorship_name = a.pp->'governorship'->>'name',
    council_id = a.pp->'council'->>'id',           council_name = a.pp->'council'->>'name',
    stream_id = a.pp->'stream'->>'id',             stream_name = a.pp->'stream'->>'name',
    campus_id = a.pp->'campus'->>'id',             campus_name = a.pp->'campus'->>'name',
    oversight_id = a.pp->'oversight'->>'id',       oversight_name = a.pp->'oversight'->>'name',
    denomination_id = a.pp->'denomination'->>'id', denomination_name = a.pp->'denomination'->>'name',
    scope_ids   = i.scope_ids,
    scope_paths = a.scope_paths,
    updated_at  = now()
    from graph_members m
    join _agg a on a.member_id = m.id
    left join _ids i on i.member_id = m.id
   where m.email is not null
     and lower(p.email) = m.email
     and p.id <> m.id
     and not exists (select 1 from _agg a2 where a2.member_id = p.id);
  get diagnostics v_bridged = row_count;

  update member_profiles p set is_active = false, updated_at = now()
   where p.is_active
     and not exists (select 1 from _agg a where a.member_id = p.id)
     and not exists (select 1 from graph_members m join _agg a on a.member_id = m.id
                      where m.email is not null and lower(p.email) = m.email);
  get diagnostics v_deactivated = row_count;

  return jsonb_build_object('ok', true, 'upserted', v_upserted,
    'bridged', v_bridged, 'deactivated', v_deactivated);
end;
$$;
revoke execute on function public.refresh_member_profiles_from_graph() from public, anon, authenticated;
grant execute on function public.refresh_member_profiles_from_graph() to service_role;
