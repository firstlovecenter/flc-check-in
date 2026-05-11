/** Pre-saved venue coordinates for FLC events.
 *  Used in the GeoFencePicker to snap the map to a known location in one tap. */
export interface PresetVenue {
  id: string
  name: string
  lat: number
  lng: number
  defaultRadiusM: number
}

export const PRESET_VENUES: PresetVenue[] = [
  {
    id: 'flc-accra',
    name: 'First Love Center, Accra',
    lat: 5.6559482,
    lng: -0.1670423,
    defaultRadiusM: 70,
  },
  {
    id: 'anagkazo-great-hall',
    name: 'Anagkazo Great Hall',
    lat: 5.9061191,
    lng: -0.1523899,
    defaultRadiusM: 100,
  },
  {
    id: 'the-qodesh',
    name: 'The Qodesh',
    lat: 5.5878787,
    lng: -0.230101,
    defaultRadiusM: 70,
  },
  {
    id: 'anagkazo-congress-hall',
    name: 'Anagkazo Congress Hall',
    lat: 5.9049091,
    lng: -0.148589,
    defaultRadiusM: 70,
  },
]
