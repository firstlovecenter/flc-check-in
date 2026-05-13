-- Migration 004: event_scope_members
--
-- Permanently attaches every member who was in-scope when an event was
-- created (or re-scoped). Membership is keyed by the stable FLC graph ID
-- (m.id from Neo4j) — names and profile details live in member_profiles and
-- may change, but the graph ID never changes.
--
-- Why no FK to member_profiles?
--   The snapshot is saved in the background right after event creation.
--   If a member has never logged into the app they won't have a
--   member_profiles row yet. A FK constraint would silently drop those rows.
--   The join is optional at query time.

create table if not exists public.event_scope_members (
  event_id    uuid  not null references public.checkin_events(id) on delete cascade,
  member_id   text  not null,   -- stable FLC graph ID (m.id)
  created_at  timestamptz not null default now(),
  primary key (event_id, member_id)
);

-- Fast lookup of all events a member was scoped to (for History screen)
create index if not exists event_scope_members_member_idx
  on public.event_scope_members (member_id);

alter table public.event_scope_members enable row level security;

-- anon role needs read (dashboards) + write (snapshot saved from browser)
create policy "anon_all_event_scope_members"
  on public.event_scope_members
  for all to anon
  using (true)
  with check (true);

grant select, insert, delete on public.event_scope_members to anon;
