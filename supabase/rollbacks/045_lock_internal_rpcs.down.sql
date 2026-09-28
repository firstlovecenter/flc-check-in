-- Rollback for 045_lock_internal_rpcs.sql — restores the exact pre-045 state
-- captured from prod on 2026-09-28 (ACL was {=X, postgres, anon,
-- authenticated, service_role} on every function below; geo helpers had no
-- proconfig).

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.auto_checkout_expired_events()',
    'public.claim_device_for_event(uuid, text, text)',
    'public.claim_face_match(uuid, text)',
    'public.count_event_scope_profiles(uuid, text[])',
    'public.event_scope_relation(uuid, text, text, boolean)',
    'public.get_event_face_descriptors(uuid)',
    'public.member_eligible_for_event_checkin(uuid, text[], text)',
    'public.record_pin_attempt(uuid, text, text)',
    'public.resolve_event_snapshot_member(uuid, text[], text)',
    'public.rls_auto_enable()'
  ] loop
    execute format('grant execute on function %s to public, anon, authenticated', fn);
  end loop;
end $$;

alter function public.haversine_meters(double precision, double precision, double precision, double precision)
  reset search_path;
alter function public.point_in_polygon(double precision, double precision, jsonb)
  reset search_path;
alter function public.point_in_event_geofence(uuid, double precision, double precision)
  reset search_path;

-- The dropped overload, verbatim from prod (it was already non-functional:
-- public.superadmins no longer exists).
CREATE OR REPLACE FUNCTION public.delete_event(p_event_id uuid, p_admin_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$;

grant execute on function public.delete_event(uuid, text) to public, anon, authenticated, service_role;
