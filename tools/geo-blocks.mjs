// tools/geo-blocks.mjs — the blocks ("curb islands") of the detailed area: every street is rasterised at its
// curb-to-curb width over the land (1 m cells), what is left is labelled, and each island's curb outline traced.
// Streets are narrowed where buildings stand closer than their nominal width, and curbs keep clear of buildings.
// The approach (and the tracing & simplification) follows Slop New York's tools/geo-blocks.mjs.
import { detailLand } from './geo-coast.mjs';
import { streetLinks, roundabouts, paths, motorways, detailRect as R } from './geo-roads.mjs';
import { buildings } from './geo-buildings.mjs';
import { Raster, loadOsm, areaPolygons, wayPts, isClosedWay, labelComponents, traceComponent, destair, rdpRing, rdp, ringArea, polylineLength, log } from './geo-util.mjs';

const RES = 1;
const SIDEWALK = 1.6; // least footpath kept between a curb and a building
const CORE = 2.4; // half width of the lane a street always keeps, whatever stands beside it

// --- Land ---------------------------------------------------------------------------------------------------------------
// The detailed land: the isthmus's part of the rectangle (not the North Shore's tip across the harbour)
export const landPolys = detailLand.filter((p) => Math.max(...p.outer.map((q) => q[1])) > R.z0 + 420);
const land = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
for (const p of landPolys) land.fillPolygon(p, 1);
const W = land.w, H = land.h;
const X0 = land.x0, Z0 = land.z0;
log(`land raster ${W} x ${H}; ${landPolys.length} land polygons`);

// Streets on bridges over water become decks: land for the street network, drawn as slabs by the game
export const decks = [];
for (const l of streetLinks) {
  let wet = 0, n = 0;
  const run = [];
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s <= L; s += 2) {
      const x = ax + ((bx - ax) * s) / (L || 1), z = az + ((bz - az) * s) / (L || 1);
      n++;
      if (!land.at(x, z)) { wet++; run.push([x, z]); }
    }
  }
  if (wet < 3) continue;
  l.wet = wet / n;
  if (l.wet > 0.6) continue; // a street off the detailed land altogether (the North Shore's tip)
  const pts = rdp(run, 0.4);
  if (pts.length < 2 || polylineLength(pts) > wet * 2 + 30) continue; // several separate crossings: leave the land as it is
  // lengthen the deck 6 m onto the banks
  const ext = (p, q) => { const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1; return [p[0] + ((p[0] - q[0]) / L) * 6, p[1] + ((p[1] - q[1]) / L) * 6]; };
  pts.unshift(ext(pts[0], pts[1]));
  pts.push(ext(pts[pts.length - 1], pts[pts.length - 2]));
  decks.push({ name: l.name, w: l.w + 5, pts });
}
for (const d of decks) land.stampPolyline(d.pts, d.w / 2, 1);
log(`${decks.length} street decks over water: ${[...new Set(decks.map((d) => d.name))].join(', ')}`);

// --- Buildings: distance to the nearest one ---------------------------------------------------------------------------
const built = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
for (const b of buildings) {
  if (b.area < 12) continue;
  for (const p of b.polys) built.fillPolygon(p, 1);
}
const toBuilding = built.edt((v) => v === 1); // squared, in cells
const distBuilding = (x, z) => {
  const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
  return i >= 0 && j >= 0 && i < W && j < H ? Math.sqrt(toBuilding[j * W + i]) * RES : 1e9;
};

