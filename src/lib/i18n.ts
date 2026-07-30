import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from '../locales/en.json'
import fr from '../locales/fr.json'
import es from '../locales/es.json'

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

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
      es: { translation: es },
    },
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
    react: { useSuspense: false },
  })

const syncDocumentLang = (language: string) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }
}

syncDocumentLang(i18n.resolvedLanguage || i18n.language || 'en')
i18n.on('languageChanged', syncDocumentLang)

export default i18n
