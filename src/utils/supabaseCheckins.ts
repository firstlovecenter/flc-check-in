// All Supabase reads and writes for the app.
// Patterns mirror src/legacy/utils/logs.js. Every screen and admin component
// goes through this file — no direct supabase calls elsewhere.

import { supabase } from './supabase'
import { generateQrSecretHex } from './checkinsCrypto'
import { pointInGeofence } from './geo'
import { getUserLeadershipRefs } from './userScope'
import { childScopeLevel, getChildChurches, getChurchAncestors } from './membersApi'
import { fetchDescendantScopesFromDb } from './hierarchyCache'
import type { AppUser, CheckinEventRow } from '../types/app'

type FocusedScope = { level?: string; id?: string }

/** Run async tasks with a concurrency cap instead of firing all at once.
 *  Scope/event queries here are batched (URL length limits, OR-filter size),
 *  and every leader/admin who loads a scoped screen re-runs all the batches —
 *  unbounded Promise.all turns one screen view into a burst of dozens of
 *  simultaneous Supabase connections that multiplies with concurrent
 *  viewers during a live service. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => PromiseLike<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const BATCH_CONCURRENCY = 5

export function filterEventsByFocusedScope<T extends { scope_level?: string; scope_church_id?: string }>(
  events: T[],
  focusedScope?: FocusedScope | null,
): T[] {
  if (!focusedScope?.level || !focusedScope?.id) return events
  return events.filter((evt) => evt.scope_level === focusedScope.level && evt.scope_church_id === focusedScope.id)
}

const DESC_SCOPE_TTL = 60 * 1000
const _descendantScopeCache = new Map<string, { keys: Set<string>; ts: number }>()
const DESC_SCOPE_HOME_TIMEOUT_MS = 2500

function withFallbackAfter<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let settled = false
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

function exactScopeKeys(scopes: Array<{ level: string; id: string }>): Set<string> {
  return new Set(
    (scopes || [])
      .filter((s) => s?.level && s?.id)
      .map((s) => `${s.level}:${s.id}`),
  )
}

// Descendant expansion for a scope: church_hierarchy RPC first (one round
// trip; only answers when the cached subtree is provably complete — see
// migration 022), then the per-level GraphQL BFS as fallback. The BFS goes
// through getChildChurches, which mirrors every child list it fetches back
// into church_hierarchy — so the slow path heals the fast path.
async function getDescendantScopeKeysForScope(scope: { level: string; id: string }): Promise<Set<string>> {
  const cacheKey = `${scope.level}:${scope.id}`
  const hit = _descendantScopeCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < DESC_SCOPE_TTL) return hit.keys

  // 1. Postgres cache (single recursive-CTE RPC).
  try {
    const rows = await fetchDescendantScopesFromDb(scope)
    if (rows?.length) {
      const keys = new Set(rows.map((r) => `${r.level}:${r.id}`))
      keys.add(cacheKey) // root is included by the RPC, but be explicit
      _descendantScopeCache.set(cacheKey, { keys, ts: Date.now() })
      return keys
    }
  } catch { /* fall through to graph BFS */ }

  // 2. GraphQL BFS (original path).
  const keys = new Set<string>()
  const queue: Array<{ level: string; id: string }> = [{ level: scope.level, id: scope.id }]
  const visited = new Set<string>()
  let hadError = false

  while (queue.length > 0) {
    const cur = queue.shift()!
    const k = `${cur.level}:${cur.id}`
    if (visited.has(k)) continue
    visited.add(k)
    keys.add(k)

    const childLevel = childScopeLevel(cur.level)
    if (!childLevel) continue
    try {
      const children = await getChildChurches({ level: cur.level, id: cur.id })
      for (const c of children || []) {
        if (c?.id) queue.push({ level: childLevel, id: c.id })
      }
    } catch {
      hadError = true
    }
  }

  if (hadError) {
    // Deterministic fallback: exact scope only; do not cache partial trees.
    return new Set([cacheKey])
  }

  _descendantScopeCache.set(cacheKey, { keys, ts: Date.now() })
  return keys
}

async function getDescendantScopeKeysForScopes(scopes: Array<{ level: string; id: string }>): Promise<Set<string>> {
  const out = new Set<string>()
  const valid = (scopes || []).filter((s) => s?.level && s?.id)
  const expanded = await mapWithConcurrency(valid, BATCH_CONCURRENCY, (s) =>
    getDescendantScopeKeysForScope({ level: s.level, id: s.id }),
  )
  for (const keys of expanded) {
    for (const k of keys) out.add(k)
  }
  return out
}

async function queryEventsByExpandedScopeKeys(
  expandedScopeKeys: Set<string>,
  {
    statuses,
    excludeSpecialGroup = false,
    limit,
  }: { statuses?: string[]; excludeSpecialGroup?: boolean; limit?: number } = {},
) {
  if (!expandedScopeKeys.size) return []
  const expandedScopes = [...expandedScopeKeys].map((k) => {
    const [level, id] = k.split(':')
    return { level, id }
  })

  const batches: Array<Array<{ level: string; id: string }>> = []
  for (let i = 0; i < expandedScopes.length; i += SCOPE_OR_BATCH_SIZE) {
    batches.push(expandedScopes.slice(i, i + SCOPE_OR_BATCH_SIZE))
  }

  const resultSets = await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
    let q = supabase.from('checkin_events').select(CHECKIN_EVENT_LIST_COLUMNS)
    if (excludeSpecialGroup) q = q.neq('scope_level', 'special_group')
    const orFilter = batch
      .map((s) => `and(scope_level.eq.${s.level},scope_church_id.eq.${s.id})`)
      .join(',')
    q = q.or(orFilter)
    if (statuses?.length) q = q.in('status', statuses)
    q = q.order('starts_at', { ascending: false })
    if (limit) q = q.limit(limit)
    const { data, error } = await q
    if (error) throw error
    return (data || []).map(mapEventRow)
  })

  const byId = new Map<string, any>()
  for (const rows of resultSets) {
    for (const row of rows) byId.set(row.id, row)
  }
  const sorted = [...byId.values()].sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())
  return limit ? sorted.slice(0, limit) : sorted
}

// ─── Column projections (Phase 2.1) ──────────────────────────────────────
// Explicit column lists keep transferred-bytes small. The biggest win:
//   • CHECKIN_EVENT_LIST_COLUMNS — drops geofence_polygon (jsonb, can be
//     large) from list queries that only need to render an event card.
//     Detail/edit screens use CHECKIN_EVENT_FULL_COLUMNS = '*'.
const MEMBER_PROFILE_LIST_COLUMNS =
  'id, email, title, first_name, last_name, phone, picture_url, roles, ' +
  'bacenta_id, bacenta_name, governorship_id, governorship_name, ' +
  'council_id, council_name, stream_id, stream_name, ' +
  'campus_id, campus_name, oversight_id, oversight_name, ' +
  'denomination_id, denomination_name, scope_ids, updated_at'

