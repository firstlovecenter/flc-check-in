// Resolves the origin for the same-origin API proxies (/flc-graphql,
// /api/flc-auth).
//
// Web (dev + prod) → window.location.origin, because the Vite dev proxy and
// the Vercel serverless functions live on the app's own origin.
//
// Native (Capacitor) → the app is served from capacitor://localhost (iOS) /
// https://localhost (Android), where no proxy exists. Native builds run
// `npm run build:mobile`, which loads .env.mobile and sets VITE_API_ORIGIN
// to the deployed Vercel origin so the same proxy endpoints keep working.
export function apiOrigin(): string {
  const configured = (import.meta.env.VITE_API_ORIGIN ?? '').trim().replace(/\/+$/, '')
  if (configured) return configured
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}
