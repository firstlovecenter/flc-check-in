-- 028: Remove checkout logic — attendance is binary.
--
-- Product rule: only two attendance states exist. Present = the member has a
-- checkin_records row for the event; Absent = they don't. Checked-out /
-- still-in / left tracking is gone:
--   • report_member_location (geofence heartbeat auto-checkout) is dropped.
--   • end_event_now no longer closes open records — it only ends the event.
--   • auto_checkout_expired_events keeps its name (the cron schedule and the
--     auto-checkout edge function call it) but now only flips expired ACTIVE
--     events to ENDED.
--
-- The legacy columns (checked_out_at, auto_checked_out, outside_since,
-- is_late) stay on checkin_records so historical rows survive; nothing reads
-- them anymore.

drop function if exists public.report_member_location(uuid, text, double precision, double precision);

create or replace function public.end_event_now(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_event       public.checkin_events%rowtype;
  v_now         timestamptz := now();
  v_new_ends_at timestamptz;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  v_new_ends_at := case
    when v_event.ends_at > v_now then v_now
    else v_event.ends_at
  end;

  update public.checkin_events
     set status  = 'ENDED',
         ends_at = v_new_ends_at
   where id = p_event_id;

  return jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'ends_at', v_new_ends_at
  );
end;
$$;

create or replace function public.auto_checkout_expired_events()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  with ended as (
    update public.checkin_events
       set status = 'ENDED'
     where status = 'ACTIVE'
       and ends_at <= now()
    returning id
  )
  select count(*) into v_count from ended;

  return v_count;
end;
$$;