const CHECKIN_EVENT_LIST_COLUMNS =
  'id, name, event_type, status, scope_level, scope_church_id, scope_church_name, ' +
  'venue_name, starts_at, ends_at, grace_period_min, auto_checkout_min, ' +
  'allowed_check_in_methods, allowed_roles, ' +
  'geofence_type, geofence_center_lat, geofence_center_lng, geofence_radius_m, ' +
  'qr_secret, created_by_id, created_by_name, created_at, ' +
  'series_id, series_index, is_public'

// Detail/edit screens — pulls geofence_polygon and pin_hash columns too.
const CHECKIN_EVENT_FULL_COLUMNS = '*'

// Location-filtered listings — list columns plus the polygon needed for the
// client-side pointInGeofence check. Avoids pulling every detail column
// ('*') for rows that are mostly filtered out anyway.
const CHECKIN_EVENT_GEO_COLUMNS = CHECKIN_EVENT_LIST_COLUMNS + ', geofence_polygon'

// Attendance is binary — a record means Present, no record means Absent.
// Legacy checkout/late columns still exist in the DB but are never read.
const CHECKIN_RECORD_COLUMNS =
  'id, event_id, member_id, member_name, member_role, member_unit_name, ' +
  'checked_in_at, ' +
  'method, geo_verified, check_in_lat, check_in_lng, device_fingerprint, ' +
  'manual_reason, verified_by'

const AUDIT_LOG_COLUMNS =
  'id, action, actor_id, actor_name, event_id, target_id, target_name, details, created_at'

// ─── Module-level SWR cache for event listings ───────────────────────────
// Keyed by the scope filter string so different users get separate cache
// buckets (relevant when multiple users share a device / test session).
const EVENTS_LIST_TTL = 30 * 1000  // 30 s
const SCOPE_OR_BATCH_SIZE = 40
const _activeEventsCaches = new Map<string, { data: any[]; ts: number }>()
const _pastEventsCaches   = new Map<string, { data: any[]; ts: number }>()
const _allEventsCaches    = new Map<string, { data: any[]; ts: number }>()

// Throttle: fire the auto-end RPC at most once per minute client-side.
let _lastAutoEndTs = 0
const AUTO_END_INTERVAL = 60 * 1000  // 1 min

/** Fire-and-forget: tell the server to end any events that have passed
 *  their ends_at time. Safe to call frequently — the RPC is idempotent and
 *  this function is throttled to at most once per minute. */
function triggerAutoEnd() {
  const now = Date.now()
  if (now - _lastAutoEndTs < AUTO_END_INTERVAL) return
  _lastAutoEndTs = now
  // Wrap in a real Promise so `.catch` is reachable — supabase-js's builder
  // is a PromiseLike whose `.then` returns PromiseLike<void> without `.catch`.
  Promise.resolve(supabase.rpc('auto_checkout_expired_events'))
    .then(() => {
      // Invalidate caches so the next read picks up the updated statuses.
      invalidateEventListCache()
    })
    .catch(() => {/* best-effort */})
}

// Sentinel returned when a non-superadmin has no resolvable church ID.
// Listing functions short-circuit to [] when they see this value.
const _NO_SCOPE = '__no_scope__'

// Build a PostgREST OR filter for event visibility.
//
// Policy (product rule): visibility derives from where the user LEADS or
// ADMINS — never from where they merely sit as a member. The clause set is:
//   1. Every church the user holds a role edge for (getUserLeadershipRefs).
//   2. The ANCESTOR chain of each of those churches — a leader inside a
//      stream is an expected attendee of that stream's events, so events at
//      ancestor scopes of the church they lead are visible. Ancestors of the
//      user's own membership chain (flat profile refs) are NOT consulted.
// Descendant scopes are handled separately (listLowerScopeEventsVisibleToUser).
//
// SuperAdmins/superViewers bypass the filter and see all events (null).
// No role edges at all returns _NO_SCOPE — listing functions return [] early
// and skip the DB round-trip.
async function buildScopeOrFilter(user: AppUser): Promise<string | null> {
  if (user.isSuperAdmin || user.isSuperViewer) return null
  const anchors = getUserLeadershipRefs(user)
  if (anchors.length === 0) return _NO_SCOPE

  const seen = new Set(anchors.map((a) => `${a.level}:${a.id}`))
  const clauses = anchors.map((a) => `and(scope_level.eq.${a.level},scope_church_id.eq.${a.id})`)

  // Ancestor expansion is best-effort: hierarchy cache first inside
  // getChurchAncestors (in-memory TTL), then graph, then church_hierarchy.
  // On total failure the user still sees events at their own scopes.
  const chains = await Promise.all(
    anchors.map((a) =>
      withFallbackAfter(
        getChurchAncestors({ level: a.level, id: a.id }),
        DESC_SCOPE_HOME_TIMEOUT_MS,
        [] as Array<{ level: string; id: string }>,
      ),
    ),
  )
  for (const chain of chains) {
    for (const node of chain || []) {
      if (!node?.id || !node.level || node.level === 'special_group') continue
      const key = `${node.level}:${node.id}`
      if (seen.has(key)) continue
      seen.add(key)
      clauses.push(`and(scope_level.eq.${node.level},scope_church_id.eq.${node.id})`)
    }
  }

  return clauses.join(',')
}

// Client-side relevance gate applied after fetching.
// An event is relevant to a user when:
//   1. The user's role is explicitly listed in allowed_roles, OR
//   2. allowed_roles contains no admin roles (it's a pure leader event visible
//      to everyone who is structurally in scope).
// Exported for unit testing only — internal callers use it via .filter().
// Visibility is determined entirely by the DB scope filter (buildScopeOrFilter).
// If the query returned an event, the user is structurally scoped for it — that
// is sufficient. allowed_roles governs check-in eligibility, not visibility.
export function isEventRelevantToUser(_evt: any, _user: AppUser): boolean {
  return true
}

// ─── member_profiles ────────────────────────────────────────────────────────

/** Upsert a single leader after login. Mirrors the user object built by
 *  enrichUser() — falls back to memberToProfileRow() shape if you've already
 *  fetched a Member node via the GraphQL adapter. */
