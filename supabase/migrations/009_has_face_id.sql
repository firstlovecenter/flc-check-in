-- 009_has_face_id.sql
--
-- Add a generated boolean column `has_face_id` to member_profiles so admin
-- biometrics screens can read enrolment status without pulling the full
-- 128-float face_descriptor over the wire. For a denomination admin with
-- thousands of members in scope, this is the difference between a few KB
-- and several MB of response payload on every screen open.
--
-- The column is STORED so PostgREST can index/filter on it cheaply.

alter table public.member_profiles
  add column if not exists has_face_id boolean
  generated always as (
    face_descriptor is not null and array_length(face_descriptor, 1) > 0
  ) stored;

create index if not exists member_profiles_has_face_id_idx
  on public.member_profiles (has_face_id);
