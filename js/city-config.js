import { GEO } from './akl-geodata.js';

// Auckland's spatial configuration at true 1:1 scale, derived from the real geography in js/akl-geodata.js (generated
// by tools/build-geodata.mjs from OpenStreetMap).
//
// World frame: 1 unit = 1 m, x = east, z = south (north = -z), origin at the Sky Tower. The detailed city is the
// central isthmus inside GEO.frame.rect: the waterfront from Westhaven to the port, the city centre, Ponsonby, Freemans
// Bay, Grafton, Parnell & Newmarket. The North Shore, the suburbs beyond and the gulf are low-detail (surroundings.js).

const toPts = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};

// New Zealand drives on the left: lanes run on the left of the centre line, right turns cross the oncoming traffic.
// (-1: keep left, 1: keep right. The road network, the traffic and the road paint all read this.)
const KEEP = -1;

// Longitude / latitude -> world (the frame is the local tangent plane at the Sky Tower; tools/akl-frame.mjs)
const KX = GEO.frame.kx; // metres per degree of longitude at the origin's latitude
const KY = GEO.frame.ky; // metres per degree of latitude
function LL(lon, lat) {
  return { x: (lon - GEO.frame.lon0) * KX, z: -(lat - GEO.frame.lat0) * KY };
}

// ---------------------------------------------------------------------------------------------------------------------
// The detailed land: outlines, and a 2 m raster of them with the distance to the shore (positive on land, negative on
// the water) for keeping people and vehicles ashore
// ---------------------------------------------------------------------------------------------------------------------
const [RX0, RX1, RZ0, RZ1] = GEO.frame.rect;
const LAND_POLYGONS = GEO.land.map(([outer, holes]) => ({ outer: toPts(outer), holes: holes.map(toPts) }));
const COASTLINE = LAND_POLYGONS[0].outer; // the isthmus

const LAND = (() => {
  const res = 2;
  const w = Math.ceil((RX1 - RX0) / res), h = Math.ceil((RZ1 - RZ0) / res);
  const mask = new Uint8Array(w * h);
  const fill = (rings, value) => {
    const xs = [];
    for (let j = 0; j < h; j++) {
      const z = RZ0 + (j + 0.5) * res;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
          const a = ring[k], b = ring[i];
          if ((a.z > z) !== (b.z > z)) xs.push(a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z));
        }
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - RX0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - RX0) / res - 0.5));
        for (let i = i0; i <= i1; i++) mask[j * w + i] = value;
      }
    }
  };
  for (const p of LAND_POLYGONS) fill([p.outer, ...p.holes], 1);
  // Chamfer distance (cells) to the nearest cell of the other kind, both ways
  const sweep = (isSource) => {
    const d = new Float32Array(w * h);
    const INF = 1e9;
    for (let k = 0; k < w * h; k++) d[k] = isSource(mask[k]) ? 0 : INF;
    const A = 1, B = Math.SQRT2;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        let v = d[k];
        if (i > 0) v = Math.min(v, d[k - 1] + A);
        if (j > 0) {
          v = Math.min(v, d[k - w] + A);
          if (i > 0) v = Math.min(v, d[k - w - 1] + B);
          if (i < w - 1) v = Math.min(v, d[k - w + 1] + B);
        }
        d[k] = v;
      }
    }
    for (let j = h - 1; j >= 0; j--) {
      for (let i = w - 1; i >= 0; i--) {
        const k = j * w + i;
        let v = d[k];
        if (i < w - 1) v = Math.min(v, d[k + 1] + A);
        if (j < h - 1) {
          v = Math.min(v, d[k + w] + A);
          if (i < w - 1) v = Math.min(v, d[k + w + 1] + B);
          if (i > 0) v = Math.min(v, d[k + w - 1] + B);
        }
        d[k] = v;
      }
    }
    return d;
  };
  const toWater = sweep((v) => v === 0);
  const toLand = sweep((v) => v === 1);
  const dist = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) dist[k] = mask[k] ? Math.min(toWater[k] - 0.5, 400) * res : -Math.min(toLand[k] - 0.5, 400) * res;
  return { res, w, h, mask, dist };
})();

