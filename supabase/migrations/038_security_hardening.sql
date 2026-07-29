-- 038: Close two holes that are independent of scale and worse than it.
--
-- ════════════════════════════════════════════════════════════════════════════
--  1. qr_secret was being handed to every client
-- ════════════════════════════════════════════════════════════════════════════
-- CHECKIN_EVENT_LIST_COLUMNS included qr_secret, so every event LISTING shipped
-- the HMAC secret to every phone. Anyone who could see an event could derive a
-- valid rotating PIN or QR token for it from anywhere in the world — the
-- geofence was the only remaining control, and the whole point of rotating
-- codes is that possession of a current code proves presence.
--
-- The secret is genuinely needed by ONE screen (the QR/PIN display at the
-- venue). get_event_display_secret serves exactly that, and only to a caller
-- who can already manage the event, so it cannot be harvested from a listing.
--
-- ════════════════════════════════════════════════════════════════════════════
--  2. anon holds full read/write on the attendance record
-- ════════════════════════════════════════════════════════════════════════════
-- Migration 002 granted `for all to anon using(true) with check(true)` on
-- member_profiles, checkin_events, checkin_records and event_scope_members.
-- The publishable key ships inside the JS bundle, so anyone who views source
-- can read every member's name, email and phone, or DELETE the entire
-- attendance register.
--
-- On the Free tier there is no PITR, so that deletion is unrecoverable.
--
-- Fully fixing this needs the Supabase token exchange switched on
-- (VITE_USE_SUPABASE_TOKEN_EXCHANGE=1) so auth.jwt() claims exist for policies
-- to read. Until that is live, this migration takes the step that is safe to
-- take unilaterally: removing DELETE, which no client code path uses.
-- Deletion still happens through the security-definer RPCs (delete_event),
-- which bypass RLS by design.


-- ─── 1. Event secret, on request, for managers only ─────────────────────────
create or replace function public.get_event_display_secret(p_event_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select qr_secret from public.checkin_events where id = p_event_id;
$$;

comment on function public.get_event_display_secret(uuid) is
  'Rotating-code secret for the venue display screen. Deliberately NOT part of '
  'any event listing: shipping it with every list let any client mint valid '
  'PINs/QR codes for any event they could see.';

grant execute on function public.get_event_display_secret(uuid) to anon, authenticated;


-- ─── 2. Revoke DELETE from the browser role ─────────────────────────────────
-- No client path deletes from these tables; every legitimate deletion runs
-- through a security-definer RPC. Removing the grant closes the "leaked
-- publishable key wipes the register" path without waiting for the full RLS
-- rework.
revoke delete on public.checkin_records    from anon;
revoke delete on public.checkin_events     from anon;
revoke delete on public.member_profiles    from anon;
revoke delete on public.event_scope_members from anon;

-- The permissive policies still allow SELECT/INSERT/UPDATE, so nothing that
-- works today stops working. Narrow the policies too, so the policy layer
-- agrees with the grant layer rather than silently permitting more.
drop policy if exists "anon_all_checkin_records" on public.checkin_records;
create policy "anon_rw_checkin_records"
  on public.checkin_records
  for select to anon using (true);
create policy "anon_insert_checkin_records"
  on public.checkin_records
  for insert to anon with check (true);
create policy "anon_update_checkin_records"
  on public.checkin_records
  for update to anon using (true) with check (true);

drop policy if exists "anon_all_checkin_events" on public.checkin_events;
create policy "anon_read_checkin_events"
  on public.checkin_events
  for select to anon using (true);
create policy "anon_insert_checkin_events"
  on public.checkin_events
  for insert to anon with check (true);
create policy "anon_update_checkin_events"
  on public.checkin_events
  for update to anon using (true) with check (true);

drop policy if exists "anon_all_member_profiles" on public.member_profiles;
create policy "anon_read_member_profiles"
  on public.member_profiles
  for select to anon using (true);
create policy "anon_insert_member_profiles"
  on public.member_profiles
  for insert to anon with check (true);
create policy "anon_update_member_profiles"
  on public.member_profiles
  for update to anon using (true) with check (true);

drop policy if exists "anon_all_event_scope_members" on public.event_scope_members;
create policy "anon_read_event_scope_members"
  on public.event_scope_members
  for select to anon using (true);
create policy "anon_insert_event_scope_members"
  on public.event_scope_members
  for insert to anon with check (true);


-- ─── 3. Remaining work, recorded so it is not forgotten ─────────────────────
-- Read access is still wide open: any holder of the publishable key can read
-- every member_profiles row (names, emails, phone numbers). Narrowing it
-- requires auth.jwt() claims, i.e. the token-exchange edge function must be
-- enabled for all clients first. The intended end state is:
--
--   • member_profiles  — SELECT limited to profiles within the caller's
--                        scope_paths, plus their own row.
--   • checkin_records  — SELECT limited to events the caller can view.
--   • checkin_events   — SELECT limited to the caller's scope (public events
--                        remain readable anonymously for the QR display page).
--   • INSERT/UPDATE    — removed entirely in favour of the existing
--                        security-definer RPCs, which already carry the real
--                        authorization logic.
--
-- Do that as a separate migration, after confirming every client is sending an
-- exchanged token. Rolling it out before then locks users out.
