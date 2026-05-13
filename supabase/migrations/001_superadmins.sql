-- ─── superadmins ────────────────────────────────────────────────────────────
-- Simple email-based allowlist. Rows are managed directly in the Supabase
-- dashboard (Table Editor). No RLS needed — reads happen server-side via
-- the service-role key, not the browser anon key.
--
-- To grant superadmin access:
--   INSERT INTO public.superadmins (email) VALUES ('user@example.com');
-- To revoke:
--   DELETE FROM public.superadmins WHERE email = 'user@example.com';

create table if not exists public.superadmins (
  email       text primary key,
  note        text,          -- optional label, e.g. 'IT / devops access'
  created_at  timestamptz not null default now()
);

-- Allow the anon/service key to read (needed for the post-login check).
grant select on public.superadmins to anon, authenticated;
-- Writes are intentionally NOT granted to anon — use the Supabase dashboard
-- or the service-role key to manage rows.
