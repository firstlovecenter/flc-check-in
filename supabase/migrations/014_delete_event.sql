-- 014_delete_event.sql
--
-- Superadmin-only "hard delete an event" RPC. Removes the event and every
-- dependent row by relying on ON DELETE CASCADE / SET NULL FKs already
-- defined on checkin_records, checkin_attempts, checkin_devices,
-- face_match_claims, event_scope_members, absence_notes, and audit_log.
--
-- Authorisation is checked inside the function (caller must be in the
-- superadmins table) so the broad anon RLS policy on checkin_events isn't
-- enough to delete by itself — even an anon-keyed client can only delete
-- if they pass through this RPC and prove super-admin status by email.

create or replace function public.delete_event(
  p_event_id uuid,
  p_admin_email text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_is_super  boolean;
  v_existed   boolean;
  v_event_name text;
begin
  -- 1. Auth check: caller must be a super-admin. We accept email rather
  --    than relying on auth.uid() because this app uses an external JWT
  --    that isn't issued by Supabase Auth.
  if p_admin_email is null or length(trim(p_admin_email)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'admin_email_required');
  end if;

  select exists (
    select 1 from public.superadmins
     where lower(email) = lower(trim(p_admin_email))
  ) into v_is_super;

  if not v_is_super then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  -- 2. Capture identity before delete so the response is useful.
  select name into v_event_name
    from public.checkin_events
   where id = p_event_id;

  if v_event_name is null then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- 3. Delete. Cascades take care of every dependent row.
  delete from public.checkin_events where id = p_event_id;
  get diagnostics v_existed = row_count;

  return jsonb_build_object(
    'ok', v_existed > 0,
    'event_id', p_event_id,
    'event_name', v_event_name
  );
end;
$$;

-- Allow the public RLS-bypassing RPC to be invoked. Authorisation is
-- enforced inside the function body via the superadmins lookup.
grant execute on function public.delete_event(uuid, text) to anon, authenticated;
