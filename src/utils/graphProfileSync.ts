// FL member graph → Supabase `member_profiles` + local church context.
//
// Hineni treats the graph as source of truth for hierarchy columns (bacenta_id …
// denomination_id) and derived leader/admin roles. Supabase caches that shape for
// fast event lists and joins; it is refreshed on login and periodically while
// the session is active.

import type { AppUser } from '../types/app'
import {
  clearResolveCurrentMemberCache,
  resolveCurrentMember,
  memberToProfileRow,
} from './membersApi'
import {
  persistChurchContextFromProfileRow,
  persistChurchContextFromJwt,
  mergeRoleLists,
} from './auth'
import { upsertMemberProfile } from './supabaseCheckins'
import { cacheHierarchyChain, type HierarchyNode } from './hierarchyCache'

/** Ancestor chain (highest level first) from a member_profiles-shaped row's
 *  flat columns. Gaps are fine — cacheHierarchyChain only links adjacent
 *  levels. */
function profileRowToHierarchyChain(row: any): HierarchyNode[] {
  const levels = ['denomination', 'oversight', 'campus', 'stream', 'council', 'governorship', 'bacenta']
  const chain: HierarchyNode[] = []
  for (const lvl of levels) {
    const id = row?.[`${lvl}_id`]
    if (id) chain.push({ level: lvl, id, name: row[`${lvl}_name`] || null })
  }
  return chain
}

const SYNC_TS_PREFIX = 'flc:lastGraphProfileSync:'
/** Re-probe occasionally while a session is active; login/refresh still force sync. */
const SESSION_RESYNC_MS = 30 * 60 * 1000

function syncKey(userId: string) {
  return `${SYNC_TS_PREFIX}${userId}`
}

export function markGraphProfileSynced(userId: string) {
  try {
    sessionStorage.setItem(syncKey(userId), String(Date.now()))
  } catch { /* private mode */ }
}

export function shouldRefreshGraphProfile(user: AppUser | null | undefined): boolean {
  if (!user?.userId) return false
  try {
    const raw = sessionStorage.getItem(syncKey(user.userId))
    if (!raw) return true
    return Date.now() - Number(raw) > SESSION_RESYNC_MS
  } catch {
    return true
  }
}

export function clearGraphProfileSyncMarker(userId?: string) {
  try {
    if (userId) sessionStorage.removeItem(syncKey(userId))
    else {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i)
        if (k?.startsWith(SYNC_TS_PREFIX)) sessionStorage.removeItem(k)
      }
    }
  } catch { /* ignore */ }
}

export interface GraphProfileSyncResult {
  member: any | null
  synced: boolean
}

/**
 * Probe the FL member graph for the logged-in user, persist church context, and
 * upsert `member_profiles` keyed by auth `userId` (not graph node id).
 */
export async function syncGraphProfileForUser(
  user: AppUser,
  opts?: { force?: boolean },
): Promise<GraphProfileSyncResult> {
  if (!user?.userId && !user?.email) return { member: null, synced: false }

  if (!opts?.force && user.userId && !shouldRefreshGraphProfile(user)) {
    return { member: null, synced: false }
  }

  clearResolveCurrentMemberCache(user)
  const member = await resolveCurrentMember(user)

  if (member?.pictureUrl) localStorage.setItem('pictureUrl', member.pictureUrl)
  const memberTitle = Array.isArray(member?.title) ? member.title[0]?.name : member?.title
  if (memberTitle) localStorage.setItem('memberTitle', memberTitle)

  const row = member ? memberToProfileRow(member) : null
  if (row) {
    persistChurchContextFromProfileRow(row)
    cacheHierarchyChain(profileRowToHierarchyChain(row))  // fire-and-forget
  }
  if ((user as any).churchScopes) {
    persistChurchContextFromJwt((user as any).churchScopes)
  }

  await upsertMemberProfile({
    ...(row || {}),
    id: user.userId,
    email: user.email || row?.email,
    title: row?.title || user.title,
    first_name: row?.first_name || user.firstName,
    last_name: row?.last_name || user.lastName,
    roles: mergeRoleLists(row?.roles, user.roles),
    phone: row?.phone || (user as any).phone,
    picture_url: row?.picture_url || (user as any).pictureUrl,
  })

  if (user.userId) markGraphProfileSynced(user.userId)
  return { member, synced: true }
}

/** Non-blocking wrapper for login / route guards. */
export function syncGraphProfileForUserBackground(
  user: AppUser,
  opts?: { force?: boolean },
): void {
  syncGraphProfileForUser(user, opts).catch((err) => {
    console.warn('[graphProfileSync]', err?.message || err)
  })
}
