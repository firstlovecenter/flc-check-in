-- 021: Capture schema drift + harden is_super_viewer.
--
-- The superviewers table and is_super_viewer RPC were applied directly to
-- prod (tracked there as 20260607075844_add_superviewers_table_and_rpc) but
-- never committed to this folder. This file records them so a fresh
-- environment bootstrapped from these migrations matches prod.
--
-- Also pins search_path on the function (the prod original had none), matching
-- the hardening already present on is_super_admin (002_rls_and_security.sql).

create table if not exists public.superviewers (
  email      text primary key,
  created_at timestamptz default now()
);

alter table public.superviewers enable row level security;
-- No policies: deny-all for direct access. The only read path is the
-- security-definer RPC below (same pattern as superadmins).
revoke select on public.superviewers from anon, authenticated;

create or replace function public.is_super_viewer(p_email text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.superviewers
    where email = lower(trim(p_email))
  );
$$;