// --- Streets narrowed between buildings ---------------------------------------------------------------------------------
let narrowed = 0, lanesOnly = 0, droppedLinks = 0;
for (const l of streetLinks) {
  const ds = [];
  let s0 = 0;
  const margin = Math.min(8, l.len * 0.25);
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    for (let s = Math.max(margin, Math.ceil(s0 / 3) * 3); s <= Math.min(s0 + L, l.len - margin); s += 3) {
      const t = (s - s0) / (L || 1);
      ds.push(distBuilding(ax + (bx - ax) * t, az + (bz - az) * t));
    }
    s0 += L;
  }
  l.w0 = l.w;
  if (ds.length) {
    ds.sort((a, b) => a - b);
    const near = ds[Math.floor(ds.length * 0.15)];
    const allowed = 2 * (near - 0.5 - SIDEWALK);
    if (allowed < l.w) {
      l.w = Math.max(allowed, 0);
      narrowed++;
    }
  }
  l.w = Math.round(l.w * 10) / 10;
  // lanes that fit (3 m each and a little room)
  const fit = Math.max(1, Math.floor((l.w - 0.6) / 3.0));
  if (l.dir === 0 && l.w < 6.0) {
    // too narrow for two-way traffic to pass: a lane for people (and the player), no through traffic
    l.noTraffic = true;
    lanesOnly++;
  }
  if (l.w < 4.2) {
    l.dropped = true; // a passage between buildings: part of the block
    droppedLinks++;
  }
  l.lanes = Math.min(l.lanes, l.dir === 0 ? Math.max(2, fit - (fit % 2)) : fit);
}
log(`streets: ${narrowed} links narrowed between buildings, ${lanesOnly} too narrow for traffic, ${droppedLinks} passages left to the blocks`);

// --- Roadway raster ---------------------------------------------------------------------------------------------------
const road = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
const core = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
for (const l of streetLinks) {
  if (l.dropped) continue;
  // a bridge's deck is carried over the ground: only its last metres at either end, where it lands, are roadway
  if (l.bridge && l.len > 30) {
    const ends = [l.pts.slice(0, 2), l.pts.slice(-2).reverse()];
    for (const [a, b] of ends) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = Math.min(1, 8 / L);
      const c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      road.stampCapsule(a[0], a[1], c[0], c[1], l.w / 2, 1);
      core.stampCapsule(a[0], a[1], c[0], c[1], Math.min(CORE, l.w / 2), 1);
    }
    continue;
  }
  road.stampPolyline(l.pts, l.w / 2, 1);
  core.stampPolyline(l.pts, Math.min(CORE, l.w / 2), 1);
}
// Motorways & their ramps at grade (in their cuttings and along the shore): roadway too. Their viaducts pass over
// whatever is below, their tunnel under it.
for (const m of motorways) {
  if (m.bridge || m.tunnel) continue;
  road.stampPolyline(m.pts, m.w / 2, 1);
  core.stampPolyline(m.pts, Math.min(m.w / 2, 5), 1);
}
for (const r of roundabouts) {
  road.stampCapsule(r.x, r.z, r.x, r.z, r.r + r.w / 2 + 0.5, 1);
  core.stampCapsule(r.x, r.z, r.x, r.z, r.r + 2, 1);
}
{
  const keep = ((SIDEWALK - 0.4) / RES) ** 2;
  let spared = 0;
  for (let k = 0; k < W * H; k++) {
    if (road.d[k] && !core.d[k] && toBuilding[k] <= keep) { road.d[k] = 0; spared++; }
  }
  log(`roadway: ${(road.d.reduce((t, v) => t + v, 0) / 1e6).toFixed(2)} km²; ${spared} m² of it left to buildings and their footpaths`);
}

// --- Islands -----------------------------------------------------------------------------------------------------------
// Blocks keep 2 m back from the water (the seawall's coping), but run to the edge of the detailed area
const shore = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
{
  // water = not land, but beyond the rectangle counts as land (so the blocks reach its edge)
  const toWater = land.edt((v) => v === 0);
  for (let k = 0; k < W * H; k++) shore.d[k] = land.d[k] && toWater[k] > 4 ? 1 : 0;
}
const D = new Uint8Array(W * H);
for (let k = 0; k < W * H; k++) D[k] = shore.d[k] && !road.d[k] ? 1 : 0;
// Kerbs turn their corners on a 3 m radius (a morphological opening of the islands). What the opening takes away
// besides corners (strips & islands under 6 m wide: medians, promenades, slivers between carriageways) is put back.
{
  const CORNER = 3;
  const opened = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
  opened.d = D.slice();
  opened.open(CORNER);
  const cut = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) cut[k] = D[k] && !opened.d[k] ? 1 : 0;
  const cutLab = new Int32Array(W * H);
  const pieces = labelComponents(W, H, (k) => cut[k] === 1, cutLab);
  const corner = new Uint8Array(pieces.length + 1);
  // a rounded-off corner is a few cells in a tight clump; anything bigger or longer is a narrow strip to keep
  for (const p of pieces) corner[p.id] = p.n <= 7 && p.i1 - p.i0 <= 3 && p.j1 - p.j0 <= 3 ? 1 : 0;
  let rounded = 0;
  for (let k = 0; k < W * H; k++) if (cut[k] && corner[cutLab[k]]) { D[k] = 0; rounded++; }
  log(`kerb corners rounded: ${rounded} m² off ${pieces.filter((p) => corner[p.id]).length} corners`);
}
const lab = new Int32Array(W * H);
const comps = labelComponents(W, H, (k) => D[k] === 1, lab);
log(`${comps.length} islands labelled`);

