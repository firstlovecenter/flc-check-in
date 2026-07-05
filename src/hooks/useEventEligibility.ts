// SWR-style hook that loads the eligibility pipeline for an event:
//   getEvent + listCheckedIn + resolveCurrentMember + getChurchAncestors
//   + scope members (snapshot-first) → eligible members + viewer capabilities.
//
// Performance design:
//   • Stale-while-revalidate: serves the previous result from the module-level
//     cache IMMEDIATELY (no spinner on revisit), then revalidates in the
//     background and updates the UI when fresh data arrives.
//   • Snapshot-first: loads scope members from event_scope_members (Supabase,
//     fast) instead of querying the live Neo4j graph. Falls back to the graph
//     only if no snapshot exists yet (legacy events / create race), and saves
//     the snapshot immediately so the next load is fast.
//   • bulkUpsertMemberProfiles fires in the background — never blocks render.
//   • All graph calls are already deduplicated / TTL-cached in membersApi.ts.
//   • Optional poll: only refreshes the cheap part (event status + records).
//     The expensive eligibility pipeline is NOT re-run on every poll tick.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getEvent, listCheckedIn, bulkUpsertMemberProfiles,
  listEventScopeMembersWithProfiles, snapshotEventScopeMembers,
  listMemberProfilesByScope, listSpecialGroupMembers,
  countEventScopeMembers,
} from '../utils/supabaseCheckins'
import {
  getMembersInScope, memberToProfileRow,
  resolveCurrentMember, getChurchAncestors, getViewerCapabilities,
  getAdminScopes, countChildScopes,
} from '../utils/membersApi'
import { getUserChurchRef } from '../utils/userScope'
import { bypassesScopeAndRoleLimits } from '../utils/superadmin'
import { SCOPE_LEVELS } from '../types/app'
import type { AppUser, CheckinEventRow, ScopeLevel } from '../types/app'

// ─── Module-level SWR cache ──────────────────────────────────────────────
const ELIGIBILITY_TTL = 4 * 60 * 1000  // 4 min
// Persisted cache survives full reloads / tab restores; only used for instant
// first-paint while the fresh fetch is in flight.
const ELIGIBILITY_PERSIST_TTL = 30 * 60 * 1000  // 30 min sanity cap
// v2: persisted entries must include event + viewerCaps (v1 could strand UI on spinner).
const ELIGIBILITY_STORAGE_PREFIX = 'flc:elig:v2:'
// Cap stored event/records snapshots to avoid pathological localStorage usage.
const PERSIST_EVENTS_MAX = 6

interface CachedEligibility {
  eligible: any[]
  eligibleIds: Set<string>
  viewerCaps: any
  viewerSlice: any[]
  adminScopes: any[]
  childCount: number | null
  /** Fixed event-scope snapshot size — the stable "Total Expected" count. */
  scopeMemberCount: number | null
  event?: CheckinEventRow | null
  records?: any[]
  ts: number
}

const eligibilityCache = new Map<string, CachedEligibility>()

function persistKey(cacheKey: string) { return ELIGIBILITY_STORAGE_PREFIX + cacheKey }

function normalizeCacheEntry(raw: any): CachedEligibility | null {
  if (!raw || Date.now() - (raw.ts ?? 0) > ELIGIBILITY_PERSIST_TTL) return null
  if (!raw.event || !raw.viewerCaps) return null
  return {
      eligible: Array.isArray(raw.eligible)
        ? raw.eligible.filter((r: any) => r != null && r.id != null && r.id !== '')
        : [],
    eligibleIds: new Set<string>(raw.eligibleIds || []),
    viewerCaps: raw.viewerCaps,
      viewerSlice: Array.isArray(raw.viewerSlice)
        ? raw.viewerSlice.filter((r: any) => r != null && r.id != null && r.id !== '')
        : [],
    adminScopes: Array.isArray(raw.adminScopes) ? raw.adminScopes : [],
    childCount: raw.childCount ?? null,
    scopeMemberCount: raw.scopeMemberCount ?? null,
    event: raw.event,
    records: Array.isArray(raw.records) ? raw.records : [],
    ts: raw.ts,
  }
}

