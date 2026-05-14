-- 008_title_column.sql
-- Adds a title column to member_profiles so we can store and display
-- titles (e.g. "Rev.", "Pastor", "Bishop") from the FLC member graph.

alter table public.member_profiles
  add column if not exists title text;
