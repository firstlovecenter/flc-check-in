// Lazy loader for the Google Maps JavaScript API.
//
// We only need the `places` library — Autocomplete + Place Details — to power
// the venue search in GeoFencePicker. The map itself stays Leaflet (Google's
// JS map widget would conflict and double the bundle).
//
// Usage:
//   const google = await loadGoogleMaps()
//   const service = new google.maps.places.AutocompleteService()
//
// The script is loaded at most once per page. Concurrent callers share the
// same Promise so we never inject duplicate <script> tags.

// We don't pull in @types/google.maps because the only Places-API surface
// we use (AutocompleteService, AutocompleteSessionToken, PlacesService,
// getPlacePredictions, getDetails) is small and stable. Loose typing keeps
// the dependency surface minimal.
let _loadPromise: Promise<any> | null = null

export function loadGoogleMaps(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps requires a browser environment'))
  }
  // Already loaded (e.g. by another tab/component on the same page).
  if ((window as any).google?.maps?.places) {
    return Promise.resolve((window as any).google)
  }
  if (_loadPromise) return _loadPromise

  const key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY
  if (!key) {
    return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not set'))
  }

  _loadPromise = new Promise((resolve, reject) => {
    const callbackName = `__gmaps_cb_${Date.now()}`
    ;(window as any)[callbackName] = () => {
      delete (window as any)[callbackName]
      resolve((window as any).google)
    }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&callback=${callbackName}&loading=async`
    script.async = true
    script.defer = true
    script.onerror = () => {
      delete (window as any)[callbackName]
      _loadPromise = null
      reject(new Error('Failed to load Google Maps JS — check your API key, billing, and HTTP-referrer restrictions'))
    }
    document.head.appendChild(script)
  })
  return _loadPromise
}
