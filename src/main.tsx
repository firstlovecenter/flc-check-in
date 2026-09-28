import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { i18nReady } from './lib/i18n'
import './index.css'
import App from './App'

// Wait for the user's language (a precached chunk, or nothing for English)
// so the first paint is already in the right language.
i18nReady.finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
