// All Supabase reads and writes for the FLC Check-In feature.
// Patterns mirror src/legacy/utils/logs.js. Every screen and admin component
// goes through this file — no direct supabase calls elsewhere.

import { supabase } from './supabase'
import { generateQrSecretHex } from './checkinsCrypto'
import { pointInGeofence } from './geo'

// ─── Module-level SWR cache for event listings ───────────────────────────
// Makes the home screen and QR screen instant on revisit (no spinner, no
// extra network round-trip while the background revalidation runs in parallel).
const EVENTS_LIST_TTL = 30 * 1000  // 30 s — events don't change minute-to-minute
let _activeEventsCache: { data: any[]; ts: number } | null = null
let _pastEventsCache:   { data: any[]; ts: number } | null = null

// ─── member_profiles ────────────────────────────────────────────────────────

/** Upsert a single leader after login. Mirrors the user object built by
 *  enrichUser() — falls back to memberToProfileRow() shape if you've already
 *  fetched a Member node via the GraphQL adapter. */
export async function upsertMemberProfile(user) {
  if (!user?.userId && !user?.id) return null
  const row = {
    id: user.userId || user.id,
    email: user.email || null,
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

export async function getMemberProfile(memberId) {
  const { data, error } = await supabase
    .from('member_profiles').select('*').eq('id', memberId).maybeSingle()
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
export async function listMembersForBiometricsAdmin(
  scopes: Array<{ level: string; id: string }>
): Promise<Array<any>> {
  if (!scopes?.length) return []
  // OR over (<level>_id eq <id>) pairs.
  const orFilter = scopes.map((s) => `${s.level}_id.eq.${s.id}`).join(',')
  const { data, error } = await supabase
    .from('member_profiles')
    .select('id, first_name, last_name, email, roles, bacenta_id, bacenta_name, governorship_id, governorship_name, council_id, council_name, stream_id, stream_name, campus_id, campus_name, oversight_id, oversight_name, denomination_id, denomination_name, face_descriptor')
    .or(orFilter)
  if (error) throw error
  return (data || []).map((r) => {
    const arr = r.face_descriptor
    const has_face_id = Array.isArray(arr) && arr.length > 0
    // Drop the descriptor bytes from the row — UI just needs the boolean.
    const { face_descriptor, ...rest } = r
    void face_descriptor
    return { ...rest, has_face_id }
  })
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

/** Active events (status=ACTIVE, within time window) — all events, no
 *  location filtering. Used for listing on the leader home screen. */
export async function listActiveEvents() {
  if (_activeEventsCache && Date.now() - _activeEventsCache.ts < EVENTS_LIST_TTL) {
    return _activeEventsCache.data
  }
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('checkin_events')
    .select('*')
    .eq('status', 'ACTIVE')
    .lte('starts_at', nowIso)
    .gte('ends_at', nowIso)
    .order('ends_at', { ascending: true })
  if (error) throw error
  const result = (data || []).map(mapEventRow)
  _activeEventsCache = { data: result, ts: Date.now() }
  return result
}

/** Recent past events (status=ENDED, ended within `daysBack` days) — no
 *  location filtering. Used for listing on the leader home screen. */
export async function listRecentPastEvents({ daysBack = 30 } = {}) {
  if (_pastEventsCache && Date.now() - _pastEventsCache.ts < EVENTS_LIST_TTL) {
    return _pastEventsCache.data
  }
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('checkin_events')
    .select('*')
    .eq('status', 'ENDED')
    .gte('ends_at', cutoff)
    .order('ends_at', { ascending: false })
    .limit(20)
  if (error) throw error
  const result = (data || []).map(mapEventRow)
  _pastEventsCache = { data: result, ts: Date.now() }
  return result
}

/** Active events filtered to the caller's GPS position (geofence check).
 *  Used by the QR display screen at the venue. */
export async function listActiveEventsAtLocation(lat, lng) {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('checkin_events')
    .select('*')
    .eq('status', 'ACTIVE')
    .lte('starts_at', nowIso)
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

// ─── Event lifecycle (admin actions) ────────────────────────────────────────
function invalidateEventListCache() {
  _activeEventsCache = null
  _pastEventsCache   = null
}

export async function pauseEvent(eventId)  { invalidateEventListCache(); return updateEventStatus(eventId, 'PAUSED') }
export async function resumeEvent(eventId) { invalidateEventListCache(); return updateEventStatus(eventId, 'ACTIVE') }
export async function endEvent(eventId)    { invalidateEventListCache(); return updateEventStatus(eventId, 'ENDED') }

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

/** Voluntarily check out: sets checked_out_at = now() on the leader's own record. */
export async function selfCheckOut(recordId) {
  const { error } = await supabase
    .from('checkin_records')
    .update({ checked_out_at: new Date().toISOString() })
    .eq('id', recordId)
  if (error) throw error
}

// ─── helpers ────────────────────────────────────────────────────────────────

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
  return { ...row, qr_secret_hex: qrSecretHex }
}
