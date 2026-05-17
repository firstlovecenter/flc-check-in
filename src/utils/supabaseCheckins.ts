// All Supabase reads and writes for the app.
// Patterns mirror src/legacy/utils/logs.js. Every screen and admin component
// goes through this file — no direct supabase calls elsewhere.

import { supabase } from './supabase'
import { generateQrSecretHex } from './checkinsCrypto'
import { pointInGeofence } from './geo'
import { getUserChurchRefs } from './userScope'
import type { AppUser } from '../types/app'

// ─── Module-level SWR cache for event listings ───────────────────────────
// Keyed by the scope filter string so different users get separate cache
// buckets (relevant when multiple users share a device / test session).
const EVENTS_LIST_TTL = 30 * 1000  // 30 s
const _activeEventsCaches = new Map<string, { data: any[]; ts: number }>()
const _pastEventsCaches   = new Map<string, { data: any[]; ts: number }>()

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
  supabase.rpc('auto_checkout_expired_events').then(() => {
    // Invalidate caches so the next read picks up the updated statuses.
    invalidateEventListCache()
  }).catch(() => {/* best-effort */})
}

// Sentinel returned when a non-superadmin has no resolvable church ID.
// Listing functions short-circuit to [] when they see this value.
const _NO_SCOPE = '__no_scope__'

// Build a PostgREST OR filter that covers every church level in the user's
// ancestry. Sub-scope leaders can discover higher-scope events they are
// structurally part of (e.g. a bacenta leader can see a stream-level event).
// SuperAdmins bypass the filter and see all events (returns null).
// Anyone without any resolvable church IDs returns _NO_SCOPE — listing
// functions return [] early and skip the DB round-trip.
//
// The per-level resolution rules live in utils/userScope.ts; this function
// only assembles the resulting clauses.
function buildScopeOrFilter(user: AppUser): string | null {
  if (user.isSuperAdmin) return null
  const refs = getUserChurchRefs(user)
  if (refs.length === 0) return _NO_SCOPE
  return refs
    .map((r) => `and(scope_level.eq.${r.level},scope_church_id.eq.${r.id})`)
    .join(',')
}

// Client-side relevance gate applied after fetching.
// An event is relevant to a user when:
//   1. The user's role is explicitly listed in allowed_roles, OR
//   2. allowed_roles contains no admin roles (it's a pure leader event visible
//      to everyone who is structurally in scope).
// Exported for unit testing only — internal callers use it via .filter().
export function isEventRelevantToUser(evt: any, user: AppUser): boolean {
  if (user.isSuperAdmin) return true
  const userRoles = new Set<string>(user.roles || [])
  const allowed: string[] = evt.allowed_roles || []
  if (allowed.some((r) => userRoles.has(r))) return true
  if (!allowed.some((r) => r.startsWith('admin'))) return true
  return false
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
    .select()
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
    .select()
  if (error) throw error
  return data || []
}

/** Read a member's flat profile row.
 *  Excludes face_descriptor (128-float array, ~1KB) — that column is only
 *  needed by face-enrolment and biometrics admin screens, which fetch it
 *  via dedicated helpers (getMyFaceDescriptor / listMembersForBiometricsAdmin). */
export async function getMemberProfile(memberId) {
  const { data, error } = await supabase
    .from('member_profiles')
    .select('id, email, title, first_name, last_name, phone, roles, ' +
            'bacenta_id, bacenta_name, governorship_id, governorship_name, ' +
            'council_id, council_name, stream_id, stream_name, ' +
            'campus_id, campus_name, oversight_id, oversight_name, ' +
            'denomination_id, denomination_name, updated_at')
    .eq('id', memberId)
    .maybeSingle()
  if (error) throw error
  return data
}

// ─── Face ID ───────────────────────────────────────────────────────────────
// Descriptors are 128-float vectors from face-api.js. Stored on
// member_profiles.face_descriptor (double precision[]).

export async function getMyFaceDescriptor(memberId: string): Promise<Float32Array | null> {
  const { data, error } = await supabase
    .from('member_profiles').select('face_descriptor').eq('id', memberId).maybeSingle()
  if (error) throw error
  const arr = data?.face_descriptor
  if (!Array.isArray(arr) || arr.length === 0) return null
  return new Float32Array(arr)
}

