// tools/build-geodata.mjs — writes the game's geography from the OpenStreetMap extracts (node tools/fetch-osm.mjs) and
// LINZ's LiDAR elevation models (node tools/fetch-terrain.mjs) in tools/data:
//   js/akl-geodata.js            land, blocks, street graph, parks, paths, piers, bridges, motorways, places   (GEO)
//   js/terrain-geodata.bin.gz    the ground's height: 5 m grid of the detailed city, 32 m grid of the region
//   js/building-geodata.bin.gz   building footprints with their surveyed heights, and houses as oriented boxes
//   js/tree-geodata.bin.gz       surveyed street trees, and trees grown in woods, parks & gardens
// usage: node --max-old-space-size=8192 tools/build-geodata.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LAT0, LON0, KX, KY, toWorld } from './akl-frame.mjs';
import { ROOT, loadOsm, wayPts, rdp, rdpRing, pointInRing, polylineLength, log } from './geo-util.mjs';
import { regionLand } from './geo-coast.mjs';
import { streetLinks, buildStreetGraph, motorways as motorwayWays, detailRect as R, inRect } from './geo-roads.mjs';
import { buildings, orientedBox } from './geo-buildings.mjs';
import { landPolys, blocks, greens, parkPaths, piers, rails, blockIndexAt, isLand, isRoad, greenAt, distBuilding, distCurb } from './geo-blocks.mjs';
import { deckProfile, roofOver, terrainOrGround, groundAt, writeTerrain, SEA } from './geo-terrain.mjs';

