// SWR-style hook that loads the eligibility pipeline for an event:
//   getEvent + listCheckedIn + event_scope_members (Postgres snapshot)
//   → eligible members + viewer capabilities.
//
// Architectural rule: the live Neo4j graph is NEVER probed here. Eligibility
// comes from the event snapshot taken at creation (or by an explicit
// "Refresh eligible list" — see utils/eventScopeSnapshot.ts). Capabilities
// come from capsOverride (the entry gate) with a JWT-only fallback.
//
// Performance design:
//   • Stale-while-revalidate: serves the previous result from the module-level
//     cache IMMEDIATELY (no spinner on revisit), then revalidates in the
//     background and updates the UI when fresh data arrives.
//   • Snapshot-only roster: listEventScopeMembersWithProfiles hits Supabase
//     with server-side role/scope filters (migration 037).
//   • Optional poll: only refreshes the cheap part (event status + records).
//     The eligibility pipeline is NOT re-run on every poll tick.

import { useEffect, useRef, useState } from 'react'
import {
  getEvent, listCheckedIn,
  listEventScopeMembersWithProfiles, listSpecialGroupMembers,
  countEventScopeMembers,
} from '../utils/supabaseCheckins'
import { getUserChurchRef, getUserAdminScopesFromJwt, getUserLeadershipRefs } from '../utils/userScope'
import { friendlyErrorMessage } from '../utils/network'
import { SCOPE_LEVELS } from '../types/app'
import type { ViewerCaps } from '../utils/eventCaps'
import type { AppUser, CheckinEventRow } from '../types/app'

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
  /** Always null — child-scope counts used to come from Neo4j; the inline
   *  rollup RPC replaced that. Kept on the cache shape so persisted v2
   *  entries still normalize cleanly. */
  childCount: number | null
  /** event_scope_members row count for this event; 0 = no snapshot yet. */
  scopeMemberCount: number | null
  event?: CheckinEventRow | null
  records?: any[]
  ts: number
}

const eligibilityCache = new Map<string, CachedEligibility>()

function candidateUserIds(user: AppUser | null | undefined, viewer: any | null): string[] {
  return [
    viewer?.id,
    user?.graphMemberId,
    user?.userId,
  ].filter((id, idx, arr): id is string =>
    typeof id === 'string' && id.length > 0 && arr.indexOf(id) === idx,
  )
}

function hasAnyId(ids: string[], set: Set<string> | null | undefined): boolean {
  return ids.some((id) => set?.has(id))
}

