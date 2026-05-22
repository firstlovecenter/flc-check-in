// Vercel serverless proxy from /flc-graphql to the FLC member GraphQL endpoint.
//
// vercel.json rewrites /flc-graphql → /api/flc-graphql so callers still hit
// a same-origin path. This function reads MEMBER_GRAPHQL_URL from the
// Vercel project's env vars, so each environment (prod, preview, dev) can
// point at its own upstream without editing source.
//
// Reads the upstream URL from VITE_MEMBER_GRAPHQL_URL (same env var the
// client + Vite proxy use) so you only configure ONE variable per
// environment. Falls back to MEMBER_GRAPHQL_URL if you prefer a
// server-only name. Per environment on the Vercel project:
//   prod    → https://api-synago.firstlovecenter.com/graphql
//   preview → (whatever you want previews to use)
//   dev     → (Vite has its own proxy in vite.config.js for local dev)
//
// No hardcoded fallback — a misconfigured deployment fails loudly via a 500
// rather than silently routing prod traffic to dev.

/** Normalise the env var: validate it's a URL, strip trailing slash.
 *  Unlike the auth proxy we keep the path because GraphQL endpoints
 *  typically live at /graphql, not at the origin. */
function normaliseTarget(raw) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return null
  }
}

const TARGET = normaliseTarget(process.env.VITE_MEMBER_GRAPHQL_URL || process.env.MEMBER_GRAPHQL_URL)

if (!TARGET) {
  console.error('[flc-graphql] VITE_MEMBER_GRAPHQL_URL is not set or invalid — add a full URL to the Vercel project env vars')
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
        // Forward the caller's bearer token so authenticated graph queries
        // (RLS/row-level filters in Neo4j-GraphQL) see the real user.
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