/** Is (x, z) on the detailed land? */
function isLand(x, z) {
  const i = Math.floor((x - RX0) / LAND.res), j = Math.floor((z - RZ0) / LAND.res);
  return i >= 0 && j >= 0 && i < LAND.w && j < LAND.h && LAND.mask[j * LAND.w + i] === 1;
}

/** Distance (m) from (x, z) to the shore: positive on land, negative on the water (bilinear, to within a couple of metres) */
function shoreDistance(x, z) {
  const fx = Math.max(0, Math.min(LAND.w - 1.001, (x - RX0) / LAND.res - 0.5));
  const fz = Math.max(0, Math.min(LAND.h - 1.001, (z - RZ0) / LAND.res - 0.5));
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const k = j * LAND.w + i;
  const d = LAND.dist;
  return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - tz) + (d[k + LAND.w] * (1 - tx) + d[k + LAND.w + 1] * tx) * tz;
}

/**
 * Moves pos ({ x, z }) back until it is at least `margin` m inland of the shore. Returns true if it had to move.
 */
function keepAshore(pos, margin = 8) {
  let moved = false;
  for (let pass = 0; pass < 4; pass++) {
    const d = shoreDistance(pos.x, pos.z);
    if (d >= margin) break;
    const e = 3;
    let gx = shoreDistance(pos.x + e, pos.z) - shoreDistance(pos.x - e, pos.z);
    let gz = shoreDistance(pos.x, pos.z + e) - shoreDistance(pos.x, pos.z - e);
    const g = Math.hypot(gx, gz);
    if (g < 1e-4) break;
    gx /= g;
    gz /= g;
    const step = Math.min(margin - d + 0.05, 30);
    pos.x += gx * step;
    pos.z += gz * step;
    moved = true;
  }
  return moved;
}

const ISLAND_BOUNDS = { minX: RX0, maxX: RX1, minZ: RZ0, maxZ: RZ1, sidewalkHeight: 0.22, waterLevel: -2.2 };

// ---------------------------------------------------------------------------------------------------------------------
// Streets: the centreline graph's links as named roads (maps, labels & lookups)
//   cls: 0 local street, 1 collector, 2 main road, 3 arterial
// ---------------------------------------------------------------------------------------------------------------------
const RG = GEO.roadGraph;
const ROADS = RG.links.map(([a, b, ni, w, lanes, dir, inner, cls, closed]) => {
  const pts = [{ x: RG.nodes[a * 2], z: RG.nodes[a * 2 + 1] }, ...toPts(inner), { x: RG.nodes[b * 2], z: RG.nodes[b * 2 + 1] }];
  return { name: RG.names[ni], w, dir, lanes, cls, closed: !!(closed & 1), bridge: !!(closed & 2), highway: false, pts };
});
// Motorway carriageways (one way each, in the direction of travel) with the height of their surface: in their
// cuttings and along the shore on the ground, over the gullies and the harbour on decks, under Victoria Park in a
// tunnel. pts: [{ x, z, y, kind }] (kind 0 at grade, 1 on a deck, 2 in a tunnel)
const MOTORWAYS = GEO.motorways.map(([name, ref, lanes, flat, kinds]) => {
  const pts = [];
  for (let i = 0; i < flat.length; i += 3) pts.push({ x: flat[i], z: flat[i + 1], y: flat[i + 2], kind: kinds[i / 3] });
  return { name, ref, lanes, pts };
});

