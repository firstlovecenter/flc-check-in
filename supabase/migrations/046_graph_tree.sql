-- 046: Canonical copy of the FL Admin Portal church tree and servant edges.
--
-- Why
-- ---
-- Until now Hineni's copy of the hierarchy was assembled in browsers, from
-- each user's permission-filtered view of the portal graph, and written back
-- to shared tables (member_profiles, church_hierarchy). A stream admin
-- creating an event wrote rows for leaders whose OTHER hierarchies that admin
-- could not see, so multi-hierarchy leaders (37% of active leaders in prod)
-- silently lost chains, and nothing refreshed unless someone used the app.
--
-- These tables mirror the portal EXACTLY and are written by one path only:
-- the flc-tree-sync edge function, which reads the whole tree with a
-- denomination-level identity and applies it here atomically. Nothing in the
-- browser writes them.
--
-- Fidelity with the portal (api/src/schema/directory.graphql)
-- -----------------------------------------------------------
--   * Spine: Denomination → Oversight → Campus → Stream → Council →
--     Governorship → Bacenta, one parent each via (:parent)-[:HAS]->(:child).
--   * Servant edges held here are the ones that make someone part of a tree
--     in Hineni: LEADS (all levels), DEPUTY_LEADS (Bacenta), IS_ADMIN_FOR
--     (Governorship and up). The portal's edgeToRole maps DEPUTY_LEADS to the
--     leader role, so deputies are leaders here too.
--   * Specialist edges (arrivals, teller, payer) are portal-only and never
--     granted Hineni access; they are not mirrored.
--
-- Lifecycle, not deletion
-- -----------------------
-- A church missing from a snapshot gets removed_at; an edge missing gets
-- ended_at. Rows are never deleted, so past rosters, check-ins and reports
-- keep resolving. Reappearing rows are reactivated.

create table if not exists public.graph_churches (
  id             text primary key,
  level          text not null check (level in
                   ('denomination','oversight','campus','stream','council','governorship','bacenta')),
  name           text,
  parent_id      text,
  -- Ancestor ids root→self, recomputed on every apply. `path @> array[X]`
  -- answers "is this church X or below X" with one GIN index probe.
  path           text[] not null default '{}',
  labels         text[] not null default '{}',
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  removed_at     timestamptz
);
create index if not exists graph_churches_path_gin on public.graph_churches using gin (path);
create index if not exists graph_churches_parent_idx on public.graph_churches (parent_id);

