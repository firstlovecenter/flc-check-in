import { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { AppUser, ChurchRef, ScopeLevel } from '../types/app'
import { getCurrentUser } from '../utils/auth'

const STORAGE_KEY = 'flc:churchFocus:v1'

interface ChurchFocusValue {
  focusedScope: ChurchRef | null
  availableScopes: ChurchRef[]
  isMultiScope: boolean
  setFocusedScope: (s: ChurchRef | null) => void
}

const ChurchFocusCtx = createContext<ChurchFocusValue>({
  focusedScope: null,
  availableScopes: [],
  isMultiScope: false,
  setFocusedScope: () => {},
})

export function useChurchFocus() {
  return useContext(ChurchFocusCtx)
}

export function ChurchFocusProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [user, setUser] = useState<AppUser | null>(getCurrentUser)

  // Re-sync the user object on every navigation so the provider stays fresh
  // after login (/ → /home) and after token refreshes.
  useEffect(() => {
    setUser(getCurrentUser())
  }, [location.pathname])

  const availableScopes = useMemo(() => getUserRoleScopes(user), [user?.userId])

  const storageKey = `${STORAGE_KEY}:${user?.userId ?? 'anon'}`

  const [focusedScope, setFocusedScopeState] = useState<ChurchRef | null>(() => {
    if (!user?.userId) return null
    try {
      const raw = sessionStorage.getItem(`${STORAGE_KEY}:${user.userId}`)
      return raw ? (JSON.parse(raw) as ChurchRef) : null
    } catch { return null }
  })

  // Re-read from sessionStorage when the active user changes.
  useEffect(() => {
    if (!user?.userId) { setFocusedScopeState(null); return }
    try {
      const raw = sessionStorage.getItem(`${STORAGE_KEY}:${user.userId}`)
      setFocusedScopeState(raw ? (JSON.parse(raw) as ChurchRef) : null)
    } catch { setFocusedScopeState(null) }
  }, [user?.userId])

  // Drop a saved focus if the user's role set no longer includes it
  // (e.g. after a token refresh that removed an admin edge).
  useEffect(() => {
    if (!focusedScope) return
    const still = availableScopes.find(
      s => s.level === focusedScope.level && s.id === focusedScope.id,
    )
    if (!still) setFocusedScopeState(null)
  }, [availableScopes, focusedScope?.id, focusedScope?.level])

  const setFocusedScope = useCallback((s: ChurchRef | null) => {
    setFocusedScopeState(s)
    try {
      if (s && user?.userId) {
        sessionStorage.setItem(storageKey, JSON.stringify(s))
      } else if (user?.userId) {
        sessionStorage.removeItem(storageKey)
      }
    } catch { /* quota / disabled storage */ }
  }, [storageKey, user?.userId])

  // Memoised so consumers only re-render when the focus/scope data actually
  // changes — the provider itself re-renders on every navigation (it re-syncs
  // the user from storage on pathname change).
  const value = useMemo<ChurchFocusValue>(() => ({
    focusedScope,
    availableScopes,
    isMultiScope: availableScopes.length > 1,
    setFocusedScope,
  }), [focusedScope, availableScopes, setFocusedScope])

  return (
    <ChurchFocusCtx.Provider value={value}>
      {children}
    </ChurchFocusCtx.Provider>
  )
}

// ── Scope extraction ──────────────────────────────────────────────────────────

const ROLE_LEVELS: ScopeLevel[] = [
  'denomination', 'oversight', 'campus', 'stream', 'council', 'governorship', 'bacenta',
]

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Every scope the user holds an explicit admin or leader role at.
 *  Reads both the `churchScopes` single-edge JWT block and the top-level
 *  `isAdminFor<Level>` / `leads<Level>` arrays (present for multi-scope users).
 *  Returned in descending scope level order (denomination → bacenta). */
export function getUserRoleScopes(user: AppUser | null | undefined): ChurchRef[] {
  if (!user) return []
  const seen = new Set<string>()
  const out: ChurchRef[] = []
  const push = (level: ScopeLevel, id: string, name?: string) => {
    const key = `${level}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id, name: name || cap(level), level })
  }
  for (const level of ROLE_LEVELS) {
    const cs = user.churchScopes
    if (cs) {
      const aRef = (cs as any)[`isAdminFor${cap(level)}Of`]
      if (aRef?.id) push(level, aRef.id, aRef.name)
      const lRef = (cs as any)[`leads${cap(level)}Of`]
      if (lRef?.id) push(level, lRef.id, lRef.name)
    }
    const aArr = (user as any)[`isAdminFor${cap(level)}`]
    if (Array.isArray(aArr)) for (const r of aArr) if (r?.id) push(level, r.id, r.name)
    const lArr = (user as any)[`leads${cap(level)}`]
    if (Array.isArray(lArr)) for (const r of lArr) if (r?.id) push(level, r.id, r.name)
  }
  return out
}
