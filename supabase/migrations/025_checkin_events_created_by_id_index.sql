-- 025: Cover checkin_events.created_by_id with an index.
--
-- Flagged by the Supabase performance advisor: checkin_events_created_by_id_fkey
-- has no covering index, so any lookup/join by created_by_id (e.g. "events I
-- created") forces a sequential scan as the table grows.

create index if not exists checkin_events_created_by_id_idx
  on public.checkin_events (created_by_id);
