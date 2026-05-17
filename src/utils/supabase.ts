// src/utils/supabase.js
// Supabase client singleton + helper to hand the external JWT to Supabase
// so Row Level Security policies can identify the current user.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  // Fail loudly at module load. A misconfigured deployment passing
  // undefined to createClient silently swallows every request and you
  // spend an afternoon wondering why nothing loads.
  throw new Error(
    '[supabase] VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set ' +
    '(check your .env locally and your Vercel project env vars for prod).',
  )
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

/**
 * Pass the external JWT (from the FLC auth system) to Supabase so that
 * RLS policies using auth.uid() resolve correctly.
 *
 * Call this immediately after a successful login, before any DB reads/writes.
 *
 * REQUIREMENT: The JWT must be signed with the same secret configured in
 * Supabase → Settings → API → JWT Secret. Confirm this with the auth
 * system owner. If the secrets don't match, RLS will silently reject all
 * requests — in that case, remove RLS and enforce access rules server-side.
 *
 * @param {string} accessToken — the raw JWT string from loginWithCredentials()
 */
export async function setSupabaseAuth(accessToken) {
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: '',    // not used — external auth handles refresh
  })
  if (error) console.error('[supabase] setSession error:', error.message)
}
