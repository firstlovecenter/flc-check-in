-- Add scope_ids JSONB to member_profiles.
--
-- The flat *_id columns store only one hierarchy path per member (the first
-- path returned by the graph). A member who traverses multiple campuses
-- (e.g. a stream leader who also leads or admins in other campuses) will have
-- all but one path silently dropped, causing them to disappear from scope
-- breakdown views that filter by the flat column.
--
-- scope_ids stores ALL IDs at each level extracted from every leads* and
-- isAdminFor* graph edge. Shape: { "campus": ["id1","id2"], "stream": ["id1"], … }
--
-- The flat columns remain for backward compatibility and still store the
-- primary/first path. New code prefers scope_ids; old code is unaffected.

ALTER TABLE public.member_profiles
  ADD COLUMN IF NOT EXISTS scope_ids JSONB;
