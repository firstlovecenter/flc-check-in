// Vercel serverless proxy from /api/flc-auth/* to the FLC auth Lambda.
//
// In dev, Vite's proxy (vite.config.js) handles the same /api/flc-auth →
// Lambda forwarding using VITE_AUTH_API_URL from .env. In prod this function
// does the same job, reading AUTH_LAMBDA_URL from the Vercel project's
// environment variables.
//
// Reads the upstream URL from VITE_AUTH_API_URL (same env var Vite's dev
// proxy uses) so you only configure ONE variable per environment. Falls
// back to AUTH_LAMBDA_URL if you prefer a server-only name.
//
// Accepted shapes — the function normalises all of these to "<origin>/auth":
//   https://<host>                        → https://<host>/auth
//   https://<host>/auth                   → https://<host>/auth
//   https://<host>/auth/login             → https://<host>/auth
//   https://<host>/auth/anything/else     → https://<host>/auth
//
// This matches Vite's dev proxy (vite.config.js) which also strips the
// path and reconstructs /auth itself. So one env-var value works in both
// places without a "split brain" between dev and prod.
//
// No hardcoded fallback — a misconfigured deployment fails loudly via a
// 500 rather than silently routing prod logins to dev's user database.

import { applyCors } from '../_cors.js'

const RAW = process.env.VITE_AUTH_API_URL || process.env.AUTH_LAMBDA_URL

/** Build "<origin>/auth" from whatever the env var contains. */
function normaliseTarget(raw) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return `${u.origin}/auth`
  } catch {
    return null
  }
}

const TARGET = normaliseTarget(RAW)
const UPSTREAM_TIMEOUT_MS = 12_000

// The auth service keeps the refresh token in an httpOnly cookie (SYN-173):
// set on /login, read by /refresh-token, cleared by /logout. The browser only
// ever talks to THIS origin, so the cookie must be relayed first-party:
//   - request:  forward the browser's Cookie header upstream;
//   - response: pass Set-Cookie back, with Domain dropped (a cookie scoped to
//     the Lambda's host would be rejected here) and Path pinned to this proxy
//     so the browser returns it on /api/flc-auth/* and nowhere else.
const PROXY_PATH = '/api/flc-auth'

export function rewriteSetCookie(cookie) {
  const parts = cookie.split(';').map((p) => p.trim()).filter(Boolean)
  const kept = parts.filter((p, i) => i === 0 || !/^(domain|path)=/i.test(p))
  return [...kept, `Path=${PROXY_PATH}`].join('; ')
}

function upstreamSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

if (!TARGET) {
  console.error('[flc-auth] VITE_AUTH_API_URL is not set or invalid — add a full URL to the Vercel project env vars')
}

export default async function handler(req, res) {
  // Native (Capacitor) callers are cross-origin — see api/_cors.js.
  if (applyCors(req, res)) return
  if (!TARGET) {
    return res.status(500).json({
      error: 'Auth proxy is not configured',
      detail: 'AUTH_LAMBDA_URL is missing on the deployment',
    })
  }

  const path = req.url.replace(/^\/api\/flc-auth/, '') || '/'
  try {
    const upstreamRes = await fetch(`${TARGET}${path}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const cookies = upstreamSetCookies(upstreamRes.headers)
    if (cookies.length) res.setHeader('Set-Cookie', cookies.map(rewriteSetCookie))
    // Token responses are per-user credentials — never cache them anywhere.
    res.setHeader('Cache-Control', 'no-store')
    const data = await upstreamRes.json().catch(() => ({}))
    res.status(upstreamRes.status).json(data)
  } catch (err) {
    console.error('[flc-auth] upstream fetch failed:', err?.message)
    res.status(502).json({ error: 'Auth upstream unreachable' })
  }
}
