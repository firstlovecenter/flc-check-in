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

if (!TARGET) {
  console.error('[flc-auth] VITE_AUTH_API_URL is not set or invalid — add a full URL to the Vercel project env vars')
}

export default async function handler(req, res) {
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
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    })
    const data = await upstreamRes.json().catch(() => ({}))
    res.status(upstreamRes.status).json(data)
  } catch (err) {
    console.error('[flc-auth] upstream fetch failed:', err?.message)
    res.status(502).json({ error: 'Auth upstream unreachable' })
  }
}
