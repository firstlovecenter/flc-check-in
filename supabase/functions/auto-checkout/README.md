# auto-checkout Edge Function

Free-tier replacement for pg_cron. Runs `auto_checkout_expired_events()`
every minute via the Supabase Cron schedule (Dashboard → Edge Functions →
Schedules).

## What it does

For every ACTIVE event whose `ends_at` is in the past:
1. Sets `checked_out_at = now()` and `auto_checked_out = true` on every
   open `checkin_record`.
2. Flips the event's `status` to `ENDED`.

The function is small and idempotent — calling it on a tick where there's
nothing to do returns `{ ok: true, closed: 0 }`.

## Deploy

You need the Supabase CLI. Install it with `npm i -g supabase` if you don't
have it.

```bash
# 1. Authenticate (opens a browser).
supabase login

# 2. Link this repo to your Supabase project.
#    Get the project ref from Dashboard → Settings → General.
supabase link --project-ref qtegrwobxpljbzmctyof

# 3. Deploy the function. --no-verify-jwt because we want it callable by
#    the Cron scheduler without an end-user JWT — the service role key it
#    uses for RPC calls is auto-injected as $SUPABASE_SERVICE_ROLE_KEY.
supabase functions deploy auto-checkout --no-verify-jwt
```

## Schedule it

In the Supabase Dashboard:
1. Edge Functions → `auto-checkout` → **Cron** tab → **Add schedule**.
2. Cron expression: `* * * * *` (every minute).
3. Method: `POST`.

That's it. Within 60 seconds of an event's `ends_at` passing, all open
records are auto-closed.

## Verify

After deploying:
```bash
# Manual ping — should return { ok: true, closed: <int> }
curl -X POST https://qtegrwobxpljbzmctyof.supabase.co/functions/v1/auto-checkout
```

Or via the Dashboard → Edge Functions → `auto-checkout` → **Invocations**
tab to see scheduled runs.

## Geo-checkout

Geo-based auto-checkout (leader walks out of the fence) is handled
client-side: the `<LocationHeartbeat>` component calls
`report_member_location` every 60s while the leader is checked in. The RPC
itself owns the checkout decision — no Edge Function needed for that path.