// Nearest-road index (labels): uniform grid of the named roads' segments
const ROAD_CELL = 64;
const ROAD_GRID = new Map();
for (const r of ROADS) {
  if (!r.name) continue;
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i];
    const b = r.pts[i + 1];
    const seg = { r, ax: a.x, az: a.z, bx: b.x, bz: b.z };
    const ix0 = Math.floor(Math.min(a.x, b.x) / ROAD_CELL), ix1 = Math.floor(Math.max(a.x, b.x) / ROAD_CELL);
    const iz0 = Math.floor(Math.min(a.z, b.z) / ROAD_CELL), iz1 = Math.floor(Math.max(a.z, b.z) / ROAD_CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const k = ix * 100000 + iz;
      if (!ROAD_GRID.has(k)) ROAD_GRID.set(k, []);
      ROAD_GRID.get(k).push(seg);
    }
  }
}
/** Nearest roads to (x, z) within `radius`: [{ road, dist, x, z, dx, dz }] sorted by distance (one entry per road name) */
function nearestRoads(x, z, radius = 60) {
  const best = new Map();
  const ix0 = Math.floor((x - radius) / ROAD_CELL), ix1 = Math.floor((x + radius) / ROAD_CELL);
  const iz0 = Math.floor((z - radius) / ROAD_CELL), iz1 = Math.floor((z + radius) / ROAD_CELL);
  for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
    const list = ROAD_GRID.get(ix * 100000 + iz);
    if (!list) continue;
    for (const s of list) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
      const px = s.ax + t * dx, pz = s.az + t * dz;
      const d = Math.hypot(px - x, pz - z);
      if (d > radius) continue;
      const prev = best.get(s.r.name);
      const L = Math.sqrt(L2);
      if (!prev || d < prev.dist) best.set(s.r.name, { road: s.r, dist: d, x: px, z: pz, dx: dx / L, dz: dz / L });
    }
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist);
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks: every curb island with its curb outline
//   kind: 0 paved (the city & shopping streets), 1 gardens (houses), 2 park, 3 yard (port, rail, industry)
//   park: 1 for parks (as a share of the block, like Slop New York's), parkName, median: a traffic island
// ---------------------------------------------------------------------------------------------------------------------
const BLOCKS = GEO.blocks.map(([flat, kind, name, island], id) => {
  const poly = toPts(flat);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i], q = poly[j];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    const c = q.x * p.z - p.x * q.z;
    a += c; cx += (q.x + p.x) * c; cz += (q.z + p.z) * c;
  }
  a *= 0.5;
  return {
    id, poly, kind, rects: [], frames: null, park: kind === 2 ? 1 : 0, parkName: name, rect: false, area: Math.abs(a),
    minX, maxX, minZ, maxZ,
    cx: a ? cx / (6 * a) : (minX + maxX) / 2,
    cz: a ? cz / (6 * a) : (minZ + maxZ) / 2,
    median: !!island
  };
});
// Spatial index of the blocks (64 m cells)
const BLOCK_CELL = 64;
const BLOCK_GRID = new Map();
for (const b of BLOCKS) {
  for (let ix = Math.floor(b.minX / BLOCK_CELL); ix <= Math.floor(b.maxX / BLOCK_CELL); ix++) {
    for (let iz = Math.floor(b.minZ / BLOCK_CELL); iz <= Math.floor(b.maxZ / BLOCK_CELL); iz++) {
      const k = ix * 100000 + iz;
      if (!BLOCK_GRID.has(k)) BLOCK_GRID.set(k, []);
      BLOCK_GRID.get(k).push(b);
    }
  }
}
function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
/** The block (curb island) under (x, z), or null on the roadway / in the water */
function blockAt(x, z) {
  const list = BLOCK_GRID.get(Math.floor(x / BLOCK_CELL) * 100000 + Math.floor(z / BLOCK_CELL));
  if (!list) return null;
  for (const b of list) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (pointInPoly(b.poly, x, z)) return b;
  }
  return null;
}

// Green spaces lying on the blocks: 1 lawn, 2 woods, 3 sports pitch, 4 pond, 5 beach
const GREENS = GEO.greens.map(([kind, flat, holes]) => ({ kind, outer: toPts(flat), holes: holes.map(toPts) }));
const PARK_PATHS = GEO.parkPaths.map(([w, flat]) => ({ w, pts: toPts(flat) }));
const PIERS = GEO.piers.map(([kind, floating, flat]) => ({ breakwater: kind === 1, floating: !!floating, ring: toPts(flat) }));
const RAILS = GEO.rails.map(toPts);
const REGION_LAND = GEO.region.map(toPts);

// ---------------------------------------------------------------------------------------------------------------------
// Places: suburbs & neighbourhoods
// ---------------------------------------------------------------------------------------------------------------------
const PLACES = GEO.places.map(([name, minor, x, z]) => ({ name, minor: !!minor, x, z }));
/** The neighbourhood (within 420 m) or else the suburb nearest to (x, z) */
function placeAt(x, z) {
  let near = null, nd = 420, suburb = null, sd = Infinity;
  for (const p of PLACES) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (p.minor && d < nd) { nd = d; near = p; }
    if (!p.minor && d < sd) { sd = d; suburb = p; }
  }
  return (near || suburb || { name: 'Auckland' }).name;
}
const districtAt = placeAt;
for (const b of BLOCKS) b.district = placeAt(b.cx, b.cz);

