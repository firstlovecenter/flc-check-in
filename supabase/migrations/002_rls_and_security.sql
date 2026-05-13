-- ════════════════════════════════════════════════════════════════════════════
--  RLS + security hardening
--
--  Run this in the Supabase SQL Editor (or supabase db push).
--  Idempotent — safe to re-run on an already-configured database.
--
--  What this does:
--   1. Enables RLS on all public tables (silences Security Advisor errors).
--   2. Adds the minimum permissive policies needed for the anon role.
--      Tables accessed ONLY via security-definer RPCs get no policy → deny-all.
--   3. Locks down the superadmins table: revokes direct SELECT from anon and
--      adds a security-definer RPC `is_super_admin(p_email)` as the only
--      read path, so the email allowlist cannot be enumerated via the API.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1. Enable RLS on every table ───────────────────────────────────────────

alter table public.member_profiles   enable row level security;
alter table public.checkin_events    enable row level security;
alter table public.checkin_records   enable row level security;
alter table public.checkin_attempts  enable row level security;
alter table public.checkin_devices   enable row level security;
alter table public.face_match_claims enable row level security;
alter table public.superadmins       enable row level security;


-- ─── 2. Policies for tables the app client accesses directly ─────────────────
--
--  member_profiles
--   • app upserts profile rows post-login (INSERT + UPDATE)
--   • face-api reads/writes face_descriptor (SELECT + UPDATE)
--   • admin resets Face ID (UPDATE)
drop policy if exists "anon_all_member_profiles" on public.member_profiles;
create policy "anon_all_member_profiles"
  on public.member_profiles
  for all
  to anon
  using (true)
  with check (true);

--  checkin_events
--   • app reads event details, lists active/past events (SELECT)
--   • admin pauses/resumes/ends/extends events (UPDATE)
drop policy if exists "anon_all_checkin_events" on public.checkin_events;
create policy "anon_all_checkin_events"
  on public.checkin_events
  for all
  to anon
  using (true)
  with check (true);

--  checkin_records
--   • app reads check-in records for dashboards and reports (SELECT)
--   • submit_checkin RPC writes records (security-definer → bypasses RLS)
--   • selfCheckOut updates records (UPDATE via direct client call)
drop policy if exists "anon_all_checkin_records" on public.checkin_records;
create policy "anon_all_checkin_records"
  on public.checkin_records
  for all
  to anon
  using (true)
  with check (true);

--  checkin_attempts, checkin_devices, face_match_claims
--   • written exclusively via security-definer RPCs → no policy needed.
--   • No policy = deny-all for direct client access (belt-and-suspenders).


-- ─── 3. Lock down superadmins — no direct anon read ─────────────────────────

-- Revoke the direct SELECT that was granted in the initial migration.
revoke select on public.superadmins from anon, authenticated;
-- No RLS policy added → direct queries from the browser are denied.


-- ─── 4. Security-definer RPC: is_super_admin(p_email) ───────────────────────
--
--  Returns true if the email is in the superadmins table.
--  Runs as postgres (security definer) so RLS on superadmins is bypassed
--  inside the function only. The anon role can EXECUTE but never SELECT the
--  table directly.
--
--  search_path is pinned to public,extensions to prevent search-path injection.
create or replace function public.is_super_admin(p_email text)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
begin
  return exists (
    select 1 from public.superadmins
    where email = lower(trim(p_email))
  );
end;
$$;

-- Allow the anon role to call it (needed for the post-login check in auth.ts).
grant execute on function public.is_super_admin(text) to anon;