// --- Land use & green space (OpenStreetMap areas) --------------------------------------------------------------------
const areaEls = loadOsm('areas');
const GREEN = { park: 1, garden: 1, playground: 1, dog_park: 1, recreation_ground: 1, village_green: 1, grass: 1, grassland: 1, cemetery: 1, nature_reserve: 2, wood: 2, forest: 2, scrub: 2, pitch: 3, golf_course: 1, flowerbed: 1 };
const USE = { commercial: 1, retail: 1, industrial: 2, railway: 2, construction: 2, brownfield: 2, residential: 3, education: 4, religious: 4, military: 2 };
const greenR = new Raster(R.x0, R.z0, R.x1, R.z1, RES); // 1 lawn, 2 woods, 3 sports pitch, 4 water, 5 sand
const useR = new Raster(R.x0, R.z0, R.x1, R.z1, RES); // 1 commercial, 2 industrial, 3 residential, 4 institutional
const greens = []; // { kind, name, poly }
const parkNames = []; // named parks for labels: { name, ring }
const piers = [];
const rails = [];
// big to small, so a pitch or pond inside a park is drawn over it
const areaList = [];
for (const e of areaEls) {
  const t = e.tags || {};
  if (t.railway === 'rail' && e.type === 'way' && !isClosedWay(e) && !(t.tunnel && t.tunnel !== 'no') && t.service !== 'siding' && t.service !== 'yard') {
    rails.push({ pts: wayPts(e), bridge: t.bridge && t.bridge !== 'no' ? 1 : 0 });
    continue;
  }
  const polys = areaPolygons(e);
  if (!polys.length) continue;
  const area = polys.reduce((s, p) => s + Math.abs(ringArea(p.outer)), 0);
  let green = 0, use = 0;
  const g = t.leisure || t.landuse || t.natural;
  if (t.natural === 'water' || t.leisure === 'swimming_pool') green = t.leisure === 'swimming_pool' ? 0 : 4;
  else if (t.natural === 'beach' || t.natural === 'sand') green = 5;
  else if (GREEN[t.leisure] || GREEN[t.landuse] || GREEN[t.natural]) green = GREEN[t.leisure] || GREEN[t.landuse] || GREEN[t.natural];
  if (USE[t.landuse]) use = USE[t.landuse];
  if (/^(university|school|hospital)$/.test(t.amenity || '')) use = 4;
  if (t.man_made === 'pier' || t.man_made === 'breakwater') {
    for (const p of polys) piers.push({ name: t.name || '', kind: t.man_made, floating: t.floating === 'yes' ? 1 : 0, ring: p.outer });
    continue;
  }
  if (!green && !use) continue;
  if (t.leisure === 'pitch' && (t.sport === 'tennis' || t.sport === 'basketball' || t.sport === 'netball' || t.surface === 'asphalt' || t.surface === 'concrete' || area < 300)) continue; // hard courts
  if (t.leisure === 'park' && t.name) for (const p of polys) parkNames.push({ name: t.name, ring: p.outer, area });
  areaList.push({ polys, area, green, use, name: t.name || '', tag: g });
}
areaList.sort((a, b) => b.area - a.area);
for (const a of areaList) {
  for (const p of a.polys) {
    if (a.green) greenR.fillPolygon(p, a.green);
    if (a.use) useR.fillPolygon(p, a.use);
  }
}
log(`${areaList.length} land-use & green areas, ${piers.length} piers & breakwaters, ${rails.length} rail lines`);

