// src/utils/supabase.ts
// Supabase client singleton.
//
// Default: runs as the bare anon role (the FLC JWT never reaches Postgres);
// authorization is enforced by RPCs + client checks.
//
// With VITE_USE_SUPABASE_TOKEN_EXCHANGE=1, every request instead carries a
// Supabase-signed token minted from the FLC JWT by the flc-token-exchange
// edge function, making auth.jwt() claims (sub/email/flc_roles/flc_scopes)
// available to RLS policies. Exchange failure falls back to the anon key.
// See supabase/functions/flc-token-exchange/README.md.

import { createClient } from '@supabase/supabase-js'
import { getSupabaseAccessToken } from './supabaseTokenExchange'
import { createBoundedFetch } from './network'

const useTokenExchange = import.meta.env.VITE_USE_SUPABASE_TOKEN_EXCHANGE === '1'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    ...(useTokenExchange ? { accessToken: getSupabaseAccessToken } : {}),
    global: {
      fetch: createBoundedFetch({ timeoutMs: 12_000, retries: 1 }),
    },
    realtime: {
      timeout: 10_000,
    },
  },
)
