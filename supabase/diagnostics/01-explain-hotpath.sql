-- ════════════════════════════════════════════════════════════════════════════
--  Phase 0 — prove (or disprove) the O(scope) claim on the check-in hot path.
--  READ ONLY. Safe on production.
--
--  The claim under test: resolve_event_snapshot_member cannot use the
--  event_scope_members primary key to jump straight to the caller's row,
--  because the WHERE is an OR across three branches. If true, it walks every
--  scope member of the event on EVERY event-open and EVERY check-in submit.
--
--  How to read the output:
--    • "rows=<N>" on the event_scope_members scan ≈ the event's scope size
--      → the claim holds; this is the top-priority fix.
--    • "rows=1" via an Index Scan on the primary key
--      → the claim is wrong; re-prioritise off pg_stat_statements instead.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── Step 1: pick the largest real event and a member actually in its scope ──
-- Run this first and copy the two ids into steps 2 and 3.
select
  e.id           as event_id,
  e.name,
  count(esm.member_id) as scope_size,
  (array_agg(esm.member_id order by esm.member_id))[1] as a_member_id
from public.checkin_events e
join public.event_scope_members esm on esm.event_id = e.id
group by e.id, e.name
order by count(esm.member_id) desc
limit 1;


-- ─── Step 2: the entry gate — runs when ANY user opens the event ────────────
-- Substitute the ids from step 1.
explain (analyze, buffers, verbose)
select * from public.resolve_event_snapshot_member(
  '00000000-0000-0000-0000-000000000000'::uuid,   -- ← event_id from step 1
  array['REPLACE_WITH_MEMBER_ID'],                 -- ← a_member_id from step 1
  null
);


-- ─── Step 3: the same predicate inlined, so the plan is actually visible ────
-- EXPLAIN on a security-definer function call shows only the function node.
-- This reproduces its body inline so you can see the real access path.
explain (analyze, buffers, verbose)
select
  esm.member_id,
  coalesce(p_graph.roles, array[]::text[])
from public.event_scope_members esm
join public.member_profiles p_graph on p_graph.id = esm.member_id
where esm.event_id = '00000000-0000-0000-0000-000000000000'::uuid   -- ← event_id
  and (
    esm.member_id = any(array['REPLACE_WITH_MEMBER_ID'])            -- ← member id
    or (
      null::text is not null
      and lower(coalesce(p_graph.email, '')) = lower(null::text)
    )
    or exists (
      select 1
      from unnest(array['REPLACE_WITH_MEMBER_ID']) as mid(member_id)
      join public.member_profiles p_auth on p_auth.id = mid.member_id
      where null::text is not null
        and lower(coalesce(p_auth.email, '')) = lower(null::text)
    )
  )
order by esm.member_id
limit 1;


-- ─── Step 4: what it SHOULD cost — the targeted probe ───────────────────────
-- This is the access path the rewritten function uses. Compare the timing and
-- the buffer counts against step 3; the ratio is the size of the win.
explain (analyze, buffers, verbose)
select esm.member_id
from public.event_scope_members esm
where esm.event_id = '00000000-0000-0000-0000-000000000000'::uuid   -- ← event_id
  and esm.member_id = any(array['REPLACE_WITH_MEMBER_ID'])          -- ← member id
limit 1;


-- ─── Step 5: the email fallback path ────────────────────────────────────────
-- Without an index on lower(email) this is a sequential scan of the whole
-- member_profiles table. Confirm before adding the index, and re-run after.
explain (analyze, buffers)
select id from public.member_profiles
where lower(email) = 'someone@example.com'
limit 1;


-- ─── Step 6: the dashboard aggregate, for completeness ──────────────────────
-- Polled every 8–30 s per admin viewer while an event is live.
explain (analyze, buffers)
select * from public.get_event_dashboard_stats(
  '00000000-0000-0000-0000-000000000000'::uuid,   -- ← event_id
  null,
  null,
  array['leaderBacenta'],
  false,
  '{}'
);