// --- Blocks ------------------------------------------------------------------------------------------------------------
const blocks = [];
const blockOfComp = new Int32Array(comps.length + 1).fill(-1);
let specks = 0, holed = 0;
for (const c of comps) {
  const area = c.n * RES * RES;
  if (area < 30) { specks++; continue; }
  let poly = destair(traceComponent(lab, W, H, c, X0, Z0, RES), RES * 1.5);
  poly = rdpRing(poly, 0.45);
  if (poly.length < 3) continue;
  if (ringArea(poly) > 0) poly.reverse();
  if (Math.abs(ringArea(poly)) > area * 1.08 + 40) holed++;
  // what stands on it
  let nGreen = 0, nWood = 0, nPitch = 0, nWater = 0, nBuilt = 0, nCom = 0, nInd = 0, nRes = 0, nInst = 0;
  for (let j = c.j0; j <= c.j1; j++) {
    for (let i = c.i0; i <= c.i1; i++) {
      const k = j * W + i;
      if (lab[k] !== c.id) continue;
      const g = greenR.d[k], u = useR.d[k];
      if (g === 1) nGreen++; else if (g === 2) nWood++; else if (g === 3) nPitch++; else if (g === 4) nWater++;
      if (built.d[k]) nBuilt++;
      if (u === 1) nCom++; else if (u === 2) nInd++; else if (u === 3) nRes++; else if (u === 4) nInst++;
    }
  }
  const n = c.n;
  const park = (nGreen + nWood + nPitch + nWater) / n;
  const bw = (c.i1 - c.i0 + 1) * RES, bd = (c.j1 - c.j0 + 1) * RES;
  // 0 paved (city & shops), 1 gardens (houses), 2 park, 3 yard (port, rail, industry)
  let kind;
  if (park > 0.6 && nBuilt / n < 0.25) kind = 2;
  else if (nInd / n > 0.45) kind = 3;
  else if (nBuilt / n > 0.4 || (nCom + nInd) / n > 0.4 || (nInst / n > 0.5 && nBuilt / n > 0.22)) kind = 0;
  else kind = 1;
  // small leftovers between roads: traffic islands
  const narrow = Math.min(bw, bd) < 7 || area < 90 || area / (Math.hypot(bw, bd) || 1) < 2.6;
  blockOfComp[c.id] = blocks.length;
  blocks.push({ poly, area: Math.round(area), kind, park: Math.round(park * 100) / 100, wood: Math.round((nWood / n) * 100) / 100, built: Math.round((nBuilt / n) * 100) / 100, island: narrow && nBuilt === 0 ? 1 : 0, name: '', comp: c });
}
// park names: the named park covering most of each park block
for (const p of parkNames.sort((a, b) => b.area - a.area)) {
  const hits = new Map();
  const bb = { x0: Math.min(...p.ring.map((q) => q[0])), x1: Math.max(...p.ring.map((q) => q[0])), z0: Math.min(...p.ring.map((q) => q[1])), z1: Math.max(...p.ring.map((q) => q[1])) };
  const tmp = new Raster(bb.x0, bb.z0, bb.x1, bb.z1, 4);
  tmp.fillRing(p.ring, 1);
  for (let j = 0; j < tmp.h; j++) for (let i = 0; i < tmp.w; i++) {
    if (!tmp.d[j * tmp.w + i]) continue;
    const x = tmp.x0 + (i + 0.5) * 4, z = tmp.z0 + (j + 0.5) * 4;
    const gi = Math.floor((x - X0) / RES), gj = Math.floor((z - Z0) / RES);
    if (gi < 0 || gj < 0 || gi >= W || gj >= H) continue;
    const b = blockOfComp[lab[gj * W + gi]];
    if (b >= 0) hits.set(b, (hits.get(b) || 0) + 16);
  }
  for (const [b, a] of hits) if (a > blocks[b].area * 0.35 && blocks[b].kind === 2) blocks[b].name = p.name; // (the smaller park wins: sorted big to small)
}
log(`${blocks.length} blocks (${blocks.filter((b) => b.kind === 0).length} paved, ${blocks.filter((b) => b.kind === 1).length} gardens, ${blocks.filter((b) => b.kind === 2).length} parks, ${blocks.filter((b) => b.kind === 3).length} yards, ${blocks.filter((b) => b.island).length} traffic islands); ${specks} specks dropped; ${holed} with enclosed roadway`);