// ---------------------------------------------------------------------------------------------------------------------
// Landmarks (real places; buildings by their OpenStreetMap names where they have a footprint)
// ---------------------------------------------------------------------------------------------------------------------
const NAMED = new Map();
for (const [name, x, z, h] of GEO.named) if (!NAMED.has(name) || NAMED.get(name).h < h) NAMED.set(name, { x, z, h });
const LANDMARK_SITES = Object.fromEntries(NAMED);
const SKY_TOWER = { x: 0, z: 0 };
// The Harbour Bridge: its deck's centre line from the St Marys Bay abutment to Northcote Point, and the main span's piers
const HARBOUR_BRIDGE = (() => {
  const south = { x: -1776, z: -1424 }; // where the deck leaves the St Marys Bay reclamation
  const north = { x: -1043, z: -2850 }; // where the Northcote Point approach comes down
  // the 244 m navigation span under the arch, pier to pier (from the mapped bridge)
  const a = { x: -1452, z: -2034 }, b = { x: -1327, z: -2242 };
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const dx = north.x - south.x, dz = north.z - south.z;
  const length = Math.hypot(dx, dz);
  return { south, north, ux: dx / length, uz: dz / length, length, a, b, span, sx: (b.x - a.x) / span, sz: (b.z - a.z) / span, deckY: 40 };
})();

const at = (lon, lat) => LL(lon, lat);
const AKL_LANDMARKS = [
  { id: 'skytower', name: 'Sky Tower', short: 'Sky Tower', ...SKY_TOWER, district: 'City Centre' },
  { id: 'ferry', name: 'Ferry Building & Downtown Ferry Terminal', short: 'Ferry Building', ...at(174.76700, -36.84295), district: 'Downtown' },
  { id: 'britomart', name: 'Britomart & Te Komititanga', short: 'Britomart', ...at(174.76730, -36.84420), district: 'Britomart' },
  { id: 'viaduct', name: 'Viaduct Harbour', short: 'Viaduct Harbour', ...at(174.75990, -36.84440), district: 'Viaduct Harbour' },
  { id: 'wynyard', name: 'Wynyard Quarter & Silo Park', short: 'Wynyard Quarter', ...at(174.75420, -36.84050), district: 'Wynyard Quarter' },
  { id: 'bridge', name: 'Auckland Harbour Bridge', short: 'Harbour Bridge', x: HARBOUR_BRIDGE.south.x + HARBOUR_BRIDGE.ux * 500, z: HARBOUR_BRIDGE.south.z + HARBOUR_BRIDGE.uz * 500, district: 'Waitematā Harbour' },
  { id: 'westhaven', name: 'Westhaven Marina', short: 'Westhaven', ...at(174.74620, -36.84030), district: 'Westhaven' },
  { id: 'aotea', name: 'Aotea Square & Town Hall', short: 'Aotea Square', ...at(174.76300, -36.85260), district: 'Midtown' },
  { id: 'albertpark', name: 'Albert Park', short: 'Albert Park', ...at(174.76790, -36.85060), district: 'City Centre' },
  { id: 'university', name: 'University of Auckland Clock Tower', short: 'University', ...at(174.76960, -36.85030), district: 'Learning Quarter' },
  { id: 'museum', name: 'Auckland War Memorial Museum', short: 'Museum', ...at(174.77790, -36.86040), district: 'Auckland Domain' },
  { id: 'domain', name: 'Pukekawa / Auckland Domain', short: 'The Domain', ...at(174.77500, -36.85920), district: 'Grafton' },
  { id: 'kroad', name: 'Karangahape Road', short: 'K Road', ...at(174.75930, -36.85780), district: 'Karangahape' },
  { id: 'ponsonby', name: 'Ponsonby Road', short: 'Ponsonby', ...at(174.74640, -36.85420), district: 'Ponsonby' },
  { id: 'victoriapark', name: 'Waiatarau / Victoria Park', short: 'Victoria Park', ...at(174.75420, -36.84780), district: 'Freemans Bay' },
  { id: 'parnell', name: 'Parnell Village', short: 'Parnell', ...at(174.78180, -36.85650), district: 'Parnell' },
  { id: 'newmarket', name: 'Broadway, Newmarket', short: 'Newmarket', ...at(174.77770, -36.86930), district: 'Newmarket' },
  { id: 'arena', name: 'Spark Arena', short: 'Spark Arena', ...at(174.77700, -36.84700), district: 'Te Tōangaroa' },
  { id: 'port', name: 'Ports of Auckland', short: 'The Port', ...at(174.78200, -36.84560), district: 'Mechanics Bay' }
];