// Self-service first-time enrolment. Refuses to overwrite an existing
// descriptor — once a user has Face ID set up, only an admin can clear it
// (which then re-enables this path on the user's next login).
//
// Uses a check-then-upsert pattern so enrollment succeeds even when the
// member_profiles row hasn't been written yet (the post-login profile sync
// is fire-and-forget and may not have landed by the time the user completes
// the face sweep).
export async function setMyFaceDescriptor(memberId: string, descriptor: Float32Array): Promise<void> {
  // Read current state first (maybeSingle → null if row doesn't exist yet)
  const { data: existing, error: checkErr } = await supabase
    .from('member_profiles')
    .select('face_descriptor')
    .eq('id', memberId)
    .maybeSingle()
  if (checkErr) throw checkErr

  if (existing?.face_descriptor) {
    throw new Error('Face ID is already set up. Contact an admin to reset it.')
  }

  // Row either doesn't exist yet (upsert will create it) or exists with
  // face_descriptor = null (upsert will update just that column).
  const { error } = await supabase
    .from('member_profiles')
    .upsert({ id: memberId, face_descriptor: Array.from(descriptor) }, { onConflict: 'id' })
  if (error) throw error
}

// Admin-only: wipe a member's Face ID. After this the member's next login
// will re-trigger the first-time enrolment modal.
export async function adminClearFaceDescriptor(memberId: string): Promise<void> {
  const { error } = await supabase
    .from('member_profiles')
    .update({ face_descriptor: null })
    .eq('id', memberId)
  if (error) throw error
}

// Fetches member profile rows for an admin's biometrics dashboard. Returns
// every member within the OR of the given (level, churchId) scope pairs,
// with a boolean `has_face_id` derived from face_descriptor presence.
//
// scopes: [{ level, id }] — typically getAdminScopes(member).
//
// Uses the `has_face_id` generated column (migration 009) instead of pulling
// the 128-float face_descriptor over the wire. For large scopes this turns a
// multi-MB payload into a few KB.
export async function listMembersForBiometricsAdmin(
  scopes: Array<{ level: string; id: string }>
): Promise<Array<any>> {
  if (!scopes?.length) return []
  // OR over (<level>_id eq <id>) pairs.
  const orFilter = scopes.map((s) => `${s.level}_id.eq.${s.id}`).join(',')
  const { data, error } = await supabase
    .from('member_profiles')
    .select('id, first_name, last_name, email, roles, ' +
            'bacenta_id, bacenta_name, governorship_id, governorship_name, ' +
            'council_id, council_name, stream_id, stream_name, ' +
            'campus_id, campus_name, oversight_id, oversight_name, ' +
            'denomination_id, denomination_name, has_face_id')
    .or(orFilter)
  if (error) throw error
  return data || []
}

// Records a server-side claim that the client just matched the user's face
// locally. submit_checkin requires a fresh claim (<60s) for FACE_ID and
// consumes it on success.
export async function claimFaceMatch(eventId: string, memberId: string) {
  const { data, error } = await supabase.rpc('claim_face_match', {
    p_event_id: eventId,
    p_member_id: memberId,
  })
  if (error) return { ok: false, reason: 'rpc_error', error: error.message }
  return data
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
  }
  const { data, error } = await supabase.rpc('create_checkin_event', params)
  if (error) throw error
  invalidateEventListCache()
  return { eventId: data, qrSecretHex, pin: input.pin || null }
}

export async function getEvent(eventId) {
  const { data, error } = await supabase
    .from('checkin_events').select('*').eq('id', eventId).single()
  if (error) throw error
  return mapEventRow(data)
}

/** Active events (status=ACTIVE, within time window), filtered to the events
 *  whose scope church appears in the calling user's church hierarchy.
 *  SuperAdmins bypass the filter and see all events.
 *  Includes events starting within the next hour (pre-event check-in window). */