export async function upsertMemberProfile(user) {
  if (!user?.userId && !user?.id) return null
  const row = {
    id: user.userId || user.id,
    email: user.email || null,
    title: user.title || null,
    first_name: user.firstName || user.first_name || null,
    last_name: user.lastName || user.last_name || null,
    phone: user.phone || user.phoneNumber || null,
    picture_url: user.picture_url || user.pictureUrl || null,
    roles: user.roles || [],
    bacenta_id:      user.bacenta?.id      || user.bacenta_id      || null,
    bacenta_name:    user.bacenta?.name    || user.bacenta_name    || null,
    governorship_id: user.governorship?.id || user.governorship_id || null,
    governorship_name: user.governorship?.name || user.governorship_name || null,
    council_id:      user.council?.id      || user.council_id      || null,
    council_name:    user.council?.name    || user.council_name    || null,
    stream_id:       user.stream?.id       || user.stream_id       || null,
    stream_name:     user.stream?.name     || user.stream_name     || null,
    campus_id:       user.campus?.id       || user.campus_id       || null,
    campus_name:     user.campus?.name     || user.campus_name     || null,
    oversight_id:    user.oversight?.id    || user.oversight_id    || null,
    oversight_name:  user.oversight?.name  || user.oversight_name  || null,
    denomination_id: user.denomination?.id || user.denomination_id || null,
    denomination_name: user.denomination?.name || user.denomination_name || null,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('member_profiles')
    .upsert(row, { onConflict: 'id' })
    // Explicit columns, not '*': anon SELECT on face_descriptor is revoked
    // by migration 024 and a '*' representation would fail outright.
    .select(MEMBER_PROFILE_LIST_COLUMNS)
    .single()
  if (error) throw error
  return data
}

/** Bulk upsert — used after admin event creation to sync the eligible-member
 *  set into member_profiles for fast dashboard joins. Accepts rows in the
 *  shape returned by memberToProfileRow(). */
export async function bulkUpsertMemberProfiles(rows) {
  if (!rows?.length) return []
  const stamped = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))
  const { data, error } = await supabase
    .from('member_profiles')
    .upsert(stamped, { onConflict: 'id' })
    // Explicit columns, not '*' — see upsertMemberProfile.
    .select(MEMBER_PROFILE_LIST_COLUMNS)
  if (error) throw error
  return data || []
}

