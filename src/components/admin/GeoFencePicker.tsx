import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Circle, Polygon, Marker, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getCurrentPosition } from '../../utils/geo'
import { PRESET_VENUES } from '../../data/venues'
import type { GeofenceInput } from '../../types/app'

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
  const [mode, setMode] = useState<'circle' | 'polygon'>(value?.type || 'circle')
  const [center, setCenter] = useState<LatLngTuple>(
    value?.type === 'circle' ? [value.centerLat, value.centerLng] : DEFAULT_CENTER
  )
  const [radius, setRadius] = useState<number>(value?.type === 'circle' ? (value.radiusM ?? 50) : 50)
  const [polygon, setPolygon] = useState<LatLngTuple[]>(
    value?.type === 'polygon' ? value.polygon : []
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ display_name: string; lat: string; lon: string }>>([])
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
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
          { headers: { 'Accept-Language': 'en' } }
        )
        setSearchResults(await res.json())
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [searchQuery])

  async function snapToMyLocation() {
    try {
      const pos = await getCurrentPosition()
      setCenter([pos.lat, pos.lng])
      setSelectedVenueId(null)
    } catch (err: any) {
      alert('Could not get GPS: ' + err.message)
    }
  }

  function selectResult(r: { lat: string; lon: string }) {
    setCenter([parseFloat(r.lat), parseFloat(r.lon)])
    setSelectedVenueId(null)
    setSearchQuery('')
    setSearchResults([])
  }

  return (
    <div className='flex flex-col gap-3'>
      <div
        className='flex gap-1 p-1'
        style={{ background: 'var(--bg2)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)', alignSelf: 'flex-start' }}
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
        <button
          type='button'
          onClick={snapToMyLocation}
          className='ml-auto px-3 py-1.5 text-xs cursor-pointer'
          style={{ background: 'transparent', color: 'var(--muted)', border: 'none', borderRadius: 'var(--radius-pill)' }}
        >📍 My Location</button>
      </div>

      {/* Preset venues */}
      <div className='flex flex-wrap gap-1.5'>
        {PRESET_VENUES.map((v) => {
          const isSelected = selectedVenueId === v.id
          return (
            <button
              key={v.id}
              type='button'
              onClick={() => { setCenter([v.lat, v.lng]); setRadius(v.defaultRadiusM); setSelectedVenueId(v.id) }}
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

      {/* Place search — Nominatim / OpenStreetMap, no API key needed */}
      <div style={{ position: 'relative' }}>
        <input
          type='text'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={searching ? 'Searching…' : '🔍 Search for a place…'}
          className='input-field'
          autoComplete='off'
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
              maxHeight: 220,
              overflowY: 'auto',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            {searchResults.map((r, i) => (
              <button
                key={i}
                type='button'
                onClick={() => selectResult(r)}
                className='w-full text-left px-3 py-2.5 text-sm cursor-pointer'
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
                {r.display_name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className='overflow-hidden'
        style={{ height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius-btn)' }}
      >
        <MapContainer center={center} zoom={DEFAULT_ZOOM} scrollWheelZoom={true} style={{ height: '100%', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url='https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            subdomains='abcd'
            maxZoom={19}
          />
          <RecenterOnChange center={center} />
          {mode === 'circle' && (
          <CircleEditor center={center} radius={radius} onMove={(ll) => { setCenter(ll); setSelectedVenueId(null) }} />
          )}
          {mode === 'polygon' && (
            <PolygonEditor polygon={polygon} onPolygonChange={setPolygon} />
          )}
        </MapContainer>
      </div>

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
