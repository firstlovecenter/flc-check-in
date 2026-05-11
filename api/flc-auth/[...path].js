const TARGET = 'https://rgldisl2bxl3l2upaauxodtrhy0uxkot.lambda-url.eu-west-2.on.aws/auth'

export default async function handler(req, res) {
  const path = req.url.replace(/^\/api\/flc-auth/, '') || '/'
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
}
