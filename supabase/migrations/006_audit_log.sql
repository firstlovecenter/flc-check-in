-- Migration 006: audit_log
-- Append-only record of admin actions. Provides an immutable trail of
-- event.create, event.update, event.status_change, checkin.manual,
-- face.descriptor_clear, and pin.reset actions.

create table if not exists audit_log (
  id          bigserial    primary key,
  action      text         not null,   -- e.g. 'event.pause', 'checkin.manual'
  actor_id    text         not null,
  actor_name  text,
  event_id    uuid         references checkin_events(id) on delete set null,
  target_id   text,                    -- member_id or other entity id
  target_name text,
  details     jsonb,
  created_at  timestamptz  not null default now()
);

create index if not exists audit_log_event_idx on audit_log(event_id, created_at desc);

alter table audit_log enable row level security;

-- anon may insert (app enforces who can call addAuditLog)
create policy "anon_insert_audit_log"
  on audit_log
  for insert
  to anon
  with check (true);

-- anon may read (FullReport / AuditLogScreen guards access by viewerCaps.canManage)
create policy "anon_read_audit_log"
  on audit_log
  for select
  to anon
  using (true);

grant select, insert on audit_log to anon;
grant usage, select on sequence audit_log_id_seq to anon;
