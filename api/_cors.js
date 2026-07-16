// CORS for the native (Capacitor) app shells. The web app never needs this —
// it calls these proxies same-origin, which browsers exempt from CORS. The
// native apps are served from capacitor://localhost (iOS) / https://localhost
// (Android), so their calls to the deployed origin are cross-origin and every
// JSON POST triggers an OPTIONS preflight that must be answered here.
//
// Underscore prefix keeps Vercel from deploying this file as its own route.
const ALLOWED_ORIGINS = new Set([
  'capacitor://localhost', // iOS Capacitor WebView
  'https://localhost', // Android Capacitor WebView
])

/** Set CORS headers for allowed native origins. Returns true when the
 *  request was an OPTIONS preflight and has been fully answered — the
 *  caller must return immediately without touching the upstream. */
export function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.status(204).end()
    return true
  }
  return false
}