export async function listActiveEvents(user?: AppUser) {
  // Best-effort background sync: end expired events so DB stays up-to-date.
  triggerAutoEnd()

  const scopeFilter = user ? buildScopeOrFilter(user) : null
  if (scopeFilter === _NO_SCOPE) return []
  const cacheKey    = scopeFilter ?? 'all'
  const cached = _activeEventsCaches.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_LIST_TTL) return cached.data

  const nowIso          = new Date().toISOString()
  const oneHourLaterIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  let query = supabase
    .from('checkin_events')
    .select('*')
    .eq('status', 'ACTIVE')
    .lte('starts_at', oneHourLaterIso)
    .gte('ends_at', nowIso)
    .order('ends_at', { ascending: true })
  if (scopeFilter) query = query.or(scopeFilter)
  const { data, error } = await query
  if (error) throw error
  const mapped = (data || []).map(mapEventRow)
  const result = user ? mapped.filter((evt) => isEventRelevantToUser(evt, user)) : mapped
  _activeEventsCaches.set(cacheKey, { data: result, ts: Date.now() })
  return result
}

/** Recent past events (ENDED or time-expired ACTIVE), within `daysBack` days,
 *  filtered to the calling user's church hierarchy scope. */
export async function listRecentPastEvents({ daysBack = 30, user }: { daysBack?: number; user?: AppUser } = {}) {
  const scopeFilter = user ? buildScopeOrFilter(user) : null
  if (scopeFilter === _NO_SCOPE) return []
  const cacheKey    = `past:${scopeFilter ?? 'all'}`
  const cached = _pastEventsCaches.get(cacheKey)
  if (cached && Date.now() - cached.ts < EVENTS_LIST_TTL) return cached.data

  const nowIso = new Date().toISOString()
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  // Include properly ENDED events AND ACTIVE events whose time has already
  // passed (not yet auto-ended by the server cron).
  let query = supabase
    .from('checkin_events')
    .select('*')
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

/** Active events filtered to the caller's GPS position (geofence check).
 *  Used by the QR display screen at the venue.
 *  Includes events starting within the next hour. */
export async function listActiveEventsAtLocation(lat, lng) {
  const nowIso          = new Date().toISOString()
  const oneHourLaterIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('checkin_events')
    .select('*')
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
  const { data, error } = await supabase
    .from('checkin_events')
    .select('*')
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
  { statuses }: { statuses?: string[] } = {}
) {
  if (!scopes?.length) return []
  // OR over (scope_level + scope_church_id) pairs.
  const orFilter = scopes
    .map((s) => `and(scope_level.eq.${s.level},scope_church_id.eq.${s.id})`)
    .join(',')
  let q = supabase.from('checkin_events').select('*').or(orFilter)
  if (statuses?.length) q = q.in('status', statuses)
  const { data, error } = await q.order('starts_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapEventRow)
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
    .select('*')
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

/** Load the scope snapshot for an event joined with current member_profiles.
 *  Returns member_profiles rows for every snapshotted member that has a
 *  profile row. Members who have never logged in are omitted from the join
 *  result but remain in event_scope_members for history purposes.
 *  Returns [] if no snapshot exists yet (caller should fall back to graph). */
export async function listEventScopeMembersWithProfiles(eventId: string): Promise<any[]> {
  if (!eventId) return []
  const { data: snap, error: se } = await supabase
    .from('event_scope_members')
    .select('member_id')
    .eq('event_id', eventId)
  if (se) throw se
  const ids = (snap || []).map((r: any) => r.member_id)
  if (!ids.length) return []
  const { data: profiles, error: pe } = await supabase
    .from('member_profiles')
    .select('*')
    .in('id', ids)
  if (pe) throw pe
  return profiles || []
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
    .select('*')
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
    .select('*')
    .eq(col, scopeChurchId)
  if (error) throw error
  return data || []
}

// ─── Event lifecycle (admin actions) ────────────────────────────────────────
function invalidateEventListCache() {
  _activeEventsCaches.clear()
  _pastEventsCaches.clear()
}

export async function pauseEvent(eventId)  { invalidateEventListCache(); return updateEventStatus(eventId, 'PAUSED') }
export async function resumeEvent(eventId) { invalidateEventListCache(); return updateEventStatus(eventId, 'ACTIVE') }

// Manually ending an event. Calls the end_event_now RPC which atomically:
//  - Flips status to ENDED.
//  - Truncates ends_at to now() if the scheduled end was still in the future.
//  - Closes every open checkin_record (auto_checked_out = true).
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
  const isLate = event
    ? Date.now() > new Date(event.starts_at).getTime() + (event.grace_period_min || 0) * 60_000
    : false
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
      is_late: isLate,
    })
    .select().single()
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'already_checked_in' }
    return { ok: false, reason: 'db_error', error: error.message }
  }
  return { ok: true, record: data }
}

