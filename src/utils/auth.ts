// src/utils/auth.js
// JWT decode + role→level mapping for the FLC 7-level hierarchy.
// Wire real auth by replacing getCurrentUser() body.

const LEAD_CHURCHES_URL =
  import.meta.env.VITE_LEAD_CHURCHES_API_URL ||
  'https://rgldisl2bxl3l2upaauxodtrhy0uxkot.lambda-url.eu-west-2.on.aws/auth/churches'

export function decodeJWT(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}

// FLC scope hierarchy, lowest to highest. Used for picking the highest
// level when a user holds multiple roles, and for ordering scopes.
export const SCOPE_LEVELS = [
  'bacenta',
  'governorship',
  'council',
  'stream',
  'campus',
  'oversight',
  'denomination',
]

export function getLevelFromRoles(roles = []) {
  const r = roles.map((x) => x.toLowerCase())
  const matches = []
  if (r.some((x) => x.includes('denomination'))) matches.push('denomination')
  if (r.some((x) => x.includes('oversight'))) matches.push('oversight')
  if (r.some((x) => x.includes('campus'))) matches.push('campus')
  if (r.some((x) => x.includes('stream'))) matches.push('stream')
  if (r.some((x) => x.includes('council'))) matches.push('council')
  if (r.some((x) => x.includes('governorship'))) matches.push('governorship')
  if (r.some((x) => x.includes('bacenta'))) matches.push('bacenta')
  if (matches.length === 0) return 'bacenta'
  // Pick the highest level the user holds.
  return matches.reduce((highest, lvl) =>
    SCOPE_LEVELS.indexOf(lvl) > SCOPE_LEVELS.indexOf(highest) ? lvl : highest
  )
}

export function isAdmin(roles = []) {
  return roles.some(r => r.startsWith('admin'));
}

