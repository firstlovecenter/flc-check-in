-- 042: Repair two regressions migration 038 introduced on event_scope_members.
--
-- Both produced the same opaque symptom — "permission denied for table
-- event_scope_members" — because Postgres reports a missing POLICY and a
-- missing GRANT identically.
--
-- ── 1. reconcile_inactive_member_profiles was SECURITY INVOKER ──────────────
-- It runs `delete from event_scope_members` for members who no longer hold a
-- leader/admin relationship. As INVOKER it executes with the CALLER's
-- privileges, so revoking DELETE from anon in 038 broke it and Sync Members
-- failed partway through.
--
-- The fix is deliberately NOT to hand the DELETE grant back. As SECURITY
-- DEFINER the function keeps working while anon still cannot delete rows
-- directly through PostgREST — deletion is possible only through this
-- function's constrained logic (an explicit member-id list, and only on events
-- that have not ENDED, so history is preserved for reports). That is strictly
-- tighter than the pre-038 state, where anon held blanket DELETE on the table.
--
-- search_path is already pinned on the function, which DEFINER requires.
--
-- ── 2. The upsert path had no UPDATE policy ─────────────────────────────────
-- snapshotEventScopeMembers uses .upsert(..., { onConflict: 'event_id,member_id' }),
-- which PostgREST compiles to INSERT ... ON CONFLICT DO UPDATE. That needs an
-- UPDATE policy as well as an INSERT one. 038 replaced the old catch-all
-- `for all` policy with SELECT + INSERT only, so every scope-snapshot write —
-- event creation, re-scoping, addMemberToEventScope — failed.
--
-- anon already held the UPDATE grant; only the policy was missing.
--
-- ── The general lesson ──────────────────────────────────────────────────────
-- When replacing a `for all` policy with per-command policies, enumerate what
-- the client actually DOES, not what it appears to do. An upsert is two
-- commands. And check for SECURITY INVOKER functions touching the table: they
-- silently inherit whatever the caller lost.

create or replace function public.reconcile_inactive_member_profiles(p_member_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  if coalesce(array_length(p_member_ids, 1), 0) = 0 then
    return 0;
  end if;

  update public.member_profiles
     set is_active = false,
         updated_at = now()
   where id = any(p_member_ids)
     and is_active;
  get diagnostics v_updated = row_count;

  -- Past event snapshots stay intact for reports; open/future snapshots are
  -- pruned so inactive members cannot check in and no longer inflate totals.
  delete from public.event_scope_members esm
   using public.checkin_events e
   where esm.event_id = e.id
     and esm.member_id = any(p_member_ids)
     and e.status <> 'ENDED';

  return v_updated;
end;
$$;

grant execute on function public.reconcile_inactive_member_profiles(text[]) to anon, authenticated;

-- Required for the ON CONFLICT DO UPDATE half of every scope-snapshot upsert.
drop policy if exists "anon_update_event_scope_members" on public.event_scope_members;
create policy "anon_update_event_scope_members"
  on public.event_scope_members
  for update to anon using (true) with check (true);