create table if not exists public.graph_members (
  id             text primary key,          -- portal Member.id (graph node id)
  email          text,
  title          text,
  first_name     text,
  last_name      text,
  phone          text,
  picture_url    text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index if not exists graph_members_email_idx on public.graph_members (lower(email));

create table if not exists public.graph_servant_edges (
  member_id      text not null,
  church_id      text not null,
  level          text not null,
  edge_type      text not null check (edge_type in ('LEADS','DEPUTY_LEADS','IS_ADMIN_FOR')),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  ended_at       timestamptz,
  primary key (member_id, church_id, edge_type)
);
create index if not exists graph_servant_edges_church_idx on public.graph_servant_edges (church_id) where ended_at is null;
create index if not exists graph_servant_edges_member_idx on public.graph_servant_edges (member_id) where ended_at is null;

create table if not exists public.graph_sync_runs (
  id               bigserial primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running',
  triggered_by     text,
  churches         int,
  members          int,
  edges            int,
  churches_removed int,
  edges_ended      int,
  orphan_churches  int,
  note             text
);

-- Server-side only. Reads reach clients through SECURITY DEFINER functions.
alter table public.graph_churches      enable row level security;
alter table public.graph_members       enable row level security;
alter table public.graph_servant_edges enable row level security;
alter table public.graph_sync_runs     enable row level security;
revoke all on public.graph_churches, public.graph_members,
              public.graph_servant_edges, public.graph_sync_runs
  from anon, authenticated;


-- ─── apply_graph_snapshot ───────────────────────────────────────────────────
-- Applies one COMPLETE snapshot atomically. Refuses a snapshot that is much
-- smaller than what is already stored: the portal filters every church read
-- by the caller's servant edges, so a token without denomination-wide reach
-- returns a partial tree — and a partial tree applied as if complete would
-- end every edge it cannot see. That is exactly the failure this whole design
-- exists to prevent, so it is a hard stop, not a warning.
create or replace function public.apply_graph_snapshot(
  p_churches     jsonb,
  p_members      jsonb,
  p_edges        jsonb,
  p_triggered_by text default null,
  p_force        boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run      bigint;
  v_now      timestamptz := now();
  v_in_ch    int := coalesce(jsonb_array_length(p_churches), 0);
  v_in_ed    int := coalesce(jsonb_array_length(p_edges), 0);
  v_cur_ch   int;
  v_cur_ed   int;
  v_removed  int;
  v_ended    int;
  v_orphans  int;
begin
  select count(*) into v_cur_ch from graph_churches where removed_at is null;
  select count(*) into v_cur_ed from graph_servant_edges where ended_at is null;

  if not p_force and (
       v_in_ch = 0
    or (v_cur_ch > 0 and v_in_ch < v_cur_ch * 0.9)
    or (v_cur_ed > 0 and v_in_ed < v_cur_ed * 0.9)
  ) then
    insert into graph_sync_runs (status, triggered_by, churches, edges, finished_at, note)
    values ('rejected', p_triggered_by, v_in_ch, v_in_ed, v_now,
            format('snapshot too small: %s churches / %s edges vs %s / %s stored',
                   v_in_ch, v_in_ed, v_cur_ch, v_cur_ed));
    return jsonb_build_object('ok', false, 'reason', 'snapshot_too_small',
      'churches', v_in_ch, 'edges', v_in_ed,
      'stored_churches', v_cur_ch, 'stored_edges', v_cur_ed);
  end if;

  insert into graph_sync_runs (triggered_by) values (p_triggered_by) returning id into v_run;

  -- Churches -----------------------------------------------------------------
  drop table if exists _ch;
  create temp table _ch on commit drop as
  select * from jsonb_to_recordset(p_churches)
    as x(id text, level text, name text, parent_id text, labels text[]);

  insert into graph_churches as g (id, level, name, parent_id, labels, last_seen_at, removed_at)
  select id, level, name, parent_id, coalesce(labels, '{}'), v_now, null from _ch
  on conflict (id) do update
    set level = excluded.level, name = excluded.name, parent_id = excluded.parent_id,
        labels = excluded.labels, last_seen_at = v_now, removed_at = null;

  update graph_churches set removed_at = v_now
   where removed_at is null and id not in (select id from _ch);
  get diagnostics v_removed = row_count;

  -- Paths, root→self, over live churches only.
  with recursive t as (
    select c.id, array[c.id] as path
      from graph_churches c
     where c.removed_at is null
       and (c.parent_id is null
            or not exists (select 1 from graph_churches p
                            where p.id = c.parent_id and p.removed_at is null))
    union all
    select c.id, t.path || c.id
      from graph_churches c join t on c.parent_id = t.id
     where c.removed_at is null and cardinality(t.path) < 8
  )
  update graph_churches g set path = t.path from t where g.id = t.id;

  -- A live non-denomination church with no live parent sits outside the tree.
  select count(*) into v_orphans from graph_churches
   where removed_at is null and level <> 'denomination' and cardinality(path) <= 1;

  -- Members ------------------------------------------------------------------
  insert into graph_members as m (id, email, title, first_name, last_name, phone, picture_url, last_seen_at)
  select id, nullif(lower(trim(email)), ''), title, first_name, last_name, phone, picture_url, v_now
    from jsonb_to_recordset(p_members)
      as x(id text, email text, title text, first_name text, last_name text, phone text, picture_url text)
  on conflict (id) do update
    set email = excluded.email, title = excluded.title, first_name = excluded.first_name,
        last_name = excluded.last_name, phone = excluded.phone,
        picture_url = excluded.picture_url, last_seen_at = v_now;

  -- Edges --------------------------------------------------------------------
  drop table if exists _ed;
  create temp table _ed on commit drop as
  select distinct member_id, church_id, level, edge_type
    from jsonb_to_recordset(p_edges)
      as x(member_id text, church_id text, level text, edge_type text);

  insert into graph_servant_edges as e (member_id, church_id, level, edge_type, last_seen_at, ended_at)
  select member_id, church_id, level, edge_type, v_now, null from _ed
  on conflict (member_id, church_id, edge_type) do update
    set level = excluded.level, last_seen_at = v_now, ended_at = null;

  update graph_servant_edges e set ended_at = v_now
   where e.ended_at is null
     and not exists (select 1 from _ed x
                      where x.member_id = e.member_id and x.church_id = e.church_id
                        and x.edge_type = e.edge_type);
  get diagnostics v_ended = row_count;

  update graph_sync_runs
     set status = 'ok', finished_at = now(), churches = v_in_ch,
         members = coalesce(jsonb_array_length(p_members), 0), edges = v_in_ed,
         churches_removed = v_removed, edges_ended = v_ended, orphan_churches = v_orphans
   where id = v_run;

  return jsonb_build_object('ok', true, 'run_id', v_run,
    'churches', v_in_ch, 'members', coalesce(jsonb_array_length(p_members), 0), 'edges', v_in_ed,
    'churches_removed', v_removed, 'edges_ended', v_ended, 'orphan_churches', v_orphans);
end;
$$;

revoke execute on function public.apply_graph_snapshot(jsonb, jsonb, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.apply_graph_snapshot(jsonb, jsonb, jsonb, text, boolean)
  to service_role;


-- ─── Scope helpers ──────────────────────────────────────────────────────────
-- Everyone who serves at a church or anywhere beneath it — the exact
-- semantics of the portal's GET_MEMBERS_FOR_<Level> queries, plus deputies.
create or replace function public.graph_subtree_servants(p_church_id text)
returns table (member_id text, church_id text, level text, edge_type text)
language sql
stable
security definer
set search_path = public
as $$
  select e.member_id, e.church_id, e.level, e.edge_type
    from graph_churches c
    join graph_servant_edges e on e.church_id = c.id and e.ended_at is null
   where c.removed_at is null
     and c.path @> array[p_church_id];
$$;

-- Ancestor chain of a church, root first.
create or replace function public.graph_church_ancestors(p_church_id text)
returns table (id text, level text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.level, a.name
    from graph_churches c
    cross join lateral unnest(c.path) with ordinality as p(ancestor_id, ord)
    join graph_churches a on a.id = p.ancestor_id
   where c.id = p_church_id
   order by p.ord;
$$;

-- Roster audit: compares an event's stored snapshot with its true tree.
-- 'missing_from_roster' = a genuine tree servant the event does not know about
-- (the access-loss case); 'not_in_tree' = on the roster but holds no current
-- edge in the event's subtree (moved, removed, or deputy/admin drift).
create or replace function public.graph_roster_diff(p_event_id uuid)
returns table (member_id text, status text, name text)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select scope_church_id from checkin_events
     where id = p_event_id and scope_level <> 'special_group'
  ),
  tree as (
    select distinct s.member_id from ev, graph_subtree_servants(ev.scope_church_id) s
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

revoke execute on function public.graph_subtree_servants(text),
                           public.graph_church_ancestors(text),
                           public.graph_roster_diff(uuid)
  from public, anon, authenticated;
grant execute on function public.graph_subtree_servants(text),
                          public.graph_church_ancestors(text),
                          public.graph_roster_diff(uuid)
  to service_role;
