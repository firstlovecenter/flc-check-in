import { useCallback, useEffect, useState } from 'react'
import {
  cyclePreference,
  getStoredPreference,
  initThemeListeners,
  preferenceLabel,
  resolveTheme,
  setPreference,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme'

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredPreference)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(getStoredPreference()))

  useEffect(() => {
    return initThemeListeners(setResolved)
  }, [])

  const setThemePreference = useCallback((next: ThemePreference) => {
    setPreference(next)
    setPreferenceState(next)
    setResolved(resolveTheme(next))
  }, [])

  const toggle = useCallback(() => {
    setThemePreference(cyclePreference(preference))
  }, [preference, setThemePreference])

  return {
    preference,
    resolved,
    /** @deprecated use `resolved` — kept for existing toggle labels */
    theme: resolved,
    setPreference: setThemePreference,
    toggle,
    label: preferenceLabel(preference),
  }
}