/**
 * A place to arrive on the street nearest to a point: the lane kept to on the nearest road, heading along it (towards
 * `face` = { x, z } if given)
 */
function streetArrival(x, z, face = null, radius = 220) {
  const near = nearestRoads(x, z, radius).filter((n) => !n.road.closed && n.road.w >= 7);
  if (!near.length) return { x, z, heading: 0 };
  const n = near[0];
  let dx = n.dx, dz = n.dz;
  const along = face ? (face.x - n.x) * dx + (face.z - n.z) * dz : n.road.dir || 1;
  if (n.road.dir ? n.road.dir < 0 : along < 0) { dx = -dx; dz = -dz; }
  // the lane: right of the travel direction is (-dz, dx)
  const off = n.road.dir ? 0 : 1.8 * KEEP;
  return { x: n.x - dz * off, z: n.z + dx * off, heading: Math.atan2(dx, dz) };
}
// Street-level arrivals shared by every travel mode. Heading 0 faces south (+z), PI north.
const arrive = (lon, lat, faceLon, faceLat) => streetArrival(LL(lon, lat).x, LL(lon, lat).z, faceLon === undefined ? null : LL(faceLon, faceLat));
const TELEPORT_LOCATIONS = {
  skytower: arrive(174.76330, -36.84760, 174.762191, -36.848448), // Victoria St West, by the tower's foot
  queenst: arrive(174.76560, -36.84700, 174.7670, -36.8430), // Queen St, looking down to the harbour
  ferry: arrive(174.76660, -36.84340, 174.7670, -36.8428), // Quay St at the Ferry Building
  viaduct: arrive(174.75990, -36.84440, 174.7592, -36.8425),
  wynyard: arrive(174.75560, -36.84130, 174.7535, -36.8400),
  bridge: arrive(174.74620, -36.84030, 174.7445, -36.8330), // Westhaven Drive under the Harbour Bridge
  aotea: arrive(174.76390, -36.85210, 174.7628, -36.8526),
  albertpark: arrive(174.76850, -36.85110, 174.7679, -36.8505),
  museum: arrive(174.77800, -36.85930, 174.7779, -36.8604),
  kroad: arrive(174.75930, -36.85780, 174.7570, -36.8580),
  ponsonby: arrive(174.74640, -36.85420, 174.7462, -36.8500),
  parnell: arrive(174.78180, -36.85650, 174.7822, -36.8540),
  newmarket: arrive(174.77770, -36.86930, 174.7775, -36.8660)
};
const SPAWN = TELEPORT_LOCATIONS.queenst;

/**
 * Where (x, z) is: "Place · Street & Street" (the place is a landmark, a park or the neighbourhood)
 */
function getLocationLabel(x, z) {
  if (!isLand(x, z) && (x < RX0 || x > RX1 || z < RZ0 || z > RZ1 || shoreDistance(x, z) < -6)) {
    const d = Math.hypot(x - HARBOUR_BRIDGE.south.x - HARBOUR_BRIDGE.ux * 600, z - HARBOUR_BRIDGE.south.z - HARBOUR_BRIDGE.uz * 600);
    if (d < 650) return 'Auckland Harbour Bridge';
    if (isRegionLand(x, z)) {
      if (Math.hypot(x - 8559, z + 6854) < 3400) return 'Rangitoto Island';
      let best = null, bd = 2600;
      for (const p of PLACES) {
        const pd = Math.hypot(p.x - x, p.z - z);
        if (pd < bd) { bd = pd; best = p; }
      }
      return best ? best.name : 'Tāmaki Makaurau / Auckland';
    }
    if (z > 6500) return 'Manukau Harbour';
    if (x > 4200 && z < 600) return 'Hauraki Gulf';
    return 'Waitematā Harbour';
  }
  let place = '';
  for (const lm of AKL_LANDMARKS) {
    if (Math.hypot(x - lm.x, z - lm.z) < 70) {
      place = lm.name;
      break;
    }
  }
  const block = blockAt(x, z);
  if (!place && block && block.parkName) place = block.parkName;
  if (!place) place = placeAt(x, z);
  const near = nearestRoads(x, z, 90);
  if (!near.length) return place;
  const first = near[0];
  // a second street only at their corner
  const second = near.find((n) => n !== first && n.dist < 34 && Math.abs(n.dx * first.dx + n.dz * first.dz) < 0.94);
  if (first.dist > 45 && block && block.park) return place;
  return `${place} · ${first.dist > 45 ? 'near ' : ''}${first.road.name}${second && first.dist < 34 ? ` & ${second.road.name}` : ''}`;
}