/** Read a member's flat profile row. */
export async function getMemberProfile(memberId) {
  const { data, error } = await supabase
    .from('member_profiles')
    .select('id, email, title, first_name, last_name, phone, picture_url, roles, ' +
            'bacenta_id, bacenta_name, governorship_id, governorship_name, ' +
            'council_id, council_name, stream_id, stream_name, ' +
            'campus_id, campus_name, oversight_id, oversight_name, ' +
            'denomination_id, denomination_name, updated_at')
    .eq('id', memberId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function listMemberProfilesPaginated(
  page: number, pageSize: number,
): Promise<{ data: any[]; count: number }> {
  const from = page * pageSize
  const to = from + pageSize - 1
  const { data, error, count } = await supabase
    .from('member_profiles')
    .select(
      'id, title, first_name, last_name, email, picture_url, roles, ' +
      'bacenta_name, governorship_name, council_name, stream_name, campus_name',
      { count: 'exact' },
    )
    .order('first_name', { ascending: true })
    .range(from, to)
  if (error) throw error
  return { data: data || [], count: count ?? 0 }
}

export async function searchMemberProfiles(query: string, limit = 50): Promise<any[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const { data, error } = await supabase
    .from('member_profiles')
    .select('id, title, first_name, last_name, email, picture_url, roles, ' +
            'bacenta_name, governorship_name, council_name, stream_name, campus_name')
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
    .order('first_name', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data || []
}

// ─── checkin_events ─────────────────────────────────────────────────────────

/** Create an event via the create_checkin_event RPC. PIN is hashed
 *  server-side; QR secret is generated client-side (returned in `qrSecretHex`
 *  so the admin's UI can immediately render the QR).
 *
 *  input: {
 *    name, eventType, scopeLevel, scopeChurchId, scopeChurchName,
 *    startsAt (Date|ISO string), endsAt, gracePeriodMin, autoCheckoutMin,
 *    allowedCheckInMethods: string[], allowedRoles: string[],
 *    geofence: { type: 'circle', centerLat, centerLng, radiusM }
 *           | { type: 'polygon', polygon: [[lat,lng], ...] },
 *    pin: string|null, createdBy: { id, name }
 *  }
 *  returns: { eventId, qrSecretHex, pin }   // pin echoed for admin display
 */
export async function createEvent(input) {
  const qrSecretHex = generateQrSecretHex()
  const params = {
    p_name: input.name,
    p_event_type: input.eventType || null,
    p_scope_level: input.scopeLevel,
    p_scope_church_id: input.scopeChurchId,
    p_scope_church_name: input.scopeChurchName,
    p_venue_name: input.venueName || null,
    p_starts_at: toIso(input.startsAt),
    p_ends_at: toIso(input.endsAt),
    p_grace_period_min: input.gracePeriodMin ?? 15,
    p_auto_checkout_min: input.autoCheckoutMin ?? 0,
    p_allowed_check_in_methods: input.allowedCheckInMethods,
    p_allowed_roles: input.allowedRoles,
    p_geofence_type: input.geofence.type,
    p_geofence_center_lat: input.geofence.type === 'circle' ? input.geofence.centerLat : null,
    p_geofence_center_lng: input.geofence.type === 'circle' ? input.geofence.centerLng : null,
    p_geofence_radius_m:   input.geofence.type === 'circle' ? input.geofence.radiusM   : null,
    p_geofence_polygon:    input.geofence.type === 'polygon' ? input.geofence.polygon  : null,
    p_pin_plain: input.pin || null,
    p_qr_secret_hex: qrSecretHex,
    p_created_by_id: input.createdBy.id,
    p_created_by_name: input.createdBy.name,
    p_is_public: input.isPublic ?? true,
  }
  const { data, error } = await supabase.rpc('create_checkin_event', params)
  if (error) throw error
  if (input.seriesId) {
    // Non-critical — best-effort tag; series linkage doesn't affect check-in.
    await supabase
      .from('checkin_events')
      .update({ series_id: input.seriesId, series_index: input.seriesIndex ?? 1 })
      .eq('id', data)
  }
  invalidateEventListCache()
  return { eventId: data, qrSecretHex, pin: input.pin || null }
}

export async function getEvent(eventId) {
  // Detail/edit screen — need geofence_polygon and pin_hash.
  const { data, error } = await supabase
    .from('checkin_events').select(CHECKIN_EVENT_FULL_COLUMNS).eq('id', eventId).single()
  if (error) throw error
  return mapEventRow(data)
}

/** Snapshot-based entry gate — one RPC before dashboard or check-in routing. */
export async function getEventEntryState(input: {
  eventId: string
  memberIds: string[]
  email?: string
}): Promise<any> {
  const { data, error } = await supabase.rpc('get_event_entry_state', {
    p_event_id: input.eventId,
    p_member_ids: input.memberIds,
    p_email: input.email ?? null,
  })
  if (error) throw error
  return data
}

/** Active events (status=ACTIVE, within time window), filtered to the events
 *  whose scope church appears in the calling user's church hierarchy.
 *  SuperAdmins bypass the filter and see all events.
 *  Includes events starting within the next hour (pre-event check-in window). */
export async function listActiveEvents(user?: AppUser) {
  // Best-effort background sync: end expired events so DB stays up-to-date.
  triggerAutoEnd()

  const scopeFilter = user ? await buildScopeOrFilter(user) : null
  if (scopeFilter === _NO_SCOPE) return []
  // Cache key must distinguish: anonymous ('public'), superadmin ('superadmin'),
  // and each scoped user (their orFilter string). Without this, a public-page
  // fetch (which strips special_group events) would poison the superadmin cache.
  // Include userId so two scoped users on the same device never share a
  // bucket — isEventRelevantToUser filters per-user below.
  const cacheKey = user?.isSuperAdmin ? 'superadmin' : user?.isSuperViewer ? 'superviewer'
    : user?.userId ? `u:${user.userId}:${scopeFilter ?? 'none'}` : (scopeFilter ?? 'public')
  const cached = _activeEventsCaches.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_LIST_TTL) return cached.data

  const nowIso          = new Date().toISOString()
  const oneHourLaterIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  let query = supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .eq('status', 'ACTIVE')
    .lte('starts_at', oneHourLaterIso)
    .gte('ends_at', nowIso)
    .order('ends_at', { ascending: true })
  // Never expose special_group events on the public QR page or to non-superadmins
  // via this function. Member-scoped special group events are fetched separately
  // via listActiveSpecialGroupEventsForUser and merged by the caller.
  if (!user || (!user.isSuperAdmin && !user.isSuperViewer)) query = query.neq('scope_level', 'special_group')
  // Public QR page (no user): only show events the creator flagged as public.
  if (!user) query = query.eq('is_public', true)
  if (scopeFilter) query = query.or(scopeFilter)
  const { data, error } = await query
  if (error) throw error
  const mapped = (data || []).map(mapEventRow)
  const result = user ? mapped.filter((evt) => isEventRelevantToUser(evt, user)) : mapped
  _activeEventsCaches.set(cacheKey, { data: result, ts: Date.now() })
  return result
}

/** Active special-group events scoped to groups the given member belongs to.
 *  Used by the QR display page to show special meeting QR codes only to
 *  members who are actually in that group — other authenticated users won't
 *  see them, and anonymous visitors never see them at all. */
export async function listActiveSpecialGroupEventsForUser(memberId: string) {
  // Step 1: resolve which special groups this member belongs to.
  const { data: memberships, error: me } = await supabase
    .from('special_group_members')
    .select('group_id')
    .eq('member_id', memberId)
  if (me) throw me
  const groupIds = (memberships || []).map((m: { group_id: string }) => m.group_id)
  if (!groupIds.length) return []

  // Step 2: fetch active events scoped to those groups.
  triggerAutoEnd()
  const nowIso          = new Date().toISOString()
  const oneHourLaterIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .eq('status', 'ACTIVE')
    .eq('scope_level', 'special_group')
    .in('scope_church_id', groupIds)
    .lte('starts_at', oneHourLaterIso)
    .gte('ends_at', nowIso)
    .order('ends_at', { ascending: true })
  if (error) throw error
  return (data || []).map(mapEventRow)
}

/** Recent past events (ENDED or time-expired ACTIVE), within `daysBack` days,
 *  filtered to the calling user's church hierarchy scope. */
export async function listRecentPastEvents({ daysBack = 30, user }: { daysBack?: number; user?: AppUser } = {}) {
  const scopeFilter = user ? await buildScopeOrFilter(user) : null
  if (scopeFilter === _NO_SCOPE) return []
  const cacheKey    = `past:${user?.userId ?? 'anon'}:${scopeFilter ?? 'all'}`
  const cached = _pastEventsCaches.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_LIST_TTL) return cached.data

  const nowIso = new Date().toISOString()
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  // Include properly ENDED events AND ACTIVE events whose time has already
  // passed (not yet auto-ended by the server cron).
  let query = supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .in('status', ['ENDED', 'ACTIVE'])
    .lte('ends_at', nowIso)
    .gte('ends_at', cutoff)
    .order('ends_at', { ascending: false })
    .limit(20)
  if (scopeFilter) query = query.or(scopeFilter)
  const { data, error } = await query
  if (error) throw error
  const mapped = (data || []).map(mapEventRow)
  const result = user ? mapped.filter((evt) => isEventRelevantToUser(evt, user)) : mapped
  _pastEventsCaches.set(cacheKey, { data: result, ts: Date.now() })
  return result
}

/** All special-group events (any status) for the groups a member belongs to.
 *  Parallel sibling of listActiveSpecialGroupEventsForUser — no time filter. */
async function listAllSpecialGroupEventsForUser(memberId: string) {
  const { data: memberships, error: me } = await supabase
    .from('special_group_members')
    .select('group_id')
    .eq('member_id', memberId)
  if (me) throw me
  const groupIds = (memberships || []).map((m: { group_id: string }) => m.group_id)
  if (!groupIds.length) return []

  const { data, error } = await supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .eq('scope_level', 'special_group')
    .in('scope_church_id', groupIds)
    .order('starts_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return (data || []).map(mapEventRow)
}

async function listLowerScopeEventsVisibleToUser(user: AppUser, limit = 200, existingIds?: Set<string>) {
  if (!user || user.isSuperAdmin || user.isSuperViewer) return []
  // Role edges only — getUserChurchRefs would let a flat membership ref
  // shadow a role edge with the same church id and drop it entirely.
  const roleAnchorScopes = getUserLeadershipRefs(user)
    .map((r) => ({ level: r.level, id: r.id }))
  if (roleAnchorScopes.length === 0) return []

  const expandedScopeKeys = await withFallbackAfter(
    getDescendantScopeKeysForScopes(roleAnchorScopes),
    DESC_SCOPE_HOME_TIMEOUT_MS,
    exactScopeKeys(roleAnchorScopes),
  )
  if (!expandedScopeKeys.size) return []
  const rows = await queryEventsByExpandedScopeKeys(expandedScopeKeys, { excludeSpecialGroup: true })
  const fresh = rows.filter((evt) => !existingIds?.has(evt.id))
  return limit > 0 ? fresh.slice(0, limit) : fresh
}

/** All events (past, active, future) for the user's scope, newest-first.
 *  Used by the home screen so leaders always see their events.
 *  Special-group events are merged in separately because buildScopeOrFilter
 *  never generates special_group clauses.
 *
 *  When a focusedScope is set, the focus (plus its descendants) becomes the
 *  SQL predicate itself — one indexed query on (scope_level, scope_church_id)
 *  — instead of fetching everything the user's roles allow and narrowing the
 *  array in JS afterwards. */
export async function listAllEvents(user?: AppUser, opts?: { focusedScope?: FocusedScope; limit?: number }) {
  triggerAutoEnd()

  const focus = opts?.focusedScope
  if (user && focus?.level && focus?.id) {
    return listAllEventsForFocusedScope(user, { level: focus.level, id: focus.id }, opts)
  }

  const scopeFilter = user ? await buildScopeOrFilter(user) : null
  if (scopeFilter === _NO_SCOPE) return []
  // Key must include both userId (separate buckets for same-hierarchy users with
  // different group memberships) AND scopeFilter (so post-hydration re-fetches
  // get a fresh bucket when the scope has widened rather than hitting stale data).
  const cacheKey = user?.userId
    ? `all:${user.userId}:${scopeFilter ?? 'nofilter'}`
    : `all:${scopeFilter ?? 'all'}`
  const cached = _allEventsCaches.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_LIST_TTL) return cached.data

  let query = supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .order('starts_at', { ascending: false })
    .limit(opts?.limit ?? 50)
  if (scopeFilter) query = query.or(scopeFilter)
  // scopeFilter is non-null for normal users, null for superAdmin/superViewer
  // (who already get all events from the main query).
  const [{ data, error }, groupEvents] = await Promise.all([
    query,
    user?.userId && !user.isSuperAdmin && !user.isSuperViewer
      ? listAllSpecialGroupEventsForUser(user.userId)
      : Promise.resolve([] as any[]),
  ])
  if (error) throw error
  const mapped = (data || []).map(mapEventRow)

  const lowerScopeEvents = user && scopeFilter !== null
    ? await withFallbackAfter(
        listLowerScopeEventsVisibleToUser(user, Math.max(200, opts?.limit ?? 50), new Set(mapped.map((e) => e.id))),
        DESC_SCOPE_HOME_TIMEOUT_MS,
        [] as CheckinEventRow[],
      )
    : []

  // Merge extra events (special-group + lower-scope hierarchy visibility),
  // dedup by id, then re-sort by starts_at descending.
  let merged = mapped
  const extra = [...groupEvents, ...lowerScopeEvents]
  if (extra.length > 0) {
    const seen = new Set(mapped.map((e) => e.id))
    const fresh = extra.filter((e) => !seen.has(e.id))
    if (fresh.length > 0) {
      merged = [...mapped, ...fresh].sort(
        (a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime(),
      )
    }
  }

  const result = user ? merged.filter((evt) => isEventRelevantToUser(evt, user)) : merged
  _allEventsCaches.set(cacheKey, { data: result, ts: Date.now() })
  return result
}

/** Server-side focused listing. The focus must be one of the user's own
 *  church refs (superadmin/superviewer excepted) — a tampered sessionStorage
 *  focus outside the user's tree returns [], matching what the old
 *  fetch-then-filter path would have produced. */
async function listAllEventsForFocusedScope(
  user: AppUser,
  focus: { level: string; id: string },
  opts?: { limit?: number },
) {
  const cacheKey = `allfocus:${user.userId ?? 'anon'}:${focus.level}:${focus.id}`
  const cached = _allEventsCaches.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_LIST_TTL) return cached.data

  // Defensive: special_group never comes from the scope switcher today
  // (availableScopes only holds church levels), but keep old semantics.
  if (focus.level === 'special_group') {
    const { data, error } = await supabase
      .from('checkin_events')
      .select(CHECKIN_EVENT_LIST_COLUMNS)
      .eq('scope_level', 'special_group')
      .eq('scope_church_id', focus.id)
      .order('starts_at', { ascending: false })
      .limit(opts?.limit ?? 50)
    if (error) throw error
    const result = (data || []).map(mapEventRow)
    _allEventsCaches.set(cacheKey, { data: result, ts: Date.now() })
    return result
  }

  if (!user.isSuperAdmin && !user.isSuperViewer) {
    // Focus options come from the user's role scopes (getUserRoleScopes), so
    // authorize against role edges — membership refs grant nothing.
    const authorized = getUserLeadershipRefs(user)
      .some((r) => r.level === focus.level && r.id === focus.id)
    if (!authorized) return []
  }

  const scopeKeys = await withFallbackAfter(
    getDescendantScopeKeysForScope(focus),
    DESC_SCOPE_HOME_TIMEOUT_MS,
    exactScopeKeys([focus]),
  )
  const result = await queryEventsByExpandedScopeKeys(scopeKeys, {
    excludeSpecialGroup: true,
    limit: Math.max(200, opts?.limit ?? 50),
  })
  _allEventsCaches.set(cacheKey, { data: result, ts: Date.now() })
  return result
}

/** Active events filtered to the caller's GPS position (geofence check).
 *  Used by the QR display screen at the venue.
 *  Includes events starting within the next hour. */
export async function listActiveEventsAtLocation(lat, lng) {
  const nowIso          = new Date().toISOString()
  const oneHourLaterIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  // Needs geofence_polygon for pointInGeofence on polygon-shaped events.
  const { data, error } = await supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_GEO_COLUMNS)
    .eq('status', 'ACTIVE')
    .lte('starts_at', oneHourLaterIso)
    .gte('ends_at', nowIso)
  if (error) throw error
  return (data || [])
    .map(mapEventRow)
    .filter((evt) => pointInGeofence({ lat, lng }, evt))
}

