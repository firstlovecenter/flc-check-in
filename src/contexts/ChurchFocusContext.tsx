import { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import type { AppUser, ChurchRef } from '../types/app'
import { getCurrentUser } from '../utils/auth'
import {
  getUserRoleScopes, defaultRoleScope, findRoleScope, isMultiRole,
  type RoleScope,
} from '../utils/roleScopes'

// Persisted as the hat's KEY (`leader:bacenta:b-1`), not the object, so a
// renamed church or a refreshed token cannot resurrect a stale snapshot.
// v2 because v1 stored a church ref, which cannot express "leader vs admin at
// the same church" — they are two different hats with different capabilities.
const STORAGE_KEY = 'flc:roleScope:v2'
const ALL_ROLES = 'ALL'

interface ChurchFocusValue {
  /** The (role, church) pair the user is currently acting as.
   *  null = "All roles" — a read-only browse mode, never a capability. */
  focusedHat: RoleScope | null
  /** Every hat the user holds, most-specific first. */
  availableHats: RoleScope[]
  /** True when the switcher is meaningful. */
  isMultiRole: boolean
  setFocusedHat: (hat: RoleScope | null) => void

  /** Church-shaped view of the active hat, for the event-list SQL filter.
   *  Keeps listAllEvents' focusedScope contract unchanged. */
  focusedScope: ChurchRef | null
  /** Legacy: every church the user has a role at, deduped. */
  availableScopes: ChurchRef[]
  isMultiScope: boolean
  setFocusedScope: (s: ChurchRef | null) => void
}

const ChurchFocusCtx = createContext<ChurchFocusValue>({
  focusedHat: null,
  availableHats: [],
  isMultiRole: false,
  setFocusedHat: () => {},
  focusedScope: null,
  availableScopes: [],
  isMultiScope: false,
  setFocusedScope: () => {},
})

export function useChurchFocus() {
  return useContext(ChurchFocusCtx)
}

function hatToChurchRef(hat: RoleScope | null): ChurchRef | null {
  if (!hat) return null
  return { id: hat.id, name: hat.name, level: hat.level, source: hat.source }
}

function readSavedKey(userId: string | undefined): string | null {
  try { return sessionStorage.getItem(`${STORAGE_KEY}:${userId ?? 'anon'}`) } catch { return null }
}

export function ChurchFocusProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [user, setUser] = useState<AppUser | null>(getCurrentUser)

  // Re-sync the user object on every navigation so the provider stays fresh
  // after login (/ → /home) and after token refreshes.
  useEffect(() => {
    setUser(getCurrentUser())
  }, [location.pathname])

  // Re-sync immediately when the background superadmin/superviewer
  // re-verification changes the local privilege flags (auth.ts).
  useEffect(() => {
    const onChange = () => setUser(getCurrentUser())
    window.addEventListener('flc:privileges-changed', onChange)
    return () => window.removeEventListener('flc:privileges-changed', onChange)
  }, [])

  const availableHats = useMemo(() => getUserRoleScopes(user), [user?.userId])

  const storageKey = `${STORAGE_KEY}:${user?.userId ?? 'anon'}`

  // The default is the user's LOWEST (most specific) role — never "All roles".
  //
  // A union of every hat cannot answer "what may I do here?", and pretending
  // otherwise is what produced the confusion this model replaces. The most
  // specific role is also the one whose day-to-day work the app exists for: a
  // bacenta leader who also admins a stream spends most Sundays being counted,
  // not supervising. Mirrors the FL Admin Portal's getLowestRole default.
  const [focusedHat, setFocusedHatState] = useState<RoleScope | null>(() => {
    const initial = getCurrentUser()
    const hats = getUserRoleScopes(initial)
    if (!hats.length) return null
    const saved = readSavedKey(initial?.userId)
    if (saved === ALL_ROLES) return null
    return findRoleScope(hats, saved) ?? hats[0]
  })

  // Re-resolve when the active user or their role set changes. Also covers the
  // case where a saved hat was removed from the JWT between sessions — we fall
  // back to the default rather than acting under an identity they no longer
  // hold.
  useEffect(() => {
    if (!availableHats.length) { setFocusedHatState(null); return }
    const saved = readSavedKey(user?.userId)
    if (saved === ALL_ROLES) { setFocusedHatState(null); return }
    setFocusedHatState((current) =>
      findRoleScope(availableHats, current?.key ?? saved) ?? availableHats[0],
    )
  }, [storageKey, availableHats, user?.userId])

  const setFocusedHat = useCallback((hat: RoleScope | null) => {
    setFocusedHatState(hat)
    try {
      sessionStorage.setItem(storageKey, hat ? hat.key : ALL_ROLES)
    } catch { /* quota / disabled storage */ }
  }, [storageKey])

  // ── Legacy church-shaped API, derived so existing callers keep working ────
  const availableScopes = useMemo<ChurchRef[]>(() => {
    const seen = new Set<string>()
    const out: ChurchRef[] = []
    for (const hat of availableHats) {
      const key = `${hat.level}:${hat.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: hat.id, name: hat.name, level: hat.level })
    }
    return out
  }, [availableHats])

  const setFocusedScope = useCallback((s: ChurchRef | null) => {
    if (!s) { setFocusedHat(null); return }
    const match = availableHats.find((h) => h.level === s.level && h.id === s.id)
    setFocusedHat(match ?? null)
  }, [availableHats, setFocusedHat])

  const value = useMemo<ChurchFocusValue>(() => ({
    focusedHat,
    availableHats,
    isMultiRole: isMultiRole(availableHats),
    setFocusedHat,
    focusedScope: hatToChurchRef(focusedHat),
    availableScopes,
    isMultiScope: availableScopes.length > 1,
    setFocusedScope,
  }), [
    focusedHat, availableHats, setFocusedHat, availableScopes,
    setFocusedScope,
  ])

  return (
    <ChurchFocusCtx.Provider value={value}>
      {children}
    </ChurchFocusCtx.Provider>
  )
}

/** Re-exported so existing imports keep resolving. Prefer importing from
 *  utils/roleScopes in new code. */
export { getUserRoleScopes, defaultRoleScope }
export type { RoleScope }