// The region's land (outlines out to the horizon): point lookup through z-bands of edges
const REGION_INDEX = REGION_LAND.map((poly) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const BAND = 250;
  const bands = new Map();
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    for (let k = Math.floor(Math.min(a.z, b.z) / BAND); k <= Math.floor(Math.max(a.z, b.z) / BAND); k++) {
      if (!bands.has(k)) bands.set(k, []);
      bands.get(k).push(a.x, a.z, b.x, b.z);
    }
  }
  return { minX, maxX, minZ, maxZ, bands, BAND };
});
/** Is (x, z) on any land of the region (the mainland, the North Shore, the gulf islands)? */
function isRegionLand(x, z) {
  for (const ix of REGION_INDEX) {
    if (x < ix.minX || x > ix.maxX || z < ix.minZ || z > ix.maxZ) continue;
    const e = ix.bands.get(Math.floor(z / ix.BAND));
    if (!e) continue;
    let inside = false;
    for (let i = 0; i < e.length; i += 4) {
      const az = e[i + 1], bz = e[i + 3];
      if ((az > z) !== (bz > z) && x < e[i] + ((z - az) * (e[i + 2] - e[i])) / (bz - az)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// Keyboard shortcuts are ignored while typing into a form field (e.g. the map's street search box)
function isTypingInField(e) {
  return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
}

// Traffic signal cycle shared by the signal heads (street-details.js) and the traffic (traffic.js), in seconds:
// main roads green until avenueAmber, amber until avenueRed; side streets green from avenueRed until streetAmber,
// amber until the end of the cycle. Pedestrians cross with the traffic that runs parallel to them, stepping off
// only on the WALK, the first `walk` seconds of its green: long enough before the cross traffic's green for the
// slowest walker to get across the widest road.
const SIGNAL_TIMING = { cycle: 60, avenueAmber: 26, avenueRed: 30, streetAmber: 56, walk: 7 };

// 'green', 'amber' or 'red' for main road or side street traffic at a given time
function signalPhase(time, isAvenue) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const t = ((time % cycle) + cycle) % cycle;
  if (isAvenue) return t < avenueAmber ? 'green' : t < avenueRed ? 'amber' : 'red';
  return t < avenueRed ? 'red' : t < streetAmber ? 'green' : 'amber';
}

// Do pedestrians walking alongside main road (or side street) traffic have the WALK at a given time?
function walkSignal(time, isAvenue) {
  const { cycle, avenueRed, walk } = SIGNAL_TIMING;
  const t = (((time - (isAvenue ? 0 : avenueRed)) % cycle) + cycle) % cycle;
  return t < walk;
}

export {
  KEEP,
  LL,
  toPts,
  LAND_POLYGONS,
  COASTLINE,
  REGION_LAND,
  isLand,
  isRegionLand,
  shoreDistance,
  keepAshore,
  ISLAND_BOUNDS,
  ROADS,
  MOTORWAYS,
  BLOCKS,
  GREENS,
  PARK_PATHS,
  PIERS,
  RAILS,
  PLACES,
  placeAt,
  districtAt,
  AKL_LANDMARKS,
  LANDMARK_SITES,
  SKY_TOWER,
  HARBOUR_BRIDGE,
  TELEPORT_LOCATIONS,
  SPAWN,
  streetArrival,
  SIGNAL_TIMING,
  blockAt,
  nearestRoads,
  getLocationLabel,
  isTypingInField,
  signalPhase,
  walkSignal
};
