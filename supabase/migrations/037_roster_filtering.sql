-- 037: Stop shipping the whole roster to every phone.
--
-- get_event_scope_profiles returned 24 columns for EVERY member in an event's
-- scope, to EVERY viewer who opened that event, so the client could filter by
-- allowed_roles in JavaScript. For a 2,000-member event that is roughly 400 KB
-- gzipped per viewer per open; 500 leaders opening one event is ~200 MB in a
-- single service.
--
-- On Supabase's Free tier that is not merely slow — the 5 GB/month egress
-- allowance is gone in a handful of services, and on paid tiers it is a
-- recurring bill for data the client immediately throws away.
--
-- This version pushes the filtering into Postgres and adds a search predicate
-- so drill-downs can page instead of preloading. All parameters are optional:
-- calling it with only p_event_id reproduces the previous behaviour exactly,
-- so an older deployed client keeps working during a staged rollout.

drop function if exists public.get_event_scope_profiles(uuid);

create or replace function public.get_event_scope_profiles(
  p_event_id        uuid,
  p_allowed_roles   text[] default null,
  p_scope_level     text   default null,
  p_scope_church_id text   default null,
  p_search          text   default null
)
returns table (
  id text,
  email text,
  title text,
  first_name text,
  last_name text,
  phone text,
  picture_url text,
  roles text[],
  bacenta_id text,
  bacenta_name text,
  governorship_id text,
  governorship_name text,
  council_id text,
  council_name text,
  stream_id text,
  stream_name text,
  campus_id text,
  campus_name text,
  oversight_id text,
  oversight_name text,
  denomination_id text,
  denomination_name text,
  scope_ids jsonb,
  scope_paths jsonb,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    p.id, p.email, p.title, p.first_name, p.last_name, p.phone, p.picture_url,
    p.roles,
    p.bacenta_id, p.bacenta_name,
    p.governorship_id, p.governorship_name,
    p.council_id, p.council_name,
    p.stream_id, p.stream_name,
    p.campus_id, p.campus_name,
    p.oversight_id, p.oversight_name,
    p.denomination_id, p.denomination_name,
    p.scope_ids, p.scope_paths,
    p.updated_at
  from public.event_scope_members esm
  join public.member_profiles p on p.id = esm.member_id
  where esm.event_id = p_event_id
    -- Role filter: the same "eligible" rule the client used to apply in JS.
    and (p_allowed_roles is null or p.roles && p_allowed_roles)
    -- Sub-scope drill-down. Prefers scope_ids (which holds every level the
    -- member touches) and falls back to the flat primary-chain column, so a
    -- member in two hierarchies is found under BOTH — the flat columns alone
    -- describe only their primary chain.
    and (
      p_scope_level is null or p_scope_church_id is null
      or coalesce(p.scope_ids -> p_scope_level, '[]'::jsonb) @> to_jsonb(p_scope_church_id)
      or (
        case p_scope_level
          when 'bacenta'      then p.bacenta_id
          when 'governorship' then p.governorship_id
          when 'council'      then p.council_id
          when 'stream'       then p.stream_id
          when 'campus'       then p.campus_id
          when 'oversight'    then p.oversight_id
          when 'denomination' then p.denomination_id
        end
      ) = p_scope_church_id
    )
    -- Server-side search so a large roster can be looked up without being
    -- downloaded first.
    and (
      p_search is null or btrim(p_search) = ''
      or lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '') || ' ' || coalesce(p.email, ''))
         like '%' || lower(btrim(p_search)) || '%'
    )
  order by p.first_name nulls last, p.last_name nulls last, p.email nulls last;
$$;

grant execute on function
  public.get_event_scope_profiles(uuid, text[], text, text, text)
  to anon, authenticated;


-- Count without transferring rows — lets a screen show "1,240 members" and a
-- search box instead of preloading everything to count it client-side.
create or replace function public.count_event_scope_profiles(
  p_event_id      uuid,
  p_allowed_roles text[] default null
)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.event_scope_members esm
  join public.member_profiles p on p.id = esm.member_id
  where esm.event_id = p_event_id
    and (p_allowed_roles is null or p.roles && p_allowed_roles);
$$;

grant execute on function public.count_event_scope_profiles(uuid, text[]) to anon, authenticated;