/** Recent past events filtered to the caller's GPS position.
 *  Kept for any future location-aware past-event views. */
export async function listRecentPastEventsAtLocation(lat, lng, { daysBack = 30 } = {}) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  // Needs geofence_polygon for pointInGeofence on polygon-shaped events.
  const { data, error } = await supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_GEO_COLUMNS)
    .eq('status', 'ENDED')
    .gte('ends_at', cutoff)
    .order('ends_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return (data || [])
    .map(mapEventRow)
    .filter((evt) => pointInGeofence({ lat, lng }, evt))
}

/** Lists all events the user can see for admin views (dashboard, history).
 *  scopes: array of { level, id } — typically from getAdminScopes(member). */
export async function listEventsForAdminScopes(
  scopes: Array<{ level: string; id: string }>,
  { statuses, user }: { statuses?: string[]; user?: AppUser } = {}
) {
  if (user?.isSuperAdmin || user?.isSuperViewer) {
    let q = supabase.from('checkin_events').select(CHECKIN_EVENT_LIST_COLUMNS)
    if (statuses?.length) q = q.in('status', statuses)
    const { data, error } = await q.order('starts_at', { ascending: false })
    if (error) throw error
    return (data || []).map(mapEventRow)
  }

  if (!scopes?.length) return []
  const expandedScopeKeys = await getDescendantScopeKeysForScopes(scopes)
  if (expandedScopeKeys.size === 0) return []
  return queryEventsByExpandedScopeKeys(expandedScopeKeys, { statuses })
}

/** Lists events the member has personally attended (has a checkin_record for).
 *  Used by History so a leader keeps seeing past events they participated in
 *  even after being moved to a different scope. */
