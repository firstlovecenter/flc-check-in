import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
// Only English (the fallback) ships in the startup bundle. The other
// languages are separate chunks fetched on demand — ~97 KB every phone used to
// download before first paint whatever its language. The service worker
// precaches every JS chunk, so offline installs still have all three.
import en from '../locales/en.json'

const LAZY_LANGUAGES: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  fr: () => import('../locales/fr.json'),
  es: () => import('../locales/es.json'),
}

/** Shared with the FL Admin Portal so both apps remember the same preference. */
export const LANGUAGE_STORAGE_KEY = 'flc-language'

export interface SupportedLanguage {
  code: string
  nativeName: string
}

// Native names are never translated — speakers find their language by name.
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en', nativeName: 'English' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'es', nativeName: 'Español' },
]

/** Make sure a language's strings are loaded. Resolves immediately for
 *  English and for anything already loaded; never rejects (English fallback). */
export async function loadLanguage(code: string | undefined): Promise<void> {
  const lng = (code || 'en').split('-')[0]
  const loader = LAZY_LANGUAGES[lng]
  if (!loader || i18n.hasResourceBundle(lng, 'translation')) return
  try {
    const mod = await loader()
    i18n.addResourceBundle(lng, 'translation', mod.default, true, true)
  } catch { /* offline + not cached: English fallback */ }
}

/** Resolves once the detected language's strings are ready. main.tsx waits
 *  on it before the first render so French/Spanish users never see a flash
 *  of English; for English it settles in a microtask. */
export const i18nReady: Promise<void> = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    // Other languages are added at runtime by loadLanguage().
    partialBundledLanguages: true,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    // Bundled at build time — PWA works offline without http-backend.
    load: 'languageOnly',
    // Portal parity (ADR-017): remember an explicit pick in `flc-language`,
    // otherwise follow the browser/OS language. Login has no picker — first
    // paint is always localStorage → navigator → English fallback.
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
    interpolation: { escapeValue: false },
    // bindI18nStore: re-render when a lazily-loaded bundle lands.
    react: { useSuspense: false, bindI18nStore: 'added' },
  })
  .then(() => loadLanguage(i18n.language).then(syncDocumentLang), () => {})

// Covers every path that switches language (picker, detector, other tabs).
// <html lang> is set only once the strings are actually loaded, so it always
// names the language on screen (screen readers, browser translate prompts).
i18n.on('languageChanged', (lng) => { void loadLanguage(lng).then(syncDocumentLang) })

function syncDocumentLang() {
  if (typeof document === 'undefined') return
  const lng = (i18n.language || 'en').split('-')[0]
  document.documentElement.lang = i18n.hasResourceBundle(lng, 'translation') ? lng : 'en'
}

export default i18n
