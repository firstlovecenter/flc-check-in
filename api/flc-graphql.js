// Vercel serverless proxy from /flc-graphql to the FLC member GraphQL endpoint.
//
// In dev, Vite's proxy (vite.config.js) handles the same /flc-graphql →
// upstream forwarding, reading VITE_MEMBER_GRAPHQL_URL from .env. In prod
// this function does the same job, reading MEMBER_GRAPHQL_URL from the
// Vercel project's environment variables.
//
// MEMBER_GRAPHQL_URL must be set on every Vercel deployment:
//   https://<host>/graphql
//
// We deliberately do NOT hardcode a fallback (see api/flc-auth/[...path].js
// for the same rationale — env-var-only avoids silent prod-uses-dev).

const TARGET = process.env.MEMBER_GRAPHQL_URL

if (!TARGET) {
  console.error('[flc-graphql] MEMBER_GRAPHQL_URL is not set — add it to the Vercel project env vars')
}

export default async function handler(req, res) {
  if (!TARGET) {
    return res.status(500).json({
      error: 'GraphQL proxy is not configured',
      detail: 'MEMBER_GRAPHQL_URL is missing on the deployment',
    })
  }

  try {
    const upstreamRes = await fetch(TARGET, {
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
    console.error('[flc-graphql] upstream fetch failed:', err?.message)
    res.status(502).json({ error: 'GraphQL upstream unreachable' })
  }
}
