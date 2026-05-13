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
} from '../utils/supabaseCheckins'
import {
  getMembersInScope, memberToProfileRow,
  resolveCurrentMember, getChurchAncestors, getViewerCapabilities,
  getAdminScopes, countChildScopes,
} from '../utils/membersApi'
import type { AppUser, CheckinEventRow } from '../types/app'

// ─── Module-level SWR cache ──────────────────────────────────────────────
const ELIGIBILITY_TTL = 4 * 60 * 1000  // 4 min

interface CachedEligibility {
  eligible: any[]
  eligibleIds: Set<string>
  viewerCaps: any
  viewerSlice: any[]
  adminScopes: any[]
  childCount: number | null
  ts: number
}

const eligibilityCache = new Map<string, CachedEligibility>()

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
  { pollMs }: { pollMs?: number } = {},
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

    // Stale-while-revalidate: serve cached result immediately so the UI
    // renders with real data before any network request completes.
    const hit = eligibilityCache.get(cacheKey)
    if (hit && Date.now() - hit.ts < ELIGIBILITY_TTL) {
      setEligible(hit.eligible)
      setEligibleIds(hit.eligibleIds)
      setViewerCaps(hit.viewerCaps)
      setViewerSlice(hit.viewerSlice)
      setAdminScopes(hit.adminScopes)
      setChildCount(hit.childCount)
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
        const [viewer, ancestors, snapshotProfiles, childTotal] = await Promise.all([
          resolveCurrentMember(user),
          getChurchAncestors({ level: evt.scope_level, id: evt.scope_church_id }),
          listEventScopeMembersWithProfiles(eventId),
          countChildScopes({ level: evt.scope_level, id: evt.scope_church_id }).catch(() => null),
        ])
        if (cancelled) return

        let allRows: any[]
        if (snapshotProfiles.length > 0) {
          // Snapshot exists — use it directly. No graph round-trip needed.
          allRows = snapshotProfiles
        } else {
          // No snapshot yet (legacy event or first load after create).
          // Hit the live graph, then save snapshot + profiles for next time.
          const graphMembers = await getMembersInScope({
            level: evt.scope_level, churchId: evt.scope_church_id,
          })
          if (cancelled) return
          allRows = graphMembers.map(memberToProfileRow)
          const ids = graphMembers.map((m: any) => m.id).filter(Boolean)
          // Fire-and-forget: save snapshot so subsequent loads skip the graph.
          Promise.all([
            snapshotEventScopeMembers(eventId, ids),
            bulkUpsertMemberProfiles(allRows),
          ]).catch(() => {})
        }

        const allowed = new Set<string>(evt.allowed_roles || [])
        const eligibleRows = allRows.filter((r) =>
          (r.roles || []).some((role: string) => allowed.has(role)),
        )
        const eligibleIdSet = new Set<string>(eligibleRows.map((r) => r.id))
        // getViewerCapabilities requires a graph viewer node. Superadmins may
        // not be in the graph (viewer === null), so we compute caps from graph
        // data when available, then unconditionally force canManage: true for
        // superadmins — their additional FLC roles are honoured where possible.
        const rawCaps = getViewerCapabilities(viewer, evt, ancestors, eligibleIdSet)
        const caps = user.isSuperAdmin
          ? {
              ...rawCaps,
              canManage: true,
              canCheckIn: true,
              // If the graph resolved a viewerScope use it; otherwise fall back
              // to the full event scope so dashboards render correctly.
              viewerScope: rawCaps.viewerScope ?? {
                level: evt.scope_level,
                id: evt.scope_church_id,
                name: evt.scope_church_name,
              },
            }
          : rawCaps
        const scopes = getAdminScopes(viewer)

        // Tier 3: viewer slice (only needed for non-admin leaders).
        let slice = eligibleRows
        if (!caps.canManage && caps.viewerScope) {
          const sliceMembers = await getMembersInScope({
            level: caps.viewerScope.level,
            churchId: caps.viewerScope.id,
          })
          if (cancelled) return
          const sliceIds = new Set(sliceMembers.map((m: any) => m.id))
          slice = eligibleRows.filter((r) => sliceIds.has(r.id))
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
          eligibilityCache.set(cacheKey, {
            eligible: eligibleRows,
            eligibleIds: eligibleIdSet,
            viewerCaps: caps,
            viewerSlice: slice,
            adminScopes: scopes,
            childCount: childTotal,
            ts: Date.now(),
          })
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message)
          setInitialLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [eventId, user?.userId, user?.email]) // eslint-disable-line react-hooks/exhaustive-deps

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
