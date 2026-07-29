-- 041: Retire the superadmins / superviewers allowlists.
--
-- Superadmin was already granted by product policy to anyone holding
-- `adminDenomination` (see enrichUser in src/utils/auth.ts). The Supabase
-- `superadmins` table was a THIRD, parallel grant path — hand-maintained,
-- invisible to the graph, and able to disagree with it. Single source of truth
-- wins: superadmin is now exactly "holds adminDenomination in the FL graph".
--
-- ACCESS CHANGES, recorded deliberately:
--   • Daniel Cyrus Adjei (d.a.adjei@googlemail.com) held superadmin ONLY via
--     the table — his roles are leader-only. He loses it. Restore by granting
--     adminDenomination in the graph, NOT by reinstating an allowlist.
--   • Isaac Nakoja and Paul Baidoo held superviewer, which has NO graph
--     equivalent — no role means "read-only everywhere". They fall back to
--     their normal leader scopes. Unlike superadmin this REMOVES a capability
--     rather than consolidating one.
--   • The other 5 denomination admins are unaffected; policy already gave them
--     superadmin.
--
-- Client side (same change):
--   • checkSuperAdminTable / checkSuperViewerTable are deleted.
--   • loginWithCredentials no longer makes two RPC round trips before login —
--     a small latency win on every sign-in.
--   • verifySuperPrivileges is kept but now only REVOKES: it clears
--     superAdminOverride / superViewerOverride flags written by a previous
--     build. Without it a stale flag would keep granting privileges the graph
--     does not, for as long as that browser's localStorage survived. Safe to
--     delete once every active session has logged in after this change.
--
-- Both tables are archived first, so restoring is a recreate-and-reinsert
-- rather than a reconstruction from memory.

create table if not exists public.superadmins_archive_20260729 as
  select *, now() as archived_at from public.superadmins;

create table if not exists public.superviewers_archive_20260729 as
  select *, now() as archived_at from public.superviewers;

-- Archives are operator-only: they hold an email list anon must not read.
alter table public.superadmins_archive_20260729  enable row level security;
alter table public.superviewers_archive_20260729 enable row level security;
revoke all on public.superadmins_archive_20260729  from anon, authenticated;
revoke all on public.superviewers_archive_20260729 from anon, authenticated;

-- Drop the RPCs before the tables they read.
drop function if exists public.is_super_admin(text);
drop function if exists public.is_super_viewer(text);

drop table if exists public.superadmins;
drop table if exists public.superviewers;