/** Heartbeat from a checked-in leader. Server decides whether to checkout. */
export async function reportLocation(eventId, memberId, lat, lng) {
  const { data, error } = await supabase.rpc('report_member_location', {
    p_event_id: eventId, p_member_id: memberId, p_lat: lat, p_lng: lng,
  })
  if (error) throw error
  return data
}

// ─── Dashboard reads ────────────────────────────────────────────────────────

export async function listCheckedIn(eventId) {
  const { data, error } = await supabase
    .from('checkin_records')
    .select('*')
    .eq('event_id', eventId)
    .order('checked_in_at', { ascending: false })
  if (error) throw error
  return data || []
}

/** Defaulted = eligible members with NO record for this event. Caller passes
 *  the eligible set (typically from member_profiles filtered by event scope). */
export async function listDefaulted(eventId, eligibleMemberIds) {
  if (!eligibleMemberIds?.length) return []
  const { data: records, error } = await supabase
    .from('checkin_records')
    .select('member_id')
    .eq('event_id', eventId)
  if (error) throw error
  const checkedIn = new Set((records || []).map((r) => r.member_id))
  const defaultedIds = eligibleMemberIds.filter((id) => !checkedIn.has(id))
  if (!defaultedIds.length) return []
  const { data: profiles, error: pe } = await supabase
    .from('member_profiles')
    .select('*')
    .in('id', defaultedIds)
  if (pe) throw pe
  return profiles || []
}

/** Fetch the current user's check-in record for a specific event (null if none). */
export async function getMyRecord(eventId, memberId) {
  const { data, error } = await supabase
    .from('checkin_records')
    .select('*')
    .eq('event_id', eventId)
    .eq('member_id', memberId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// ─── Attendance Stats ─────────────────────────────────────────────────────────

/** Returns aggregate attendance statistics for a member across all events they
 *  were in scope for.  Pass the graph member ID (same value stored in
 *  event_scope_members.member_id and member_profiles.id). */
export async function getAttendanceStats(graphMemberId: string): Promise<{
  scopedCount: number
  attendedCount: number
  lateCount: number
  onTimeCount: number
  pct: number | null
  lastCheckIn: string | null
} | null> {
  if (!graphMemberId) return null
  const [scopeRes, recordRes] = await Promise.all([
    supabase
      .from('event_scope_members')
      .select('event_id')
      .eq('member_id', graphMemberId),
    supabase
      .from('checkin_records')
      .select('event_id, checked_in_at, is_late')
      .eq('member_id', graphMemberId)
      .order('checked_in_at', { ascending: false }),
  ])
  if (scopeRes.error) throw scopeRes.error
  if (recordRes.error) throw recordRes.error

  const scopedCount   = (scopeRes.data  || []).length
  const records       = (recordRes.data || [])
  const attendedCount = records.length
  const lateCount     = records.filter((r) => r.is_late).length

  return {
    scopedCount,
    attendedCount,
    lateCount,
    onTimeCount: attendedCount - lateCount,
    pct: scopedCount > 0 ? Math.round((attendedCount / scopedCount) * 100) : null,
    lastCheckIn: records[0]?.checked_in_at || null,
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
    .select('*')
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
  const { data, error } = await supabase
    .from('checkin_records')
    .select('member_id, device_fingerprint, method')
    .eq('event_id', eventId)
  if (error) throw error
  if (!data || data.length === 0) return new Set()

  // Group by fingerprint, ignoring MANUAL and blank fingerprints.
  const fpMap = new Map<string, string[]>()
  for (const row of data) {
    if (!row.device_fingerprint || row.method === 'MANUAL') continue
    const existing = fpMap.get(row.device_fingerprint) ?? []
    existing.push(row.member_id)
    fpMap.set(row.device_fingerprint, existing)
  }

  const risky = new Set<string>()
  for (const members of fpMap.values()) {
    if (members.length > 1) members.forEach((m) => risky.add(m))
  }
  return risky
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