const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const flat3 = (pts) => pts.flatMap(([x, z, y]) => [q(x), q(z), Math.round(y * 100) / 100]);
const hash = (x, z, k = 0) => {
  const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

writeTerrain(path.join(ROOT, 'js/terrain-geodata.bin.gz'));

// =====================================================================================================================
// Streets off the detailed land (the North Shore's tip inside the rectangle) drop out
// =====================================================================================================================
for (const l of streetLinks) {
  let n = 0, on = 0;
  for (const [x, z] of l.pts) { n++; if (isLand(x, z)) on++; }
  if (on / n < 0.6) l.dropped = l.offLand = true;
}
const graph = buildStreetGraph();

// =====================================================================================================================
// Bridge decks: streets & motorways carried over gullies, cuttings, other roads and the harbour. Their heights come
// from the LiDAR surface model; where a deck starts and ends it rides on the ground.
// =====================================================================================================================
const decks = [];
// a centre line lengthened by `d` m at both ends
const lengthen = (pts, d) => {
  const ext = (p, o) => { const L = Math.hypot(p[0] - o[0], p[1] - o[1]) || 1; return [p[0] + ((p[0] - o[0]) / L) * d, p[1] + ((p[1] - o[1]) / L) * d]; };
  return [ext(pts[0], pts[1]), ...pts, ext(pts[pts.length - 1], pts[pts.length - 2])];
};
function addDeck(kind, w, pts, name) {
  // the ends ride on the ground only where the ground is there to ride on (not where one bridge piece meets the next)
  const prof = deckProfile(pts, { grounded: false });
  const n = prof.length;
  for (const end of [0, n - 1]) {
    const g = terrainOrGround(prof[end][0], prof[end][1]);
    if (Math.abs(prof[end][2] - g) > 3) continue;
    for (let i = 0; i < n; i++) {
      const k = end ? n - 1 - i : i;
      const d = Math.hypot(prof[k][0] - prof[end][0], prof[k][1] - prof[end][1]);
      if (d > 14) break;
      const t = d / 14;
      const gk = terrainOrGround(prof[k][0], prof[k][1]);
      prof[k][2] = gk + (Math.max(prof[k][2], gk) - gk) * t * t * (3 - 2 * t);
    }
  }
  // thin the profile where it is straight
  const keep = rdp(prof.map((p, i) => [p[0], p[1], i]), 0.15).map((p) => p[2]);
  const idx = new Set(keep);
  for (let i = 0; i < n; i += 3) idx.add(i); // ...but keep enough points to follow its height
  idx.add(n - 1);
  const out = [...idx].sort((a, b) => a - b).map((i) => prof[i]);
  let rise = 0;
  for (const p of out) rise = Math.max(rise, p[2] - terrainOrGround(p[0], p[1]));
  if (rise < 1.2) return; // on the ground after all (a culvert, an embankment)
  decks.push({ kind, w, pts: out, name, rise });
}
for (const l of streetLinks) {
  if (l.dropped || !l.bridge || l.len < 12) continue;
  addDeck(0, l.w + 4.4, lengthen(l.pts, 12), l.name);
}
// motorway ramps on bridges (the carriageways themselves follow below, from the regional extract)
for (const m of motorwayWays) {
  if (!m.link || !m.bridge || polylineLength(m.pts) < 15) continue;
  addDeck(1, m.w + 1.6, lengthen(m.pts, 8), m.name || 'ramp');
}

// =====================================================================================================================
// Motorways: the carriageways chained end to end, from the regional extract (so they run on beyond the detailed area
// and over the Harbour Bridge), with the height of their surface: the ground at grade, the deck on bridges & viaducts,
// a straight grade through tunnels
// =====================================================================================================================
const motorways = [];
{
  const els = loadOsm('region').filter((e) => e.type === 'way' && e.tags && e.tags.highway === 'motorway' && e.geometry);
  const near = (p) => p[0] > R.x0 - 1400 && p[0] < R.x1 + 900 && p[1] > R.z0 - 1400 && p[1] < R.z1 + 900;
  const ways = els.map((e) => ({ id: e.id, a: e.nodes[0], b: e.nodes[e.nodes.length - 1], pts: wayPts(e), lanes: parseInt(e.tags.lanes, 10) || 3, name: e.tags.name || '', ref: e.tags.ref || '',
    level: e.tags.tunnel && e.tags.tunnel !== 'no' ? -1 : e.tags.bridge && e.tags.bridge !== 'no' ? Math.max(1, parseInt(e.tags.layer, 10) || 1) : 0 }))
    .filter((w) => w.pts.some(near));
  const byStart = new Map();
  const ends = new Map();
  for (const w of ways) {
    if (!byStart.has(w.a)) byStart.set(w.a, []);
    byStart.get(w.a).push(w);
    ends.set(w.b, (ends.get(w.b) || 0) + 1);
  }
  const used = new Set();
  // chains start where no way (or more than one) leads in
  const starts = ways.filter((w) => (ends.get(w.a) || 0) !== 1 || (byStart.get(w.a) || []).length !== 1);
  let bridges = 0, tunnels = 0;
  for (const first of [...starts, ...ways]) {
    if (used.has(first)) continue;
    // pieces of the chain: [{ pts, level, lanes }]
    const pieces = [];
    let cur = first;
    let lanes = 0, len = 0;
    while (cur && !used.has(cur)) {
      used.add(cur);
      const last = pieces[pieces.length - 1];
      if (last && last.level === cur.level) last.pts.push(...cur.pts.slice(1));
      else pieces.push({ pts: cur.pts.slice(), level: cur.level });
      const L = polylineLength(cur.pts);
      lanes += cur.lanes * L;
      len += L;
      const next = byStart.get(cur.b) || [];
      cur = next.length === 1 && (ends.get(cur.b) || 0) === 1 ? next[0] : null;
    }
    if (len < 80) continue;
    lanes = Math.max(1, Math.round(lanes / len));
    // points every ~10 m with their height & kind (0 at grade, 1 on a deck, 2 in a tunnel)
    const pts = [];
    for (const piece of pieces) {
      const L = polylineLength(piece.pts);
      if (piece.level > 0) {
        const prof = deckProfile(piece.pts, { grounded: false });
        // a deck's ends meet the road on either side
        addDeck(1, lanes * 3.6 + 3.2, piece.pts, first.name);
        bridges++;
        for (const p of prof) pts.push([p[0], p[1], p[2], 1]);
      } else {
        const n = Math.max(1, Math.ceil(L / 10));
        let seg = 0, s0 = 0;
        for (let k = 0; k <= n; k++) {
          const s = (L * k) / n;
          while (seg + 2 < piece.pts.length && s > s0 + Math.hypot(piece.pts[seg + 1][0] - piece.pts[seg][0], piece.pts[seg + 1][1] - piece.pts[seg][1])) {
            s0 += Math.hypot(piece.pts[seg + 1][0] - piece.pts[seg][0], piece.pts[seg + 1][1] - piece.pts[seg][1]);
            seg++;
          }
          const sl = Math.hypot(piece.pts[seg + 1][0] - piece.pts[seg][0], piece.pts[seg + 1][1] - piece.pts[seg][1]) || 1;
          const t = Math.min(1, (s - s0) / sl);
          const x = piece.pts[seg][0] + (piece.pts[seg + 1][0] - piece.pts[seg][0]) * t, z = piece.pts[seg][1] + (piece.pts[seg + 1][1] - piece.pts[seg][1]) * t;
          pts.push([x, z, terrainOrGround(x, z), piece.level < 0 ? 2 : 0]);
        }
        if (piece.level < 0) tunnels++;
      }
    }
    // tunnels: a straight grade from portal to portal, under the ground
    for (let i = 0; i < pts.length; i++) {
      if (pts[i][3] !== 2) continue;
      let j = i;
      while (j + 1 < pts.length && pts[j + 1][3] === 2) j++;
      const a = pts[Math.max(0, i - 1)][2], b = pts[Math.min(pts.length - 1, j + 1)][2];
      for (let k = i; k <= j; k++) pts[k][2] = Math.min(pts[k][2] - 5.5, a + ((b - a) * (k - i + 1)) / (j - i + 2));
      i = j;
    }
    // smooth the road's grade a little (the ground under it is rougher than the carriageway), keeping decks as surveyed
    for (let it = 0; it < 3; it++) {
      const ys = pts.map((p) => p[2]);
      for (let i = 1; i + 1 < pts.length; i++) if (pts[i][3] === 0) pts[i][2] = (ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4;
    }
    // drop duplicate joints, then thin where straight & evenly graded
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
    motorways.push({ name: first.name, ref: first.ref, lanes, pts: clean });
  }
  log(`motorways: ${motorways.length} carriageway chains, ${(motorways.reduce((t, m) => t + polylineLength(m.pts), 0) / 1000).toFixed(0)} km, ${bridges} bridge runs, ${tunnels} tunnel runs`);
}
log(`${decks.length} bridge decks (${decks.filter((d) => d.kind === 0).length} street, ${decks.filter((d) => d.kind === 1).length} motorway), highest ${Math.max(...decks.map((d) => d.rise)).toFixed(0)} m above the ground`);

// =====================================================================================================================
// Buildings
// =====================================================================================================================
const SMALL = /^(garage|garages|shed|carport|hut|cabin|kiosk|toilets|service|container|boathouse|greenhouse)$/;
const HOUSE = /^(yes|house|residential|detached|terrace|semidetached_house|bungalow|static_caravan|garage|garages|shed|hut|cabin|carport)$/;
function guessHeight(b, kind, h) {
  const k = b.kind;
  if (k === 'container') return 2.6 * (1 + Math.floor(h * 3));
  if (SMALL.test(k)) return 2.8 + h * 0.8;
  if (/^(church|cathedral|chapel|mosque|temple|synagogue)$/.test(k) || b.amenity === 'place_of_worship') return 9 + h * 6 + Math.min(8, b.area / 250);
  if (k === 'apartments' || k === 'dormitory') return 10 + Math.floor(h * 4) * 3.2;
  if (k === 'hotel') return 14 + Math.floor(h * 5) * 3.3;
  if (k === 'office') return 12 + Math.floor(h * 5) * 3.6;
  if (/^(warehouse|industrial|hangar)$/.test(k)) return 7.5 + h * 3.5;
  if (/^(school|university|hospital|college|civic|public|government)$/.test(k)) return 8 + Math.floor(h * 3) * 3.6;
  if (/^(retail|commercial|supermarket)$/.test(k)) return 6.5 + Math.floor(h * 3) * 3.4;
  if (kind === 0) return b.area < 120 ? 6.5 + h * 3 : b.area < 500 ? 7.5 + Math.floor(h * 3) * 3.4 : 9 + h * 8;
  if (kind === 3) return 7 + h * 4;
  if (kind === 2) return b.area > 800 ? 8 : 3.6;
  return b.area > 420 ? 6.5 + Math.floor(h * 2) * 3 : h < 0.3 ? 5.8 : 3.2;
}

const outBuildings = [];
const houses = [];
const named = [];
let offRoad = 0, offLand = 0, surveyed = 0, fromTags = 0, guessed = 0;
const SKY_TOWER_R = 34;
for (const b of buildings) {
  const h01 = hash(b.cx, b.cz, 1);
  // The Sky Tower is modelled by hand (js/landmarks.js)
  if (Math.hypot(b.cx, b.cz) < SKY_TOWER_R && ((b.height || 0) > 100 || /Sky Tower/i.test(b.name) || b.area < 900)) continue;
  // where it stands: mostly on a roadway (mapped over the street: a canopy, a bridge) or off the land -> dropped
  let n = 0, onRoad = 0, onLand = 0;
  const ring = b.polys[0].outer;
  for (let z = b.bb.z0 + 0.5; z < b.bb.z1; z += Math.max(1, (b.bb.z1 - b.bb.z0) / 14)) {
    for (let x = b.bb.x0 + 0.5; x < b.bb.x1; x += Math.max(1, (b.bb.x1 - b.bb.x0) / 14)) {
      if (!pointInRing(ring, x, z)) continue;
      n++;
      if (isLand(x, z)) onLand++;
      if (isRoad(x, z)) onRoad++;
    }
  }
  if (n && onLand / n < 0.5) { offLand++; continue; }
  if (n && onRoad / n > 0.4) { offRoad++; continue; }
  const bi = blockIndexAt(b.cx, b.cz);
  const kind = bi >= 0 ? blocks[bi].kind : 0;

  // Height above the lowest ground it stands on: surveyed by LiDAR (the 75th percentile of the surface over the
  // footprint: under the ridge of a pitched roof, at the parapet of a flat one); OpenStreetMap's where that says more
  // (towers finished since the survey); a guess from its kind & size where neither knows
  const tagged = b.height ?? (b.levels ? b.levels * 3.3 + 1.2 + b.roofLevels * 2.4 : null);
  const roof = roofOver(ring, b.bb);
  let height = null;
  if (roof && roof.top - roof.base > 2.2) {
    height = roof.top - roof.base;
    // a tower shaft mapped as a 3D part stands as tall as its tag says, whatever podium the footprint also covers
    if (tagged && (tagged > height * 1.25 || (b.part && tagged > height))) { height = tagged; fromTags++; } else surveyed++;
  } else if (tagged) { height = tagged; fromTags++; } else { height = guessHeight(b, kind, h01); guessed++; }
  height = Math.max(2.4, Math.min(height, 340));
  if (b.name) named.push([b.name, q(b.cx), q(b.cz), Math.round(height)]);

  // Houses: small, low, roughly rectangular buildings among gardens stand as boxes under hipped roofs
  const box = orientedBox(ring);
  if (box && b.polys.length === 1 && !b.polys[0].holes.length && HOUSE.test(b.kind) && height <= 10.5 && b.area <= 460 && b.area >= 9 &&
    b.area / box.area >= 0.5 && (kind === 1 || kind === 2 || (b.kind !== 'yes' && kind !== 0)) && !b.part && !b.podium) {
    const shed = b.area < 42 || SMALL.test(b.kind);
    // walls up to the eaves: the surveyed height sits near the ridge
    const wall = shed ? Math.max(2.2, Math.min(3.2, height - 0.6)) : Math.max(2.7, Math.min(7.2, height - 1.5));
    // the box keeps the footprint's area: an L-shaped house's box is drawn in a little
    const s = Math.sqrt(Math.min(1, (b.area / box.area) * 1.12));
    houses.push({ x: box.cx, z: box.cz, w: Math.max(2.5, box.w * s), d: Math.max(2.2, box.d * s), ang: box.ang, wall, style: Math.floor(hash(b.cx, b.cz, 2) * 250), shed: shed ? 1 : 0 });
    continue;
  }
  // facade era: the year it was built where known, else by height and chance
  let year = b.year;
  if (!year) {
    const r = hash(b.cx, b.cz, 3);
    year = height >= 60 ? 2005 : height >= 26 ? (r < 0.45 ? 1975 : 2008) : height >= 13 ? (r < 0.3 ? 1925 : r < 0.62 ? 1968 : 2000) : (r < 0.5 ? 1928 : r < 0.8 ? 1962 : 1996);
  }
  outBuildings.push({ height, year, shop: kind === 0 ? 1 : 0, polys: b.polys.map((p) => ({ outer: rdpRing(p.outer, 0.2), holes: p.holes.map((r) => rdpRing(r, 0.2)) })), cx: b.cx, cz: b.cz });
}
log(`buildings: ${outBuildings.length} footprints, ${houses.length} houses; heights: ${surveyed} surveyed, ${fromTags} from tags, ${guessed} guessed; dropped ${offRoad} standing in roadways, ${offLand} off the land; ${named.length} named`);

function varints() {
  const data = [];
  return {
    data,
    uint(v) {
      v = Math.max(0, Math.round(v));
      while (v > 127) { data.push((v & 127) | 128); v = Math.floor(v / 128); }
      data.push(v);
    },
    sint(v) { this.uint(v >= 0 ? v * 2 : -v * 2 - 1); }
  };
}
const morton = (x, z) => {
  let m = 0;
  const xi = Math.max(0, Math.round(x - R.x0)), zi = Math.max(0, Math.round(z - R.z0));
  for (let i = 0; i < 14; i++) m += (((xi >> i) & 1) * 2 ** (2 * i)) + (((zi >> i) & 1) * 2 ** (2 * i + 1));
  return m;
};
function writeGz(file, parts) {
  const raw = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  // a fixed mtime keeps rebuilds byte-identical
  const gz = zlib.gzipSync(raw, { level: 9 });
  gz.writeUInt32LE(0, 4);
  fs.writeFileSync(file, gz);
  return gz.length;
}
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; };

{
  // AKB1: 'AKB1', metadata length, x length; metadata varints, then x & z coordinate deltas (0.25 m, zigzag varints)
  const Q = 4;
  const meta = varints(), xs = varints(), zs = varints();
  let x = 0, z = 0;
  const pt = (px, pz) => {
    const qx = Math.round(px * Q), qz = Math.round(pz * Q);
    xs.sint(qx - x); zs.sint(qz - z);
    x = qx; z = qz;
  };
  outBuildings.sort((a, b) => morton(a.cx, a.cz) - morton(b.cx, b.cz));
  houses.sort((a, b) => morton(a.x, a.z) - morton(b.x, b.z));
  meta.uint(outBuildings.length);
  for (const b of outBuildings) {
    meta.uint(b.height * 2);
    meta.uint(b.year ? b.year - 1800 : 0);
    meta.uint(b.shop);
    meta.uint(b.polys.length);
    for (const p of b.polys) {
      meta.uint(1 + p.holes.length);
      for (const ring of [p.outer, ...p.holes]) {
        meta.uint(ring.length);
        for (const [px, pz] of ring) pt(px, pz);
      }
    }
  }
  meta.uint(houses.length);
  for (const h of houses) {
    pt(h.x, h.z);
    meta.uint(h.w * 4);
    meta.uint(h.d * 4);
    meta.uint(Math.round((h.ang / Math.PI) * 256) % 256);
    meta.uint(h.wall * 4);
    meta.uint(h.style);
    meta.uint(h.shed);
  }
  const size = writeGz(path.join(ROOT, 'js/building-geodata.bin.gz'), [Buffer.from('AKB1'), u32(meta.data.length, xs.data.length), meta.data, xs.data, zs.data]);
  log(`wrote js/building-geodata.bin.gz (${(size / 1024).toFixed(0)} KB)`);
}

// =====================================================================================================================
// Trees
// =====================================================================================================================
const treeSets = { street: [], park: [], wood: [], garden: [] };
{
  const els = loadOsm('points');
  for (const e of els) {
    const t = e.tags || {};
    if (e.type === 'node' && t.natural === 'tree') {
      const [x, z] = toWorld(e.lon, e.lat);
      if (inRect([x, z], 2) && isLand(x, z)) treeSets.street.push([x, z]);
    } else if (e.type === 'way' && t.natural === 'tree_row') {
      const pts = wayPts(e);
      for (let i = 0; i + 1 < pts.length; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        for (let s = 0; s < L; s += 9) {
          const x = pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * s) / L, z = pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * s) / L;
          if (inRect([x, z], 2) && isLand(x, z)) treeSets.street.push([x, z]);
        }
      }
    }
  }
  // path corridors stay clear
  const pathCells = new Set();
  for (const p of parkPaths) {
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const L = Math.hypot(p.pts[i + 1][0] - p.pts[i][0], p.pts[i + 1][1] - p.pts[i][1]);
      for (let s = 0; s <= L; s += 1.5) {
        const x = p.pts[i][0] + ((p.pts[i + 1][0] - p.pts[i][0]) * s) / (L || 1), z = p.pts[i][1] + ((p.pts[i + 1][1] - p.pts[i][1]) * s) / (L || 1);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) pathCells.add(`${Math.floor(x / 2.5) + dx},${Math.floor(z / 2.5) + dz}`);
      }
    }
  }
  const onPath = (x, z) => pathCells.has(`${Math.floor(x / 2.5)},${Math.floor(z / 2.5)}`);
  const grid = (step, fn) => {
    for (let gz = R.z0 + step; gz < R.z1 - step; gz += step) {
      for (let gx = R.x0 + step; gx < R.x1 - step; gx += step) {
        const x = gx + (hash(gx, gz, 4) - 0.5) * step * 0.9, z = gz + (hash(gx, gz, 5) - 0.5) * step * 0.9;
        const b = blockIndexAt(x, z);
        if (b < 0 || blocks[b].island) continue;
        fn(x, z, blocks[b], hash(gx, gz, 6));
      }
    }
  };
  // woods: dense
  grid(7.5, (x, z, b, r) => {
    if (greenAt(x, z) !== 2 || distBuilding(x, z) < 3.5 || distCurb(x, z) < 2.2 || onPath(x, z) || r < 0.12) return;
    treeSets.wood.push([x, z]);
  });
  // park lawns: scattered, in drifts
  grid(21, (x, z, b, r) => {
    const g = greenAt(x, z);
    if (g === 2 || g === 3 || g === 4 || g === 5) return;
    if (!(b.kind === 2 || g === 1) || distBuilding(x, z) < 5 || distCurb(x, z) < 3 || onPath(x, z)) return;
    const drift = Math.sin(x * 0.021 + 1.3) * Math.sin(z * 0.017 + 0.4);
    if (r < (drift > 0.2 ? 0.25 : 0.62)) return;
    treeSets.park.push([x, z]);
  });
  // gardens: back yards & front yards
  grid(12.5, (x, z, b, r) => {
    if (b.kind !== 1 || greenAt(x, z) > 0 || r < 0.38) return;
    if (distBuilding(x, z) < 2.6 || distCurb(x, z) < 4.2) return;
    treeSets.garden.push([x, z]);
  });
  // AKT1: 'AKT1', section count, the sections' tree counts, x length; x & z deltas (0.5 m, zigzag varints) section after section
  const xs = varints(), zs = varints();
  let x = 0, z = 0;
  const counts = [];
  for (const key of ['street', 'park', 'wood', 'garden']) {
    const seen = new Set();
    const list = treeSets[key].map(([px, pz]) => [Math.round(px * 2), Math.round(pz * 2)]).filter(([a, b]) => {
      const k = a * 100003 + b;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => morton(a[0] / 2, a[1] / 2) - morton(b[0] / 2, b[1] / 2));
    counts.push(list.length);
    for (const [qx, qz] of list) { xs.sint(qx - x); zs.sint(qz - z); x = qx; z = qz; }
  }
  const size = writeGz(path.join(ROOT, 'js/tree-geodata.bin.gz'), [Buffer.from('AKT1'), u32(counts.length, ...counts, xs.data.length), xs.data, zs.data]);
  log(`trees: ${counts[0]} surveyed, ${counts[1]} in parks, ${counts[2]} in woods, ${counts[3]} in gardens -> js/tree-geodata.bin.gz (${(size / 1024).toFixed(0)} KB)`);
}

