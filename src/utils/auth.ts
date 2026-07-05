// src/utils/auth.js
// JWT decode + role→level mapping for the FLC 7-level hierarchy.
// Wire real auth by replacing getCurrentUser() body.

// Always call the same-origin proxy — never the Lambda directly.
// Dev  → Vite proxy rewrites /api/flc-auth → Lambda (vite.config.js).
// Prod → Vercel serverless function at api/flc-auth/[...path].js forwards it.
function leadChurchesUrl() {
  const base = typeof window !== 'undefined' ? window.location.origin : ''
  return `${base}/api/flc-auth/churches`
}

export function decodeJWT(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}

// Church levels that may carry an { id, name } ref in the JWT payload or
// login API response. We persist these to localStorage so getCurrentUser()
// can fill in IDs that the JWT itself doesn't embed (e.g. denomination for
// top-level leaders whose JWT only carries roles, not church refs).
const CHURCH_LEVELS = [
  'denomination', 'oversight', 'campus',
  'stream', 'council', 'governorship', 'bacenta',
] as const

function loadPersistedChurchContext(): Record<string, { id: string; name: string }> | null {
  try {
    const raw = localStorage.getItem('churchContext')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Merge church-level IDs that are missing from `payload` with whatever was
 *  persisted from the last login/refresh API response. JWT values always win. */
function mergeChurchContext(payload: any): any {
  const saved = loadPersistedChurchContext()
  if (!saved) return payload
  const merged = { ...payload }
  for (const lvl of CHURCH_LEVELS) {
    if (!merged[lvl]?.id && saved[lvl]?.id) merged[lvl] = saved[lvl]
  }
  return merged
}

/** Persist church refs from a Supabase member_profiles row to localStorage.
 *  The row uses flat columns (denomination_id / denomination_name etc.) rather
 *  than nested objects. Called from LeaderHomeScreen when the JWT doesn't
 *  carry church IDs (e.g. denomination-level leaders after a stale login). */
export function persistChurchContextFromProfileRow(row: any) {
  if (!row) return
  const ctx: Record<string, { id: string; name: string }> = {}
  for (const lvl of CHURCH_LEVELS) {
    const id   = row[`${lvl}_id`]
    const name = row[`${lvl}_name`]
    if (id) ctx[lvl] = { id, name: name || lvl }
  }
  if (Object.keys(ctx).length) localStorage.setItem('churchContext', JSON.stringify(ctx))
}

/** Persist church refs found inside the JWT's `churchScopes` object
 *  (e.g. leadsCouncilOf, isAdminForDenominationOf) into the flat
 *  localStorage churchContext. This is a fallback for accounts whose
 *  member_profiles row is empty/missing but whose JWT does carry their
 *  own scope under churchScopes.
 *
 *  Non-destructive: existing keys are preserved (member_profiles wins). */
export function persistChurchContextFromJwt(churchScopes: any) {
  if (!churchScopes || typeof churchScopes !== 'object') return
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const existing = loadPersistedChurchContext() || {}
  const ctx: Record<string, { id: string; name: string }> = { ...existing }
  let added = false
  for (const lvl of CHURCH_LEVELS) {
    if (ctx[lvl]?.id) continue
    const ref =
      churchScopes[`isAdminFor${cap(lvl)}Of`] ??
      churchScopes[`leads${cap(lvl)}Of`]
    if (ref?.id) {
      ctx[lvl] = { id: ref.id, name: ref.name || lvl }
      added = true
    }
  }
  if (added) localStorage.setItem('churchContext', JSON.stringify(ctx))
}

/** Extract church refs from an auth API user object and persist to localStorage
 *  so they survive page refreshes (JWT may not embed all IDs). */
function persistChurchContext(userFields: any) {
  if (!userFields) return
  const ctx: Record<string, { id: string; name: string }> = {}
  for (const lvl of CHURCH_LEVELS) {
    if (userFields[lvl]?.id) ctx[lvl] = { id: userFields[lvl].id, name: userFields[lvl].name || lvl }
  }
  if (Object.keys(ctx).length) localStorage.setItem('churchContext', JSON.stringify(ctx))
}

// FLC scope hierarchy — single source of truth lives in types/app.ts.
// Imported into this module AND re-exported so existing imports of
// `{ SCOPE_LEVELS }` from auth keep working.
import { SCOPE_LEVELS } from '../types/app'
export { SCOPE_LEVELS }

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

function normalizeRoleList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.filter((r): r is string => typeof r === 'string' && r.length > 0)
}

export function mergeRoleLists(...roleLists: unknown[]): string[] {
  const merged = new Set<string>()
  for (const list of roleLists) {
    for (const role of normalizeRoleList(list)) merged.add(role)
  }
  return [...merged]
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

function contextRank(level: string | undefined, source: string | undefined): number {
  const idx = SCOPE_LEVELS.indexOf((level as any) ?? 'bacenta')
  const levelScore = idx < 0 ? 0 : idx * 10
  const sourceScore = source === 'admin' ? 3 : source === 'leader' ? 2 : source === 'active' ? 1 : 0
  return levelScore + sourceScore
}

function buildChurchContexts(payload: any) {
  const bySource = localFallbackChurchContexts(payload)

  const roleScoped = uniqueChurchContexts([
    ...(payload?.isAdminForDenomination || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Denomination', level: 'denomination', source: 'admin' })),
    ...(payload?.isAdminForOversight || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Oversight', level: 'oversight', source: 'admin' })),
    ...(payload?.isAdminForCampus || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Campus', level: 'campus', source: 'admin' })),
    ...(payload?.isAdminForStream || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Stream', level: 'stream', source: 'admin' })),
    ...(payload?.isAdminForCouncil || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Council', level: 'council', source: 'admin' })),
    ...(payload?.isAdminForGovernorship || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Governorship', level: 'governorship', source: 'admin' })),
    ...(payload?.leadsDenomination || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Denomination', level: 'denomination', source: 'leader' })),
    ...(payload?.leadsOversight || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Oversight', level: 'oversight', source: 'leader' })),
    ...(payload?.leadsCampus || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Campus', level: 'campus', source: 'leader' })),
    ...(payload?.leadsStream || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Stream', level: 'stream', source: 'leader' })),
    ...(payload?.leadsCouncil || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Council', level: 'council', source: 'leader' })),
    ...(payload?.leadsGovernorship || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Governorship', level: 'governorship', source: 'leader' })),
    ...(payload?.leadsBacenta || []).map((x: any) => ({ id: x?.id, name: x?.name || 'Bacenta', level: 'bacenta', source: 'leader' })),
    payload?.churchScopes?.isAdminForDenominationOf?.id ? { id: payload.churchScopes.isAdminForDenominationOf.id, name: payload.churchScopes.isAdminForDenominationOf.name || 'Denomination', level: 'denomination', source: 'admin' } : null,
    payload?.churchScopes?.isAdminForOversightOf?.id ? { id: payload.churchScopes.isAdminForOversightOf.id, name: payload.churchScopes.isAdminForOversightOf.name || 'Oversight', level: 'oversight', source: 'admin' } : null,
    payload?.churchScopes?.isAdminForCampusOf?.id ? { id: payload.churchScopes.isAdminForCampusOf.id, name: payload.churchScopes.isAdminForCampusOf.name || 'Campus', level: 'campus', source: 'admin' } : null,
    payload?.churchScopes?.isAdminForStreamOf?.id ? { id: payload.churchScopes.isAdminForStreamOf.id, name: payload.churchScopes.isAdminForStreamOf.name || 'Stream', level: 'stream', source: 'admin' } : null,
    payload?.churchScopes?.isAdminForCouncilOf?.id ? { id: payload.churchScopes.isAdminForCouncilOf.id, name: payload.churchScopes.isAdminForCouncilOf.name || 'Council', level: 'council', source: 'admin' } : null,
    payload?.churchScopes?.isAdminForGovernorshipOf?.id ? { id: payload.churchScopes.isAdminForGovernorshipOf.id, name: payload.churchScopes.isAdminForGovernorshipOf.name || 'Governorship', level: 'governorship', source: 'admin' } : null,
    payload?.churchScopes?.leadsDenominationOf?.id ? { id: payload.churchScopes.leadsDenominationOf.id, name: payload.churchScopes.leadsDenominationOf.name || 'Denomination', level: 'denomination', source: 'leader' } : null,
    payload?.churchScopes?.leadsOversightOf?.id ? { id: payload.churchScopes.leadsOversightOf.id, name: payload.churchScopes.leadsOversightOf.name || 'Oversight', level: 'oversight', source: 'leader' } : null,
    payload?.churchScopes?.leadsCampusOf?.id ? { id: payload.churchScopes.leadsCampusOf.id, name: payload.churchScopes.leadsCampusOf.name || 'Campus', level: 'campus', source: 'leader' } : null,
    payload?.churchScopes?.leadsStreamOf?.id ? { id: payload.churchScopes.leadsStreamOf.id, name: payload.churchScopes.leadsStreamOf.name || 'Stream', level: 'stream', source: 'leader' } : null,
    payload?.churchScopes?.leadsCouncilOf?.id ? { id: payload.churchScopes.leadsCouncilOf.id, name: payload.churchScopes.leadsCouncilOf.name || 'Council', level: 'council', source: 'leader' } : null,
    payload?.churchScopes?.leadsGovernorshipOf?.id ? { id: payload.churchScopes.leadsGovernorshipOf.id, name: payload.churchScopes.leadsGovernorshipOf.name || 'Governorship', level: 'governorship', source: 'leader' } : null,
    payload?.churchScopes?.leadsBacentaOf?.id ? { id: payload.churchScopes.leadsBacentaOf.id, name: payload.churchScopes.leadsBacentaOf.name || 'Bacenta', level: 'bacenta', source: 'leader' } : null,
  ].filter((x: any) => !!x?.id))

  const base = roleScoped.length > 0 ? roleScoped : bySource
  return [...base].sort((a: any, b: any) => contextRank(b.level, b.source) - contextRank(a.level, a.source))
}

const TOKEN_SKEW_SEC = 30  // treat token as expired 30s early

export function isTokenExpired(token: string): boolean {
  const payload = decodeJWT(token)
  if (!payload?.exp) return true
  return payload.exp - TOKEN_SKEW_SEC < Date.now() / 1000
}

export function getCurrentUser() {
  const token = localStorage.getItem('accessToken');
  if (token) {
    const payload = decodeJWT(token);
    if (payload && !isTokenExpired(token)) return enrichUser(mergeChurchContext(payload));
  }
  return null;
}

// Attempt a silent token refresh using the stored refreshToken.
// Returns the new enriched user on success, null on failure.
export async function refreshSession(): Promise<ReturnType<typeof enrichUser> | null> {
  const refreshToken = localStorage.getItem('refreshToken')
  if (!refreshToken) return null
  try {
    const res = await fetch(`${authApiUrl()}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (!data?.tokens?.accessToken) return null
    localStorage.setItem('accessToken', data.tokens.accessToken)
    if (data.tokens.refreshToken) {
      localStorage.setItem('refreshToken', data.tokens.refreshToken)
    }
    const payload = decodeJWT(data.tokens.accessToken)
    if (!payload) return null
    const { id, ...userFields } = data.user ?? {}
    // Persist church refs from the refresh response so getCurrentUser() can use them.
    persistChurchContext(userFields)
    const mergedRoles = mergeRoleLists(payload?.roles, userFields?.roles)
    const user = enrichUser({ ...mergeChurchContext(payload), ...userFields, roles: mergedRoles, userId: payload.userId ?? id })
    import('./graphProfileSync').then(({ syncGraphProfileForUserBackground }) => {
      syncGraphProfileForUserBackground(user, { force: true })
    })
    return user
  } catch {
    return null
  }
}

/** Check the superadmins Supabase table for this email via a security-definer
 * RPC — the anon role has no direct SELECT on the table. */
async function checkSuperAdminTable(email: string): Promise<boolean> {
  if (!email) return false
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .rpc('is_super_admin', { p_email: email.toLowerCase().trim() })
  if (error) throw error
  return !!data
}

/** Check the superviewers Supabase table — view-only equivalent of superAdmin. */
async function checkSuperViewerTable(email: string): Promise<boolean> {
  if (!email) return false
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .rpc('is_super_viewer', { p_email: email.toLowerCase().trim() })
  if (error) throw error
  return !!data
}

export function enrichUser(payload) {
  const roles = mergeRoleLists(payload?.roles)
  // isSuperAdmin can come from the JWT role OR from the localStorage override
  // (set by loginWithCredentials after a Supabase table check).
  const localOverride = localStorage.getItem('superAdminOverride') === '1'
  const superAdmin = roles.includes('superAdmin') || localOverride
  const superViewer = !superAdmin && localStorage.getItem('superViewerOverride') === '1'
  const level = getLevelFromRoles(roles);
  const unitName =
    payload.bacenta?.name ||
    payload.governorship?.name ||
    payload.council?.name ||
    payload.stream?.name ||
    payload.campus?.name ||
    payload.oversight?.name ||
    payload.denomination?.name || '';
  const churchContexts = buildChurchContexts(payload)
  const activeChurch = churchContexts[0] || null
  const title = localStorage.getItem('memberTitle') || payload.title || undefined
  return {
    ...payload,
    roles,
    title,
    level: activeChurch?.level || level,
    unitName: activeChurch?.name || unitName,
    isAdmin: superAdmin || superViewer || isAdmin(roles),
    isSuperAdmin: superAdmin,
    isSuperViewer: superViewer,
    churchContexts,
    activeChurch,
  }
}

/** Returns "Title FirstName LastName" — any missing parts are omitted. */
export function formatName(user: { title?: string; firstName?: string; lastName?: string } | null | undefined): string {
  return [user?.title, user?.firstName, user?.lastName].filter(Boolean).join(' ')
}

export function canCreateMeetings(user: any): boolean {
  if (!user) return false
  if (user.isSuperViewer) return false
  if (user.isSuperAdmin) return true
  const roles = mergeRoleLists(user.roles)
  return roles.some((role) => /^admin(Governorship|Council|Stream|Campus|Oversight|Denomination)$/.test(role))
    || roles.some((role) => /^leader(Governorship|Council|Stream|Campus|Oversight|Denomination)$/.test(role))
}

export async function fetchLeadChurchesByEmail(email, accessToken) {
  if (!email) throw new Error('Email is required to load church contexts')
  if (!accessToken) throw new Error('Access token is required to load church contexts')

  const response = await fetch(leadChurchesUrl(), {
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
  // Start both privilege checks immediately — in parallel with the Lambda login fetch.
  // RPCs (~150-300ms) typically resolve before the Lambda (~500-1500ms).
  const saCheckPromise = checkSuperAdminTable(email.toLowerCase().trim()).catch(() => null)
  const svCheckPromise = checkSuperViewerTable(email.toLowerCase().trim()).catch(() => null)

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

  // Persist church refs so getCurrentUser() can fill in IDs not in the JWT.
  persistChurchContext(userFields)

  // Await both checks — likely already resolved (ran concurrently above).
  const [isSA, isSV] = await Promise.all([saCheckPromise, svCheckPromise])
  if (isSA) {
    localStorage.setItem('superAdminOverride', '1')
    localStorage.removeItem('superViewerOverride')
  } else if (isSV) {
    localStorage.setItem('superViewerOverride', '1')
    localStorage.removeItem('superAdminOverride')
  } else {
    localStorage.removeItem('superAdminOverride')
    localStorage.removeItem('superViewerOverride')
  }
  // Clear persisted eligibility cache so the new SA/SV status is picked up
  // immediately rather than waiting for the 30-min localStorage TTL to expire.
  try {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('flc:elig:v2:')) toRemove.push(k)
    }
    toRemove.forEach((k) => localStorage.removeItem(k))
  } catch { /* ignore */ }

  const mergedRoles = mergeRoleLists(payload?.roles, userFields?.roles)
  const user = enrichUser({ ...payload, ...userFields, roles: mergedRoles, userId: payload.userId ?? id });

  // Every login: fresh graph probe → member_profiles + churchContext (see graphProfileSync.ts).
  import('./graphProfileSync').then(({ syncGraphProfileForUserBackground }) => {
    syncGraphProfileForUserBackground(user, { force: true })
  })

  return user;
}

export function logout() {
  const uid = decodeJWT(localStorage.getItem('accessToken') || '')?.userId
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('pictureUrl');
  localStorage.removeItem('memberTitle');
  localStorage.removeItem('superAdminOverride');
  localStorage.removeItem('superViewerOverride');
  localStorage.removeItem('churchContext');
  import('./graphProfileSync').then(({ clearGraphProfileSyncMarker }) => {
    clearGraphProfileSyncMarker(uid)
  })
  import('./membersApi').then(({ clearResolveCurrentMemberCache }) => {
    clearResolveCurrentMemberCache()
  })
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
