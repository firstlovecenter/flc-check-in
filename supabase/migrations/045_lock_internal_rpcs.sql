-- 045: Take internal SECURITY DEFINER functions off the public API.
--
-- Every function in `public` is callable over /rest/v1/rpc by anyone holding
-- the publishable key (it ships in the JS bundle). The functions below are
-- never called by the app — they are either dead (logic since inlined into
-- submit_checkin by 035, Face ID removed from the client) or helpers that only
-- other SECURITY DEFINER functions call. Two were actively abusable:
--
--   • record_pin_attempt   — anyone could log wrong-PIN attempts against any
--                            member and trip the 15-minute lockout.
--   • claim_device_for_event — anyone could claim a device fingerprint for a
--                            member, so the real owner's check-in is flagged.
--
-- Internal callers are unaffected: every caller (get_event_entry_state,
-- open_checkin, submit_checkin, member_eligible_for_event_checkin) is
-- SECURITY DEFINER owned by postgres, so callees run with the owner's EXECUTE
-- rights, not the web caller's. service_role keeps access (the auto-checkout
-- edge function uses it for auto_checkout_expired_events).
--
-- Verified against prod before writing: no client code, policy or other
-- function outside the listed definer callers references these names.
--
-- Rollback: supabase/rollbacks/045_lock_internal_rpcs.down.sql

-- ─── 1. Revoke public EXECUTE ───────────────────────────────────────────────
-- PUBLIC holds a default EXECUTE grant on every function, so revoking from
-- anon/authenticated alone would leave them reachable through it.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.auto_checkout_expired_events()',
    'public.claim_device_for_event(uuid, text, text)',
    'public.claim_face_match(uuid, text)',
    'public.count_event_scope_profiles(uuid, text[])',
    'public.event_scope_relation(uuid, text, text, boolean)',
    'public.get_event_face_descriptors(uuid)',
    'public.member_eligible_for_event_checkin(uuid, text[], text)',
    'public.record_pin_attempt(uuid, text, text)',
    'public.resolve_event_snapshot_member(uuid, text[], text)',
    'public.rls_auto_enable()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;


-- ─── 2. Drop the broken delete_event overload ───────────────────────────────
-- The 2-arg form authorises against public.superadmins, dropped in 041, so
-- every call errors. The app calls the 3-arg form (043). Leaving it also makes
-- PostgREST's overload resolution ambiguous for 2-param calls.
drop function if exists public.delete_event(uuid, text);


-- ─── 3. Pin search_path on the geo helpers ──────────────────────────────────
-- Flagged by the security advisor (function_search_path_mutable). All three
-- are plpgsql, so pinning costs nothing on the check-in hot path.
-- roles_overlap_allowed is deliberately left alone: it is a SQL function, and
-- a SET clause would stop the planner inlining it into submit_checkin.
alter function public.haversine_meters(double precision, double precision, double precision, double precision)
  set search_path = public;
alter function public.point_in_polygon(double precision, double precision, jsonb)
  set search_path = public;
alter function public.point_in_event_geofence(uuid, double precision, double precision)
  set search_path = public;
