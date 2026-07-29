-- 034: scope_paths — store hierarchy CHAINS, not a per-level id soup.
--
-- The problem this closes
-- -----------------------
-- A member can hold role edges in several hierarchies at once: lead a Bacenta
-- under Council C1 while administering Council C2 in a different stream. Two
-- earlier representations both lost that:
--
--   • The flat *_id columns resolved each level independently, so the stored
--     chain could jump hierarchies mid-walk and describe a path that exists
--     nowhere in the graph (Bacenta B → Governorship G1 → Council C2, where
--     G1's real parent is C1).
--
--   • scope_ids (migration 020) fixed the "silently dropped" half by storing
--     every id per level — but as a per-level UNION. {council:[C1,C2],
--     stream:[S1,S2]} cannot tell you that C1 sits under S1 and C2 under S2.
--
-- scope_paths keeps the pairing. Shape — an array, one entry per role edge:
--
--   [{"source":"leader","level":"bacenta",
--     "path":{"bacenta":{"id":"b-1","name":"Bacenta B"},
--             "governorship":{"id":"g-1","name":"G1"},
--             "council":{"id":"c-1","name":"C1"}, …}},
--    {"source":"admin","level":"council",
--     "path":{"council":{"id":"c-2","name":"C2"},
--             "stream":{"id":"s-2","name":"S2"}, …}}]
--
-- Every entry within one `path` is a genuine parent of the entry below it —
-- it is read from the parent objects the FLC graph itself embeds. See
-- buildScopeChains() in src/utils/membersApi.ts.
--
-- Column semantics after this migration:
--   • flat *_id / *_name  — the PRIMARY chain only (most-specific role edge).
--                           Not a summary of everywhere the member has a role.
--                           Use for display of the one canonical unit.
--   • scope_ids           — per-level union. Lossy. Kept for migration-020
--                           consumers; answers "does this member touch X?".
--   • scope_paths         — the full truth. Use for anything that needs to
--                           know WHICH hierarchy, or to enumerate a member's
--                           distinct roles (the "hat" model).

alter table public.member_profiles
  add column if not exists scope_paths jsonb;

comment on column public.member_profiles.scope_paths is
  'Array of {source, level, path} — one coherent hierarchy chain per role edge. '
  'Authoritative for multi-hierarchy members. The flat *_id columns hold only '
  'the primary chain; scope_ids holds a lossy per-level union.';

comment on column public.member_profiles.scope_ids is
  'Per-level union of every id across every chain. LOSSY — cannot pair a '
  'council with its stream. Prefer scope_paths in new code.';

-- Containment queries ("members with any edge under campus X") run against
-- scope_ids; jsonb_path_ops is the smaller, faster GIN variant for @>.
create index if not exists member_profiles_scope_ids_gin
  on public.member_profiles using gin (scope_ids jsonb_path_ops);

create index if not exists member_profiles_scope_paths_gin
  on public.member_profiles using gin (scope_paths jsonb_path_ops);


-- ─── Purge the fabricated links out of church_hierarchy ─────────────────────
--
-- church_hierarchy is a SHARED cache of the church tree, and the client used
-- to populate it from each logged-in member's flat columns. For every
-- multi-hierarchy member, that wrote a parent link that does not exist —
-- corrupting get_descendant_scopes for every other user under either
-- hierarchy.
--
-- The corruption is not detectable in place: `id` is the primary key, so each
-- node stores exactly one parent and the last writer silently replaced the
-- correct one. There is no contradictory pair left to find. The only safe
-- move is to discard all derived structure and let it refill from the graph
-- walkers (getChurchAncestors / getChildChurches), which read real parent
-- edges.
--
-- Names and levels are kept — they are harmless and save a little refetching.
-- Clearing children_synced_at makes get_descendant_scopes return nothing for
-- every subtree (it requires the marker on every non-leaf), so callers fall
-- back to the GraphQL BFS, which heals the cache as it goes. No caller sees
-- wrong data in the meantime; they see a slower path.
--
-- RUN THIS OFF-PEAK. Until the cache refills, scope expansion falls back to
-- one GraphQL query per node against Neo4j. Do not run it on a service day.
update public.church_hierarchy
   set parent_id          = null,
       parent_level       = null,
       children_synced_at = null,
       updated_at         = now()
 where parent_id is not null
    or children_synced_at is not null;