function fallbackCapsFromUser(
  user: AppUser,
  evt: CheckinEventRow,
  ids: string[],
  eligibleIdSet: Set<string>,
  allMemberIdSet: Set<string>,
  ancestors: any[],
) {
  const eventScope = {
    level: evt.scope_level,
    id: evt.scope_church_id,
    name: evt.scope_church_name,
  }
  const refs = getUserLeadershipRefs(user)
  const eventScopeIdx = SCOPE_LEVELS.indexOf(evt.scope_level)
  const ancestorByLevel = new Map<string, any>((ancestors || []).map((a: any) => [a.level, a]))
  const canCheckIn = hasAnyId(ids, eligibleIdSet)

  const exactAdmin = refs.some((r) =>
    r.source === 'admin' && r.level === evt.scope_level && r.id === evt.scope_church_id,
  )
  if (exactAdmin) {
    return {
      canManage: true,
      canCheckIn: false,
      canView: true,
      canViewFullEvent: false,
      canManuallyCheckIn: !(user.roles || []).some((r) => r.startsWith('leader')),
      viewerScope: eventScope,
    }
  }

  const exactLeader = refs.some((r) =>
    r.source === 'leader' && r.level === evt.scope_level && r.id === evt.scope_church_id,
  )
  if (exactLeader) {
    return {
      canManage: false,
      canCheckIn,
      canView: true,
      canViewFullEvent: true,
      canManuallyCheckIn: false,
      viewerScope: eventScope,
    }
  }

  for (const ref of refs) {
    const refIdx = SCOPE_LEVELS.indexOf(ref.level)
    if (refIdx <= eventScopeIdx) continue
    const ancestor = ancestorByLevel.get(ref.level)
    const containsEvent = ancestor?.id === ref.id
      || getUserChurchRef(user, evt.scope_level)?.id === evt.scope_church_id
    if (!containsEvent) continue
    return {
      canManage: false,
      canCheckIn: false,
      canView: true,
      canViewFullEvent: true,
      canManuallyCheckIn: false,
      viewerScope: eventScope,
    }
  }

  const inEventScope = getUserChurchRef(user, evt.scope_level)?.id === evt.scope_church_id
  if (inEventScope || hasAnyId(ids, allMemberIdSet)) {
    const scopedRef = refs
      .filter((r) => SCOPE_LEVELS.indexOf(r.level) < eventScopeIdx)
      .sort((a, b) => SCOPE_LEVELS.indexOf(b.level) - SCOPE_LEVELS.indexOf(a.level))[0]
    if (scopedRef) {
      return {
        canManage: false,
        canCheckIn,
        canView: true,
        canViewFullEvent: false,
        canManuallyCheckIn: false,
        viewerScope: {
          level: scopedRef.level,
          id: scopedRef.id,
          name: scopedRef.name ?? '',
        },
      }
    }
  }

  return null
}

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
  /** Deprecated: always null. Prefer get_event_scope_rollup / InlineScopeRollup. */
  childCount: number | null
  /** event_scope_members row count for this event (0 = no snapshot yet);
   *  null until resolved. */
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
  {
    pollMs,
    refreshKey = 0,
    loadRecords = true,
    capsOverride,
  }: {
    pollMs?: number
    refreshKey?: number
    loadRecords?: boolean
    /** Capabilities already decided by the entry gate from the active hat.
     *  Supplying this skips the whole legacy cascade AND the two Neo4j calls
     *  that only existed to feed it. */
    capsOverride?: ViewerCaps | null
  } = {},
): EventEligibilityResult {
  const [event, setEvent]         = useState<CheckinEventRow | null>(null)
  const [eligible, setEligible]   = useState<any[]>([])
  const [eligibleIds, setEligibleIds] = useState(new Set<string>())
  const [viewerCaps, setViewerCaps]   = useState<any | null>(null)
  const [viewerSlice, setViewerSlice] = useState<any[]>([])
  const [adminScopes, setAdminScopes] = useState<any[]>([])
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
      setScopeMemberCount(hit.scopeMemberCount ?? null)
      setEvent(hit.event)
      setRecords(loadRecords ? hit.records : [])
      setInitialLoading(false)
      // Still revalidate in background — don't return early.
    }

    ;(async () => {
      try {
        // Tier 1: event + records. Both Postgres.
        const [evt, recs] = await Promise.all([
          getEvent(eventId),
          loadRecords ? listCheckedIn(eventId) : Promise.resolve([]),
        ])
        if (cancelled) return
        setEvent(evt)
        setRecords(recs)

        const isSpecialGroup = evt.scope_level === 'special_group'

        // Tier 2: the event's eligible list, read ENTIRELY from the snapshot.
        //
        // This block used to make up to five separate Neo4j calls —
        // resolveCurrentMember, getChurchAncestors, countChildScopes, a
        // no-snapshot getMembersInScope fallback, and a "widen visibility from
        // the live graph" probe. All of them ran while an event was live.
        //
        // They are gone. Eligibility is decided by event_scope_members, which is
        // captured once at creation and refreshed only by an explicit admin
        // action (see utils/eventScopeSnapshot.ts). Login is already gated by
        // the auth JWT, so a live service no longer depends on the member
        // directory being reachable — which mattered most exactly when it was
        // under the heaviest load.
        //
        // Server-side filtering: passing allowedRoles makes Postgres return
        // only the eligible rows rather than the whole roster (migration 037).
        const [snapshotProfiles, scopeCountFetched] = await Promise.all([
          listEventScopeMembersWithProfiles(eventId, {
            allowedRoles: isSpecialGroup ? null : (evt.allowed_roles || null),
          }),
          countEventScopeMembers(eventId).catch(() => 0),
        ])
        if (cancelled) return

        let allRows: any[] = snapshotProfiles

        // Special-group events whose snapshot was never written fall back to
        // live group membership — that is a Supabase table, not the graph.
        if (isSpecialGroup && snapshotProfiles.length === 0) {
          const members = await listSpecialGroupMembers(evt.scope_church_id)
          if (cancelled) return
          allRows = members.map((m) => ({
            id: m.member_id,
            first_name: m.member_name?.split(' ')[0] ?? '',
            last_name: m.member_name?.split(' ').slice(1).join(' ') ?? '',
            roles: [],
            picture_url: (m as any).picture_url ?? null,
          }))
        }

        const allowed = new Set<string>(evt.allowed_roles || [])
        // Special-group: membership IS eligibility (roles are irrelevant).
        // Everything else: allowed_roles defines expected attendance and drives
        // the count even for superAdmin (they bypass scope, not event policy).
        // Postgres already applied this filter when allowedRoles was passed;
        // re-applying is cheap and keeps the special-group path correct.
        const eligibleRows = (isSpecialGroup
          ? allRows
          : allRows.filter((r) => (r.roles || []).some((role: string) => allowed.has(role)))
        ).filter((r) => r != null && r.id != null && r.id !== '')
        const eligibleIdSet = new Set<string>(eligibleRows.map((r) => r.id))

        // Capability comes from the entry gate — a pure function of the active
        // hat and the server's scope relation (utils/eventCaps.ts). The old
        // three-way cascade (getViewerCapabilities → fallbackCapsFromUser → JWT
        // reconstruction) needed a live graph viewer node, which meant the same
        // user could get different UI depending on whether Neo4j answered.
        //
        // capsOverride is always supplied now: EventEntryScreen runs the gate
        // for drill-downs too. The fallback below is JWT-only and exists purely
        // so a direct component mount cannot render capability-less.
        const caps: ViewerCaps = capsOverride ?? (fallbackCapsFromUser(
          user,
          evt,
          candidateUserIds(user, null),
          eligibleIdSet,
          new Set<string>(allRows.map((r: any) => r.id)),
          [],
        ) as ViewerCaps | null) ?? {
          canManage: false,
          canCheckIn: false,
          canView: true,
          canViewFullEvent: false,
          canManuallyCheckIn: false,
          viewerScope: {
            level: evt.scope_level,
            id: evt.scope_church_id,
            name: evt.scope_church_name,
          },
        }

        // Viewer slice: narrow the eligible list to the viewer's own sub-scope.
        // Done in Postgres via the scope filter migration 037 added, replacing a
        // getMembersInScope call against Neo4j.
        let slice = eligibleRows
        if (!isSpecialGroup && !caps.canManage && !caps.canViewFullEvent && caps.viewerScope) {
          try {
            slice = await listEventScopeMembersWithProfiles(eventId, {
              allowedRoles: evt.allowed_roles || null,
              scopeLevel: caps.viewerScope.level,
              scopeChurchId: caps.viewerScope.id,
            })
            if (cancelled) return
          } catch {
            // Show the full eligible list unfiltered rather than nothing.
          }
        }

        if (!cancelled) {
          setEligible(eligibleRows)
          setEligibleIds(eligibleIdSet)
          setViewerCaps(caps)
          setViewerSlice(slice)
          setAdminScopes(getUserAdminScopesFromJwt(user))
          setScopeMemberCount(scopeCountFetched)
          setInitialLoading(false)
          const entry: CachedEligibility = {
            eligible: eligibleRows,
            eligibleIds: eligibleIdSet,
            viewerCaps: caps,
            viewerSlice: slice,
            adminScopes: getUserAdminScopesFromJwt(user),
            childCount: null,
            scopeMemberCount: scopeCountFetched,
            event: evt,
            records: loadRecords ? recs : [],
            ts: Date.now(),
          }
          eligibilityCache.set(cacheKey, entry)
          writePersistedEligibility(cacheKey, entry)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(friendlyErrorMessage(err))
          setInitialLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [eventId, user?.userId, user?.email, refreshKey, loadRecords, capsOverride]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Optional poll: cheaply refresh records + event status only ────────
  // The expensive eligibility pipeline above is NOT re-run on every tick.
  const pollRef = useRef(pollMs)
  useEffect(() => { pollRef.current = pollMs }, [pollMs])

  useEffect(() => {
    if (!eventId || !pollMs) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const [recs, evt] = await Promise.all([
          loadRecords ? listCheckedIn(eventId) : Promise.resolve(null),
          getEvent(eventId),
        ])
        if (!cancelled) {
          if (loadRecords && recs) setRecords(recs)
          setEvent(evt)
        }
      } catch { /* swallow transient poll errors */ }
      if (!cancelled) {
        const backgroundMultiplier = document.visibilityState === 'visible' ? 1 : 4
        const jitter = 0.85 + Math.random() * 0.3
        timer = setTimeout(poll, Math.round(pollMs * backgroundMultiplier * jitter))
      }
    }
    timer = setTimeout(poll, Math.round(pollMs * (0.85 + Math.random() * 0.3)))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [eventId, pollMs, loadRecords]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    event, eligible, eligibleIds, viewerCaps, viewerSlice,
    adminScopes, childCount: null, scopeMemberCount, records, error, initialLoading,
    setEvent, setRecords,
  }
}
