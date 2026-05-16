// Tests for geofence math.
//
// Why these matter: pointInCircle and pointInPolygon are the *client-side*
// pre-flight check before a user submits a check-in. A bug here gives users
// false "you're not at the venue" errors or, worse, lets out-of-fence
// check-ins through. The server-side equivalents are mirrored in Postgres.

import { describe, it, expect } from 'vitest'
import { haversineMeters, pointInCircle, pointInPolygon, pointInGeofence } from './geo'

describe('haversineMeters', () => {
  it('zero distance for identical points', () => {
    expect(haversineMeters(5.6037, -0.1870, 5.6037, -0.1870)).toBe(0)
  })

  it('symmetric — distance(a,b) == distance(b,a)', () => {
    const ab = haversineMeters(5.6, -0.18, 5.61, -0.19)
    const ba = haversineMeters(5.61, -0.19, 5.6, -0.18)
    expect(ab).toBeCloseTo(ba, 6)
  })

  it('one degree of latitude ≈ 111 km', () => {
    // From the equator at the same longitude.
    const m = haversineMeters(0, 0, 1, 0)
    // Allow 1% tolerance for the spherical-vs-ellipsoid approximation.
    expect(m).toBeGreaterThan(110_000)
    expect(m).toBeLessThan(112_000)
  })

  it('handles negative coordinates (Accra hemisphere)', () => {
    // Two well-known points in Accra; sanity-check it returns a positive
    // metric value (not NaN, not negative).
    const m = haversineMeters(5.6037, -0.1870, 5.6559, -0.1670)
    expect(m).toBeGreaterThan(0)
    expect(Number.isFinite(m)).toBe(true)
  })
})

describe('pointInCircle', () => {
  const centre = { centerLat: 5.6037, centerLng: -0.1870, radiusM: 50 }

  it('returns true at the exact centre', () => {
    expect(pointInCircle({ lat: 5.6037, lng: -0.1870 }, centre)).toBe(true)
  })

  it('returns true just inside the radius', () => {
    // ~10 m north of centre — well inside 50 m.
    expect(pointInCircle({ lat: 5.6037 + 0.00009, lng: -0.1870 }, centre)).toBe(true)
  })

  it('returns false outside the radius', () => {
    // ~500 m north of centre.
    expect(pointInCircle({ lat: 5.6037 + 0.0045, lng: -0.1870 }, centre)).toBe(false)
  })

  it('treats the boundary as inside (inclusive ≤)', () => {
    // Approx 1° of latitude ≈ 111km, so 0.00045° ≈ 50 m. Boundary check.
    // We assert that points clearly inside are inside; the exact boundary
    // depends on float precision, but the implementation uses ≤ so equal
    // distances should be inside.
    expect(pointInCircle({ lat: 5.6037, lng: -0.1870 }, { ...centre, radiusM: 0 })).toBe(true)
  })
})

describe('pointInPolygon', () => {
  // Small square around Accra reference point. Vertex order doesn't matter
  // for the ray-casting algorithm.
  const square: Array<[number, number]> = [
    [5.60, -0.19],
    [5.60, -0.18],
    [5.61, -0.18],
    [5.61, -0.19],
  ]

  it('returns true for a point clearly inside', () => {
    expect(pointInPolygon({ lat: 5.605, lng: -0.185 }, square)).toBe(true)
  })

  it('returns false for a point clearly outside', () => {
    expect(pointInPolygon({ lat: 5.62, lng: -0.185 }, square)).toBe(false)
    expect(pointInPolygon({ lat: 5.605, lng: -0.20 }, square)).toBe(false)
  })

  it('returns false for empty/invalid vertex lists', () => {
    expect(pointInPolygon({ lat: 5.605, lng: -0.185 }, [])).toBe(false)
    expect(pointInPolygon({ lat: 5.605, lng: -0.185 }, null)).toBe(false)
    expect(pointInPolygon({ lat: 5.605, lng: -0.185 }, undefined)).toBe(false)
    // Two vertices isn't a polygon.
    expect(pointInPolygon({ lat: 5.605, lng: -0.185 }, [[5.60, -0.19], [5.60, -0.18]])).toBe(false)
  })

  it('handles concave (L-shaped) polygons correctly', () => {
    // L-shape: removes the upper-right corner of the square.
    const lShape: Array<[number, number]> = [
      [5.60, -0.19],
      [5.60, -0.18],
      [5.605, -0.18],
      [5.605, -0.185],
      [5.61, -0.185],
      [5.61, -0.19],
    ]
    // Inside the L (lower-left arm)
    expect(pointInPolygon({ lat: 5.602, lng: -0.187 }, lShape)).toBe(true)
    // In the notch (would-be upper-right) → outside
    expect(pointInPolygon({ lat: 5.608, lng: -0.182 }, lShape)).toBe(false)
  })

  it('handles polygons spanning negative longitudes (West Africa)', () => {
    // FLC Accra polygon (subset of the real venue boundary).
    const flcAccra: Array<[number, number]> = [
      [5.656660, -0.168375],
      [5.655853, -0.168329],
      [5.655866, -0.165875],
      [5.656570, -0.166074],
    ]
    // Point inside
    expect(pointInPolygon({ lat: 5.65620, lng: -0.16720 }, flcAccra)).toBe(true)
    // Point far away
    expect(pointInPolygon({ lat: 5.7000, lng: -0.1500 }, flcAccra)).toBe(false)
  })
})

describe('pointInGeofence — discriminated event shape', () => {
  it('returns false for null event', () => {
    expect(pointInGeofence({ lat: 5.6, lng: -0.18 }, null)).toBe(false)
  })

  it('dispatches to circle math for geofence_type=circle', () => {
    const evt = {
      geofence_type: 'circle' as const,
      geofence_center_lat: 5.6037,
      geofence_center_lng: -0.1870,
      geofence_radius_m: 50,
    }
    expect(pointInGeofence({ lat: 5.6037, lng: -0.1870 }, evt)).toBe(true)
    expect(pointInGeofence({ lat: 5.62, lng: -0.1870 }, evt)).toBe(false)
  })

  it('dispatches to polygon math for geofence_type=polygon', () => {
    const evt = {
      geofence_type: 'polygon' as const,
      geofence_polygon: [
        [5.60, -0.19],
        [5.60, -0.18],
        [5.61, -0.18],
        [5.61, -0.19],
      ] as Array<[number, number]>,
    }
    expect(pointInGeofence({ lat: 5.605, lng: -0.185 }, evt)).toBe(true)
    expect(pointInGeofence({ lat: 5.62, lng: -0.185 }, evt)).toBe(false)
  })

  it('returns false for an event with no geofence_type', () => {
    expect(pointInGeofence({ lat: 5.605, lng: -0.185 }, {} as any)).toBe(false)
  })
})
