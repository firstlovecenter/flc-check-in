-- Link recurring event instances under a shared series_id UUID.
-- series_index is 1-based (first occurrence = 1).
ALTER TABLE public.checkin_events
  ADD COLUMN IF NOT EXISTS series_id    uuid    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS series_index integer DEFAULT NULL;

CREATE INDEX IF NOT EXISTS checkin_events_series_id_idx
  ON public.checkin_events (series_id)
  WHERE series_id IS NOT NULL;
