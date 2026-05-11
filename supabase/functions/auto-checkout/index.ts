// Supabase Edge Function — auto-checkout
//
// Free-tier replacement for pg_cron. Calls the auto_checkout_expired_events()
// RPC on every invocation. Invoke via the Supabase Cron schedule (Dashboard →
// Edge Functions → Schedules) every minute.
//
// Deploy:
//   supabase functions deploy auto-checkout
//   supabase functions schedule create auto-checkout --cron "* * * * *"
//
// The function uses the SERVICE_ROLE_KEY (auto-injected as env on Supabase)
// so it can call security-definer RPCs without an end-user JWT.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (_req) => {
  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    )
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.rpc('auto_checkout_expired_events')

  if (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({ ok: true, closed: data, ranAt: new Date().toISOString() }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
})
