-- 032: Index the bounded list and aggregate access paths used during large events.
-- CONCURRENTLY is intentionally omitted because Supabase migrations run inside
-- a transaction; IF NOT EXISTS keeps this safe across restored environments.

create index if not exists checkin_events_status_time_idx
  on public.checkin_events (status, starts_at, ends_at);

create index if not exists checkin_events_scope_start_idx
  on public.checkin_events (scope_level, scope_church_id, starts_at desc);

create index if not exists checkin_records_event_time_idx
  on public.checkin_records (event_id, checked_in_at desc);

create index if not exists checkin_records_member_time_idx
  on public.checkin_records (member_id, checked_in_at desc);