export async function listEventsAttendedByMember(memberId: string) {
  if (!memberId) return []
  const { data: recs, error: re } = await supabase
    .from('checkin_records')
    .select('event_id')
    .eq('member_id', memberId)
  if (re) throw re
  const ids = [...new Set((recs || []).map((r) => r.event_id))]
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .in('id', ids)
    .order('starts_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapEventRow)
}

// ─── event_scope_members ─────────────────────────────────────────────────────
// Permanent scope snapshot: every member who was in-scope at event creation is
// recorded by their stable graph ID. This is the source of truth for event
// history and replaces live Neo4j queries on the dashboard.

/** Bulk-upsert a set of graph member IDs as the scope snapshot for an event.
 *  Safe to call repeatedly — upsert is idempotent. */
export async function snapshotEventScopeMembers(
  eventId: string,
  memberIds: string[],
): Promise<void> {
  if (!eventId || !memberIds.length) return
  const rows = memberIds.map((member_id) => ({ event_id: eventId, member_id }))
  const { error } = await supabase
    .from('event_scope_members')
    .upsert(rows, { onConflict: 'event_id,member_id' })
  if (error) throw error
}

/** Add a single member to an event's scope snapshot and upsert their profile.
 *  Used by superadmins to include a member who was added to the graph after
 *  the snapshot was taken. profileRow must be the output of memberToProfileRow(). */
export async function addMemberToEventScope(
  eventId: string,
  profileRow: any,
): Promise<void> {
  await bulkUpsertMemberProfiles([profileRow])
  await snapshotEventScopeMembers(eventId, [profileRow.id])
}

/** Load the scope snapshot for an event joined with current member_profiles.
 *  Returns member_profiles rows for every snapshotted member that has a
 *  profile row. Members who have never logged in are omitted from the join
 *  result but remain in event_scope_members for history purposes.
 *  Returns [] if no snapshot exists yet (caller should fall back to graph). */
export async function listEventScopeMembersWithProfiles(eventId: string): Promise<any[]> {
  if (!eventId) return []
  try {
    const { data, error } = await supabase.rpc('get_event_scope_profiles', {
      p_event_id: eventId,
    })
    if (!error) return data || []
    if (!/function .*get_event_scope_profiles|could not find/i.test(error.message || '')) {
      throw error
    }
  } catch (err: any) {
    if (!/function .*get_event_scope_profiles|could not find/i.test(err?.message || '')) {
      throw err
    }
    // Older deployments without migration 026 fall back to the batched path.
  }

  const { data: snap, error: se } = await supabase
    .from('event_scope_members')
    .select('member_id')
    .eq('event_id', eventId)
  if (se) throw se
  const ids = (snap || []).map((r: any) => r.member_id)
  if (!ids.length) return []

  // Batch into groups of 50 to stay well under Supabase's URL length limit.
  // 500 UUIDs in one .in() call ≈ 18 KB URL → 400 Bad Request.
  const BATCH = 50
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH))

  // See mapWithConcurrency near the top of this file for why this isn't Promise.all.
  const results = await mapWithConcurrency(batches, BATCH_CONCURRENCY, (batch) =>
    supabase
      .from('member_profiles')
      .select(MEMBER_PROFILE_LIST_COLUMNS)
      .in('id', batch),
  )
  for (const { error } of results) if (error) throw error
  return results.flatMap((r) => r.data || [])
}

/** Count of members in an event's scope snapshot — the stable "Total Expected"
 *  denominator. Unlike listEventScopeMembersWithProfiles (which inner-joins
 *  member_profiles and so only counts members who have logged in), this counts
 *  every snapshotted member. The snapshot is written at event creation (and only
 *  grows via an explicit superadmin add), so this number stays stable on refresh
 *  rather than drifting as members lazily gain profiles by logging in. */
export async function countEventScopeMembers(eventId: string): Promise<number> {
  if (!eventId) return 0
  const { count, error } = await supabase
    .from('event_scope_members')
    .select('member_id', { count: 'exact', head: true })
    .eq('event_id', eventId)
  if (error) throw error
  return count ?? 0
}

/** Events where the given graph member ID appears in the scope snapshot.
 *  Used by EventHistory to include events a member was scoped to even if
 *  they didn't check in and were later moved to a different scope. */
