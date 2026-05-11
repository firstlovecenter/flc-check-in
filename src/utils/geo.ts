// Geofence + GPS helpers. Mirrors the server-side helpers in
// supabase/checkins_schema.sql so the client can show the same gate before
// firing the network call.

import type { LatLng, CheckinEventRow } from '../types/app'

const EARTH_RADIUS_M = 6371000

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function pointInCircle(
  { lat, lng }: LatLng,
  { centerLat, centerLng, radiusM }: { centerLat: number; centerLng: number; radiusM: number }
): boolean {
  return haversineMeters(lat, lng, centerLat, centerLng) <= radiusM
}

// Polygon as [[lat, lng], ...] — same shape as stored in jsonb.
export function pointInPolygon(
  { lat, lng }: LatLng,
  vertices: Array<[number, number]> | null | undefined
): boolean {
  if (!Array.isArray(vertices) || vertices.length < 3) return false
  let inside = false
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const yi = vertices[i][0]
    const xi = vertices[i][1]
    const yj = vertices[j][0]
    const xj = vertices[j][1]
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function pointInGeofence(point: LatLng, event: Partial<CheckinEventRow> | null | undefined): boolean {
  if (!event) return false
  if (event.geofence_type === 'circle') {
    return pointInCircle(point, {
      centerLat: event.geofence_center_lat as number,
      centerLng: event.geofence_center_lng as number,
      radiusM:   event.geofence_radius_m  as number,
    })
  }
  if (event.geofence_type === 'polygon') {
    return pointInPolygon(point, event.geofence_polygon || [])
  }
  return false
}

interface GpsOpts { timeout?: number; enableHighAccuracy?: boolean }

export function getCurrentPosition(opts: GpsOpts = {}): Promise<LatLng> {
  const { timeout = 15000, enableHighAccuracy = true } = opts
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported in this browser'))
      return
    }
    const toLatLng = (pos: GeolocationPosition): LatLng =>
      ({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toLatLng(pos)),
      (err) => {
        // High-accuracy timed out or unavailable — retry with coarse location.
        // This recovers desktop browsers and weak-GPS environments.
        if (enableHighAccuracy) {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve(toLatLng(pos)),
            (err2) => reject(new Error(err2.message || 'Failed to acquire GPS position')),
            { timeout, enableHighAccuracy: false, maximumAge: 60000 }
          )
        } else {
          reject(new Error(err.message || 'Failed to acquire GPS position'))
        }
      },
      // maximumAge: 30s — use a cached fix if available; avoids cold-start every call
      { timeout, enableHighAccuracy, maximumAge: 30000 }
    )
  })
}

// Returns an unsubscribe function. Calls onPosition with { lat, lng, accuracy }
// throttled to at most once per intervalMs.
// Uses navigator.geolocation.watchPosition internally — the OS keeps GPS warm
// and delivers updates without a cold-start on every tick.
export function watchPositionThrottled(
  onPosition: (pos: LatLng) => void,
  onError?: ((err: Error) => void) | null,
  intervalMs: number = 60000
): () => void {
  if (!('geolocation' in navigator)) {
    onError?.(new Error('Geolocation not supported'))
    return () => {}
  }
  let lastFired = 0
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now()
      if (now - lastFired >= intervalMs) {
        lastFired = now
        onPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
      }
    },
    (err) => onError?.(new Error(err.message || 'GPS watch error')),
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
  )
  return () => navigator.geolocation.clearWatch(watchId)
}
