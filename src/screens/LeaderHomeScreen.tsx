import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import Spinner from '../components/Spinner'
import NavDrawer from '../components/NavDrawer'
import PullToRefreshIndicator from '../components/PullToRefreshIndicator'
import { PageShell, PageMain } from '../components/layout/PageShell'
import { EmptyState } from '../components/layout/EmptyState'
import { Alert } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { SCOPE_LEVELS } from '../types/app'
import { getCurrentUser, persistChurchContextFromProfileRow, persistChurchContextFromJwt } from '../utils/auth'
import {
  listAllEvents, getMemberProfile, upsertMemberProfile,
} from '../utils/supabaseCheckins'
import { useRefreshSignal } from '../hooks/useRefreshSignal'
import { getUserChurchRefs, type UserScopeRef } from '../utils/userScope'
import type { AppUser, CheckinEventRow } from '../types/app'

// ─── Church in Focus ─────────────────────────────────────────────────────────

const CHURCH_FOCUS_KEY = 'flc:churchInFocus'
const CHURCH_FOCUS_EVENT = 'flc:churchInFocusChange'

function roleLabel(source: UserScopeRef['source']): string {
  if (source === 'admin') return 'Admin'
  if (source === 'leader') return 'Leader'
  return 'Member'
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function readFocusId(): string | null {
  try { return localStorage.getItem(CHURCH_FOCUS_KEY) } catch { return null }
}
function writeFocusId(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(CHURCH_FOCUS_KEY)
    else localStorage.setItem(CHURCH_FOCUS_KEY, id)
    window.dispatchEvent(new Event(CHURCH_FOCUS_EVENT))
  } catch { /* ignore */ }
}

