-- Migration 005: absence_notes
-- Admins can record reasons for members who defaulted on an event.

create table if not exists absence_notes (
  event_id    uuid    not null references checkin_events(id) on delete cascade,
  member_id   text    not null,
  reason      text    not null,
  recorded_by text    not null,
  recorded_at timestamptz not null default now(),
  primary key (event_id, member_id)
);

alter table absence_notes enable row level security;

create policy "anon_all_absence_notes"
  on absence_notes
  for all
  to anon
  using (true)
  with check (true);

grant select, insert, update, delete on absence_notes to anon;