export async function listScopedEventsForMember(graphMemberId: string): Promise<any[]> {
  if (!graphMemberId) return []
  const { data: snap, error: se } = await supabase
    .from('event_scope_members')
    .select('event_id')
    .eq('member_id', graphMemberId)
  if (se) throw se
  const ids = (snap || []).map((r: any) => r.event_id)
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('checkin_events')
    .select(CHECKIN_EVENT_LIST_COLUMNS)
    .in('id', ids)
    .order('starts_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapEventRow)
}

/** Fallback scope-member query that reads member_profiles directly when the
 *  Neo4j graph is unavailable (503 / timeout).
 *
 *  Because member_profiles stores every ancestor church ID (bacenta_id,
 *  governorship_id, council_id, …), filtering on `${scopeLevel}_id` returns
 *  all members who sit anywhere inside that scope — matching the graph query's
 *  intent. Coverage is best-effort (only members who have ever logged in), but
 *  avoids a hard error when the graph is down. */
export async function listMemberProfilesByScope(
  scopeLevel: string,
  scopeChurchId: string,
): Promise<any[]> {
  const col = `${scopeLevel}_id`
  const { data, error } = await supabase
    .from('member_profiles')
    .select(MEMBER_PROFILE_LIST_COLUMNS)
    .eq(col, scopeChurchId)
  if (error) throw error
  return data || []
}

// ─── Event lifecycle (admin actions) ────────────────────────────────────────
function invalidateEventListCache() {
  _activeEventsCaches.clear()
  _pastEventsCaches.clear()
  _allEventsCaches.clear()
}

export async function pauseEvent(eventId)  { invalidateEventListCache(); return updateEventStatus(eventId, 'PAUSED') }
export async function resumeEvent(eventId) { invalidateEventListCache(); return updateEventStatus(eventId, 'ACTIVE') }

// Manually ending an event. Calls the end_event_now RPC which atomically:
//  - Flips status to ENDED.
//  - Truncates ends_at to now() if the scheduled end was still in the future.
// Admins see the result immediately — no waiting for the every-minute cron.
export async function endEvent(eventId) {
  invalidateEventListCache()
  const { error: rpcError } = await supabase.rpc('end_event_now', { p_event_id: eventId })
  if (rpcError) throw rpcError
  // Re-read the row so callers get the updated mapped event.
  return getEvent(eventId)
}

/** Hard-delete an event. Restricted to super-admins server-side: the
 *  delete_event RPC checks the caller's email against the superadmins
 *  table before proceeding. Cascades via FKs remove every related
 *  checkin_record, audit_log entry, etc. Irreversible. */
export async function deleteEvent(eventId: string, adminEmail: string) {
  if (!adminEmail) throw new Error('Admin email is required')
  const { data, error } = await supabase.rpc('delete_event', {
    p_event_id: eventId,
    p_admin_email: adminEmail,
  })
  if (error) throw error
  if (!data?.ok) {
    const reason = data?.reason
    if (reason === 'forbidden')        throw new Error('Only super-admins can delete events.')
    if (reason === 'event_not_found')  throw new Error('Event not found.')
    if (reason === 'admin_email_required') throw new Error('Admin email is required.')
    throw new Error(reason || 'Delete failed.')
  }
  invalidateEventListCache()
  return data
}

async function updateEventStatus(eventId, status) {
  const { data, error } = await supabase
    .from('checkin_events').update({ status }).eq('id', eventId).select().single()
  if (error) throw error
  return mapEventRow(data)
}

export async function extendEvent(eventId, newEndsAt) {
  const patch: Record<string, any> = { ends_at: toIso(newEndsAt) }
  // If the new end time is in the future, bring an ENDED event back to ACTIVE.
  if (new Date(newEndsAt) > new Date()) {
    const current = await getEvent(eventId)
    if (current.status === 'ENDED') patch.status = 'ACTIVE'
  }
  const { data, error } = await supabase
    .from('checkin_events')
    .update(patch)
    .eq('id', eventId)
    .select().single()
  if (error) throw error
  return mapEventRow(data)
}

export async function resetPin(eventId, newPin) {
  const { error } = await supabase.rpc('reset_event_pin', {
    p_event_id: eventId, p_pin_plain: newPin,
  })
  if (error) throw error
  return { ok: true }
}

/** Generic event update for the edit form. Accepts a partial object whose
 *  keys are column names. Caller is responsible for not sending fields that
 *  should stay immutable (e.g. id, qr_secret, created_by_id) and for
 *  normalizing dates to ISO strings. */
export async function updateEvent(eventId, patch) {
  if (!patch || Object.keys(patch).length === 0) {
    return getEvent(eventId)
  }
  // Defensively strip dangerous keys.
  const { id, qr_secret, qr_secret_hex, created_by_id, created_by_name, created_at, pin_hash, ...safe } = patch
  if (safe.starts_at) safe.starts_at = toIso(safe.starts_at)
  if (safe.ends_at)   safe.ends_at   = toIso(safe.ends_at)

  // If ends_at is being pushed into the future, resurrect a previously-ended
  // event back to ACTIVE so it appears in all active-event queries.
  if (safe.ends_at && new Date(safe.ends_at) > new Date()) {
    const current = await getEvent(eventId)
    if (current.status === 'ENDED') {
      safe.status = 'ACTIVE'
    }
  }

  const { data, error } = await supabase
    .from('checkin_events').update(safe).eq('id', eventId).select().single()
  if (error) throw error
  invalidateEventListCache()
  return mapEventRow(data)
}

// ─── Check-in submission ────────────────────────────────────────────────────

/** Single entry point for QR / PIN check-ins.
 *  All validation (time window, QR HMAC, PIN, geofence, device fingerprint)
 *  is performed server-side inside the submit_checkin RPC.
 *  input: {
 *    eventId, member: { id, name, role, unitName },
 *    method: 'QR'|'PIN',
 *    lat, lng, fingerprint,
 *    qrToken?: string, pin?: string,
 *    event?: <event row>  // kept for API compat, no longer used for validation
 *  }
 */
export async function submitCheckIn(input) {
  const { eventId, member, method, lat, lng, fingerprint, qrToken, pin } = input

  // All validation (time, QR HMAC, PIN, geofence, device) is enforced
  // server-side inside the submit_checkin RPC.
  const { data, error } = await supabase.rpc('submit_checkin', {
    p_event_id:    eventId,
    p_member_id:   member.id,
    p_member_name: member.name || null,
    p_member_role: member.role || null,
    p_member_unit: member.unitName || null,
    p_method:      method,
    p_lat:         lat,
    p_lng:         lng,
    p_fingerprint: fingerprint,
    p_qr_token:    qrToken || null,
    p_pin_plain:   pin || null,
  })
  if (error) return { ok: false, reason: 'rpc_error', error: error.message }
  return data
}

/** Admin-driven manual check-in. Bypasses QR/PIN/Face but enforces
 *  geofence + role + scope. Records who did it and why. */
export async function submitManualCheckIn({
  eventId, admin, member, lat, lng, fingerprint, reason, event,
}: {
  eventId: string
  admin: { id: string; name?: string }
  member: { id: string; name?: string; role?: string | null; unitName?: string | null }
  lat: number
  lng: number
  fingerprint?: string
  reason?: string
  event?: any
}) {
  if (event && !pointInGeofence({ lat, lng }, event)) {
    return { ok: false, reason: 'admin_outside_fence' }
  }
  const { data, error } = await supabase
    .from('checkin_records')
    .insert({
      event_id: eventId,
      member_id: member.id,
      member_name: member.name || null,
      member_role: member.role || null,
      member_unit_name: member.unitName || null,
      method: 'MANUAL',
      geo_verified: true,
      check_in_lat: lat,
      check_in_lng: lng,
      device_fingerprint: fingerprint || `manual:${admin.id}`,
      manual_reason: reason || null,
      verified_by: `admin:${admin.id}`,
    })
    .select().single()
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'already_checked_in' }
    return { ok: false, reason: 'db_error', error: error.message }
  }
  return { ok: true, record: data }
}

// ─── Dashboard reads ────────────────────────────────────────────────────────

export async function listCheckedIn(eventId): Promise<any[]> {
  const { data, error } = await supabase
    .from('checkin_records')
    .select(CHECKIN_RECORD_COLUMNS)
    .eq('event_id', eventId)
    .order('checked_in_at', { ascending: false })
  if (error) throw error
  return data || []
}

