// tools/geo-coast.mjs — land polygons from the OpenStreetMap coastline.
// OSM coastline ways run with the land on their left. Ways are chained end to end; closed chains are islands, open
// ones are cut at a rectangle and closed along its edge (walking it anticlockwise on the map, land on the left).
import { toWorld, rectWorld, DETAIL, WIDE } from './akl-frame.mjs';
import { loadOsm, ringArea, rdp, rdpRing, pointInRing, log } from './geo-util.mjs';

function chainCoastline(elements) {
  const ways = elements.filter((e) => e.type === 'way' && e.geometry && e.nodes);
  const byStart = new Map();
  const byEnd = new Map();
  for (const w of ways) {
    byStart.set(w.nodes[0], w);
    byEnd.set(w.nodes[w.nodes.length - 1], w);
  }
  const used = new Set();
  const chains = [];
  for (const w of ways) {
    if (used.has(w.id)) continue;
    // back to the chain's first way (or all the way round a closed one)
    let first = w;
    const seen = new Set([w.id]);
    for (;;) {
      const prev = byEnd.get(first.nodes[0]);
      if (!prev || seen.has(prev.id) || used.has(prev.id)) break;
      seen.add(prev.id);
      first = prev;
    }
    const pts = [];
    let cur = first;
    let last = null;
    while (cur && !used.has(cur.id)) {
      used.add(cur.id);
      const g = cur.geometry.map((p) => toWorld(p.lon, p.lat));
      pts.push(...(pts.length ? g.slice(1) : g));
      last = cur.nodes[cur.nodes.length - 1];
      cur = byStart.get(last);
    }
    chains.push({ pts, closed: last === first.nodes[0] });
  }
  return chains;
}

// Position along the rectangle's edge, growing anticlockwise on the map (x east, z south): the south edge eastwards,
// the east edge northwards, the north edge westwards, the west edge southwards
function perimeter(r, x, z) {
  const W = r.x1 - r.x0, H = r.z1 - r.z0;
  const e = 1e-6;
  if (Math.abs(z - r.z1) < e) return x - r.x0;
  if (Math.abs(x - r.x1) < e) return W + (r.z1 - z);
  if (Math.abs(z - r.z0) < e) return W + H + (r.x1 - x);
  return 2 * W + H + (z - r.z0);
}
const corners = (r) => {
  const W = r.x1 - r.x0, H = r.z1 - r.z0;
  return [[W, [r.x1, r.z1]], [W + H, [r.x1, r.z0]], [2 * W + H, [r.x0, r.z0]], [2 * W + 2 * H, [r.x0, r.z1]]];
};

// The pieces of polyline `pts` inside rect r, each from where it enters to where it leaves
function clipLine(pts, r, closed) {
  const inside = (p) => p[0] > r.x0 && p[0] < r.x1 && p[1] > r.z0 && p[1] < r.z1;
  // parameter of the crossing of a -> b with the rect's edge (a, b on different sides)
  const cross = (a, b) => {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dz, a[1] - r.z0], [dz, r.z1 - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    const at = (t) => {
      const x = a[0] + dx * t, z = a[1] + dz * t;
      // snap onto the edge
      const sx = Math.abs(x - r.x0) < 1e-7 ? r.x0 : Math.abs(x - r.x1) < 1e-7 ? r.x1 : x;
      const sz = Math.abs(z - r.z0) < 1e-7 ? r.z0 : Math.abs(z - r.z1) < 1e-7 ? r.z1 : z;
      return [Math.min(r.x1, Math.max(r.x0, sx)), Math.min(r.z1, Math.max(r.z0, sz))];
    };
    return [at(t0), at(t1), t0 > 0, t1 < 1];
  };
  const n = pts.length;
  // a closed chain starts at an outside vertex, so pieces never wrap around its seam
  let start = 0;
  if (closed) {
    start = pts.findIndex((p) => !inside(p));
    if (start < 0) return { pieces: [], ring: pts };
  }
  const seq = closed ? [...pts.slice(start), ...pts.slice(0, start), pts[start]] : pts;
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    const ia = inside(a), ib = inside(b);
    if (ia && ib) {
      if (!cur) cur = [a];
      cur.push(b);
    } else {
      const c = cross(a, b);
      if (!c) continue;
      if (ia) {
        // leaves
        if (!cur) cur = [a];
        cur.push(c[1]);
        pieces.push(cur);
        cur = null;
      } else if (ib) {
        cur = [c[0], b]; // enters
      } else pieces.push([c[0], c[1]]); // passes through
    }
  }
  if (cur && !closed && n) pieces.push(cur); // (a chain ending inside the rect: data cut short)
  return { pieces, ring: null };
}

