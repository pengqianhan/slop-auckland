// tools/geo-terrain.mjs — the ground's elevation, from LINZ's LiDAR models sampled by tools/fetch-terrain.mjs.
//   detail: the detailed area's ground on a 5 m grid (smoothed over ~7 m, so streets ride evenly), world heights
//   region: the whole region's ground on a 32 m grid (the volcanic cones, the North Shore, Rangitoto)
//   groundAt / surfaceAt: the 2 m ground (DEM) and surface (DSM: roofs, bridge decks) for the other generators
// World height y = elevation - SEA: the harbour's surface is drawn at y = -2.2, the quays stand at about y = 0.3.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { rectWorld, DETAIL, WIDE } from './akl-frame.mjs';
import { log, Raster } from './geo-util.mjs';
import { regionLand } from './geo-coast.mjs';
import { isLand } from './geo-blocks.mjs';

export const SEA = 3.0; // elevation (NZVD2016, m) of world height 0
export const SEABED = -3.6;
const LAND_MIN = 0.12;

function load(name) {
  const file = fileURLToPath(new URL(`data/${name}.bin.gz`, import.meta.url));
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: run "node tools/fetch-terrain.mjs"`);
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const nl = buf.indexOf(10);
  const grid = JSON.parse(buf.subarray(0, nl).toString());
  const raw = new Int16Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + nl + 1 + grid.w * grid.h * 2));
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw[i] === -32768 ? NaN : raw[i] / 100 - SEA;
  return { ...grid, data };
}
function bilinear(g, x, z) {
  const fx = Math.max(0, Math.min(g.w - 1.001, (x - g.x0) / g.cell));
  const fz = Math.max(0, Math.min(g.h - 1.001, (z - g.z0) / g.cell));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * g.w + i;
  return (g.data[k] * (1 - u) + g.data[k + 1] * u) * (1 - v) + (g.data[k + g.w] * (1 - u) + g.data[k + g.w + 1] * u) * v;
}
const inGrid = (g, x, z) => x >= g.x0 && z >= g.z0 && x <= g.x0 + (g.w - 1) * g.cell && z <= g.z0 + (g.h - 1) * g.cell;

const dem = load('dem_detail');
const dsm = load('dsm_detail');
const demRegion = load('dem_region');
// An extra strip of ground & surface around the Harbour Bridge, north of the detailed area
const patches = [];
for (const name of ['bridge']) {
  const f = fileURLToPath(new URL(`data/dem_${name}.bin.gz`, import.meta.url));
  if (fs.existsSync(f)) patches.push({ dem: load(`dem_${name}`), dsm: load(`dsm_${name}`) });
}

/** Ground (bare earth) height at (x, z): 2 m data in the detailed area, 24 m beyond */
export function groundAt(x, z) {
  if (inGrid(dem, x, z)) return bilinear(dem, x, z);
  for (const p of patches) if (inGrid(p.dem, x, z)) return bilinear(p.dem, x, z);
  const v = bilinear(demRegion, x, z);
  return Number.isNaN(v) ? SEABED : v;
}
/** Surface height at (x, z) with whatever stands there (roofs, tree tops, bridge decks); NaN where there is no 2 m data */
export function surfaceAt(x, z) {
  if (inGrid(dsm, x, z)) return bilinear(dsm, x, z);
  for (const p of patches) if (inGrid(p.dsm, x, z)) return bilinear(p.dsm, x, z);
  return NaN;
}

// --- The detailed grid: land-only smoothing of the 2 m ground, sampled every 5 m ---------------------------------------
const R = rectWorld(DETAIL);
const CELL = 5;
const detail = { x0: Math.floor(R.x0 / CELL) * CELL, z0: Math.floor(R.z0 / CELL) * CELL, cell: CELL };
detail.w = Math.ceil((R.x1 - detail.x0) / CELL) + 1;
detail.h = Math.ceil((R.z1 - detail.z0) / CELL) + 1;
{
  // land mask on the 2 m grid, then a box blur (3 passes of +-2 cells ~ a 3.5 m gaussian) over land cells only
  const n = dem.w * dem.h;
  const mask = new Uint8Array(n);
  for (let j = 0; j < dem.h; j++) for (let i = 0; i < dem.w; i++) {
    const x = dem.x0 + i * dem.cell, z = dem.z0 + j * dem.cell;
    // beyond the detailed rectangle everything counts (the blur needs neighbours there); the sea is told by its height
    const inside = x > R.x0 && x < R.x1 && z > R.z0 && z < R.z1;
    mask[j * dem.w + i] = inside ? (isLand(x, z) ? 1 : 0) : (dem.data[j * dem.w + i] > -2.4 ? 1 : 0);
  }
  let val = new Float32Array(n), wgt = new Float32Array(n);
  for (let k = 0; k < n; k++) { val[k] = mask[k] ? dem.data[k] : 0; wgt[k] = mask[k]; }
  const pass = (src, w, h, horizontal) => {
    const out = new Float32Array(src.length);
    const r = 2;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) {
        const ii = horizontal ? Math.min(w - 1, Math.max(0, i + d)) : i, jj = horizontal ? j : Math.min(h - 1, Math.max(0, j + d));
        s += src[jj * w + ii];
      }
      out[j * w + i] = s;
    }
    return out;
  };
  for (let it = 0; it < 3; it++) {
    val = pass(pass(val, dem.w, dem.h, true), dem.w, dem.h, false);
    wgt = pass(pass(wgt, dem.w, dem.h, true), dem.w, dem.h, false);
    // renormalise between passes so the weights stay comparable
    for (let k = 0; k < n; k++) { if (wgt[k] > 0) { val[k] = mask[k] ? val[k] / wgt[k] : 0; } wgt[k] = mask[k]; }
  }
  const smooth = { ...dem, data: val };
  detail.data = new Float32Array(detail.w * detail.h);
  const land = new Uint8Array(detail.w * detail.h);
  for (let j = 0; j < detail.h; j++) for (let i = 0; i < detail.w; i++) {
    const x = detail.x0 + i * CELL, z = detail.z0 + j * CELL;
    const k = j * detail.w + i;
    const li = Math.round((x - dem.x0) / dem.cell), lj = Math.round((z - dem.z0) / dem.cell);
    land[k] = mask[lj * dem.w + li];
    detail.data[k] = land[k] ? Math.max(LAND_MIN, bilinear(smooth, x, z)) : NaN;
  }
  // The land's height carries on a few cells past the shore (the ground mesh is cut at the coastline, so its edge
  // must not sag towards the sea bed); the rest of the water is sea bed
  for (let it = 0; it < 4; it++) {
    const next = detail.data.slice();
    for (let j = 0; j < detail.h; j++) for (let i = 0; i < detail.w; i++) {
      const k = j * detail.w + i;
      if (!Number.isNaN(detail.data[k])) continue;
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= detail.w || jj >= detail.h) continue;
        const v = detail.data[jj * detail.w + ii];
        if (!Number.isNaN(v)) { s += v; c++; }
      }
      if (c) next[k] = s / c;
    }
    detail.data = next;
  }
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < detail.data.length; k++) {
    if (Number.isNaN(detail.data[k])) detail.data[k] = SEABED;
    else { lo = Math.min(lo, detail.data[k]); hi = Math.max(hi, detail.data[k]); }
  }
  log(`terrain: detailed grid ${detail.w} x ${detail.h} @ ${CELL} m, land ${lo.toFixed(1)} .. ${hi.toFixed(1)} m`);
}

/** Height of the game's ground at (x, z) in the detailed area: the 5 m grid, each cell split along its (i, j)-(i+1, j+1) diagonal */
export function terrainAt(x, z) {
  const fx = Math.max(0, Math.min(detail.w - 1.0001, (x - detail.x0) / CELL));
  const fz = Math.max(0, Math.min(detail.h - 1.0001, (z - detail.z0) / CELL));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * detail.w + i;
  const a = detail.data[k], b = detail.data[k + 1], c = detail.data[k + detail.w], d = detail.data[k + detail.w + 1];
  return u >= v ? a + (b - a) * u + (d - b) * v : a + (c - a) * v + (d - c) * u;
}

// --- The regional grid: 32 m, land raised clear of the water, the sea put on the sea bed -------------------------------
const RW = rectWorld(WIDE);
const RCELL = 32;
const region = { x0: Math.floor(RW.x0 / RCELL) * RCELL, z0: Math.floor(RW.z0 / RCELL) * RCELL, cell: RCELL };
region.w = Math.ceil((RW.x1 - region.x0) / RCELL) + 1;
region.h = Math.ceil((RW.z1 - region.z0) / RCELL) + 1;
{
  const land = new Raster(region.x0 - RCELL / 2, region.z0 - RCELL / 2, region.x0 + region.w * RCELL, region.z0 + region.h * RCELL, RCELL);
  for (const p of regionLand) land.fillRing(p.outer, 1);
  region.data = new Float32Array(region.w * region.h);
  const isL = new Uint8Array(region.w * region.h);
  for (let j = 0; j < region.h; j++) for (let i = 0; i < region.w; i++) {
    const x = region.x0 + i * RCELL, z = region.z0 + j * RCELL;
    const k = j * region.w + i;
    isL[k] = land.at(x, z);
    let v = bilinear(demRegion, x, z);
    // the detailed area's own ground, so the two meet
    if (x > R.x0 + 8 && x < R.x1 - 8 && z > R.z0 + 8 && z < R.z1 - 8 && isL[k]) v = terrainAt(x, z);
    region.data[k] = isL[k] ? Math.max(0.3, Number.isNaN(v) ? 0.3 : v) : NaN;
  }
  for (let it = 0; it < 2; it++) {
    const next = region.data.slice();
    for (let j = 0; j < region.h; j++) for (let i = 0; i < region.w; i++) {
      const k = j * region.w + i;
      if (!Number.isNaN(region.data[k])) continue;
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= region.w || jj >= region.h) continue;
        const v = region.data[jj * region.w + ii];
        if (!Number.isNaN(v)) { s += v; c++; }
      }
      if (c) next[k] = s / c;
    }
    region.data = next;
  }
  let hi = -Infinity;
  for (let k = 0; k < region.data.length; k++) {
    if (Number.isNaN(region.data[k])) region.data[k] = SEABED;
    else hi = Math.max(hi, region.data[k]);
  }
  log(`terrain: regional grid ${region.w} x ${region.h} @ ${RCELL} m, highest ${hi.toFixed(0)} m`);
}

// The edge of the detailed grid eases into the regional one over 60 m, so the two meshes meet without a step
{
  const regionAt = (x, z) => bilinear(region, x, z);
  for (let j = 0; j < detail.h; j++) for (let i = 0; i < detail.w; i++) {
    const x = detail.x0 + i * CELL, z = detail.z0 + j * CELL;
    const edge = Math.min(x - R.x0, R.x1 - x, z - R.z0, R.z1 - z);
    if (edge > 60) continue;
    const k = j * detail.w + i;
    if (detail.data[k] <= SEABED + 0.01) continue;
    const far = regionAt(x, z);
    if (far <= SEABED + 0.5) continue; // the regional grid has water here (a narrow inlet): keep the detailed ground
    const t = Math.max(0, Math.min(1, edge / 60));
    const s = t * t * (3 - 2 * t);
    detail.data[k] = far + (detail.data[k] - far) * s;
  }
}

/**
 * The height profile of a bridge deck along centreline `pts` ([x, z] points): LiDAR surface heights every 4 m, cleaned
 * of what stands on the deck, never below the ground, meeting the ground at both ends. Returns [[x, z, y], ...].
 */
export function deckProfile(pts, { step = 4, grounded = true } = {}) {
  const out = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const n = Math.max(2, Math.ceil(total / step));
  let seg = 0, s0 = 0;
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    while (seg + 2 < pts.length && s > s0 + Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1])) {
      s0 += Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
      seg++;
    }
    const L = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]) || 1;
    const t = Math.min(1, (s - s0) / L);
    const dx = (pts[seg + 1][0] - pts[seg][0]) / L, dz = (pts[seg + 1][1] - pts[seg][1]) / L;
    const x = pts[seg][0] + dx * L * t, z = pts[seg][1] + dz * L * t;
    // lowest of the surface on the centre line & 1.5 m either side: traffic & lamp posts stand above the deck
    const across = [];
    for (const o of [-1.5, 0, 1.5]) {
      const v = surfaceAt(x - dz * o, z + dx * o);
      if (!Number.isNaN(v)) across.push(v);
    }
    const g = groundAt(x, z);
    out.push([x, z, NaN, g, s, across]);
  }
  // The deck is the low side of what the laser saw within 8 m along it (a truss overhead, gantries and lorries
  // stand above it): the 20th percentile, which a steady grade hardly lowers
  for (let i = 0; i <= n; i++) {
    const near = [];
    for (let k = Math.max(0, i - 2); k <= Math.min(n, i + 2); k++) near.push(...out[k][5]);
    near.sort((a, b) => a - b);
    if (near.length) out[i][2] = near[Math.floor(near.length * 0.2)];
  }
  // median of 5 along the deck, then a moving average
  const ys = out.map((p) => p[2]);
  const med = ys.map((_, i) => {
    const w = ys.slice(Math.max(0, i - 2), i + 3).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    return w.length ? w[Math.floor(w.length / 2)] : NaN;
  });
  // no surface data (beyond the 2 m grids): a straight line between the deck's ends
  const first = med.findIndex((v) => !Number.isNaN(v));
  if (first < 0) {
    const a = out[0][3], b = out[n][3];
    return out.map((p, i) => [p[0], p[1], a + ((b - a) * i) / n]);
  }
  for (let i = 0; i <= n; i++) if (Number.isNaN(med[i])) med[i] = i ? med[i - 1] : med[first];
  let sm = med.slice();
  for (let it = 0; it < 2; it++) sm = sm.map((_, i) => (sm[Math.max(0, i - 1)] + sm[i] * 2 + sm[Math.min(n, i + 1)]) / 4);
  return out.map((p, i) => {
    let y = Math.max(sm[i] - 0.15, p[3]);
    if (grounded) {
      // the ends ride on the ground
      const e = Math.min(p[4], total - p[4]);
      const w = Math.max(0, Math.min(1, e / 10));
      y = terrainOrGround(p[0], p[1]) * (1 - w) + y * w;
    }
    return [p[0], p[1], y];
  });
}
const terrainOrGround = (x, z) => (x > R.x0 && x < R.x1 && z > R.z0 && z < R.z1 ? terrainAt(x, z) : groundAt(x, z));
export { terrainOrGround };

/** Height of what stands on a footprint ring above its lowest ground: { base, top } world heights, or null without data */
export function roofOver(ring, bb) {
  const hs = [];
  let base = Infinity;
  const step = Math.max(2, Math.min(bb.x1 - bb.x0, bb.z1 - bb.z0) / 12);
  for (let z = bb.z0 + step / 2; z < bb.z1; z += step) {
    for (let x = bb.x0 + step / 2; x < bb.x1; x += step) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      if (!inside) continue;
      const s = surfaceAt(x, z);
      if (!Number.isNaN(s)) hs.push(s);
      base = Math.min(base, groundAt(x, z));
    }
  }
  for (const [x, z] of ring) base = Math.min(base, groundAt(x, z));
  if (hs.length < 3) return null;
  hs.sort((a, b) => a - b);
  return { base, top: hs[Math.floor(hs.length * 0.75)], peak: hs[hs.length - 1], cover: hs.length };
}

// --- The game's terrain file ------------------------------------------------------------------------------------------
// 'AKH1', then two grids, each: x0, z0 (int32, m), cell (uint32, cm), w, h (uint32), then h rows of w heights as
// uint16 (2 cm steps above -40 m), every row stored as differences from the row above (the first from zero)
export function writeTerrain(file) {
  const parts = [Buffer.from('AKH1')];
  for (const g of [detail, region]) {
    const head = Buffer.alloc(20);
    head.writeInt32LE(g.x0, 0);
    head.writeInt32LE(g.z0, 4);
    head.writeUInt32LE(g.cell * 100, 8);
    head.writeUInt32LE(g.w, 12);
    head.writeUInt32LE(g.h, 16);
    const q = new Uint16Array(g.w * g.h);
    for (let k = 0; k < q.length; k++) q[k] = Math.max(0, Math.min(65535, Math.round((g.data[k] + 40) * 50)));
    const d = new Uint16Array(q.length);
    for (let k = 0; k < q.length; k++) d[k] = (q[k] - (k >= g.w ? q[k - g.w] : 0)) & 0xffff;
    parts.push(head, Buffer.from(d.buffer));
  }
  const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  gz.writeUInt32LE(0, 4);
  fs.writeFileSync(file, gz);
  log(`wrote ${file} (${(gz.length / 1024).toFixed(0)} KB)`);
}
export { detail as detailTerrain, region as regionTerrain };
