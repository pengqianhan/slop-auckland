// tools/akl-frame.mjs — the world frame of Slop Auckland and the extents of its data.
//
// World frame: 1 unit = 1 m, x = east, z = south (north = -z), y up. Origin: the Sky Tower. A local tangent plane on
// the WGS84 ellipsoid (no rotation: true north is -z).

export const LAT0 = -36.848448;
export const LON0 = 174.762191;

const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
export const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0); // metres per degree of longitude
export const KY = (Math.PI / 180) * MRAD; // metres per degree of latitude

export const toWorld = (lon, lat) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
export const toLonLat = (x, z) => [LON0 + x / KX, LAT0 - z / KY];

// The detailed city (streets, blocks, surveyed buildings): the central isthmus from Herne Bay & Ponsonby to Parnell,
// south to Newmarket & the foot of Maungawhau / Mt Eden.
export const DETAIL = { south: -36.8725, west: 174.7325, north: -36.8300, east: 174.7935 };
// Low-detail surroundings with building boxes & street patterns: the suburbs around it and the North Shore's southern
// shore (Northcote Point, Birkenhead, Bayswater, Devonport)
export const NEAR = { south: -36.9050, west: 174.6950, north: -36.7950, east: 174.8350 };
// The region out to the horizon: coastline, big roads, volcanic cones, the gulf islands
export const WIDE = { south: -36.9500, west: 174.6000, north: -36.7200, east: 174.9700 };

export const rectWorld = (b) => {
  const [x0, z1] = toWorld(b.west, b.south);
  const [x1, z0] = toWorld(b.east, b.north);
  return { x0, x1, z0, z1 };
};
