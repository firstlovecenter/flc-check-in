-- 011_admin_end_event.sql
--
-- Atomic "admin ends the event" RPC: flips status to ENDED, truncates
-- ends_at to now() if the scheduled end was still in the future, and checks
-- out every open record in one transaction. Before this, endEvent() in the
-- app did the status flip via PostgREST and relied on the every-minute cron
-- (auto_checkout_expired_events) to close the records — meaning attendees
-- stayed "checked in" for up to a minute after the admin ended the event.
--
-- Also widens auto_checkout_expired_events to catch records on ENDED events
-- that still have checked_out_at = null, as a belt-and-braces safety net.

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
  v_closed      int := 0;
begin
  select * into v_event from public.checkin_events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- Truncate the end time only if the schedule was still in the future.
  v_new_ends_at := case
    when v_event.ends_at > v_now then v_now
    else v_event.ends_at
  end;

  update public.checkin_events
     set status  = 'ENDED',
         ends_at = v_new_ends_at
   where id = p_event_id;

  -- Close every still-open record on the event.
  with closed as (
    update public.checkin_records
       set checked_out_at  = v_now,
           auto_checked_out = true
     where event_id = p_event_id
       and checked_out_at is null
    returning id
  )
  select count(*) into v_closed from closed;

  return jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'ends_at', v_new_ends_at,
    'records_closed', v_closed
  );
end;
$$;

-- Defensive: also let the cron catch ENDED events whose records didn't get
-- closed (e.g. if a future admin flow updates status outside end_event_now).
create or replace function public.auto_checkout_expired_events()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count int := 0;
begin
  with closed as (
    update public.checkin_records cr
       set checked_out_at  = now(),
           auto_checked_out = true
      from public.checkin_events ce
     where cr.event_id = ce.id
       and (ce.status = 'ENDED' or (ce.status = 'ACTIVE' and ce.ends_at <= now()))
       and cr.checked_out_at is null
    returning cr.id
  )
  select count(*) into v_count from closed;

  -- Flip ACTIVE-but-expired events to ENDED so reports show the right status.
  update public.checkin_events
     set status = 'ENDED'
   where status = 'ACTIVE'
     and ends_at <= now();

  return v_count;
end;
$$;