// =====================================================================================================================
// Places: suburbs & neighbourhoods (labels, districts), ferry terminals, stations, viewpoints
// =====================================================================================================================
const places = [];
const pois = [];
for (const e of loadOsm('points')) {
  const t = e.tags || {};
  if (e.type !== 'node' || !t.name) continue;
  const [x, z] = toWorld(e.lon, e.lat);
  if (t.place) places.push([t.name, t.place === 'suburb' ? 0 : 1, Math.round(x), Math.round(z)]);
  else if (!inRect([x, z])) continue;
  else if (t.amenity === 'ferry_terminal') pois.push(['ferry', t.name, q(x), q(z)]);
  else if (t.railway === 'station') pois.push(['station', t.name, q(x), q(z)]);
  else if (t.tourism === 'viewpoint' || t.tourism === 'attraction' || t.tourism === 'museum' || (t.tourism === 'artwork' && t.artwork_type === 'statue')) pois.push([t.tourism, t.name, q(x), q(z)]);
  else if (t.historic === 'memorial' || t.historic === 'monument') pois.push(['monument', t.name, q(x), q(z)]);
}
const peaks = [];
for (const e of loadOsm('region')) {
  const t = e.tags || {};
  if (e.type === 'node' && /^(peak|volcano)$/.test(t.natural || '') && t.name) {
    const [x, z] = toWorld(e.lon, e.lat);
    peaks.push([t.name, Math.round(x), Math.round(z), parseFloat(t.ele) || 0]);
  }
}

