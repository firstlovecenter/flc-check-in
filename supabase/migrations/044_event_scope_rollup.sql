-- 044: Per-sub-scope attendance rollup, computed in Postgres.
--
-- The scope breakdown is the dashboard for anyone overseeing several
-- sub-scopes, but it was buried behind a link and computed client-side from the
-- full eligible roster — so surfacing it inline would have re-created exactly
-- the roster download migration 037 removed.
--
-- One grouped query instead. Prefers scope_ids (which holds EVERY level a
-- member touches, so a member in two hierarchies is counted under both) and
-- falls back to the flat primary-chain column for rows synced before
-- migration 034.

create or replace function public.get_event_scope_rollup(
  p_event_id      uuid,
  p_child_level   text,
  p_allowed_roles text[] default null
)
returns table (church_id text, church_name text, expected int, attended int)
language sql
stable
security definer
set search_path = public
as $$
  with pop as (
    select
      p.id,
      coalesce(
        -- scope_ids is authoritative; a member may appear under several ids at
        -- one level, so take the first deterministically.
        (select jsonb_array_elements_text(p.scope_ids -> p_child_level) limit 1),
        case p_child_level
          when 'bacenta'      then p.bacenta_id
          when 'governorship' then p.governorship_id
          when 'council'      then p.council_id
          when 'stream'       then p.stream_id
          when 'campus'       then p.campus_id
          when 'oversight'    then p.oversight_id
          when 'denomination' then p.denomination_id
        end
      ) as child_id,
      case p_child_level
        when 'bacenta'      then p.bacenta_name
        when 'governorship' then p.governorship_name
        when 'council'      then p.council_name
        when 'stream'       then p.stream_name
        when 'campus'       then p.campus_name
        when 'oversight'    then p.oversight_name
        when 'denomination' then p.denomination_name
      end as child_name
    from public.event_scope_members esm
    join public.member_profiles p on p.id = esm.member_id
    where esm.event_id = p_event_id
      and p.is_active
      and (p_allowed_roles is null or p.roles && p_allowed_roles)
  )
  select
    pop.child_id                                   as church_id,
    max(pop.child_name)                            as church_name,
    count(*)::int                                  as expected,
    count(*) filter (where exists (
      select 1 from public.checkin_records r
       where r.event_id = p_event_id and r.member_id = pop.id
    ))::int                                        as attended
  from pop
  where pop.child_id is not null
  group by pop.child_id
  order by attended desc, expected desc, max(pop.child_name) nulls last;
$$;

grant execute on function
  public.get_event_scope_rollup(uuid, text, text[]) to anon, authenticated;
