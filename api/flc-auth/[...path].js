// Vercel serverless proxy from /api/flc-auth/* to the FLC auth Lambda.
//
// In dev, Vite's proxy (vite.config.js) handles this same /api/flc-auth →
// Lambda forwarding, reading VITE_AUTH_API_URL from .env. In prod this
// function does the same job, reading AUTH_LAMBDA_URL from the Vercel
// project's environment variables.
//
// AUTH_LAMBDA_URL must be set on every Vercel deployment of this app:
//   https://<lambda-url>.lambda-url.<region>.on.aws/auth   ← include /auth
//
// We deliberately DO NOT hardcode a fallback. A wrong-environment fallback
// is the kind of misconfiguration that silently routes prod logins to dev's
// user database for months without anyone noticing. Better to fail loudly.

const TARGET = process.env.AUTH_LAMBDA_URL

if (!TARGET) {
  // Logged once per cold start. The 500 response below makes the misconfig
  // visible to the client too.
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
