// Vercel serverless proxy from /api/flc-auth/* to the FLC auth Lambda.
//
// In dev, Vite's proxy (vite.config.js) handles the same /api/flc-auth →
// Lambda forwarding using VITE_AUTH_API_URL from .env. In prod this function
// does the same job, reading AUTH_LAMBDA_URL from the Vercel project's
// environment variables.
//
// AUTH_LAMBDA_URL must be set per environment on the Vercel project:
//   https://<lambda-url>.lambda-url.<region>.on.aws/auth   ← include /auth
//
// No hardcoded fallback — a misconfigured deployment fails loudly via a
// 500 rather than silently routing prod logins to dev's user database.

const TARGET = process.env.AUTH_LAMBDA_URL

if (!TARGET) {
  console.error('[flc-auth] AUTH_LAMBDA_URL is not set — add it to the Vercel project env vars')
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