/** Land polygons (outer rings, anticlockwise on the map) inside rect r */
function landInRect(chains, r, name) {
  const pieces = [];
  const rings = [];
  for (const c of chains) {
    if (c.closed && c.pts.length > 3) {
      const res = clipLine(c.pts.slice(0, -1), r, true);
      if (res.ring) rings.push(res.ring);
      pieces.push(...res.pieces);
    } else pieces.push(...clipLine(c.pts, r, false).pieces);
  }
  const P = 2 * (r.x1 - r.x0 + r.z1 - r.z0);
  const items = pieces.filter((p) => p.length >= 2).map((pts) => ({
    pts, tIn: perimeter(r, pts[0][0], pts[0][1]), tOut: perimeter(r, pts[pts.length - 1][0], pts[pts.length - 1][1]), used: false
  }));
  const dangling = items.filter((it) => {
    const end = it.pts[it.pts.length - 1];
    return end[0] > r.x0 + 1e-6 && end[0] < r.x1 - 1e-6 && end[1] > r.z0 + 1e-6 && end[1] < r.z1 - 1e-6;
  });
  if (dangling.length) log(`  ${name}: ${dangling.length} coastline pieces end inside the rectangle (data cut short?)`);
  const cs = corners(r);
  for (const first of items) {
    if (first.used) continue;
    const ring = [];
    let cur = first;
    for (let guard = 0; guard < items.length + 2; guard++) {
      cur.used = true;
      ring.push(...cur.pts);
      // along the edge to the next entry
      let next = null, bd = Infinity;
      for (const it of items) {
        if (it.used && it !== first) continue;
        const d = (it.tIn - cur.tOut + P) % P;
        if (d < bd) { bd = d; next = it; }
      }
      for (const [t, p] of cs.map(([t, p]) => [(t - cur.tOut + P) % P, p]).filter(([t]) => t > 0 && t < bd).sort((a, b) => a[0] - b[0])) ring.push(p);
      if (!next || next === first) break;
      cur = next;
    }
    rings.push(ring);
  }
  // Orientation: land rings are anticlockwise on the map = negative shoelace area in (x, z south); the others are water
  const land = [];
  const lakes = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const a = ringArea(ring);
    (a < 0 ? land : lakes).push(ring);
  }
  // No coastline through the rect's edge: all land when a lake or nothing sits in it and the caller says so
  return { land, lakes };
}

const coastEls = loadOsm('coast');
const chains = chainCoastline(coastEls);
log(`coastline: ${coastEls.length} ways -> ${chains.length} chains (${chains.filter((c) => c.closed).length} closed)`);

const wideRect = rectWorld(WIDE);
const detailRect = rectWorld(DETAIL);

function build(rect, eps, minArea, name) {
  const { land, lakes } = landInRect(chains, rect, name);
  const polys = land.map((ring) => {
    // corners of the rectangle stay put through the simplification
    let s = rdpRing(ring, eps);
    if (s.length < 3) s = ring;
    return { outer: s, holes: [], area: Math.abs(ringArea(s)) };
  }).filter((p) => p.area >= minArea).sort((a, b) => b.area - a.area);
  for (const lake of lakes) {
    const host = polys.find((p) => pointInRing(p.outer, lake[0][0], lake[0][1]));
    if (host && Math.abs(ringArea(lake)) > minArea) host.holes.push(rdpRing(lake, eps));
  }
  log(`${name}: ${polys.length} land polygons, ${polys.reduce((t, p) => t + p.outer.length, 0)} pts, ${(polys.reduce((t, p) => t + p.area, 0) / 1e6).toFixed(1)} km²; holes ${polys.reduce((t, p) => t + p.holes.length, 0)}`);
  return polys;
}

/** Land of the whole region (clipped to the WIDE rectangle), simplified to ~4 m */
export const regionLand = build(wideRect, 4, 2500, 'region');
/** Land of the detailed area (clipped to the DETAIL rectangle), simplified to 0.6 m */
export const detailLand = build(detailRect, 0.6, 30, 'detail');
export { chains as coastChains, wideRect, detailRect, rdp };
