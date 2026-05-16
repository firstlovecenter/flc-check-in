/** Pre-saved venue boundaries for FLC events.
 *  Used in the GeoFencePicker to snap the map to a known location in one tap.
 *
 *  Two shapes, mirroring GeofenceInput:
 *    - circle:  one centre point + default radius (good for halls, simple sites)
 *    - polygon: an array of [lat, lng] vertices (good for irregular campuses)
 *
 *  Vertices for polygons should be in order (clockwise or counter-clockwise);
 *  the picker will close the ring automatically.
 */
export type PresetVenue =
  | {
      id: string
      name: string
      type: 'circle'
      lat: number
      lng: number
      defaultRadiusM: number
    }
  | {
      id: string
      name: string
      type: 'polygon'
      /** [lat, lng] pairs in vertex order. Min 3 points. */
      polygon: [number, number][]
    }

export const PRESET_VENUES: PresetVenue[] = [
  {
    id: 'flc-accra',
    name: 'First Love Center, Accra',
    type: 'polygon',
    polygon: [
      [5.656660396591758,  -0.16837549330903834],
      [5.6558534748061815, -0.1683288860381498],
      [5.655865744980442,  -0.16587496543049524],
      [5.656570198526661,  -0.16607447530024344],
      [5.656375418890231,  -0.16670745436539672],
      [5.656425175853598,  -0.16728840262154124],
      [5.656422427594625,  -0.16729925503485035],
      [5.656847289253330,  -0.16739906617504400],
      [5.656724969899541,  -0.16834600388811530],
    ],
  },
  {
    id: 'the-qodesh',
    name: 'The Qodesh',
    type: 'polygon',
    polygon: [
      [5.588827914018548,  -0.22999578806718726],
      [5.587664031431548,  -0.22936194417713293],
      [5.5865705884730135, -0.22915208737873840],
      [5.586535250347595,  -0.22945991797865725],
      [5.586817725414024,  -0.23043252206750742],
      [5.5883913216585475, -0.23084781088461437],
      [5.588795555387998,  -0.22988484922569974],
    ],
  },
  {
    id: 'anagkazo-great-hall',
    name: 'Anagkazo Great Hall',
    type: 'polygon',
    polygon: [
      [5.9063626265913864, -0.15265185073874982],
      [5.906804006030331,  -0.15229395936502768],
      [5.906003239050045,  -0.15133966902739765],
      [5.905474829709134,  -0.15179290309029272],
      [5.906246750029382,  -0.15265701875469642],
    ],
  },
  {
    id: 'anagkazo-congress-hall',
    name: 'Anagkazo Congress Hall',
    type: 'polygon',
    polygon: [
      [5.905392654140491, -0.14857558075579205],
      [5.904975879173656, -0.14808155867780542],
      [5.904418186725164, -0.14860675857794970],
      [5.904800892372125, -0.14903412950031530],
      [5.905373967097185, -0.14855913411843410],
    ],
  },
]
