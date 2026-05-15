import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, LayersControl, Circle, Polygon, Marker, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getCurrentPosition } from '../../utils/geo'
import { PRESET_VENUES } from '../../data/venues'
import type { GeofenceInput } from '../../types/app'

function useThemeMode() {
  const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light'
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
    value?.type === 'circle' ? [value.centerLat, value.centerLng] : DEFAULT_CENTER
  )
  const [radius, setRadius] = useState<number>(value?.type === 'circle' ? (value.radiusM ?? 50) : 50)
  const [polygon, setPolygon] = useState<LatLngTuple[]>(
    value?.type === 'polygon' ? value.polygon : []
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ display_name: string; lat: string; lon: string; address?: Record<string, string> }>>([])
  const [searching, setSearching] = useState(false)
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(
    // Pre-select if the initial value matches a preset
    (() => {
      if (value?.type !== 'circle') return null
      return PRESET_VENUES.find(
        (v) => v.lat === value.centerLat && v.lng === value.centerLng
      )?.id ?? null
    })()
  )

  // Push value upward whenever any input changes
  useEffect(() => {
    if (mode === 'circle') {
      onChange?.({ type: 'circle', centerLat: center[0], centerLng: center[1], radiusM: Math.round(radius) })
    } else {
      onChange?.({ type: 'polygon', polygon })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, center[0], center[1], radius, polygon])

  // Debounced Nominatim place search (free OSM geocoding, no API key required)
  useEffect(() => {
    const q = searchQuery.trim()
    if (q.length < 3) { setSearchResults([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        // countrycodes=gh biases results toward Ghana (most FLC venues are
        // there) without excluding others — international hits still rank but
        // local matches surface first. addressdetails=1 gives us the city/
        // region so the dropdown can show a useful second line.
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&countrycodes=gh`,
          { headers: { 'Accept-Language': 'en' } }
        )
        const data = await res.json()
        // If country-biased search came back empty, retry worldwide so admins
        // creating events in other regions aren't stuck.
        if (Array.isArray(data) && data.length === 0) {
          const fallback = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1`,
            { headers: { 'Accept-Language': 'en' } }
          )
          setSearchResults(await fallback.json())
        } else {
          setSearchResults(data)
        }
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const [gpsBusy, setGpsBusy] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  // Accuracy ring data from the last "My Location" call. Cleared when the user
  // picks a preset, drags the marker, or searches — those are intentional moves.
  const [gpsFix, setGpsFix] = useState<{ lat: number; lng: number; accuracy: number } | null>(null)
  async function snapToMyLocation() {
    setGpsError(null)
    setGpsBusy(true)
    try {
      // Bypass the geo helper cache here — when the user explicitly clicks
      // "My Location" they want a fresh fix, not a 30s-old one. Call the
      // browser API directly.
      const pos = await new Promise<{ lat: number; lng: number; accuracy: number }>((resolve, reject) => {
        if (!('geolocation' in navigator)) {
          reject(new Error('Geolocation not supported in this browser'))
          return
        }
        const timer = setTimeout(
          () => reject(new Error('Location request timed out after 25s. Check that you allowed location access for this site.')),
          25000,
        )
        const onError = (e: GeolocationPositionError) => {
          clearTimeout(timer)
          const reason =
            e.code === 1 ? 'Permission denied — allow location for this site in your browser.' :
            e.code === 2 ? 'Position unavailable — no GPS signal or network fallback.' :
            e.code === 3 ? 'Location request timed out.' :
            (e.message || 'Unknown geolocation error')
          reject(new Error(reason))
        }
        const onSuccess = (p: GeolocationPosition) => {
          clearTimeout(timer)
          resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? 0 })
        }
        // First try high-accuracy (GPS). If that fails or times out, fall back
        // to low-accuracy (Wi-Fi/IP) so we at least centre the map roughly right.
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (e) => {
            // High-accuracy failed — retry with coarse location before giving up.
            if (e.code === 3 || e.code === 2) {
              navigator.geolocation.getCurrentPosition(
                onSuccess,
                onError,
                { enableHighAccuracy: false, maximumAge: 0, timeout: 15000 },
              )
            } else {
              onError(e)
            }
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
        )
      })
      setCenter([pos.lat, pos.lng])
      setGpsFix(pos)
      setSelectedVenueId(null)
    } catch (err: any) {
      console.error('[GeoFencePicker] location error:', err)
      setGpsError(err.message || 'Could not get location')
    } finally {
      setGpsBusy(false)
    }
  }

  function selectResult(r: { lat: string; lon: string }) {
    setCenter([parseFloat(r.lat), parseFloat(r.lon)])
    setSelectedVenueId(null)
    setGpsFix(null)
    setSearchQuery('')
    setSearchResults([])
  }

  return (
    <div className='flex flex-col gap-3'>
      {/* Primary: place search — most accurate way to set a venue on desktop.
          Nominatim / OpenStreetMap, no API key needed. */}
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
            {searchResults.map((r, i) => {
              const parts = (r.display_name || '').split(',').map((s) => s.trim())
              const primary = parts[0] || r.display_name
              const secondary = parts.slice(1, 4).join(', ')
              return (
                <button
                  key={i}
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
                  <div className='text-sm font-semibold truncate'>{primary}</div>
                  {secondary && (
                    <div className='text-xs truncate' style={{ color: 'var(--muted)', marginTop: 2 }}>
                      {secondary}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Secondary actions: shape toggle + GPS shortcut. Search is the primary
          way to set a venue; My Location is a desktop fallback that's often
          inaccurate, so it sits as a small secondary button. */}
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

      {/* Preset venues — fastest way to set a known recurring location. */}
      {PRESET_VENUES.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          <span className='text-xs self-center mr-1' style={{ color: 'var(--muted)' }}>Quick venues:</span>
          {PRESET_VENUES.map((v) => {
            const isSelected = selectedVenueId === v.id
            return (
              <button
                key={v.id}
                type='button'
                onClick={() => { setCenter([v.lat, v.lng]); setRadius(v.defaultRadiusM); setSelectedVenueId(v.id); setGpsFix(null) }}
                className='px-3 py-1.5 text-xs font-semibold cursor-pointer'
                style={{
                  background: isSelected ? 'var(--cta-bg)' : 'var(--bg2)',
                  color: isSelected ? 'var(--cta-text)' : 'var(--muted)',
                  border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-pill)',
                }}
              >
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
              pathOptions={{ color: '#3DBB9A', weight: 1, fillColor: '#3DBB9A', fillOpacity: 0.08, dashArray: '4 4' }}
            />
          )}
          {mode === 'circle' && (
          <CircleEditor center={center} radius={radius} onMove={(ll) => { setCenter(ll); setSelectedVenueId(null); setGpsFix(null) }} />
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
      <Circle center={center} radius={radius} pathOptions={{ color: '#4F7FFF', fillColor: '#4F7FFF', fillOpacity: 0.15 }} />
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
    <Polygon positions={polygon} pathOptions={{ color: '#4F7FFF', fillColor: '#4F7FFF', fillOpacity: 0.15 }} />
  )
}