function readPersistedEligibility(cacheKey: string): CachedEligibility | null {
  try {
    const raw = localStorage.getItem(persistKey(cacheKey))
    if (!raw) return null
    return normalizeCacheEntry(JSON.parse(raw))
  } catch { return null }
}

function writePersistedEligibility(cacheKey: string, entry: CachedEligibility) {
  try {
    const serialisable = {
      ...entry,
      eligibleIds: [...entry.eligibleIds],
    }
    localStorage.setItem(persistKey(cacheKey), JSON.stringify(serialisable))
    pruneOldPersistedEligibility()
  } catch { /* quota / disabled storage */ }
}

// Keep the persisted cache small. If more than PERSIST_EVENTS_MAX entries
// exist, drop the oldest. Best-effort — failures are silent.
function pruneOldPersistedEligibility() {
  try {
    const entries: Array<{ key: string; ts: number }> = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(ELIGIBILITY_STORAGE_PREFIX)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      try {
        const ts = JSON.parse(raw)?.ts ?? 0
        entries.push({ key: k, ts })
      } catch { localStorage.removeItem(k) }
    }
    if (entries.length <= PERSIST_EVENTS_MAX) return
    entries.sort((a, b) => a.ts - b.ts)
    for (const e of entries.slice(0, entries.length - PERSIST_EVENTS_MAX)) {
      localStorage.removeItem(e.key)
    }
  } catch { /* ignore */ }
}

// ─── Public interface ────────────────────────────────────────────────────
export interface EventEligibilityResult {
  event: CheckinEventRow | null
  eligible: any[]         // all eligible members for the event scope
  eligibleIds: Set<string>
  viewerCaps: any | null
  viewerSlice: any[]      // eligible members scoped to the viewer's unit
  adminScopes: any[]
  childCount: number | null
  /** Fixed event-scope snapshot size — the stable "Total Expected" count.
   *  null until the snapshot has been resolved. */
  scopeMemberCount: number | null
  records: any[]
  error: string | null
  /** true only on the very first load for this event — not on poll ticks or
   *  background revalidation (so there's no spinner flash on revisit). */
  initialLoading: boolean
  setEvent: React.Dispatch<React.SetStateAction<CheckinEventRow | null>>
  setRecords: React.Dispatch<React.SetStateAction<any[]>>
}

