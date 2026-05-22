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
} from '../utils/supabaseCheckins'
import {
  getMembersInScope, memberToProfileRow,
  resolveCurrentMember, getChurchAncestors, getViewerCapabilities,
  getAdminScopes, countChildScopes,
} from '../utils/membersApi'
import { getUserChurchRef } from '../utils/userScope'
import { SCOPE_LEVELS } from '../types/app'
import type { AppUser, CheckinEventRow, ScopeLevel } from '../types/app'

// ─── Module-level SWR cache ──────────────────────────────────────────────
const ELIGIBILITY_TTL = 4 * 60 * 1000  // 4 min
// Persisted cache survives full reloads / tab restores; only used for instant
// first-paint while the fresh fetch is in flight.
const ELIGIBILITY_PERSIST_TTL = 30 * 60 * 1000  // 30 min sanity cap
const ELIGIBILITY_STORAGE_PREFIX = 'flc:elig:v1:'
// Cap stored event/records snapshots to avoid pathological localStorage usage.
const PERSIST_EVENTS_MAX = 6

interface CachedEligibility {
  eligible: any[]
  eligibleIds: Set<string>
  viewerCaps: any
  viewerSlice: any[]
  adminScopes: any[]
  childCount: number | null
  event?: CheckinEventRow | null
  records?: any[]
  ts: number
}

const eligibilityCache = new Map<string, CachedEligibility>()

function persistKey(cacheKey: string) { return ELIGIBILITY_STORAGE_PREFIX + cacheKey }

function readPersistedEligibility(cacheKey: string): CachedEligibility | null {
  try {
    const raw = localStorage.getItem(persistKey(cacheKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as any
    if (!parsed || Date.now() - parsed.ts > ELIGIBILITY_PERSIST_TTL) return null
    return {
      ...parsed,
      eligibleIds: new Set<string>(parsed.eligibleIds || []),
    }
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
    const hit = memHit && Date.now() - memHit.ts < ELIGIBILITY_TTL
      ? memHit
      : readPersistedEligibility(cacheKey)
    if (hit) {
      setEligible(hit.eligible)
      setEligibleIds(hit.eligibleIds)
      setViewerCaps(hit.viewerCaps)
      setViewerSlice(hit.viewerSlice)
      setAdminScopes(hit.adminScopes)
      setChildCount(hit.childCount)
      if (hit.event) setEvent(hit.event)
      if (hit.records) setRecords(hit.records)
      setInitialLoading(false)
      // Still revalidate in background — don't return early.
    }

    ;(async () => {
      try {
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
        const [viewer, ancestors, snapshotProfiles, childTotal] = await Promise.all([
          resolveCurrentMember(user).catch(() => null),
          isSpecialGroup ? Promise.resolve([]) : getChurchAncestors({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => []),
          listEventScopeMembersWithProfiles(eventId),
          isSpecialGroup ? Promise.resolve(null) : countChildScopes({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => null),
        ])
        if (cancelled) return

        let allRows: any[]
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
        } else if (snapshotProfiles.length > 0) {
          // Snapshot exists — use it directly. No graph round-trip needed.
          allRows = snapshotProfiles
        } else {
          // No snapshot yet — try the live graph first, fall back to
          // member_profiles if the graph is unavailable (503 / timeout).
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
        // Special-group events: group membership IS eligibility — bypass role filter.
        const eligibleRows = isSpecialGroup
          ? allRows
          : allRows.filter((r) => (r.roles || []).some((role: string) => allowed.has(role)))
        const eligibleIdSet = new Set<string>(eligibleRows.map((r) => r.id))

        // getViewerCapabilities requires a graph viewer node. When the graph is
        // unavailable (viewer === null, ancestors === []), fall back to the
        // AppUser profile. Only the EXACT scope level is granted access —
        // ancestors do not see events below their scope (superAdmin handled above).
        let rawCaps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet, allMemberIdSet)
        // Special-group events: church-hierarchy checks are irrelevant.
        // Any member present in the group snapshot can self-check-in.
        if (isSpecialGroup && !rawCaps.canManage && allMemberIdSet.has(user.userId)) {
          rawCaps = {
            canManage: false,
            canCheckIn: true,
            canView: true,
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
              ? { canManage: true,  canCheckIn: false, canView: true, canManuallyCheckIn: !(user.roles || []).some((r) => r.startsWith('leader')), viewerScope }
              : { canManage: false, canCheckIn: false, canView: true, canManuallyCheckIn: false, viewerScope }
          } else if (!rawCaps.canView && userLevelIdx >= 0 && userLevelIdx < evtScopeIdx) {
            // Sub-scope leader: their JWT church hierarchy must include the event scope church,
            // confirming they are structurally within that scope.
            if (userChurchAtEvt && userChurchAtEvt.id === evt.scope_church_id) {
              const ownRef = user.level ? getUserChurchRef(user, user.level as ScopeLevel) : null
              if (ownRef) {
                const viewerScope = { level: ownRef.level, id: ownRef.id, name: ownRef.name ?? '' }
                rawCaps = { canManage: false, canCheckIn: true, canView: true, canManuallyCheckIn: false, viewerScope }
              }
            }
          }
        }
        const caps = user.isSuperAdmin
          ? {
              ...rawCaps,
              canManage: true,
              canCheckIn: true,
              canView: true,
              canManuallyCheckIn: true,
              // If the graph resolved a viewerScope use it; otherwise fall back
              // to the full event scope so dashboards render correctly.
              viewerScope: rawCaps.viewerScope ?? {
                level: evt.scope_level,
                id: evt.scope_church_id,
                name: evt.scope_church_name,
              },
            }
          : rawCaps
        const scopes = getAdminScopes(viewer, user)

        // Tier 3: viewer slice (only needed for non-admin leaders).
        let slice = eligibleRows
        // Skip the graph slice call for special-group events — the full group
        // member list is already the correct slice.
        if (!isSpecialGroup && !caps.canManage && caps.viewerScope) {
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

        if (!cancelled) {
          setEligible(eligibleRows)
          setEligibleIds(eligibleIdSet)
          setViewerCaps(caps)
          setViewerSlice(slice)
          setAdminScopes(scopes)
          setChildCount(childTotal)
          setInitialLoading(false)
          // Update cache so the next navigation is instant.
          const entry: CachedEligibility = {
            eligible: eligibleRows,
            eligibleIds: eligibleIdSet,
            viewerCaps: caps,
            viewerSlice: slice,
            adminScopes: scopes,
            childCount: childTotal,
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
    adminScopes, childCount, records, error, initialLoading,
    setEvent, setRecords,
  }
}