function uniqueChurchContexts(contexts) {
  const seen = new Set()
  return contexts.filter((ctx) => {
    const key = `${ctx.level}:${ctx.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeChurchContexts(member) {
  const toContext = (item, level, source) => {
    if (!item?.id) return null
    return {
      id: item.id,
      name: item.name || `${source} ${item.id.slice(0, 6)}`,
      level,
      source,
    }
  }

  const contexts = [
    ...(member?.leadsDenomination || []).map((x) => toContext(x, 'denomination', 'Denomination Lead')),
    ...(member?.isAdminForDenomination || []).map((x) => toContext(x, 'denomination', 'Denomination Admin')),
    ...(member?.leadsOversight || []).map((x) => toContext(x, 'oversight', 'Oversight Lead')),
    ...(member?.isAdminForOversight || []).map((x) => toContext(x, 'oversight', 'Oversight Admin')),
    ...(member?.leadsCampus || []).map((x) => toContext(x, 'campus', 'Campus Lead')),
    ...(member?.isAdminForCampus || []).map((x) => toContext(x, 'campus', 'Campus Admin')),
    ...(member?.leadsStream || []).map((x) => toContext(x, 'stream', 'Stream Lead')),
    ...(member?.isAdminForStream || []).map((x) => toContext(x, 'stream', 'Stream Admin')),
    ...(member?.leadsCouncil || []).map((x) => toContext(x, 'council', 'Council Lead')),
    ...(member?.isAdminForCouncil || []).map((x) => toContext(x, 'council', 'Council Admin')),
    ...(member?.isArrivalsAdminForCouncil || []).map((x) => toContext(x, 'council', 'Council Arrivals Admin')),
    ...(member?.leadsGovernorship || []).map((x) => toContext(x, 'governorship', 'Governorship Lead')),
    ...(member?.isAdminForGovernorship || []).map((x) => toContext(x, 'governorship', 'Governorship Admin')),
    ...(member?.isArrivalsAdminForGovernorship || []).map((x) => toContext(x, 'governorship', 'Governorship Arrivals Admin')),
    ...(member?.leadsBacenta || []).map((x) => toContext(x, 'bacenta', 'Bacenta Lead')),
  ].filter(Boolean)

  const fallbackBacentaId = member?.bacenta?.id
  if (fallbackBacentaId) {
    contexts.push({
      id: fallbackBacentaId,
      name: member?.leadsBacenta?.[0]?.name || 'Assigned Bacenta',
      level: 'bacenta',
      source: 'Member Bacenta',
    })
  }

  return uniqueChurchContexts(contexts)
}

function localFallbackChurchContexts(payload) {
  return uniqueChurchContexts([
    payload?.denomination?.id
      ? { id: payload.denomination.id, name: payload.denomination.name || 'Denomination', level: 'denomination', source: 'Local Denomination' }
      : null,
    payload?.oversight?.id
      ? { id: payload.oversight.id, name: payload.oversight.name || 'Oversight', level: 'oversight', source: 'Local Oversight' }
      : null,
    payload?.campus?.id
      ? { id: payload.campus.id, name: payload.campus.name || 'Campus', level: 'campus', source: 'Local Campus' }
      : null,
    payload?.stream?.id
      ? { id: payload.stream.id, name: payload.stream.name || 'Stream', level: 'stream', source: 'Local Stream' }
      : null,
    payload?.council?.id
      ? { id: payload.council.id, name: payload.council.name || 'Council', level: 'council', source: 'Local Council' }
      : null,
    payload?.governorship?.id
      ? { id: payload.governorship.id, name: payload.governorship.name || 'Governorship', level: 'governorship', source: 'Local Governorship' }
      : null,
    payload?.bacenta?.id
      ? { id: payload.bacenta.id, name: payload.bacenta.name || 'Bacenta', level: 'bacenta', source: 'Local Bacenta' }
      : null,
  ].filter(Boolean))
}

export function getCurrentUser() {
  const token = localStorage.getItem('accessToken');
  if (token) {
    const payload = decodeJWT(token);
    if (payload) return enrichUser(payload);
  }
  return null;
}

export function enrichUser(payload) {
  const level = getLevelFromRoles(payload.roles || []);
  const unitName =
    payload.bacenta?.name ||
    payload.governorship?.name ||
    payload.council?.name ||
    payload.stream?.name ||
    payload.campus?.name ||
    payload.oversight?.name ||
    payload.denomination?.name || '';
  const churchContexts = localFallbackChurchContexts(payload)
  const activeChurch = churchContexts[0] || null
  return {
    ...payload,
    level: activeChurch?.level || level,
    unitName: activeChurch?.name || unitName,
    isAdmin: isAdmin(payload.roles || []),
    churchContexts,
    activeChurch,
  }
}

export async function fetchLeadChurchesByEmail(email, accessToken) {
  if (!email) throw new Error('Email is required to load church contexts')
  if (!accessToken) throw new Error('Access token is required to load church contexts')

  const response = await fetch(LEAD_CHURCHES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ email }),
  })

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json?.message || 'Failed to fetch lead churches')
  }

  return json
}

export async function resolveChurchContextsForUser(user) {
  try {
    const token = localStorage.getItem('accessToken')
    const leadChurchesPayload = await fetchLeadChurchesByEmail(user.email, token)
    const churchContexts = normalizeChurchContexts(leadChurchesPayload)
    if (churchContexts.length) {
      return {
        member: leadChurchesPayload?.user || null,
        churchContexts,
        activeChurch: churchContexts[0],
      }
    }
  } catch {
    // fall back to local user payload if graphql is unavailable
  }

  const churchContexts = localFallbackChurchContexts(user)
  return {
    member: null,
    churchContexts,
    activeChurch: churchContexts[0] || null,
  }
}

export function withActiveChurch(user, church) {
  const nextChurch = church || user?.activeChurch || null
  if (!nextChurch) return user
  return {
    ...user,
    activeChurch: nextChurch,
    level: nextChurch.level,
    unitName: nextChurch.name,
  }
}

// ── Real login call ───────────────────────────────────────────────────────

// Always use the same-origin /flc-auth path.
// Dev  → Vite proxy rewrites to the Lambda URL (vite.config.js).
// Prod → Vercel rewrite in vercel.json forwards it server-side.
// Neither exposes the Lambda URL to the browser, so CORS is never an issue.
function authApiUrl() {
  if (typeof window !== 'undefined') return `${window.location.origin}/api/flc-auth`
  return '/api/flc-auth'
}

export async function loginWithCredentials(email, password) {
  const res = await fetch(`${authApiUrl()}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || 'Login failed');

  localStorage.setItem('accessToken',  data.tokens.accessToken);
  localStorage.setItem('refreshToken', data.tokens.refreshToken);

  const payload = decodeJWT(data.tokens.accessToken);
  const { id, ...userFields } = data.user;
  const user = enrichUser({ ...payload, ...userFields, userId: payload.userId ?? id });

  // Fire-and-forget: resolve graph ID and sync to Supabase in the background.
  // This must NOT block navigation — it's a best-effort profile sync.
  ;(async () => {
    try {
      const { resolveCurrentMember, memberToProfileRow } = await import('./membersApi');
      const member = await resolveCurrentMember(user);
      if (member?.id && member.id !== user.userId) {
      }
      const { upsertMemberProfile } = await import('./supabaseCheckins');
      const row = member ? memberToProfileRow(member) : user;
      await upsertMemberProfile(row);
    } catch (err: any) {
      console.warn('[auth] post-login sync failed:', err.message);
    }
  })();

  return user;
}

export function logout() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export async function requestPasswordReset(email: string) {
  const res = await fetch(`${authApiUrl()}/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || 'Request failed')
  return data
}

export async function confirmPasswordReset(token: string, newPassword: string) {
  const res = await fetch(`${authApiUrl()}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || 'Reset failed')
  return data
}
