// Shared application types. Hand-written; mirrors the Supabase columns and
// the shape of user objects we build via enrichUser().
//
// Supabase row types can also be generated via `npm run codegen:supabase`
// (requires the Supabase CLI). Those land in `src/types/supabase.ts` and
// can replace the hand-typed CheckinEventRow etc. when ready.

// ─── FLC scope hierarchy ────────────────────────────────────────────────────
export const SCOPE_LEVELS = [
  'bacenta',
  'governorship',
  'council',
  'stream',
  'campus',
  'oversight',
  'denomination',
] as const
export type ScopeLevel = typeof SCOPE_LEVELS[number]

export type LeaderRole =
  | 'leaderBacenta'
  | 'leaderGovernorship'
  | 'leaderCouncil'
  | 'leaderStream'
  | 'leaderCampus'
  | 'leaderOversight'
  | 'leaderDenomination'

// ─── App user (after enrichUser) ────────────────────────────────────────────
export interface ChurchRef {
  id: string
  name: string
  level?: ScopeLevel
  source?: string
}

export interface AppUser {
  userId: string
  email?: string
  firstName?: string
  lastName?: string
  roles: string[]
  level?: ScopeLevel
  unitName?: string
  isAdmin: boolean
  churchContexts?: ChurchRef[]
  activeChurch?: ChurchRef | null
  graphMemberId?: string
  // raw fields from JWT/auth response — keep as any since shape varies.
  bacenta?: { id?: string; name?: string }
  governorship?: { id?: string; name?: string }
  council?: { id?: string; name?: string }
  stream?: { id?: string; name?: string }
  campus?: { id?: string; name?: string }
  oversight?: { id?: string; name?: string }
  denomination?: { id?: string; name?: string }
  [extra: string]: any
}

// ─── Supabase rows ──────────────────────────────────────────────────────────
export type EventStatus = 'ACTIVE' | 'PAUSED' | 'ENDED'
export type CheckInMethod = 'QR' | 'PIN' | 'MANUAL' | 'FACE_ID'
export type GeofenceType = 'circle' | 'polygon'

export interface CheckinEventRow {
  id: string
  name: string
  event_type: string | null
  status: EventStatus
  scope_level: ScopeLevel
  scope_church_id: string
  scope_church_name: string
  starts_at: string
  ends_at: string
  grace_period_min: number
  auto_checkout_min: number
  allowed_check_in_methods: CheckInMethod[]
  allowed_roles: string[]
  geofence_type: GeofenceType
  geofence_center_lat: number | null
  geofence_center_lng: number | null
  geofence_radius_m: number | null
  geofence_polygon: Array<[number, number]> | null
  pin_hash: string | null
  pin_set_at: string | null
  qr_secret: string  // bytea returns as '\x...' hex string from PostgREST
  qr_secret_hex: string // normalized by mapEventRow (without the \x prefix)
  created_by_id: string
  created_by_name: string | null
  created_at: string
}

export interface CheckinRecordRow {
  id: string
  event_id: string
  member_id: string
  member_name: string | null
  member_role: string | null
  member_unit_name: string | null
  checked_in_at: string
  checked_out_at: string | null
  auto_checked_out: boolean
  is_late: boolean
  method: CheckInMethod
  geo_verified: boolean
  check_in_lat: number | null
  check_in_lng: number | null
  device_fingerprint: string
  manual_reason: string | null
  verified_by: string | null
}

export interface MemberProfileRow {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  roles: string[]
  bacenta_id: string | null;       bacenta_name: string | null
  governorship_id: string | null;  governorship_name: string | null
  council_id: string | null;       council_name: string | null
  stream_id: string | null;        stream_name: string | null
  campus_id: string | null;        campus_name: string | null
  oversight_id: string | null;     oversight_name: string | null
  denomination_id: string | null;  denomination_name: string | null
  updated_at?: string
}

// ─── Geofence (client form before persisting) ──────────────────────────────
export type GeofenceInput =
  | { type: 'circle';  centerLat: number; centerLng: number; radiusM: number }
  | { type: 'polygon'; polygon: Array<[number, number]> }

// ─── Lat/lng for geo helpers ───────────────────────────────────────────────
export interface LatLng { lat: number; lng: number; accuracy?: number }

// ─── Viewer capabilities ───────────────────────────────────────────────────
export interface ViewerCapabilities {
  canManage: boolean
  canCheckIn: boolean
  viewerScope: ChurchRef | null
}
