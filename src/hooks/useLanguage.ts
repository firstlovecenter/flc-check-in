import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, loadLanguage, type SupportedLanguage } from '../lib/i18n'

interface UseLanguageResult {
  language: string
  languages: SupportedLanguage[]
  setLanguage: (code: string) => void
}

export function useLanguage(): UseLanguageResult {
  const { i18n } = useTranslation()

  const setLanguage = useCallback(
    // Load first, then switch — so the screen goes straight from the old
    // language to the new one instead of flashing English in between.
    (code: string) => { void loadLanguage(code).then(() => i18n.changeLanguage(code)) },
    [i18n],
  )

  return {
    language: i18n.resolvedLanguage || i18n.language || 'en',
    languages: SUPPORTED_LANGUAGES,
    setLanguage,
  }
}