// --- Queries for the other generators -----------------------------------------------------------------------------------
const cell = (x, z) => {
  const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
  return i >= 0 && j >= 0 && i < W && j < H ? j * W + i : -1;
};
/** Index of the block at (x, z), or -1 on a roadway, the water or beyond the detailed area */
export const blockIndexAt = (x, z) => {
  const k = cell(x, z);
  return k < 0 ? -1 : blockOfComp[lab[k]];
};
export const isLand = (x, z) => { const k = cell(x, z); return k >= 0 && land.d[k] === 1; };
export const isRoad = (x, z) => { const k = cell(x, z); return k >= 0 && road.d[k] === 1 && land.d[k] === 1; };
export const greenAt = (x, z) => { const k = cell(x, z); return k < 0 ? 0 : greenR.d[k]; };
export const useAt = (x, z) => { const k = cell(x, z); return k < 0 ? 0 : useR.d[k]; };
export { distBuilding };
// distance (m) from a block cell to the nearest roadway or water
const toEdge = (() => {
  const tmp = new Raster(R.x0, R.z0, R.x1, R.z1, RES);
  tmp.d = D;
  return tmp.edt((v) => v === 0);
})();
export const distCurb = (x, z) => { const k = cell(x, z); return k < 0 ? 0 : Math.sqrt(toEdge[k]) * RES; };

// --- Green overlays: lawns, woods, pitches, ponds & beaches lying on blocks that aren't parks themselves -----------------
function onBlocks(ring, minShare) {
  let n = 0, on = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s < L; s += 2) {
      n++;
      if (blockIndexAt(ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L) >= 0) on++;
    }
  }
  return n > 0 && on / n >= minShare;
}
for (const a of areaList) {
  if (!a.green || a.area < 60) continue;
  for (const p of a.polys) {
    if (Math.abs(ringArea(p.outer)) < 60) continue;
    const s = rdpRing(p.outer, 0.5);
    if (s.length < 3) continue;
    const wet = a.green === 4 || a.green === 5;
    if (!onBlocks(s, wet ? 0.9 : 0.985)) continue;
    // on a park block a lawn is nothing new; woods, pitches, ponds & sand are
    const [mx, mz] = s.reduce((t, q) => [t[0] + q[0] / s.length, t[1] + q[1] / s.length], [0, 0]);
    const b = blockIndexAt(mx, mz);
    if (a.green === 1 && b >= 0 && blocks[b].kind === 2) continue;
    if (ringArea(s) > 0) s.reverse();
    greens.push({ kind: a.green, name: a.name, ring: s, holes: p.holes.map((h) => rdpRing(h, 0.5)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 20) });
  }
}
log(`${greens.length} green overlays (${greens.filter((g) => g.kind === 1).length} lawns, ${greens.filter((g) => g.kind === 2).length} woods, ${greens.filter((g) => g.kind === 3).length} pitches, ${greens.filter((g) => g.kind === 4).length} ponds, ${greens.filter((g) => g.kind === 5).length} beaches)`);

// --- Park paths: the stretches of footpaths that cross lawns & woods -------------------------------------------------
const parkPaths = [];
{
  const onLawn = (x, z) => {
    const b = blockIndexAt(x, z);
    if (b < 0 || distBuilding(x, z) < 1.5) return false;
    const g = greenAt(x, z);
    return blocks[b].kind === 2 || g === 1 || g === 2 || g === 3;
  };
  for (const p of paths) {
    const w = p.kind === 'mall' ? 4.5 : p.kind === 'cycle' ? 3 : p.kind === 'steps' ? 2 : 2.2;
    let run = null;
    const flush = () => {
      if (run && polylineLength(run) > 12) parkPaths.push({ w, pts: rdp(run, 0.4) });
      run = null;
    };
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const [ax, az] = p.pts[i], [bx, bz] = p.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(L / 3));
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((bx - ax) * k) / steps, z = az + ((bz - az) * k) / steps;
        if (onLawn(x, z)) (run || (run = [])).push([x, z]);
        else flush();
      }
    }
    flush();
  }
  log(`${parkPaths.length} park paths (${(parkPaths.reduce((t, p) => t + polylineLength(p.pts), 0) / 1000).toFixed(1)} km)`);
}

export { blocks, greens, parkPaths, piers, rails, lab as blockLabels, W as rasterW, H as rasterH, X0 as rasterX0, Z0 as rasterZ0 };
