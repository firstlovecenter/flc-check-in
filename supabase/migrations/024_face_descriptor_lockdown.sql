-- 024: Face-descriptor lockdown (biometric data).
--
-- ⚠ APPLY ONLY AFTER the client build that stops using '*' representations
-- on member_profiles (upsertMemberProfile / bulkUpsertMemberProfiles now
-- select explicit columns) is deployed. Older clients' post-upsert
-- `.select()` would start failing with "permission denied for column".
--
-- member_profiles.face_descriptor is a face-recognition embedding — biometric
-- data. Today the permissive anon policy lets any anon-key holder dump every
-- descriptor in one request. This migration removes blanket column read
-- access while keeping the table readable for everything else the app uses.
-- Row-level tightening (per-user JWT claims) follows once the
-- flc-token-exchange edge function is enabled.

revoke select on public.member_profiles from anon;
grant select (
  id, email, title, first_name, last_name, phone, picture_url, roles,
  bacenta_id, bacenta_name, governorship_id, governorship_name,
  council_id, council_name, stream_id, stream_name,
  campus_id, campus_name, oversight_id, oversight_name,
  denomination_id, denomination_name, scope_ids, has_face_id, updated_at
) on public.member_profiles to anon;
-- INSERT/UPDATE grants (including face_descriptor) are untouched — enrollment
-- still writes descriptors; they just can't be read back in bulk.

-- Purpose-built read for the face check-in flow: descriptors only for members
-- snapshotted into a specific ACTIVE event — never the whole table.
create or replace function public.get_event_face_descriptors(p_event_id uuid)
returns table (member_id text, face_descriptor double precision[])
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.face_descriptor
  from public.event_scope_members esm
  join public.member_profiles p on p.id = esm.member_id
  join public.checkin_events e on e.id = p_event_id
  where esm.event_id = p_event_id
    and e.status = 'ACTIVE'
    and p.face_descriptor is not null;
$$;

grant execute on function public.get_event_face_descriptors(uuid) to anon;