function ChurchInFocusSelector({ user }: { user: AppUser | null }) {
  const refs = getUserChurchRefs(user).filter(
    (r) => r.name && r.level !== 'special_group',
  )
  // Dedupe by (level, id) keeping the most-privileged source
  // (admin > leader > flat > active).
  const SOURCE_RANK: Record<UserScopeRef['source'], number> = { admin: 0, leader: 1, flat: 2, active: 3 }
  const dedupedMap = new Map<string, UserScopeRef>()
  for (const r of refs) {
    const key = `${r.level}:${r.id}`
    const existing = dedupedMap.get(key)
    if (!existing || SOURCE_RANK[r.source] < SOURCE_RANK[existing.source]) {
      dedupedMap.set(key, r)
    }
  }
  const options = Array.from(dedupedMap.values())

  const [open, setOpen] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(() => readFocusId())
  const ref = useRef<HTMLDivElement>(null)

  const active = focusId === null ? null : (options.find((o) => o.id === focusId) ?? null)

  // Sync focusId when another component (or tab) changes it
  useEffect(() => {
    function onFocusChange() { setFocusId(readFocusId()) }
    window.addEventListener(CHURCH_FOCUS_EVENT, onFocusChange)
    return () => window.removeEventListener(CHURCH_FOCUS_EVENT, onFocusChange)
  }, [])
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  if (options.length === 0) {
    // Fallback: show static badges when no refs resolved yet
    return (
      <div className='mt-4 flex flex-wrap gap-2'>
        {user?.unitName && (
          <span className='rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-foreground'>
            {user.unitName}
          </span>
        )}
        {user?.level && (
          <span className='rounded-full border border-border px-3 py-1 text-xs font-medium capitalize text-muted-foreground'>
            {cap(user.level)}
          </span>
        )}
        {(user?.isAdmin || user?.isSuperAdmin) && (
          <span className='rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground'>
            {user.isSuperAdmin ? 'Super Admin' : 'Admin'}
          </span>
        )}
      </div>
    )
  }

  function select(id: string | null) {
    writeFocusId(id)
    setFocusId(id)
    setOpen(false)
  }

  const activeLabel = active
    ? `${active.name} · ${cap(active.level)} · ${roleLabel(active.source)}`
    : 'All Churches'

  return (
    <div className='mt-4' ref={ref}>
      <p className='m-0 mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground'>
        Church in focus
      </p>
      <div className='relative inline-block max-w-full'>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          className='flex max-w-full items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-left text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-secondary active:scale-[0.99]'
        >
          <span className='min-w-0 truncate'>{activeLabel}</span>
          <svg
            viewBox='0 0 24 24'
            width='14'
            height='14'
            fill='currentColor'
            className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path d='M7 10l5 5 5-5z' />
          </svg>
        </button>

        {open && (
          <div className='absolute left-0 top-full z-50 mt-1.5 min-w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl'>
            {/* All Churches option */}
            <button
              type='button'
              onClick={() => select(null)}
              className='flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm transition-colors hover:bg-secondary'
            >
              <span className={focusId === null ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
                All Churches
              </span>
              {focusId === null && (
                <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-primary'>
                  <path d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' />
                </svg>
              )}
            </button>
            {/* Divider */}
            <div className='mx-3 border-t border-border' />
            {options.map((o) => {
              const isActive = o.id === focusId
              const label = `${o.name} · ${cap(o.level)} · ${roleLabel(o.source)}`
              return (
                <button
                  key={`${o.level}:${o.id}`}
                  type='button'
                  onClick={() => select(o.id)}
                  className='flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm transition-colors hover:bg-secondary'
                >
                  <span className={isActive ? 'font-semibold text-foreground' : 'text-foreground'}>
                    {label}
                  </span>
                  {isActive && (
                    <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' className='shrink-0 text-primary'>
                      <path d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}



const MORNING_GREETINGS: Greeting[] = [
  { line1: 'Good morning, {name}.', line2: 'The registers are open.' },
  { line1: 'Rise and lead, {name}.', line2: 'Leaders are gathering.' },
  { line1: 'Daybreak, {name}.', line2: 'Steady hands. Holy work.' },
  { line1: 'Early start, {name}.', line2: 'The faithful show up first.' },
  { line1: 'Morning, {name}.', line2: 'Another day of faithful service.' },
  { line1: 'Up and counting, {name}.', line2: 'Leaders are assembling.' },
]

const MIDDAY_GREETINGS: Greeting[] = [
  { line1: 'Good afternoon, {name}.', line2: 'Keep the count going.' },
  { line1: 'Midday, {name}.', line2: 'The session is live.' },
  { line1: 'Still going, {name}.', line2: 'Leaders are still showing up.' },
  { line1: 'Pressing on, {name}.', line2: 'Every leader counted matters.' },
  { line1: 'Halfway there, {name}.', line2: 'Faithful in the afternoon too.' },
  { line1: 'Afternoon, {name}.', line2: 'The registers are open.' },
]

const EVENING_GREETINGS: Greeting[] = [
  { line1: 'Good evening, {name}.', line2: 'Leaders are gathering.' },
  { line1: 'Evening service, {name}.', line2: 'Mark them present.' },
  { line1: 'The evening watch, {name}.', line2: 'Faithful to the end.' },
  { line1: 'Twilight roll call, {name}.', line2: 'Every leader accounted for.' },
  { line1: 'Evening, {name}.', line2: 'The day\'s work continues.' },
  { line1: 'Last count, {name}.', line2: 'Make it a good one.' },
]

const NIGHT_GREETINGS: Greeting[] = [
  { line1: 'Quiet hours, {name}.', line2: 'Steady hands. Holy work.' },
  { line1: 'Late session, {name}.', line2: 'The dedicated ones are here.' },
  { line1: 'Night watch, {name}.', line2: 'Still counting. Still faithful.' },
  { line1: 'Burning bright, {name}.', line2: 'Late night faithfulness.' },
  { line1: 'Stars are out, {name}.', line2: 'So are your leaders.' },
  { line1: 'The last hour, {name}.', line2: 'Mark them present.' },
]

const ADMIN_GREETINGS: Greeting[] = [
  { line1: 'Good to see you, {name}.', line2: 'The registers are yours.' },
  { line1: 'Steady oversight, {name}.', line2: 'Every leader has a name.' },
  { line1: 'Track well, {name}.', line2: 'Lead well.' },
  { line1: 'The numbers matter, {name}.', line2: 'Keep them true.' },
  { line1: 'Your leaders need you, {name}.', line2: 'Every check-in counts.' },
  { line1: 'Faithful records, {name}.', line2: 'Good decisions tomorrow.' },
  { line1: 'Precision, {name}.', line2: 'In attendance. In ministry.' },
  { line1: 'Behind every check-in, {name}.', line2: 'A leader you\'re investing in.' },
  { line1: 'Strong team, {name}.', line2: 'You track who shows up.' },
  { line1: 'Accountability, {name}.', line2: 'Starts with who shows up.' },
  { line1: 'The register, {name}.', line2: 'Is your first report card.' },
  { line1: 'Excellence, {name}.', line2: 'In check-in and leadership.' },
  { line1: 'Your oversight, {name}.', line2: 'Makes all the difference.' },
  { line1: 'A well-run event, {name}.', line2: 'Starts with you.' },
  { line1: 'Every absent leader, {name}.', line2: 'Has a name. Know it.' },
  { line1: 'Good records, {name}.', line2: 'Better decisions tomorrow.' },
  { line1: 'Faithfulness, {name}.', line2: 'Is measurable. You\'re measuring it.' },
  { line1: 'The health of the team, {name}.', line2: 'Shows in attendance.' },
  { line1: 'Holding the line, {name}.', line2: 'One check-in at a time.' },
  { line1: 'All eyes on the register, {name}.', line2: 'Make it count.' },
]

const LEADER_GREETINGS: Greeting[] = [
  { line1: 'Present and counted, {name}.', line2: 'Your faithfulness is noted.' },
  { line1: 'You showed up, {name}.', line2: 'That\'s already leadership.' },
  { line1: 'On time, {name}.', line2: 'Is a form of leadership.' },
  { line1: 'Here you are, {name}.', line2: 'Counted. Present. Valued.' },
  { line1: 'Good to see you, {name}.', line2: 'Your presence speaks first.' },
  { line1: 'Consistent, {name}.', line2: 'Its own kind of excellence.' },
  { line1: 'Show up, {name}.', line2: 'Lead up.' },
  { line1: 'Faithful, {name}.', line2: 'In the small things — like showing up.' },
  { line1: 'In the room, {name}.', line2: 'Where it matters most.' },
  { line1: 'Here, {name}.', line2: 'Present and ready to serve.' },
  { line1: 'Leadership, {name}.', line2: 'Begins the moment you arrive.' },
  { line1: 'A present leader, {name}.', line2: 'Is an engaged leader.' },
  { line1: 'Every check-in, {name}.', line2: 'Is a small act of commitment.' },
  { line1: 'Your attendance, {name}.', line2: 'Speaks before you do.' },
  { line1: 'Being here, {name}.', line2: 'Matters more than you know.' },
  { line1: 'The best leaders, {name}.', line2: 'Are always in the room.' },
  { line1: 'Counted, {name}.', line2: 'Present. Valued.' },
  { line1: 'You\'re here, {name}.', line2: 'That\'s already something.' },
  { line1: 'Present, {name}.', line2: 'And accounted for.' },
  { line1: 'Still showing up, {name}.', line2: 'That\'s the whole game.' },
]

// 0 = morning (5–12), 1 = midday (12–17), 2 = evening (17–21), 3 = night (21–5)
function getWatch(): number {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 0
  if (h >= 12 && h < 17) return 1
  if (h >= 17 && h < 21) return 2
  return 3
}

const TIME_POOLS = [MORNING_GREETINGS, MIDDAY_GREETINGS, EVENING_GREETINGS, NIGHT_GREETINGS]

function buildPool(isAdmin: boolean): Greeting[] {
  const timePool = TIME_POOLS[getWatch()]
  const rolePool = isAdmin ? ADMIN_GREETINGS : LEADER_GREETINGS
  return [...timePool, ...rolePool]
}

function getDailyGreeting(isAdmin: boolean): Greeting {
  const pool = buildPool(isAdmin)
  const today = new Date()
  const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
  const idx = (dateSeed * 4 + getWatch()) % pool.length
  return pool[idx]
}

function HomeGreeting({ user }: { user: AppUser | null }) {
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const { line1, line2 } = getDailyGreeting(isAdmin)
  const firstName = user?.firstName || user?.email?.split('@')[0] || ''
  const dateLabel = format(new Date(), 'EEEE, d MMMM').toUpperCase()

  const [before, after] = line1.split('{name}')

  return (
    <div className='relative px-5 pb-6 pt-5 md:px-6'>
      <PullToRefreshIndicator />
      {/* NavDrawer — renders the persistent desktop sidebar; hamburger is md:hidden inside */}
      <div className='absolute right-5 top-5'>
        <NavDrawer user={user} />
      </div>

      <div className='md:mx-auto md:max-w-5xl'>
        <p className='m-0 mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'>
          {dateLabel}
        </p>
        <h1 className='m-0 max-w-[82%] md:max-w-none text-[1.65rem] font-bold leading-tight tracking-tight text-foreground'>
          {before}<span className='text-primary'>{firstName}</span>{after}
          <br />
          {line2}
        </h1>

        <ChurchInFocusSelector user={user} />
      </div>
    </div>
  )
}

type HomeState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ok'; events: CheckinEventRow[] }

// Persist the last-rendered events list per user so cold loads paint instantly
// with the previously-seen data while the network revalidates in the background.
// The Supabase listAllEvents() in-memory cache only lives for the page session;
// this layer survives full reloads / tab restores.
const HOME_CACHE_KEY = 'flc:home:events:v1'
const HOME_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000  // 24h sanity cap

function readPersistedEvents(userId?: string): CheckinEventRow[] | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(`${HOME_CACHE_KEY}:${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts: number; events: CheckinEventRow[] }
    if (!parsed?.events || Date.now() - parsed.ts > HOME_CACHE_MAX_AGE_MS) return null
    return parsed.events
  } catch { return null }
}

function writePersistedEvents(userId: string | undefined, events: CheckinEventRow[]) {
  if (!userId) return
  try {
    localStorage.setItem(
      `${HOME_CACHE_KEY}:${userId}`,
      JSON.stringify({ ts: Date.now(), events }),
    )
  } catch { /* quota / disabled storage */ }
}

// ─── Hierarchy-aware focus filter ────────────────────────────────────────────
// Given a selected church (focusId), returns a predicate that keeps only events
// whose scope_church_id is the selected church OR a confirmed descendant of it.
//
// "Confirmed descendant" is derived from the user's own profile chain
// (user.bacenta / .governorship / .council / etc.) plus their JWT churchScopes
// admin/leader edges at levels strictly below the selected church. This covers
// the common single-chain user perfectly. For multi-campus admins whose admin
// edges span different higher-level churches, only the edges we can confirm are
// below the selected church are included — everything else is shown when the
// user picks "All Churches".
function buildFocusFilter(user: AppUser | null, focusId: string | null): (evt: CheckinEventRow) => boolean {
  if (!focusId || !user) return () => true

  const allRefs = getUserChurchRefs(user)
  const focusRef = allRefs.find(r => r.id === focusId)
  if (!focusRef) return (evt) => evt.scope_church_id === focusId

  const focusLevelIdx = SCOPE_LEVELS.indexOf(focusRef.level as any)
  if (focusLevelIdx < 0) return (evt) => evt.scope_church_id === focusId

  const included = new Set<string>([focusId])

  // Flat profile chain: user.bacenta, user.governorship, etc.
  // These are confirmed descendants when focusId IS on the user's own chain
  // (i.e. user[focusRef.level].id === focusId).
  const isOnFlatChain = (user as any)[focusRef.level]?.id === focusId
  if (isOnFlatChain) {
    for (let i = 0; i < focusLevelIdx; i++) {
      const lvl = SCOPE_LEVELS[i] as string
      const flatVal = (user as any)[lvl]
      if (flatVal?.id) included.add(flatVal.id)
    }
  }

  // JWT churchScopes edges at levels below the selected level.
  // These are the user's explicit admin/leader assignments and are very likely
  // within the selected church's subtree (best-effort — we include them since
  // omitting them would hide valid events).
  const cs = user.churchScopes
  if (cs) {
    for (let i = 0; i < focusLevelIdx; i++) {
      const lvl = SCOPE_LEVELS[i] as string
      const cLvl = lvl.charAt(0).toUpperCase() + lvl.slice(1)
      const adminRef = (cs as any)[`isAdminFor${cLvl}Of`]
      if (adminRef?.id) included.add(adminRef.id)
      const leadsRef = (cs as any)[`leads${cLvl}Of`]
      if (leadsRef?.id) included.add(leadsRef.id)
    }
  }

  return (evt: CheckinEventRow) => included.has(evt.scope_church_id)
}



export default function LeaderHomeScreen() {
  const user = getCurrentUser()
  const navigate = useNavigate()
  const isAdmin = !!(user?.isAdmin || user?.isSuperAdmin)
  const [state, setState] = useState<HomeState>(() => {
    const cached = readPersistedEvents(user?.userId)
    return cached ? { status: 'ok', events: cached } : { status: 'loading' }
  })
  const [refreshKey, setRefreshKey] = useState(0)
  const [focusId, setFocusId] = useState<string | null>(() => readFocusId())

  // Re-render when the church focus changes (dropdown fires CHURCH_FOCUS_EVENT)
  useEffect(() => {
    function onFocusChange() { setFocusId(readFocusId()) }
    window.addEventListener(CHURCH_FOCUS_EVENT, onFocusChange)
    return () => window.removeEventListener(CHURCH_FOCUS_EVENT, onFocusChange)
  }, [])

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])
  useRefreshSignal(triggerRefresh)

  // Re-fetch whenever the tab becomes visible again (user returns from event edit)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        setRefreshKey((k) => k + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // On re-fetch, keep showing current data while loading (don't flash spinner)
      if (refreshKey > 0 && state.status === 'ok') {
        // silent refresh — keep old state visible
      } else {
        setState({ status: 'loading' })
      }
      try {
        // Re-read inside the effect so we pick up any context persisted during
        // a previous async step (e.g. a re-login or a profile fetch below).
        let activeUser = getCurrentUser()

        // FAST PATH: persist the JWT churchScopes synchronously so the events
        // query below has SOMETHING to filter on even if member_profiles
        // hasn't been hydrated yet. This alone unblocks ~70% of accounts.
        persistChurchContextFromJwt((activeUser as any).churchScopes)
        activeUser = getCurrentUser()

        // The JWT only embeds the user's own level; events are filtered by
        // every level in the ancestor chain. If we don't yet have IDs for
        // every ancestor level, hydrate them in PARALLEL with the events
        // query — most leaders get a usable filter from the JWT alone, so
        // we don't need to wait for the profile round-trip.
        const LEVEL_ORDER = ['bacenta','governorship','council','stream','campus','oversight','denomination']
        const ownIdx = activeUser?.level ? LEVEL_ORDER.indexOf(activeUser.level) : -1
        const needsAncestors =
          activeUser?.userId &&
          activeUser.level &&
          LEVEL_ORDER
            .slice(ownIdx >= 0 ? ownIdx : 0)
            .some((lvl) => !(activeUser as any)[lvl]?.id)

        // Snapshot the scope set the first events fetch will use, so after
        // hydration we can tell whether anything actually changed and only
        // re-fetch when it did. This avoids the previous "always 4 calls
        // on cold load" behaviour when the JWT already had what we needed.
        const scopeKeyBefore = scopeFingerprint(activeUser)

        // Kick off both the profile-hydration AND the events fetch concurrently.
        const hydrationPromise = needsAncestors
          ? (async () => {
              try {
                const profile = await getMemberProfile(activeUser!.userId)
                if (profile) {
                  persistChurchContextFromProfileRow(profile)
                  return true
                }
                // Profile not in Supabase yet — fall back to graph.
                const { resolveCurrentMember, memberToProfileRow } = await import('../utils/membersApi')
                const member = await resolveCurrentMember(activeUser)
                if (member) {
                  const row = memberToProfileRow(member)
                  persistChurchContextFromProfileRow(row)
                  // Async-write to Supabase so future sessions skip this fallback.
                  upsertMemberProfile({ ...row, id: activeUser!.userId }).catch(() => {})
                  return true
                }
                return false
              } catch { return false }
            })()
          : Promise.resolve(false)

        const events = await listAllEvents(activeUser ?? undefined)
        if (cancelled) return
        setState({ status: 'ok', events })
        writePersistedEvents(activeUser?.userId, events)

        // Re-fetch ONLY when hydration actually widened the scope set.
        if (needsAncestors) {
          hydrationPromise.then(async (hydrated) => {
            if (!hydrated || cancelled) return
            const freshUser = getCurrentUser()
            const scopeKeyAfter = scopeFingerprint(freshUser)
            if (scopeKeyAfter === scopeKeyBefore) return
            try {
              const events2 = await listAllEvents(freshUser ?? undefined)
              if (cancelled) return
              setState({ status: 'ok', events: events2 })
              writePersistedEvents(freshUser?.userId, events2)
            } catch { /* keep the first-paint state */ }
          })
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', error: err.message })
      }
    })()
    return () => { cancelled = true }
  }, [refreshKey])

  return (
    <PageShell>
      <HomeGreeting user={user} />
      <PageMain>
        {isAdmin && !user?.isSuperViewer && (
          <div className='mb-6'>
            <Button type='button' onClick={() => navigate('/admin/events/new')} className='gap-2'>
              <svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor'>
                <path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z' />
              </svg>
              Create Event
            </Button>
          </div>
        )}

        {state.status === 'loading' && <Spinner />}

        {state.status === 'error' && <Alert variant='destructive'>{state.error}</Alert>}

        {state.status === 'ok' && (() => {
          const now = new Date()
          // Apply hierarchy-aware church-in-focus filter
          const focusPredicate = buildFocusFilter(user, focusId)
          const visibleEvents = focusId ? state.events.filter(focusPredicate) : state.events
          const live     = visibleEvents.filter(e => e.status === 'ACTIVE' && new Date(e.starts_at) <= now && new Date(e.ends_at) >= now)
          const upcoming = visibleEvents.filter(e => new Date(e.starts_at) > now && e.status !== 'ENDED')
          const past     = visibleEvents.filter(e => new Date(e.ends_at) < now || e.status === 'ENDED')
            .sort((a, b) => new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime())
          const pastSlice = past.slice(0, 5)

          if (live.length === 0 && upcoming.length === 0 && past.length === 0) {
            return (
              <EmptyState
                title='No events yet'
                description={
                  isAdmin
                    ? 'Create an event to start taking check-ins.'
                    : 'Check-ins will appear here once a leader opens an event.'
                }
                icon={
                  <svg viewBox='0 0 24 24' width='26' height='26' fill='currentColor'>
                    <path d='M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z' />
                  </svg>
                }
                action={
                  isAdmin && !user?.isSuperViewer ? (
                    <Button type='button' onClick={() => navigate('/admin/events/new')}>
                      Create event
                    </Button>
                  ) : undefined
                }
              />
            )
          }

          return (
            <div className='flex flex-col gap-8'>

              {/* ── Live ── */}
              {live.length > 0 && (
                <section>
                  <p className='section-heading mb-3 text-success'>Live now</p>
                  <div className='flex flex-col gap-2.5'>
                    {live.map(evt => <EventCard key={evt.id} evt={evt} variant='live' />)}
                  </div>
                </section>
              )}

              {/* ── Upcoming ── */}
              {upcoming.length > 0 && (
                <section>
                  <p className='section-heading mb-3'>Upcoming</p>
                  <div className='flex flex-col gap-2.5'>
                    {upcoming.map(evt => <EventCard key={evt.id} evt={evt} variant='upcoming' />)}
                  </div>
                </section>
              )}

              {/* ── Past (max 5) ── */}
              {pastSlice.length > 0 && (
                <section>
                  <div className='flex items-center justify-between mb-3'>
                    <p className='section-heading m-0'>Recent</p>
                    {past.length > 5 && (
                      <Link
                        to='/admin/history'
                        className='text-xs font-semibold text-primary no-underline hover:underline'
                      >
                        View all history →
                      </Link>
                    )}
                  </div>
                  <div className='flex flex-col gap-2.5'>
                    {pastSlice.map(evt => <EventCard key={evt.id} evt={evt} variant='past' />)}
                  </div>
                  {past.length > 5 && (
                    <Link
                      to='/admin/history'
                      className='mt-3 flex items-center justify-center rounded-lg bg-primary/5 py-2.5 text-xs font-semibold tracking-tight text-primary no-underline hover:bg-primary/10'
                    >
                      + {past.length - 5} more in history
                    </Link>
                  )}
                </section>
              )}

            </div>
          )
        })()}
      </PageMain>
    </PageShell>
  )
}

function EventCard({ evt, variant }: { evt: CheckinEventRow; variant: 'live' | 'upcoming' | 'past' }) {
  const levelColor = `var(--badge-${evt.scope_level}, var(--accent))`
  const statusColor = variant === 'live' ? 'var(--present)' : variant === 'past' ? 'var(--muted)' : levelColor
  const statusLabel = variant === 'live' ? 'Live' : variant === 'past' ? 'Ended' : 'Upcoming'

  return (
    <Link
      to={`/events/${evt.id}`}
      className={`event-row ${variant === 'past' ? 'opacity-70 shadow-none' : ''}`}
    >
      {/* Leading status dot — replaces the colored side stripe */}
      {variant === 'live' ? (
        <span className='relative flex h-2.5 w-2.5 shrink-0'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75' />
          <span className='relative inline-flex h-2.5 w-2.5 rounded-full bg-success' />
        </span>
      ) : (
        <span
          className='size-2 shrink-0 rounded-full'
          style={{ background: statusColor }}
        />
      )}

      <div className='min-w-0 flex-1'>
        <p className='m-0 truncate text-sm font-semibold tracking-tight text-foreground'>{evt.name}</p>
        <p className='m-0 mt-0.5 truncate text-xs text-muted-foreground'>
          {evt.scope_church_name}{evt.venue_name ? ` · ${evt.venue_name}` : ''}
        </p>
      </div>
      <div className='shrink-0 text-right'>
        <p className='tnum m-0 text-xs font-semibold text-muted-foreground'>
          {format(new Date(evt.starts_at), 'd MMM')}
        </p>
        <span
          className='text-[10px] font-semibold uppercase tracking-wider'
          style={{ color: statusColor }}
        >
          {statusLabel}
        </span>
      </div>
    </Link>
  )
}

/** Stable string key for the user's full scope set. Used to detect whether
 *  profile hydration actually widened the scope before triggering a second
 *  events fetch. Order is canonical (SCOPE_LEVELS) inside getUserChurchRefs,
 *  so this is a deterministic fingerprint. */
function scopeFingerprint(user: any): string {
  if (!user) return ''
  return getUserChurchRefs(user).map((r) => `${r.level}:${r.id}`).join('|')
}
