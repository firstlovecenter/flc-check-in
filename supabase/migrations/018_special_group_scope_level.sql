-- Add 'special_group' as a valid scope_level for events created from a
-- special group. Events at this level are invisible to regular admins
-- because buildScopeOrFilter only generates clauses for real church levels
-- (bacenta → denomination). Only superadmins (who bypass the filter) and
-- the members explicitly snapshotted in event_scope_members can see them.

ALTER TABLE public.checkin_events
  DROP CONSTRAINT IF EXISTS checkin_events_scope_level_check;

ALTER TABLE public.checkin_events
  ADD CONSTRAINT checkin_events_scope_level_check
  CHECK (scope_level IN (
    'bacenta','governorship','council','stream',
    'campus','oversight','denomination','special_group'
  ));
