-- ════════════════════════════════════════════════════════════════════════════
--  Phase 0 — baseline snapshot. READ ONLY. Safe to run on production.
--
--  Run this BEFORE any fix lands, and again after, so every later claim about
--  "this got faster / smaller / cleaner" is measured rather than asserted.
--  Paste each section into the Supabase SQL editor and keep the output.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1. Are we about to hit the Free-tier 500 MB wall? ──────────────────────
-- The failure mode for exceeding it is the database going read-only, which
-- during a live service means nobody can check in at all.
select
  pg_size_pretty(pg_database_size(current_database())) as database_size,
  pg_size_pretty(sum(pg_total_relation_size(c.oid)))   as tables_and_indexes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r';

-- Biggest tables first. event_scope_members is the expected growth driver:
-- one permanent row per member per event.
select
  c.relname                                          as table_name,
  pg_size_pretty(pg_total_relation_size(c.oid))      as total_size,
  pg_size_pretty(pg_relation_size(c.oid))            as heap_size,
  pg_size_pretty(pg_indexes_size(c.oid))             as index_size,
  (select reltuples::bigint from pg_class where oid = c.oid) as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 15;


-- ─── 2. Hierarchy-merge census ──────────────────────────────────────────────
-- How many members hold edges in more than one hierarchy at a level? These are
-- the rows memberToProfileRow can merge into a chain that does not exist.
-- If this returns small numbers, the Phase 3 UX budget shrinks a lot.
select
  count(*)                                                                          as profiles_with_scope_ids,
  count(*) filter (where jsonb_array_length(coalesce(scope_ids->'governorship','[]')) > 1) as multi_governorship,
  count(*) filter (where jsonb_array_length(coalesce(scope_ids->'council','[]'))      > 1) as multi_council,
  count(*) filter (where jsonb_array_length(coalesce(scope_ids->'stream','[]'))       > 1) as multi_stream,
  count(*) filter (where jsonb_array_length(coalesce(scope_ids->'campus','[]'))       > 1) as multi_campus,
  count(*) filter (where jsonb_array_length(coalesce(scope_ids->'oversight','[]'))    > 1) as multi_oversight
from public.member_profiles
where scope_ids is not null;

-- The smoking gun: the flat primary chain names a church that is NOT among the
-- churches the member actually holds an edge for at that level. Every row here
-- is a written-down hierarchy that does not exist in the graph.
select
  id, first_name, last_name, email,
  council_id, scope_ids->'council' as council_edges,
  stream_id,  scope_ids->'stream'  as stream_edges,
  campus_id,  scope_ids->'campus'  as campus_edges
from public.member_profiles
where scope_ids is not null
  and (
       (scope_ids ? 'council' and council_id is not null and not (scope_ids->'council' @> to_jsonb(council_id)))
    or (scope_ids ? 'stream'  and stream_id  is not null and not (scope_ids->'stream'  @> to_jsonb(stream_id)))
    or (scope_ids ? 'campus'  and campus_id  is not null and not (scope_ids->'campus'  @> to_jsonb(campus_id)))
  )
order by last_name, first_name;

-- Count-only version of the above, for tracking the number down to zero.
select count(*) as merged_chain_rows
from public.member_profiles
where scope_ids is not null
  and (
       (scope_ids ? 'council' and council_id is not null and not (scope_ids->'council' @> to_jsonb(council_id)))
    or (scope_ids ? 'stream'  and stream_id  is not null and not (scope_ids->'stream'  @> to_jsonb(stream_id)))
    or (scope_ids ? 'campus'  and campus_id  is not null and not (scope_ids->'campus'  @> to_jsonb(campus_id)))
  );


-- ─── 3. church_hierarchy corruption exposure ────────────────────────────────
-- NOTE: the corruption is NOT directly detectable here. `id` is the primary
-- key, so each node stores exactly one parent and the last writer wins — a
-- wrong parent silently replaced the right one, leaving no contradictory pair
-- behind. What we CAN measure is how much of the table was written with a
-- parent link at all, i.e. the blast radius of a truncate-and-refill.
select
  level,
  count(*)                                        as nodes,
  count(*) filter (where parent_id is not null)   as with_parent_link,
  count(*) filter (where children_synced_at is not null) as fully_synced
from public.church_hierarchy
group by level
order by level;


-- ─── 4. Event-scope sizes — the O(n) blast radius ───────────────────────────
-- resolve_event_snapshot_member currently scans every one of these rows per
-- check-in AND per event open. This is the multiplier on that cost.
select
  e.id, e.name, e.status, e.starts_at,
  count(esm.member_id)                                        as scope_members,
  (select count(*) from public.checkin_records r where r.event_id = e.id) as records
from public.checkin_events e
left join public.event_scope_members esm on esm.event_id = e.id
group by e.id, e.name, e.status, e.starts_at
order by scope_members desc nulls last
limit 10;


-- ─── 5. Slowest statements ──────────────────────────────────────────────────
-- Requires: create extension if not exists pg_stat_statements;
-- Reset before a service (select pg_stat_statements_reset()), read after.
-- This is the ground truth that decides what to optimise next — trust it over
-- any static reading of the SQL, including mine.
select
  round(total_exec_time::numeric, 0)          as total_ms,
  calls,
  round(mean_exec_time::numeric, 2)           as mean_ms,
  round(max_exec_time::numeric, 2)            as max_ms,
  rows,
  left(query, 200)                            as query
from pg_stat_statements
where query not ilike '%pg_stat_statements%'
order by total_exec_time desc
limit 20;


-- ─── 6. Index sanity for the hot paths ──────────────────────────────────────
-- Confirms the indexes the check-in path depends on actually exist, and shows
-- which ones are never used (dead weight on every write).
select
  relname as table_name, indexrelname as index_name,
  idx_scan as times_used,
  pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where schemaname = 'public'
order by idx_scan asc, pg_relation_size(indexrelid) desc;
