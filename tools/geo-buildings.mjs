// tools/geo-buildings.mjs — building footprints of the detailed area from OpenStreetMap (largely LINZ & Auckland Council
// outlines), with the heights OSM knows. Buildings mapped in 3D parts are replaced by their parts.
import { rectWorld, DETAIL } from './akl-frame.mjs';
import { loadOsm, areaPolygons, ringArea, ringCentroid, bbox, pointInRing, log } from './geo-util.mjs';

const R = rectWorld(DETAIL);
const num = (v) => {
  const f = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(f) ? f : null;
};

function parse(e, part) {
  const t = e.tags || {};
  const kind = part ? t['building:part'] : t.building;
  if (!kind || kind === 'no') return null;
  if (/^(roof|bridge|ruins|collapsed|tent|canopy)$/.test(kind)) return null; // open structures & skybridges
  if (t.location === 'underground' || num(t.layer) < 0 || t.man_made === 'bridge') return null;
  const minH = num(t.min_height) || (num(t['building:min_level']) || 0) * 3.4;
  if (minH > 2.5) return null; // floating parts (skybridges, the Sky Tower's pod...)
  const polys = areaPolygons(e).map((p) => {
    if (ringArea(p.outer) > 0) p.outer.reverse(); // anticlockwise on the map
    for (const h of p.holes) if (ringArea(h) < 0) h.reverse();
    return p;
  }).filter((p) => Math.abs(ringArea(p.outer)) > 4);
  if (!polys.length) return null;
  const area = polys.reduce((s, p) => s + Math.abs(ringArea(p.outer)) - p.holes.reduce((u, h) => u + Math.abs(ringArea(h)), 0), 0);
  const main = polys.reduce((a, p) => (Math.abs(ringArea(p.outer)) > Math.abs(ringArea(a.outer)) ? p : a));
  const [cx, cz] = ringCentroid(main.outer);
  if (cx < R.x0 || cx > R.x1 || cz < R.z0 || cz > R.z1) return null;
  let height = num(t.height);
  const levels = num(t['building:levels']);
  if (height !== null && (height < 1.5 || height > 400)) height = null;
  const year = parseInt(String(t.start_date || t['building:year'] || '').slice(0, 4), 10);
  return {
    id: e.id, part, kind, name: t.name || '', polys, area, cx, cz, bb: bbox(main.outer),
    height, levels: levels > 0 && levels < 90 ? levels : null, roofLevels: num(t['roof:levels']) || 0,
    year: year > 1800 && year < 2100 ? year : 0, amenity: t.amenity || t.tourism || t.shop || t.office || ''
  };
}

const elements = loadOsm('buildings');
const outlines = [];
const parts = [];
for (const e of elements) {
  const t = e.tags || {};
  if (t['building:part'] && !t.building) {
    const p = parse(e, true);
    if (p) parts.push(p);
  } else if (t.building) {
    const b = parse(e, false);
    if (b) outlines.push(b);
  }
}

// Buildings drawn as 3D parts: the parts stand in for the outline. Where they don't cover it, the outline stays as a
// podium no taller than its lowest part.
const tall = (b) => b.height ?? (b.levels ? b.levels * 3.4 + 1 : null);
const cellOf = (x, z) => `${Math.floor(x / 120)},${Math.floor(z / 120)}`;
const partCells = new Map();
for (const p of parts) {
  if (tall(p) === null) continue;
  const k = cellOf(p.cx, p.cz);
  if (!partCells.has(k)) partCells.set(k, []);
  partCells.get(k).push(p);
}
const buildings = [];
let replaced = 0;
const usedParts = new Set();
for (const b of outlines) {
  const mine = [];
  for (let ix = Math.floor((b.bb.x0 - 1) / 120); ix <= Math.floor((b.bb.x1 + 1) / 120); ix++) {
    for (let iz = Math.floor((b.bb.z0 - 1) / 120); iz <= Math.floor((b.bb.z1 + 1) / 120); iz++) {
      for (const p of partCells.get(`${ix},${iz}`) || []) {
        if (!usedParts.has(p) && b.polys.some((q) => pointInRing(q.outer, p.cx, p.cz))) mine.push(p);
      }
    }
  }
  if (!mine.length) { buildings.push(b); continue; }
  replaced++;
  for (const p of mine) {
    usedParts.add(p);
    buildings.push({ ...p, name: p.name || b.name, kind: b.kind, year: p.year || b.year, parent: b.id });
  }
  const cover = mine.reduce((s, p) => s + p.area, 0) / b.area;
  if (cover < 0.9) {
    const low = Math.min(...mine.map(tall));
    const own = tall(b);
    buildings.push({ ...b, height: Math.max(3, Math.min(own ?? low, low)), levels: null, podium: true });
  }
}
log(`${outlines.length} building outlines, ${parts.length} parts; ${replaced} buildings drawn from ${usedParts.size} parts -> ${buildings.length} buildings`);

/** Smallest rectangle around a ring: { cx, cz, w (long side), d, ang (of the long side, radians from +x towards +z) } */
export function orientedBox(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uz, u0, u1, v0, v1 } = best;
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  let w = u1 - u0, d = v1 - v0, ang = Math.atan2(uz, ux);
  if (d > w) { [w, d] = [d, w]; ang += Math.PI / 2; }
  ang = ((ang % Math.PI) + Math.PI) % Math.PI;
  return { cx: uc * ux - vc * uz, cz: uc * uz + vc * ux, w, d, ang, area: best.area };
}

export { buildings };