/** Fetch the current user's check-in record for a specific event (null if none). */
export async function getMyRecord(eventId, memberId) {
  const { data, error } = await supabase
    .from('checkin_records')
    .select(CHECKIN_RECORD_COLUMNS)
    .eq('event_id', eventId)
    .eq('member_id', memberId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// ─── Attendance Stats ─────────────────────────────────────────────────────────

/** Returns aggregate attendance statistics for a member across all events they
 *  were in scope for. Present = checked in, Absent = not checked in — nothing
 *  else. Pass the graph member ID (same value stored in
 *  event_scope_members.member_id and member_profiles.id). */
export async function getAttendanceStats(graphMemberId: string): Promise<{
  presentCount: number
  absentCount: number
  lastCheckIn: string | null
} | null> {
  if (!graphMemberId) return null
  // Aggregates run in Postgres (migration 023) — one RPC instead of pulling
  // every scope row + record row for the member and counting in JS.
  const { data, error } = await supabase.rpc('get_member_attendance_stats', {
    p_member_id: graphMemberId,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null

  const scopedCount  = row.scoped_count ?? 0
  const presentCount = row.attended_count ?? 0

  return {
    presentCount,
    absentCount: Math.max(0, scopedCount - presentCount),
    lastCheckIn: row.last_check_in || null,
  }
}

// ─── Absence Notes ────────────────────────────────────────────────────────────
// Admins record reasons for members who defaulted on an event.

/** Upsert an absence note for a (event, member) pair. Overwrites on conflict. */
export async function upsertAbsenceNote(
  eventId: string,
  memberId: string,
  reason: string,
  recordedBy: string,
): Promise<void> {
  const { error } = await supabase
    .from('absence_notes')
    .upsert(
      { event_id: eventId, member_id: memberId, reason, recorded_by: recordedBy, recorded_at: new Date().toISOString() },
      { onConflict: 'event_id,member_id' },
    )
  if (error) throw error
}

/** Returns a map from member_id → reason for all absence notes on an event. */
export async function listAbsenceNotesForEvent(eventId: string): Promise<Map<string, string>> {
  if (!eventId) return new Map()
  const { data, error } = await supabase
    .from('absence_notes')
    .select('member_id, reason')
    .eq('event_id', eventId)
  if (error) throw error
  return new Map((data || []).map((r) => [r.member_id, r.reason]))
}

// ─── Audit Log ────────────────────────────────────────────────────────────────
// Fire-and-forget append-only trail for admin actions. Never throws — a
// failed audit write must never break the user action that triggered it.

export async function addAuditLog(entry: {
  action: string
  actorId: string
  actorName?: string
  eventId?: string
  targetId?: string
  targetName?: string
  details?: Record<string, any>
}): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    action:      entry.action,
    actor_id:    entry.actorId,
    actor_name:  entry.actorName  || null,
    event_id:    entry.eventId    || null,
    target_id:   entry.targetId   || null,
    target_name: entry.targetName || null,
    details:     entry.details    || null,
  })
  if (error) console.warn('[audit_log] write failed:', error.message)
}

/** Fetch the 100 most-recent audit entries for an event (newest first). */
export async function listAuditLogForEvent(eventId: string): Promise<any[]> {
  if (!eventId) return []
  const { data, error } = await supabase
    .from('audit_log')
    .select(AUDIT_LOG_COLUMNS)
    .eq('event_id', eventId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data || []
}

// ─── helpers ────────────────────────────────────────────────────────────────

// ─── Risk Flags ────────────────────────────────────────────────────────────
/**
 * Returns a Set of member_ids whose device_fingerprint was shared with at
 * least one other member in the same event (excluding MANUAL check-ins since
 * those all originate from the admin's device by definition).
 */
export async function getRiskyCheckIns(eventId: string): Promise<Set<string>> {
  if (!eventId) return new Set()
  // GROUP BY / HAVING runs in Postgres (migration 023) — the client no longer
  // downloads every record row to tally fingerprints in JS.
  const { data, error } = await supabase.rpc('get_risky_checkin_member_ids', {
    p_event_id: eventId,
  })
  if (error) throw error
  return new Set<string>((data as string[] | null) || [])
}

/** Only two attendance metrics exist app-wide: checked in and absent. */
export interface DashboardStats {
  attended: number
  absent: number
  viewer_checked_in: boolean
  updated_at: string
}

/** Present/Absent are counted over ONE population so the dashboard headline
 *  always matches the drill-down lists: pass memberIds for an explicit slice,
 *  or allowedRoles to have Postgres derive the population from the event
 *  scope snapshot ∩ member_profiles.roles (the client's "eligible" rule). */
export async function getEventDashboardStats(input: {
  eventId: string
  memberIds?: string[] | null
  allowedRoles?: string[] | null
  notStarted?: boolean
  viewerMemberIds?: string[]
}): Promise<DashboardStats> {
  const { data, error } = await supabase.rpc('get_event_dashboard_stats', {
    p_event_id: input.eventId,
    p_member_ids: input.memberIds ?? null,
    p_allowed_roles: input.allowedRoles ?? null,
    p_not_started: !!input.notStarted,
    p_viewer_member_ids: input.viewerMemberIds ?? [],
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    attended: row?.attended ?? 0,
    absent: row?.absent ?? 0,
    viewer_checked_in: !!row?.viewer_checked_in,
    updated_at: row?.updated_at ?? new Date().toISOString(),
  }
}

export async function getRiskyCheckInCount(eventId: string): Promise<number> {
  if (!eventId) return 0
  const { data, error } = await supabase.rpc('get_risky_checkin_count', {
    p_event_id: eventId,
  })
  if (error) throw error
  return Number(data ?? 0)
}

function toIso(v) {
  if (!v) return v
  if (v instanceof Date) return v.toISOString()
  return v
}

/** Normalize a checkin_events row: bytea qr_secret comes back as a hex-prefixed
 *  string ('\x...') from PostgREST; we strip the prefix so callers can pass it
 *  to verifyQrToken / generateQrToken directly. */
function mapEventRow(row) {
  if (!row) return row
  let qrSecretHex = row.qr_secret
  if (typeof qrSecretHex === 'string' && qrSecretHex.startsWith('\\x')) {
    qrSecretHex = qrSecretHex.slice(2)
  }
  // Normalise status: if an ACTIVE event's time has passed the server cron
  // hasn't run yet — treat it as ENDED so all UI views stay consistent.
  const status =
    row.status === 'ACTIVE' && row.ends_at && new Date(row.ends_at) <= new Date()
      ? 'ENDED'
      : row.status
  return { ...row, status, qr_secret_hex: qrSecretHex }
}


// ─── Special Groups ───────────────────────────────────────────────────────────
// Cross-scope groups of members managed by superadmins. Used for special
// meetings that span multiple church scopes without following the hierarchy.

export interface SpecialGroup {
  id: string
  name: string
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
  member_count?: number
}

export interface SpecialGroupMember {
  group_id: string
  member_id: string
  member_name: string | null
  added_at: string
  picture_url?: string | null
}

export async function listSpecialGroups(): Promise<SpecialGroup[]> {
  // Counts come from the special_groups_with_counts view (migration 023) —
  // one query, no per-member row fetch.
  const { data, error } = await supabase
    .from('special_groups_with_counts')
    .select('id, name, description, created_by, created_at, updated_at, member_count')
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}

export async function getSpecialGroup(groupId: string): Promise<SpecialGroup | null> {
  const { data, error } = await supabase
    .from('special_groups')
    .select('*')
    .eq('id', groupId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function createSpecialGroup(input: {
  name: string
  description?: string
  createdBy: string
}): Promise<SpecialGroup> {
  const { data, error } = await supabase
    .from('special_groups')
    .insert({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      created_by: input.createdBy,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateSpecialGroup(groupId: string, input: {
  name: string
  description?: string
}): Promise<void> {
  const { error } = await supabase
    .from('special_groups')
    .update({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', groupId)
  if (error) throw error
}

export async function deleteSpecialGroup(groupId: string): Promise<void> {
  const { error } = await supabase
    .from('special_groups')
    .delete()
    .eq('id', groupId)
  if (error) throw error
}

export async function listSpecialGroupMembers(groupId: string): Promise<SpecialGroupMember[]> {
  const { data, error } = await supabase
    .from('special_group_members')
    .select('group_id, member_id, member_name, added_at')
    .eq('group_id', groupId)
    .order('member_name', { ascending: true })
  if (error) throw error
  const members = data || []
  if (!members.length) return []
  // Enrich with picture_url from member_profiles (member_id == member_profiles.id)
  const ids = members.map((m) => m.member_id)
  const { data: profiles } = await supabase
    .from('member_profiles')
    .select('id, picture_url')
    .in('id', ids)
  const picMap = new Map<string, string | null>()
  for (const p of profiles || []) picMap.set(p.id, p.picture_url)
  return members.map((m) => ({ ...m, picture_url: picMap.get(m.member_id) ?? null }))
}

export async function addMembersToSpecialGroup(
  groupId: string,
  members: { id: string; name: string }[],
): Promise<void> {
  if (!members.length) return
  const rows = members.map((m) => ({
    group_id: groupId,
    member_id: m.id,
    member_name: m.name,
  }))
  const { error } = await supabase
    .from('special_group_members')
    .upsert(rows, { onConflict: 'group_id,member_id' })
  if (error) throw error
}

export async function removeMemberFromSpecialGroup(
  groupId: string,
  memberId: string,
): Promise<void> {
  const { error } = await supabase
    .from('special_group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('member_id', memberId)
  if (error) throw error
}
