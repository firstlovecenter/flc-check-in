/** Theme preference + DOM application (DESIGN-new.md / portal parity). */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'flc-theme'

const THEME_COLOR = {
  light: '#EEF1F5',
  dark: '#0F1114',
} as const

export function getStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'light'
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === 'dark' || raw === 'light' || raw === 'system') return raw
  return 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'dark') return 'dark'
  if (preference === 'light') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyResolvedTheme(resolved: ResolvedTheme) {
  if (resolved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
  updateThemeColorMeta(resolved)
}

export function updateThemeColorMeta(resolved: ResolvedTheme) {
  let meta = document.querySelector('meta[name="theme-color"][data-flc-theme]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('data-flc-theme', '')
    document.head.appendChild(meta)
  }
  meta.setAttribute('content', THEME_COLOR[resolved])
}

export function setPreference(preference: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, preference)
  applyResolvedTheme(resolveTheme(preference))
}

/** Cycle: light → dark → system → light (for theme toggle buttons). */
export function cyclePreference(current: ThemePreference): ThemePreference {
  if (current === 'light') return 'dark'
  if (current === 'dark') return 'system'
  return 'light'
}

export function preferenceLabel(preference: ThemePreference): string {
  if (preference === 'system') return 'System'
  return preference === 'dark' ? 'Dark' : 'Light'
}

export function initThemeListeners(onChange: (resolved: ResolvedTheme) => void) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (getStoredPreference() !== 'system') return
    const resolved = resolveTheme('system')
    applyResolvedTheme(resolved)
    onChange(resolved)
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}

/** Inline script in index.html — runs before paint. */
export function applyThemeBeforePaint() {
  const pref = getStoredPreference()
  applyResolvedTheme(resolveTheme(pref))
}
