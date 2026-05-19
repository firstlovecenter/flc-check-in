-- Cross-scope special groups for superadmin-managed meetings.
-- A group is a reusable named list of members that cuts across the church
-- hierarchy, used when creating meetings that don't map to a single scope.

CREATE TABLE IF NOT EXISTS public.special_groups (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text,
  created_by   text        NOT NULL,  -- FLC graph member ID of creating superadmin
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.special_group_members (
  group_id    uuid  NOT NULL REFERENCES public.special_groups(id) ON DELETE CASCADE,
  member_id   text  NOT NULL,   -- stable FLC graph ID
  member_name text,             -- cached display name
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id)
);

CREATE INDEX IF NOT EXISTS special_group_members_group_idx
  ON public.special_group_members (group_id);

CREATE INDEX IF NOT EXISTS special_group_members_member_idx
  ON public.special_group_members (member_id);

-- RLS: enabled, open to anon role (same pattern as every other table here).
ALTER TABLE public.special_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_special_groups"
  ON public.special_groups FOR ALL TO anon
  USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_special_group_members"
  ON public.special_group_members FOR ALL TO anon
  USING (true) WITH CHECK (true);
