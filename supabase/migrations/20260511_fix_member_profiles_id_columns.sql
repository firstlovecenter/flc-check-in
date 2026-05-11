-- Migration: fix member_profiles church-level *_id columns
--
-- The initial deploy accidentally created these as uuid instead of text.
-- The FLC member graph uses MongoDB ObjectIds (24-char hex), not UUIDs,
-- so Postgres rejects them on upsert with:
--   invalid input syntax for type uuid: "67f870ab7c4b7c59d52c667c"
--
-- This migration casts every affected column to text.
-- The PK `id` stays uuid (auth JWTs carry real UUIDs there).
--
-- Apply in Supabase SQL editor.

-- Drop indexes that depend on the columns we're altering
drop index if exists public.member_profiles_bacenta_idx;
drop index if exists public.member_profiles_governorship_idx;
drop index if exists public.member_profiles_council_idx;
drop index if exists public.member_profiles_stream_idx;
drop index if exists public.member_profiles_campus_idx;
drop index if exists public.member_profiles_oversight_idx;

-- Alter columns uuid → text (using USING cast so existing uuid values are preserved)
alter table public.member_profiles
  alter column bacenta_id      type text using bacenta_id::text,
  alter column governorship_id type text using governorship_id::text,
  alter column council_id      type text using council_id::text,
  alter column stream_id       type text using stream_id::text,
  alter column campus_id       type text using campus_id::text,
  alter column oversight_id    type text using oversight_id::text,
  alter column denomination_id type text using denomination_id::text;

-- Recreate indexes
create index if not exists member_profiles_bacenta_idx      on public.member_profiles (bacenta_id);
create index if not exists member_profiles_governorship_idx on public.member_profiles (governorship_id);
create index if not exists member_profiles_council_idx      on public.member_profiles (council_id);
create index if not exists member_profiles_stream_idx       on public.member_profiles (stream_id);
create index if not exists member_profiles_campus_idx       on public.member_profiles (campus_id);
create index if not exists member_profiles_oversight_idx    on public.member_profiles (oversight_id);
