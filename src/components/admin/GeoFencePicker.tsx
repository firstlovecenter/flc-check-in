import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, LayersControl, Circle, Polygon, Marker, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { loadGoogleMaps } from '../../utils/googleMaps'
import { PRESET_VENUES } from '../../data/venues'
import LocationPreWarmer from '../LocationPreWarmer'
import type { GeofenceInput } from '../../types/app'

function useThemeMode() {
  const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark'
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDark()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

// Fix default marker icons (Leaflet expects them at the same path as the CSS).
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

type LatLngTuple = [number, number]
const DEFAULT_CENTER: LatLngTuple = [5.6037, -0.1870] // Accra
const DEFAULT_ZOOM = 16
const FENCE_BLUE = '#4F7FFF'
const ACCURACY_TEAL = '#3DBB9A'

interface Props {
  value: GeofenceInput | null | undefined
  onChange?: (next: GeofenceInput) => void
}

/** Output: { type: 'circle', centerLat, centerLng, radiusM }
 *       OR { type: 'polygon', polygon: [[lat,lng], ...] } */
export default function GeoFencePicker({ value, onChange }: Props) {
  const isDark = useThemeMode()
  const [mode, setMode] = useState<'circle' | 'polygon'>(value?.type || 'circle')
  const [center, setCenter] = useState<LatLngTuple>(
    value?.type === 'circle' ? [value.centerLat, value.centerLng] : DEFAULT_CENTER,
  )
  const [radius, setRadius] = useState<number>(value?.type === 'circle' ? (value.radiusM ?? 50) : 50)
  const [polygon, setPolygon] = useState<LatLngTuple[]>(
    value?.type === 'polygon' ? value.polygon : [],
  )
  const [searchQuery, setSearchQuery] = useState('')
  type SearchResult = { placeId?: string; primary: string; secondary?: string; lat?: string; lon?: string }
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  // Google Places billing session token — pairs Autocomplete + Place Details
  // calls into one billing session (~$0.017) rather than two separate charges.
  const placesSessionRef = useRef<any>(null)
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(
    (() => {
      if (!value) return null
      if (value.type === 'circle') {
        return PRESET_VENUES.find(
          (v) => v.type === 'circle' && v.lat === value.centerLat && v.lng === value.centerLng,
        )?.id ?? null
      }
      if (value.type === 'polygon') {
        // Match by polygon equality (same vertex count + same coords in order).
        const samePolygon = (a: [number, number][], b: [number, number][]) =>
          a.length === b.length && a.every(([la, lo], i) => la === b[i][0] && lo === b[i][1])
        return PRESET_VENUES.find(
          (v) => v.type === 'polygon' && samePolygon(v.polygon, value.polygon),
        )?.id ?? null
      }
      return null
    })(),
  )

  // Push value upward whenever any input changes.
  useEffect(() => {
    if (mode === 'circle') {
      onChange?.({ type: 'circle', centerLat: center[0], centerLng: center[1], radiusM: Math.round(radius) })
    } else {
      onChange?.({ type: 'polygon', polygon })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, center[0], center[1], radius, polygon])

  // Debounced place search.
  //   - Google Places Autocomplete when VITE_GOOGLE_MAPS_API_KEY is set
  //     (best Ghana coverage — indexes churches, businesses, fuzzy matching).
  //   - Falls back to Nominatim (free OSM) when no key configured.
  useEffect(() => {
    const q = searchQuery.trim()
    if (q.length < 3) { setSearchResults([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const hasGoogleKey = !!(import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY
        if (hasGoogleKey) {
          const g = await loadGoogleMaps()
          if (!placesSessionRef.current) {
            placesSessionRef.current = new g.maps.places.AutocompleteSessionToken()
          }
          const service = new g.maps.places.AutocompleteService()
          const predictions: any[] = await new Promise((resolve) => {
            service.getPlacePredictions(
              { input: q, sessionToken: placesSessionRef.current, language: 'en', region: 'gh' },
              (preds: any[] | null, status: string) => resolve(status === 'OK' && preds ? preds : []),
            )
          })
          setSearchResults(
            predictions.slice(0, 8).map((p) => ({
              placeId: p.place_id,
              primary: p.structured_formatting?.main_text || p.description,
              secondary: p.structured_formatting?.secondary_text || '',
            })),
          )
        } else {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&countrycodes=gh`,
            { headers: { 'Accept-Language': 'en' } },
          )
          const data = await res.json()
          const list = Array.isArray(data) && data.length > 0
            ? data
            : await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1`,
                { headers: { 'Accept-Language': 'en' } },
              ).then((r) => r.json())
          setSearchResults(
            (Array.isArray(list) ? list : []).map((r: any) => {
              const parts = (r.display_name || '').split(',').map((s: string) => s.trim())
              return {
                primary: parts[0] || r.display_name,
                secondary: parts.slice(1, 4).join(', '),
                lat: String(r.lat),
                lon: String(r.lon),
              }
            }),
          )
        }
      } catch (err) {
        console.error('[GeoFencePicker] search error:', err)
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const [gpsBusy, setGpsBusy] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [gpsFix, setGpsFix] = useState<{ lat: number; lng: number; accuracy: number } | null>(null)

  async function snapToMyLocation() {
    setGpsError(null); setGpsBusy(true)
    try {
      const pos = await new Promise<{ lat: number; lng: number; accuracy: number }>((resolve, reject) => {
        if (!('geolocation' in navigator)) { reject(new Error('Geolocation not supported')); return }
        const timer = setTimeout(() => reject(new Error('Location request timed out after 25s')), 25000)
        const onError = (e: GeolocationPositionError) => {
          clearTimeout(timer)
          const reason =
            e.code === 1 ? 'Permission denied — allow location for this site.' :
            e.code === 2 ? 'Position unavailable — no GPS signal.' :
            e.code === 3 ? 'Location request timed out.' :
            (e.message || 'Unknown geolocation error')
          reject(new Error(reason))
        }
        const onSuccess = (p: GeolocationPosition) => {
          clearTimeout(timer)
          resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? 0 })
        }
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (e) => {
            if (e.code === 3 || e.code === 2) {
              navigator.geolocation.getCurrentPosition(onSuccess, onError, { enableHighAccuracy: false, maximumAge: 0, timeout: 15000 })
            } else { onError(e) }
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
        )
      })
      setCenter([pos.lat, pos.lng]); setGpsFix(pos); setSelectedVenueId(null)
    } catch (err: any) {
      console.error('[GeoFencePicker] location error:', err)
      setGpsError(err.message || 'Could not get location')
    } finally { setGpsBusy(false) }
  }

  async function selectResult(r: SearchResult) {
    setSearchResults([]); setSearchQuery(''); setSelectedVenueId(null); setGpsFix(null)
    if (r.lat && r.lon) { setCenter([parseFloat(r.lat), parseFloat(r.lon)]); return }
    if (!r.placeId) return
    try {
      const g = await loadGoogleMaps()
      // PlacesService needs an attached DOM node — invisible div is fine.
      const host = document.createElement('div')
      const service = new g.maps.places.PlacesService(host)
      service.getDetails(
        { placeId: r.placeId, fields: ['geometry'], sessionToken: placesSessionRef.current },
        (place: any, status: string) => {
          if (status === 'OK' && place?.geometry?.location) {
            setCenter([place.geometry.location.lat(), place.geometry.location.lng()])
          }
          // Reset the session — next search starts a new billing session.
          placesSessionRef.current = null
        },
      )
    } catch (err) {
      console.error('[GeoFencePicker] place details error:', err)
    }
  }

  return (
    <div className='flex flex-col gap-3'>
      {/* Warm GPS — admin will likely click "Use my location" momentarily.
          Scoped to the picker so it only fires on event create/edit, not on
          every authed page. */}
      <LocationPreWarmer />
      <div style={{ position: 'relative' }}>
        <input
          type='text'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={searching ? 'Searching…' : '🔍 Search for a venue, address, or place name'}
          className='input-field'
          autoComplete='off'
          style={{ fontSize: 15 }}
        />
        {searchResults.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 1000,
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-btn)',
              maxHeight: 320,
              overflowY: 'auto',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            {searchResults.map((r, i) => (
              <button
                key={r.placeId || `${r.lat},${r.lon}` || i}
                type='button'
                onClick={() => selectResult(r)}
                className='w-full text-left px-3 py-2.5 cursor-pointer'
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: i < searchResults.length - 1 ? '1px solid var(--border)' : 'none',
                  color: 'var(--text)',
                  fontFamily: 'var(--sans)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div className='text-sm font-semibold truncate'>{r.primary}</div>
                {r.secondary && (
                  <div className='text-xs truncate' style={{ color: 'var(--muted)', marginTop: 2 }}>{r.secondary}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className='flex items-center gap-2 flex-wrap'>
        <div
          className='flex gap-1 p-1'
          style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)' }}
        >
          <button
            type='button'
            onClick={() => setMode('circle')}
            className='px-3 py-1.5 text-xs font-semibold cursor-pointer'
            style={{
              background: mode === 'circle' ? 'var(--cta-bg)' : 'transparent',
              color: mode === 'circle' ? 'var(--cta-text)' : 'var(--muted)',
              border: 'none',
              borderRadius: 'var(--radius-pill)',
            }}
          >Circle</button>
          <button
            type='button'
            onClick={() => setMode('polygon')}
            className='px-3 py-1.5 text-xs font-semibold cursor-pointer'
            style={{
              background: mode === 'polygon' ? 'var(--cta-bg)' : 'transparent',
              color: mode === 'polygon' ? 'var(--cta-text)' : 'var(--muted)',
              border: 'none',
              borderRadius: 'var(--radius-pill)',
            }}
          >Polygon</button>
        </div>
        <button
          type='button'
          onClick={snapToMyLocation}
          disabled={gpsBusy}
          className='ml-auto px-3 py-1.5 text-xs cursor-pointer'
          style={{
            background: 'transparent',
            color: 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-pill)',
            opacity: gpsBusy ? 0.5 : 1,
          }}
          title='Use device location (may be inaccurate on desktop)'
        >{gpsBusy ? '📍 Locating…' : '📍 Use my location'}</button>
      </div>
      {gpsError && (
        <p className='text-xs' style={{ color: 'var(--coral)', margin: 0 }}>{gpsError}</p>
      )}

      {PRESET_VENUES.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          <span className='text-xs self-center mr-1' style={{ color: 'var(--muted)' }}>Quick venues:</span>
          {PRESET_VENUES.map((v) => {
            const isSelected = selectedVenueId === v.id
            const onClick = () => {
              setGpsFix(null)
              setSelectedVenueId(v.id)
              if (v.type === 'circle') {
                setMode('circle')
                setCenter([v.lat, v.lng])
                setRadius(v.defaultRadiusM)
              } else {
                setMode('polygon')
                setPolygon(v.polygon)
                // Re-centre the map on the polygon's centroid so the new shape
                // is in view. Average of vertices is a good enough centroid for
                // the bounding-box sized fences we deal with here.
                if (v.polygon.length > 0) {
                  const sum = v.polygon.reduce(
                    (acc, [la, lo]) => [acc[0] + la, acc[1] + lo],
                    [0, 0],
                  )
                  setCenter([sum[0] / v.polygon.length, sum[1] / v.polygon.length])
                }
              }
            }
            return (
              <button
                key={v.id}
                type='button'
                onClick={onClick}
                className='px-3 py-1.5 text-xs font-semibold cursor-pointer'
                style={{
                  background: isSelected ? 'var(--cta-bg)' : 'var(--bg2)',
                  color: isSelected ? 'var(--cta-text)' : 'var(--muted)',
                  border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-pill)',
                }}
                title={v.type === 'polygon' ? 'Polygon boundary' : 'Circle radius'}
              >
                <span style={{ marginRight: 4, opacity: 0.7 }}>
                  {v.type === 'polygon' ? '⬡' : '●'}
                </span>
                {v.name}
              </button>
            )
          })}
        </div>
      )}

      <div
        className='overflow-hidden'
        style={{ height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
      >
        <MapContainer center={center} zoom={DEFAULT_ZOOM} scrollWheelZoom={true} style={{ height: '100%', width: '100%' }}>
          <LayersControl position='topright'>
            <LayersControl.BaseLayer checked name='Street'>
              <TileLayer
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url={isDark
                  ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
                  : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'}
                subdomains='abcd'
                maxZoom={19}
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name='Satellite'>
              <TileLayer
                attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
                url='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                maxZoom={19}
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name='Hybrid'>
              <TileLayer
                attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
                url='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                maxZoom={19}
              />
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url='https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png'
                subdomains='abcd'
                maxZoom={19}
              />
            </LayersControl.BaseLayer>
          </LayersControl>
          <RecenterOnChange center={center} />
          {gpsFix && gpsFix.accuracy > 0 && (
            <Circle
              center={[gpsFix.lat, gpsFix.lng]}
              radius={gpsFix.accuracy}
              pathOptions={{ color: ACCURACY_TEAL, weight: 1, fillColor: ACCURACY_TEAL, fillOpacity: 0.08, dashArray: '4 4' }}
            />
          )}
          {mode === 'circle' && (
            <CircleEditor
              center={center}
              radius={radius}
              onMove={(ll) => { setCenter(ll); setSelectedVenueId(null); setGpsFix(null) }}
            />
          )}
          {mode === 'polygon' && (
            <PolygonEditor polygon={polygon} onPolygonChange={setPolygon} />
          )}
        </MapContainer>
      </div>

      {gpsFix && (
        <p className='text-xs' style={{ color: 'var(--muted)', margin: 0 }}>
          📡 GPS accuracy: ±{Math.round(gpsFix.accuracy)} m
          {gpsFix.accuracy > 100 && ' — drag the marker or search to refine.'}
        </p>
      )}

      {mode === 'circle' && (
        <div className='flex items-center gap-3'>
          <label className='text-xs' style={{ color: 'var(--muted)' }}>Radius</label>
          <input
            type='range' min={10} max={500} step={5}
            value={radius} onChange={(e) => { setRadius(Number(e.target.value)); setSelectedVenueId(null) }}
            className='flex-1'
          />
          <span className='text-xs font-mono' style={{ color: 'var(--text)', minWidth: 50, textAlign: 'right' }}>{radius} m</span>
        </div>
      )}

      {mode === 'polygon' && (
        <div className='flex items-center justify-between'>
          <p className='text-xs' style={{ color: 'var(--muted)' }}>
            Tap on the map to add vertices ({polygon.length} so far). Need 3+.
          </p>
          {polygon.length > 0 && (
            <button
              type='button'
              onClick={() => setPolygon([])}
              className='text-xs underline'
              style={{ color: 'var(--coral)' }}
            >Clear</button>
          )}
        </div>
      )}
    </div>
  )
}

function RecenterOnChange({ center }: { center: LatLngTuple }) {
  const map = useMap()
  useEffect(() => {
    map.setView(center, map.getZoom())
  }, [center[0], center[1]]) // eslint-disable-line
  return null
}

function CircleEditor({ center, radius, onMove }: {
  center: LatLngTuple
  radius: number
  onMove: (next: LatLngTuple) => void
}) {
  const markerRef = useRef<any>(null)
  return (
    <>
      <Circle
        center={center}
        radius={radius}
        pathOptions={{ color: FENCE_BLUE, fillColor: FENCE_BLUE, fillOpacity: 0.15 }}
      />
      <Marker
        position={center}
        draggable={true}
        ref={markerRef}
        eventHandlers={{
          dragend: () => {
            const m = markerRef.current
            if (m) {
              const ll = m.getLatLng()
              onMove([ll.lat, ll.lng])
            }
          },
        }}
      />
    </>
  )
}

function PolygonEditor({ polygon, onPolygonChange }: {
  polygon: LatLngTuple[]
  onPolygonChange: (next: LatLngTuple[]) => void
}) {
  useMapEvents({
    click(e) {
      onPolygonChange([...polygon, [e.latlng.lat, e.latlng.lng]])
    },
  })
  if (polygon.length === 0) return null
  return (
    <Polygon
      positions={polygon}
      pathOptions={{ color: FENCE_BLUE, fillColor: FENCE_BLUE, fillOpacity: 0.15 }}
    />
  )
}
