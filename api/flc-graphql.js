// Vercel serverless proxy from /flc-graphql to the FLC member GraphQL endpoint.
//
// vercel.json rewrites /flc-graphql → /api/flc-graphql so callers still hit
// a same-origin path. This function reads MEMBER_GRAPHQL_URL from the
// Vercel project's env vars, so each environment (prod, preview, dev) can
// point at its own upstream without editing source.
//
// MEMBER_GRAPHQL_URL must be set per environment on the Vercel project:
//   prod    → https://api-synago.firstlovecenter.com/graphql
//   preview → (whatever you want previews to use)
//   dev     → (Vite has its own proxy in vite.config.js for local dev)
//
// No hardcoded fallback — a misconfigured deployment fails loudly via a 500
// rather than silently routing prod traffic to dev.

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
