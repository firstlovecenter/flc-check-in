-- 022: church_hierarchy — Postgres cache of the FLC church tree.
--
-- Source of truth stays the FL member graph (Neo4j via GraphQL). The client
-- writes rows opportunistically whenever it walks the graph anyway
-- (getChurchAncestors / getChildChurches in membersApi.ts), so the cache
-- fills itself during normal use with zero extra graph traffic.
--
-- get_descendant_scopes replaces the client-side GraphQL BFS used for scope
-- expansion (home-feed lower-scope events, focused-scope filtering, admin
-- event lists): one recursive CTE instead of one Neo4j round trip per tree
-- level per scope.
--
-- Completeness guard: children_synced_at marks "we have stored the FULL child
-- list of this node". get_descendant_scopes returns NOTHING unless every
-- non-leaf node in the requested subtree carries that marker — a partial cache
-- can therefore never silently hide churches; callers fall back to the
-- GraphQL BFS, which heals the cache for next time.

create table if not exists public.church_hierarchy (
  id                 text primary key,
  level              text not null check (level in
    ('bacenta','governorship','council','stream','campus','oversight','denomination')),
  name               text,
  parent_id          text,
  parent_level       text,
  children_synced_at timestamptz,
  updated_at         timestamptz not null default now()
);

create index if not exists church_hierarchy_parent_idx
  on public.church_hierarchy (parent_id);

alter table public.church_hierarchy enable row level security;

-- Hierarchy shape is not sensitive (names + ids only). Writes stay open to
-- anon for now, consistent with every other table pre-Phase-3; tightened when
-- per-user JWTs land.
drop policy if exists anon_all_church_hierarchy on public.church_hierarchy;
create policy anon_all_church_hierarchy on public.church_hierarchy
  for all to anon using (true) with check (true);

-- All descendants of (p_level, p_id), including the node itself.
-- Returns zero rows when the root is missing OR any non-leaf node in the
-- subtree has never had its children synced (see header). depth < 10 guards
-- against pathological parent cycles (tree is at most 7 levels deep).
create or replace function public.get_descendant_scopes(p_level text, p_id text)
returns table (level text, id text, name text, parent_id text)
language sql
stable
set search_path = public
as $$
  with recursive tree as (
    select h.id, h.level, h.name, h.parent_id, h.children_synced_at, 0 as depth
    from public.church_hierarchy h
    where h.id = p_id and h.level = p_level
    union all
    select c.id, c.level, c.name, c.parent_id, c.children_synced_at, t.depth + 1
    from public.church_hierarchy c
    join tree t on c.parent_id = t.id
    where t.depth < 10
  )
  select t.level, t.id, t.name, t.parent_id
  from tree t
  where not exists (
    select 1 from tree x
    where x.level <> 'bacenta' and x.children_synced_at is null
  );
$$;

-- Ancestor chain of (p_level, p_id), highest level first (denomination → …
-- → the node itself). Used as a fallback for membersApi.getChurchAncestors
-- when the graph is unreachable. Unlike descendants, a partial chain is still
-- useful, so there is no completeness guard — callers get whatever is cached.
create or replace function public.get_ancestor_scopes(p_level text, p_id text)
returns table (level text, id text, name text, parent_id text)
language sql
stable
set search_path = public
as $$
  with recursive up as (
    select h.id, h.level, h.name, h.parent_id, 0 as depth
    from public.church_hierarchy h
    where h.id = p_id and h.level = p_level
    union all
    select p.id, p.level, p.name, p.parent_id, u.depth + 1
    from public.church_hierarchy p
    join up u on u.parent_id = p.id
    where u.depth < 10
  )
  select u.level, u.id, u.name, u.parent_id
  from up u
  order by u.depth desc;
$$;
