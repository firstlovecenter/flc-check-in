-- 015_picture_url.sql
--
-- Cache the member's profile picture URL on member_profiles so admin lists
-- (Member Biometrics, FullReport, ScopeBreakdown) can render avatars
-- without a per-row roundtrip to the FLC member graph.
--
-- Synced from member.pictureUrl by memberToProfileRow() at login time and
-- by the bulk-upsert path used after a snapshot fetch.

alter table public.member_profiles
  add column if not exists picture_url text;