// =====================================================================================================================
// Assemble
// =====================================================================================================================
const pierKinds = { pier: 0, breakwater: 1 };
const GEO = {
  version: 2,
  // kx, ky: metres per degree of longitude / latitude; sea: the elevation (m, NZVD2016) of world height 0
  frame: { lat0: LAT0, lon0: LON0, kx: Math.round(KX * 100) / 100, ky: Math.round(KY * 100) / 100, origin: 'Sky Tower', units: 'm', sea: SEA, rect: [q(R.x0), q(R.x1), q(R.z0), q(R.z1)] },
  // the detailed land: [outline, [hole, ...]]
  land: landPolys.map((p) => [flat(p.outer), p.holes.map(flat)]),
  // the land of the whole region out to the horizon, big to small: outlines
  region: regionLand.map((p) => flat(p.outer)),
  // curb islands: [outline, kind (0 paved, 1 gardens, 2 park, 3 yard), park name, traffic island]
  blocks: blocks.map((b) => [flat(b.poly), b.kind, b.name, b.island]),
  // lawns (1), woods (2), sports pitches (3), ponds (4) & beaches (5) lying on the blocks: [kind, outline, holes]
  greens: greens.map((g) => [g.kind, flat(g.ring), g.holes.map(flat)]),
  parkPaths: parkPaths.map((p) => [p.w, flat(p.pts)]),
  // piers, pontoons (floating) & breakwaters: [kind, floating, outline]
  piers: piers.filter((p) => p.ring.some((pt) => inRect(pt, -60)) && p.ring.some((pt) => !isLand(pt[0], pt[1])) && Math.max(...p.ring.map((pt) => pt[1])) > R.z0 + 420).map((p) => [pierKinds[p.kind] || 0, p.floating, flat(rdpRing(p.ring, 0.3))]),
  rails: rails.filter((r) => r.pts.some((p) => inRect(p))).map((r) => flat(rdp(r.pts, 0.5))),
  // Street centreline graph: nodes [x, z, ...], links [node a, node b, name index, curb-to-curb width, travel lanes,
  // direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...], class (0 local .. 3 arterial),
  // flags (1: closed to through traffic, a lane too narrow for cars to pass; 2: on a bridge)],
  // signals: signalised junctions [x, z, ...]
  roadGraph: graph,
  // bridge decks: [kind (0 street, 1 motorway), width, [x, z, y, ...] along the centre line]
  decks: decks.map((d) => [d.kind, q(d.w), flat3(d.pts)]),
  // motorway carriageways (one way, in the direction of travel):
  // [name, reference, lanes, [x, z, y, ...], kinds per point (0 at grade, 1 on a deck, 2 in a tunnel)]
  motorways: motorways.map((m) => [m.name, m.ref, m.lanes, flat3(m.pts), m.pts.map((p) => p[3])]),
  // [name, 0 suburb / 1 neighbourhood, x, z]
  places,
  pois,
  // [name, x, z, summit elevation (m)]
  peaks,
  // named buildings: [name, x, z, height]
  named
};

const OUT = path.join(ROOT, 'js/akl-geodata.js');
const header = `// js/akl-geodata.js — GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Auckland's geography in the simulation's world frame: 1 unit = 1 m, x = east, z = south (north = -z), origin at the
// Sky Tower (${LAT0}, ${LON0}); heights y in metres above the quays (elevation - ${SEA} m).
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: © OpenStreetMap contributors (ODbL), including building outlines imported from LINZ & Auckland Council;
// elevations from LINZ's Auckland LiDAR 1 m DEM / DSM (CC BY 4.0).
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${JSON.stringify(GEO)};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
void groundAt;