export function useEventEligibility(
  eventId: string | undefined,
  user: AppUser | null,
  { pollMs, refreshKey = 0 }: { pollMs?: number; refreshKey?: number } = {},
): EventEligibilityResult {
  const [event, setEvent]         = useState<CheckinEventRow | null>(null)
  const [eligible, setEligible]   = useState<any[]>([])
  const [eligibleIds, setEligibleIds] = useState(new Set<string>())
  const [viewerCaps, setViewerCaps]   = useState<any | null>(null)
  const [viewerSlice, setViewerSlice] = useState<any[]>([])
  const [adminScopes, setAdminScopes] = useState<any[]>([])
  const [childCount, setChildCount]   = useState<number | null>(null)
  const [scopeMemberCount, setScopeMemberCount] = useState<number | null>(null)
  const [records, setRecords]         = useState<any[]>([])
  const [error, setError]             = useState<string | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)

  // ── Initial eligibility load ────────────────────────────────────────────
  useEffect(() => {
    if (!eventId || !user) return
    let cancelled = false
    const cacheKey = `${eventId}:${user.userId || user.email}`

    // When refreshKey increases, drop the cached entry so the load below
    // hits the network even if the previous entry is still fresh.
    if (refreshKey > 0) {
      eligibilityCache.delete(cacheKey)
      try { localStorage.removeItem(persistKey(cacheKey)) } catch { /* ignore */ }
    }

    // Stale-while-revalidate: serve cached result immediately so the UI
    // renders with real data before any network request completes.
    // Layer 1: in-memory cache (this tab session only).
    // Layer 2: localStorage cache (survives reloads / tab restores).
    const memHit = eligibilityCache.get(cacheKey)
    const memCandidate = memHit && Date.now() - memHit.ts < ELIGIBILITY_TTL ? memHit : null
    const hit = (memCandidate && memCandidate.event && memCandidate.viewerCaps)
      ? memCandidate
      : readPersistedEligibility(cacheKey)
    if (hit) {
      const withId = (rows: any[]) => rows.filter((r) => r != null && r.id != null && r.id !== '')
      // If the cached viewerCaps were computed before superAdmin/superViewer status
      // was granted, override them immediately so the UI shows full scope while
      // the background fetch revalidates.
      let cachedCaps = hit.viewerCaps
      let cachedSlice = withId(hit.viewerSlice)
      // user.isSuperAdmin/isSuperViewer already incorporate the persisted
      // override flags (enrichUser → readSuperFlag) — never read the raw
      // localStorage keys here; the flag value is an email now, not '1'.
      const effectiveIsSA = !!user?.isSuperAdmin
      const effectiveIsSV = !!user?.isSuperViewer
      if (hit.event && (effectiveIsSA || effectiveIsSV) && !hit.viewerCaps?.canManage && !hit.viewerCaps?.canViewFullEvent) {
        const eventScope = { level: hit.event.scope_level, id: hit.event.scope_church_id, name: hit.event.scope_church_name }
        const allElig = withId(hit.eligible)
        const eligSet = hit.eligibleIds ?? new Set(allElig.map((r: any) => r.id))
        cachedCaps = effectiveIsSA
          ? { ...cachedCaps, canManage: true, canCheckIn: eligSet.has(user.userId), canView: true, canViewFullEvent: true, canManuallyCheckIn: true, viewerScope: eventScope }
          : { ...cachedCaps, canManage: false, canCheckIn: false, canView: true, canViewFullEvent: true, canManuallyCheckIn: false, viewerScope: eventScope }
        cachedSlice = allElig
      }
      setEligible(withId(hit.eligible))
      setEligibleIds(hit.eligibleIds)
      setViewerCaps(cachedCaps)
      setViewerSlice(cachedSlice)
      setAdminScopes(hit.adminScopes)
      setChildCount(hit.childCount)
      setScopeMemberCount(hit.scopeMemberCount ?? null)
      setEvent(hit.event)
      setRecords(hit.records)
      setInitialLoading(false)
      // Still revalidate in background — don't return early.
    }

    ;(async () => {
      try {
        // Speculative Tier-3 warm-up: a non-admin leader's viewer slice is
        // (almost) always their own JWT scope, which we know before any
        // network call. getMembersInScope dedupes in-flight requests and
        // caches results, so the real Tier-3 call below joins this promise
        // instead of starting a fresh 400-600ms graph query after Tier 2.
        // Harmless when the guess is wrong (admin / special-group events) —
        // it just warms a cache entry.
        if (!user.isAdmin && !user.isSuperAdmin && !user.isSuperViewer && user.level) {
          const ownRef = getUserChurchRef(user, user.level as ScopeLevel)
          if (ownRef?.id) {
            getMembersInScope({ level: ownRef.level, churchId: ownRef.id }).catch(() => {})
          }
        }

        // Tier 1: get event + current check-in records in parallel (fast DB reads).
        const [evt, recs] = await Promise.all([
          getEvent(eventId),
          listCheckedIn(eventId),
        ])
        if (cancelled) return
        setEvent(evt)
        setRecords(recs)

        // Tier 2: load scope members (snapshot-first) + viewer identity in parallel.
        // listEventScopeMembersWithProfiles hits Supabase (~50ms) vs Neo4j (~1s+).
        // resolveCurrentMember / getChurchAncestors are graph calls — swallow
        // their errors so a graph outage degrades gracefully instead of crashing.
        const isSpecialGroup = evt.scope_level === 'special_group'
        const [viewer, ancestors, snapshotProfiles, childTotal, scopeCountFetched] = await Promise.all([
          resolveCurrentMember(user).catch(() => null),
          isSpecialGroup ? Promise.resolve([]) : getChurchAncestors({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => []),
          listEventScopeMembersWithProfiles(eventId),
          isSpecialGroup ? Promise.resolve(null) : countChildScopes({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => null),
          countEventScopeMembers(eventId).catch(() => 0),
        ])
        if (cancelled) return

        let allRows: any[]
        let needsProfileRefresh = false
        if (isSpecialGroup) {
          // Special-group events: membership lives in special_group_members,
          // not in the church hierarchy. Use the event snapshot if it exists;
          // otherwise fall back to a live special_group_members query.
          if (snapshotProfiles.length > 0) {
            allRows = snapshotProfiles
          } else {
            const members = await listSpecialGroupMembers(evt.scope_church_id)
            allRows = members.map((m) => ({
              id: m.member_id,
              first_name: m.member_name?.split(' ')[0] ?? '',
              last_name: m.member_name?.split(' ').slice(1).join(' ') ?? '',
              roles: [],
              picture_url: (m as any).picture_url ?? null,
            }))
          }
        } else if (snapshotProfiles.length > 0 && (scopeCountFetched === 0 || snapshotProfiles.length >= scopeCountFetched)) {
          // Snapshot exists and profile coverage is complete — use directly.
          allRows = snapshotProfiles
          // Flag for background refresh if profiles lack scope_ids (stale snapshot).
          needsProfileRefresh = snapshotProfiles.filter((r: any) => r.scope_ids == null).length > snapshotProfiles.length * 0.05
        } else {
          // Either no snapshot yet (creation race / new event), or snapshot exists
          // but profiles are incomplete (creation-time write partially failed).
          // Fall back to the graph to get the full member list and backfill profiles.
          let graphMembers: any[] | null = null
          let graphError: Error | null = null
          try {
            graphMembers = await getMembersInScope({
              level: evt.scope_level, churchId: evt.scope_church_id,
            })
          } catch (e: any) {
            graphError = e
          }
          if (cancelled) return

          if (graphMembers !== null) {
            allRows = graphMembers.map(memberToProfileRow)
            const ids = graphMembers.map((m: any) => m.id).filter(Boolean)
            // Fire-and-forget: save snapshot so subsequent loads skip the graph.
            Promise.all([
              snapshotEventScopeMembers(eventId, ids),
              bulkUpsertMemberProfiles(allRows),
            ]).catch(() => {})
          } else {
            // Graph unavailable — query member_profiles directly by scope.
            // Coverage is best-effort (only members who have logged in at
            // least once), but avoids a hard error when Neo4j is down.
            const profileRows = await listMemberProfilesByScope(
              evt.scope_level, evt.scope_church_id,
            )
            if (cancelled) return
            if (profileRows.length > 0) {
              allRows = profileRows
            } else {
              const isServiceDown = graphError?.message?.includes('503')
                || graphError?.message?.includes('Service Unavailable')
                || graphError?.message?.includes('502')
                || graphError?.message?.includes('Failed to fetch')
                || graphError?.message?.includes('Load failed')
                || graphError?.message?.includes('ERR_NAME_NOT_RESOLVED')
              throw new Error(
                isServiceDown
                  ? 'The member directory is temporarily unavailable. Please try again in a few minutes.'
                  : (graphError?.message ?? 'Failed to load event members.'),
              )
            }
          }
        }

        const allowed = new Set<string>(evt.allowed_roles || [])
        const allMemberIdSet = new Set<string>(allRows.map((r: any) => r.id))
        // Visibility should be tied to current church scope, not only the
        // event-time snapshot. Start with snapshot IDs, then widen from graph
        // when needed so leadership handovers can still view church-owned events.
        let visibilityMemberIdSet = allMemberIdSet
        // Special-group: membership IS eligibility (roles are irrelevant).
        // All other events: filter by allowed_roles regardless of who is viewing —
        // allowed_roles defines "expected attendance" and must drive the count
        // even for superAdmin/superViewer (they bypass scope, not the event's own policy).
        const eligibleRows = (isSpecialGroup
          ? allRows
          : allRows.filter((r) => (r.roles || []).some((role: string) => allowed.has(role)))
        ).filter((r) => r != null && r.id != null && r.id !== '')
        const eligibleIdSet = new Set<string>(eligibleRows.map((r) => r.id))

        // Snapshot rows can legitimately omit newly assigned leaders/admins
        // (for example after a leadership handover). If the current viewer is
        // missing from snapshot IDs, verify structural membership against the
        // live scope graph and use that set for capability checks.
        if (!isSpecialGroup && viewer?.id && !allMemberIdSet.has(viewer.id)) {
          try {
            const scopeMembers = await getMembersInScope({
              level: evt.scope_level,
              churchId: evt.scope_church_id,
            })
            if (!cancelled) {
              visibilityMemberIdSet = new Set<string>((scopeMembers || []).map((m: any) => m.id))
            }
          } catch {
            // Keep snapshot set on graph failure.
          }
        }

        // Background: stale snapshot profiles (scope_ids null) break sub-scope
        // filtering. Re-fetch from graph, upsert fresh profiles, and update state.
        if (needsProfileRefresh) {
          getMembersInScope({ level: evt.scope_level, churchId: evt.scope_church_id })
            .then((graphMembers: any[]) => {
              if (cancelled) return
              const freshRows = graphMembers.map(memberToProfileRow)
              bulkUpsertMemberProfiles(freshRows).catch(() => {})
              const freshEligible = freshRows
                .filter((r) => (r.roles || []).some((role: string) => allowed.has(role)))
                .filter((r) => r != null && r.id != null && r.id !== '')
              if (!cancelled) {
                setEligible(freshEligible)
                setEligibleIds(new Set<string>(freshEligible.map((r) => r.id)))
              }
            })
            .catch(() => {})
        }

        // getViewerCapabilities requires a graph viewer node. When the graph is
        // unavailable (viewer === null, ancestors === []), fall back to the
        // AppUser profile. Only the EXACT scope level is granted access —
        // ancestors do not see events below their scope (superAdmin handled above).
        let rawCaps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet, visibilityMemberIdSet)
        // Special-group events: church-hierarchy checks are irrelevant.
        // Any member present in the group snapshot can self-check-in.
        if (isSpecialGroup && !rawCaps.canManage && allMemberIdSet.has(user.userId)) {
          rawCaps = {
            canManage: false,
            canCheckIn: true,
            canView: true,
            canViewFullEvent: false,
            canManuallyCheckIn: false,
            viewerScope: {
              level: evt.scope_level as any,
              id: evt.scope_church_id,
              name: evt.scope_church_name,
            },
          }
        }
        if (!rawCaps.canManage && viewer === null) {
          // Graph unavailable — reconstruct viewerScope from the JWT/profile.
          // Per-level resolution lives in utils/userScope.ts; only the
          // hierarchy comparisons happen here.
          const userLevelIdx = user.level ? SCOPE_LEVELS.indexOf(user.level) : -1
          const evtScopeIdx  = SCOPE_LEVELS.indexOf(evt.scope_level)
          const userChurchAtEvt = getUserChurchRef(user, evt.scope_level)
          if (userChurchAtEvt && userChurchAtEvt.id === evt.scope_church_id && userLevelIdx === evtScopeIdx) {
            const viewerScope = {
              level: evt.scope_level,
              id: evt.scope_church_id,
              name: evt.scope_church_name,
            }
            // Admins exist from governorship level upwards — bacenta has no admin role.
            const isAdminLevel = user.level !== 'bacenta'
            rawCaps = (user.isAdmin && isAdminLevel)
              ? { canManage: true,  canCheckIn: false, canView: true, canViewFullEvent: false, canManuallyCheckIn: !(user.roles || []).some((r) => r.startsWith('leader')), viewerScope }
              : { canManage: false, canCheckIn: false, canView: true, canViewFullEvent: false, canManuallyCheckIn: false, viewerScope }
          } else if (!rawCaps.canView && userLevelIdx >= 0 && userLevelIdx < evtScopeIdx) {
            // Sub-scope leader: their JWT church hierarchy must include the event scope church,
            // confirming they are structurally within that scope.
            if (userChurchAtEvt && userChurchAtEvt.id === evt.scope_church_id) {
              const ownRef = user.level ? getUserChurchRef(user, user.level as ScopeLevel) : null
              if (ownRef) {
                const viewerScope = { level: ownRef.level, id: ownRef.id, name: ownRef.name ?? '' }
                rawCaps = { canManage: false, canCheckIn: eligibleIdSet.has(user.userId), canView: true, canViewFullEvent: false, canManuallyCheckIn: false, viewerScope }
              }
            }
          }
        }
        const eventScope = {
          level: evt.scope_level,
          id: evt.scope_church_id,
          name: evt.scope_church_name,
        }
        const scopeFallback = rawCaps.canViewFullEvent ? eventScope : (rawCaps.viewerScope ?? eventScope)
        const caps = user.isSuperAdmin
          ? { ...rawCaps, canManage: true, canCheckIn: eligibleIdSet.has(user.userId), canView: true, canViewFullEvent: true, canManuallyCheckIn: true, viewerScope: eventScope }
          : user.isSuperViewer
          ? { ...rawCaps, canManage: false, canCheckIn: false, canView: true, canViewFullEvent: true, canManuallyCheckIn: false, viewerScope: eventScope }
          : rawCaps.canViewFullEvent
          ? { ...rawCaps, viewerScope: scopeFallback }
          : rawCaps
        const scopes = getAdminScopes(viewer, user)

        // Tier 3: viewer slice (only needed for non-admin leaders).
        let slice = eligibleRows
        // Skip the graph slice call for special-group events — the full group
        // member list is already the correct slice.
        if (!isSpecialGroup && !caps.canManage && !caps.canViewFullEvent && caps.viewerScope) {
          try {
            const sliceMembers = await getMembersInScope({
              level: caps.viewerScope.level,
              churchId: caps.viewerScope.id,
            })
            if (cancelled) return
            const sliceIds = new Set(sliceMembers.map((m: any) => m.id))
            slice = eligibleRows.filter((r) => sliceIds.has(r.id))
          } catch {
            // Graph down — show the full eligible list unfiltered rather than crash.
          }
        }

        // "Total Expected" denominator: prefer the authoritative snapshot count
        // (the full in-scope leader/admin population, fixed at creation). When
        // no snapshot exists yet (legacy events / the graph-fallback path that
        // snapshots below), fall back to the role-eligible count so the number
        // stays consistent with the role-filtered attendance it's measured
        // against. The consumer (EventDashboard) only uses this as the
        // denominator when allowed_roles is unrestricted, where the snapshot and
        // eligible populations coincide.
        const resolvedScopeCount = scopeCountFetched > 0 ? scopeCountFetched : eligibleIdSet.size

        if (!cancelled) {
          setEligible(eligibleRows)
          setEligibleIds(eligibleIdSet)
          setViewerCaps(caps)
          setViewerSlice(slice)
          setAdminScopes(scopes)
          setChildCount(childTotal)
          setScopeMemberCount(resolvedScopeCount)
          setInitialLoading(false)
          // Update cache so the next navigation is instant.
          const entry: CachedEligibility = {
            eligible: eligibleRows,
            eligibleIds: eligibleIdSet,
            viewerCaps: caps,
            viewerSlice: slice,
            adminScopes: scopes,
            childCount: childTotal,
            scopeMemberCount: resolvedScopeCount,
            event: evt,
            records: recs,
            ts: Date.now(),
          }
          eligibilityCache.set(cacheKey, entry)
          writePersistedEligibility(cacheKey, entry)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message)
          setInitialLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [eventId, user?.userId, user?.email, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Optional poll: cheaply refresh records + event status only ────────
  // The expensive eligibility pipeline above is NOT re-run on every tick.
  const pollRef = useRef(pollMs)
  useEffect(() => { pollRef.current = pollMs }, [pollMs])

  useEffect(() => {
    if (!eventId || !pollMs) return
    let cancelled = false
    const id = setInterval(async () => {
      try {
        const [recs, evt] = await Promise.all([
          listCheckedIn(eventId),
          getEvent(eventId),
        ])
        if (!cancelled) {
          setRecords(recs)
          setEvent(evt)
        }
      } catch { /* swallow transient poll errors */ }
    }, pollMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [eventId, pollMs]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    event, eligible, eligibleIds, viewerCaps, viewerSlice,
    adminScopes, childCount, scopeMemberCount, records, error, initialLoading,
    setEvent, setRecords,
  }
}
