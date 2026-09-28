// Client trigger for the flc-tree-sync edge function (migration 046).
//
// The function reads the whole portal tree with the caller's FLC token and is
// the only writer of graph_churches / graph_servant_edges. It refuses callers
// without a Denomination edge, and the SQL apply refuses snapshots much
// smaller than what is stored — so this button cannot shrink anyone's tree.

import { fetchWithTimeout } from './network'

export interface TreeSyncResult {
  ok: boolean
  reason?: string
  detail?: string
  churches?: number
  members?: number
  edges?: number
  churches_removed?: number
  edges_ended?: number
  orphan_churches?: number
  scanned_members?: number
  total_ms?: number
  /** member_profiles rebuild that runs after a successful apply (047). */
  profiles?: { ok?: boolean; upserted?: number; bridged?: number; deactivated?: number; reason?: string } | null
}

// A full pull is ~100 portal round trips; give it the function's own budget.
const TREE_SYNC_TIMEOUT_MS = 150_000

export async function runTreeSync(): Promise<TreeSyncResult> {
  const token = localStorage.getItem('accessToken')
  if (!token) return { ok: false, reason: 'token_required' }
  const base = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const res = await fetchWithTimeout(`${base}/functions/v1/flc-tree-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ token }),
  }, { timeoutMs: TREE_SYNC_TIMEOUT_MS, retries: 0 })
  const body = await res.json().catch(() => null)
  if (body && typeof body === 'object') return body as TreeSyncResult
  return { ok: false, reason: `http_${res.status}` }
}
