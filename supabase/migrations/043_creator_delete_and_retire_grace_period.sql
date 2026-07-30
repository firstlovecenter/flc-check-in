-- 043: Creator-owned deletes, retire grace period / auto-checkout, add rate RPC.
--
-- ── 1. delete_event was BROKEN by migration 041 ─────────────────────────────
-- It authorised against `public.superadmins`, which 041 dropped, so every call
-- would fail at runtime. Rewritten with graph-derived authorisation:
--
--   • the event's CREATOR may delete it (created_by_id matches the caller), and
--   • denomination admins may delete any event — the former superadmin rule,
--     now read from member_profiles.roles instead of an allowlist.
--
-- Email is kept as a secondary identity resolver for accounts whose auth id
-- differs from their graph member id, the same bridge
-- resolve_event_snapshot_member uses. Dependent rows go via existing CASCADEs.
--
-- ── 2. Grace period and auto-checkout retired ───────────────────────────────
-- Attendance is binary (migration 028): a checkin_records row means Present, no
-- row means Absent. `is_late` was grace_period_min's only consumer and nothing
-- reads is_late — it is absent from CHECKIN_RECORD_COLUMNS and from every
-- screen. So every check-in did interval arithmetic to populate a dead column.
--
-- 043b writes is_late = false. The COLUMNS stay on both tables: historical rows
-- keep their values, and older deployed clients still send the create params.
-- They are simply no longer read, derived from, or offered in the UI.
--
-- ── 3. get_event_checkin_rate ───────────────────────────────────────────────
-- "42 present" does not answer the question asked during a service, which is
-- "are people still arriving?". Backed by checkin_records_event_time_idx
-- (event_id, checked_in_at desc) from migration 032.

create or replace function public.delete_event(
  p_event_id    uuid,
  p_admin_email text,
  p_member_id   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existed        integer;
  v_event_name     text;
  v_created_by     text;
  v_email          text := nullif(lower(trim(coalesce(p_admin_email, ''))), '');
  v_allowed        boolean := false;
  v_is_denom_admin boolean := false;
begin
  select name, created_by_id
    into v_event_name, v_created_by
    from public.checkin_events
   where id = p_event_id;

  if v_event_name is null then
    return jsonb_build_object('ok', false, 'reason', 'event_not_found');
  end if;

  -- Creator check: direct id match, or via the email bridge.
  if p_member_id is not null and v_created_by is not null
     and v_created_by = p_member_id then
    v_allowed := true;
  elsif v_email is not null and v_created_by is not null then
    select true into v_allowed
      from public.member_profiles mp
     where mp.id = v_created_by
       and lower(mp.email) = v_email
     limit 1;
    v_allowed := coalesce(v_allowed, false);
  end if;

  -- Denomination admins may delete any event.
  if not v_allowed then
    select true into v_is_denom_admin
      from public.member_profiles mp
     where (
             (p_member_id is not null and mp.id = p_member_id)
             or (v_email is not null and lower(mp.email) = v_email)
           )
       and 'adminDenomination' = any(coalesce(mp.roles, array[]::text[]))
     limit 1;
    v_allowed := coalesce(v_is_denom_admin, false);
  end if;

  if not v_allowed then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
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

grant execute on function public.delete_event(uuid, text, text) to anon, authenticated;

create or replace function public.get_event_checkin_rate(
  p_event_id   uuid,
  p_window_min int default 5
)
returns table (recent int, window_min int)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::int as recent,
    greatest(p_window_min, 1) as window_min
  from public.checkin_records r
  where r.event_id = p_event_id
    and r.checked_in_at >= now() - (greatest(p_window_min, 1) * interval '1 minute');
$$;

grant execute on function public.get_event_checkin_rate(uuid, int) to anon, authenticated;

-- NOTE: 043b (submit_checkin with is_late := false) was applied as a separate
-- statement because it recreates the whole 200-line function. See the comment
-- above; behaviour is identical to migration 035 apart from that one line.
