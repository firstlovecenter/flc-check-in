-- 026: Server-side event scope profile join.
--
-- Dashboard eligibility used to fetch event_scope_members and then batch
-- member_profiles in groups of 50 from every viewer's phone. During a live
-- service that multiplies quickly: a 1,000-person event opened by 200 viewers
-- can become thousands of REST requests before anyone checks in.
--
-- This RPC keeps the join inside Postgres and returns the same public
-- member_profiles projection the client already expects.

create or replace function public.get_event_scope_profiles(p_event_id uuid)
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
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    p.id,
    p.email,
    p.title,
    p.first_name,
    p.last_name,
    p.phone,
    p.picture_url,
    p.roles,
    p.bacenta_id,
    p.bacenta_name,
    p.governorship_id,
    p.governorship_name,
    p.council_id,
    p.council_name,
    p.stream_id,
    p.stream_name,
    p.campus_id,
    p.campus_name,
    p.oversight_id,
    p.oversight_name,
    p.denomination_id,
    p.denomination_name,
    p.scope_ids,
    p.updated_at
  from public.event_scope_members esm
  join public.member_profiles p on p.id = esm.member_id
  where esm.event_id = p_event_id
  order by p.first_name nulls last, p.last_name nulls last, p.email nulls last;
$$;

grant execute on function public.get_event_scope_profiles(uuid) to anon, authenticated;
