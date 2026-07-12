-- 030_fix_delete_event_row_count.sql
--
-- Fix "operator does not exist: boolean > integer" when deleting an event.
--
-- Migration 014 declared v_existed as BOOLEAN but assigned it from
-- GET DIAGNOSTICS ... ROW_COUNT (an integer) and then compared it with
-- `v_existed > 0`. Postgres has no boolean > integer operator, so every
-- delete_event call blew up after the auth checks. init.sql already carries
-- the corrected INTEGER declaration; this migration brings databases that
-- ran 014 in line with it.

create or replace function public.delete_event(
  p_event_id uuid,
  p_admin_email text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_is_super   boolean;
  v_existed    integer;
  v_event_name text;
begin
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

  select name into v_event_name
    from public.checkin_events
   where id = p_event_id;

  if v_event_name is null then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  delete from public.checkin_events where id = p_event_id;
  get diagnostics v_existed = row_count;

  return jsonb_build_object(
    'ok', v_existed > 0,
    'event_id', p_event_id,
    'event_name', v_event_name
  );
end;
$$;

grant execute on function public.delete_event(uuid, text) to anon, authenticated;
