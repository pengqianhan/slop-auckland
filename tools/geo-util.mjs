// tools/geo-util.mjs — data loading, geometry helpers and raster tools shared by the geodata generators.
// The geometry helpers and the Raster class come from Slop New York's tools/geo-base.mjs (MIT, Mr.doob).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { toWorld } from './akl-frame.mjs';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const log = (...a) => console.log('[geodata]', ...a);

/** Elements of an Overpass extract (tools/fetch-osm.mjs) */
export function loadOsm(name) {
  const file = path.join(DATA, `osm_${name}.json.gz`);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: run "node tools/fetch-osm.mjs ${name}"`);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).elements;
}

export const wayPts = (e) => (e.geometry || []).filter(Boolean).map((g) => toWorld(g.lon, g.lat));
export const isClosedWay = (e) => e.type === 'way' && e.nodes && e.nodes.length > 3 && e.nodes[0] === e.nodes[e.nodes.length - 1];

/**
 * Outer & inner rings of an OSM area (closed way or multipolygon relation, from "out geom"): [{ outer, holes }].
 * A relation's member ways are chained end to end into closed rings; every inner ring goes to the outer containing it.
 */
export function areaPolygons(e) {
  if (e.type === 'way') {
    if (!isClosedWay(e)) return [];
    const ring = wayPts(e).slice(0, -1);
    return ring.length >= 3 ? [{ outer: ring, holes: [] }] : [];
  }
  if (e.type !== 'relation') return [];
  const close = (a, b) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
  const chain = (role) => {
    const parts = (e.members || []).filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && !m.role)) && m.geometry)
      .map((m) => m.geometry.filter(Boolean).map((g) => toWorld(g.lon, g.lat))).filter((p) => p.length > 1);
    const rings = [];
    while (parts.length) {
      let ring = parts.shift();
      for (let guard = 0; guard < 2000 && !close(ring[0], ring[ring.length - 1]); guard++) {
        const end = ring[ring.length - 1];
        const i = parts.findIndex((p) => close(p[0], end) || close(p[p.length - 1], end));
        if (i < 0) break;
        const p = parts.splice(i, 1)[0];
        ring = ring.concat(close(p[0], end) ? p.slice(1) : p.reverse().slice(1));
      }
      if (ring.length > 3 && close(ring[0], ring[ring.length - 1])) rings.push(ring.slice(0, -1));
    }
    return rings;
  };
  const polys = chain('outer').map((outer) => ({ outer, holes: [] }));
  for (const hole of chain('inner')) {
    const host = polys.find((p) => pointInRing(p.outer, hole[0][0], hole[0][1]));
    if (host) host.holes.push(hole);
  }
  return polys;
}

// =====================================================================================================================
// Geometry
// =====================================================================================================================
export function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
export function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
export const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
/** Area-weighted centroid of a ring */
export function ringCentroid(r) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const c = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += c; cx += (r[j][0] + r[i][0]) * c; cz += (r[j][1] + r[i][1]) * c;
  }
  return Math.abs(a) < 1e-9 ? centroid(r) : [cx / (3 * a), cz / (3 * a)];
}
export function pointInRing(r, x, z) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
// Ramer-Douglas-Peucker on an open polyline
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring (split at the two farthest-apart vertices)
export function rdpRing(ring, eps) {
  if (ring.length < 5) return ring.slice();
  const i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
// Raster stairs -> lines: short edges (stair steps) are replaced by their midpoints, vertices between two long edges
// (true corners) are kept
export function destair(out, short) {
  const n = out.length;
  const len = (i) => { const a = out[i], b = out[(i + 1) % n]; return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]); };
  const res = [];
  for (let i = 0; i < n; i++) {
    const prevLong = len((i + n - 1) % n) > short;
    const nextLong = len(i) > short;
    if (prevLong && nextLong) res.push(out[i]);
    if (!nextLong) { const a = out[i], b = out[(i + 1) % n]; res.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  }
  return res;
}
/** Sutherland-Hodgman clip of a ring to the rectangle [x0, x1] x [z0, z1] */
export function clipRingToRect(ring, x0, x1, z0, z1) {
  const clip = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    return out;
  };
  const lerpX = (a, b, x) => [x, a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0])];
  const lerpZ = (a, b, z) => [a[0] + ((z - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), z];
  let r = ring;
  r = clip(r, (p) => p[0] >= x0, (a, b) => lerpX(a, b, x0));
  r = clip(r, (p) => p[0] <= x1, (a, b) => lerpX(a, b, x1));
  r = clip(r, (p) => p[1] >= z0, (a, b) => lerpZ(a, b, z0));
  r = clip(r, (p) => p[1] <= z1, (a, b) => lerpZ(a, b, z1));
  return r;
}

// =====================================================================================================================
// Raster tools
// =====================================================================================================================
export class Raster {
  constructor(x0, z0, x1, z1, res) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Uint8Array(this.w * this.h);
  }
  at(x, z) {
    const i = Math.floor((x - this.x0) / this.res), j = Math.floor((z - this.z0) / this.res);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? this.d[j * this.w + i] : 0;
  }
  // Scanline fill of a ring (even-odd) with `val`; `only`: just the cells holding that value
  fillRing(ring, val = 1, only = -1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k];
        const [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) if (only < 0 || d[j * w + i] === only) d[j * w + i] = val;
      }
    }
  }
  // Polygon with holes (even-odd over all its rings)
  fillPolygon(poly, val = 1) {
    if (!poly.holes || !poly.holes.length) return this.fillRing(poly.outer, val);
    const { res, x0, z0, w, h, d } = this;
    const rings = [poly.outer, ...poly.holes];
    const bb = bbox(poly.outer);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
          const [xa, za] = ring[k];
          const [xb, zb] = ring[i];
          if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
        }
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Stamp a capsule (segment a-b, radius r) with `val`; `only`: just the cells holding that value
  stampCapsule(ax, az, bx, bz, r, val = 1, only = -1) {
    const { res, x0, z0, w, h, d } = this;
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / res));
    const ix1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + r - x0) / res));
    const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - r - z0) / res));
    const iz1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + r - z0) / res));
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1e-9;
    const r2 = r * r;
    for (let j = iz0; j <= iz1; j++) {
      const pz = z0 + (j + 0.5) * res;
      for (let i = ix0; i <= ix1; i++) {
        const k = j * w + i;
        if (only >= 0 && d[k] !== only) continue;
        const px = x0 + (i + 0.5) * res;
        let t = ((px - ax) * dx + (pz - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - px, ez = az + t * dz - pz;
        if (ex * ex + ez * ez <= r2) d[k] = val;
      }
    }
  }
  stampPolyline(pts, r, val = 1, only = -1) {
    for (let i = 0; i + 1 < pts.length; i++) this.stampCapsule(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, val, only);
  }
  // Squared Euclidean distance (in cells) from every cell to the nearest cell where isSource(v) is true (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const out = new Float32Array(w * h);
    const v = new Int32Array(Math.max(w, h));
    const zz = new Float64Array(Math.max(w, h) + 1);
    const dt1 = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0;
      zz[0] = -INF;
      zz[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zz[k] = s;
        zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => (out[q * w + i] = val));
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => (out[j * w + q] = val));
    return out;
  }
  // Morphological opening of the 1-cells with a disc of radius r metres
  open(r) {
    const rc = (r / this.res) ** 2;
    const toWater = this.edt((x) => x === 0);
    const eroded = new Uint8Array(this.d.length);
    for (let i = 0; i < eroded.length; i++) eroded[i] = toWater[i] > rc ? 1 : 0;
    const save = this.d;
    this.d = eroded;
    const toEroded = this.edt((x) => x === 1);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = this.d[i] && toEroded[i] <= rc + 1e-6 ? 1 : 0;
  }
  // Morphological closing (fills inlets / gaps narrower than 2r)
  close(r) {
    const rc = (r / this.res) ** 2;
    const toLand = this.edt((x) => x === 1);
    const dil = new Uint8Array(this.d.length);
    for (let i = 0; i < dil.length; i++) dil[i] = toLand[i] <= rc ? 1 : 0;
    const save = this.d;
    this.d = dil;
    const toGap = this.edt((x) => x === 0);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = dil[i] && toGap[i] > rc ? 1 : 0;
  }
}

/**
 * 4-connected components of the cells where label(k) is truthy, on a w x h grid: fills `lab` (Int32Array, ids from 1)
 * and returns [{ id, n, i0, i1, j0, j1, start }]
 */
export function labelComponents(w, h, isSet, lab) {
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!isSet(s0) || lab[s0]) continue;
    const id = comps.length + 1;
    let sp = 0, n = 0, i0 = w, i1 = -1, j0 = h, j1 = -1;
    stack[sp++] = s0;
    lab[s0] = id;
    while (sp) {
      const p = stack[--sp];
      n++;
      const i = p % w, j = (p - i) / w;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (i > 0 && isSet(p - 1) && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (i < w - 1 && isSet(p + 1) && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (j > 0 && isSet(p - w) && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
      if (j < h - 1 && isSet(p + w) && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ id, n, i0, i1, j0, j1, start: s0 });
  }
  return comps;
}

/**
 * Outer contour of the component `c` of label raster `lab` (w x h cells of `res` m from (x0, z0)) as a ring of
 * cell-corner points, the component kept on the right of the walk; collinear runs merged.
 */
export function traceComponent(lab, w, h, c, x0, z0, res) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h && lab[j * w + i] === c.id ? 1 : 0);
  const si = c.start % w, sj = (c.start - si) / w;
  const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
  let cx = si, cz = sj, dir = 0;
  const pts = [];
  const startX = cx, startZ = cz;
  let guard = 0;
  do {
    pts.push([x0 + cx * res, z0 + cz * res]);
    cx += DX[dir];
    cz += DZ[dir];
    let left, right;
    if (dir === 0) { left = at(cx, cz - 1); right = at(cx, cz); }
    else if (dir === 1) { left = at(cx, cz); right = at(cx - 1, cz); }
    else if (dir === 2) { left = at(cx - 1, cz); right = at(cx - 1, cz - 1); }
    else { left = at(cx - 1, cz - 1); right = at(cx, cz - 1); }
    if (left && right) dir = (dir + 3) % 4;
    else if (!right) dir = (dir + 1) % 4;
    if (++guard > 2e7) throw new Error('trace runaway');
  } while (cx !== startX || cz !== startZ || dir !== 0);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
    if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
  }
  return out;
}

// =====================================================================================================================
// PNG (8-bit RGB / RGBA / grey), for debug pictures and the region textures
// =====================================================================================================================
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function encodePNG(w, h, channels, data) {
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let j = 0; j < h; j++) {
    raw[j * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + j * stride, stride).copy(raw, j * (stride + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A small RGB canvas in world coordinates, for debug pictures of the generated geography */
export class DebugCanvas {
  constructor(x0, z0, x1, z1, scale) {
    this.x0 = x0; this.z0 = z0; this.scale = scale;
    this.w = Math.ceil((x1 - x0) * scale);
    this.h = Math.ceil((z1 - z0) * scale);
    this.d = new Uint8Array(this.w * this.h * 3);
  }
  clear(r, g, b) {
    for (let i = 0; i < this.w * this.h; i++) { this.d[i * 3] = r; this.d[i * 3 + 1] = g; this.d[i * 3 + 2] = b; }
  }
  px(i, j, c) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
    const k = (j * this.w + i) * 3;
    this.d[k] = c[0]; this.d[k + 1] = c[1]; this.d[k + 2] = c[2];
  }
  fill(ring, c) {
    const pts = ring.map(([x, z]) => [(x - this.x0) * this.scale, (z - this.z0) * this.scale]);
    const bb = bbox(pts);
    const xs = [];
    for (let j = Math.max(0, Math.floor(bb.z0)); j <= Math.min(this.h - 1, Math.ceil(bb.z1)); j++) {
      const z = j + 0.5;
      xs.length = 0;
      for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
        const [xa, za] = pts[k], [xb, zb] = pts[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        for (let i = Math.max(0, Math.ceil(xs[n] - 0.5)); i <= Math.min(this.w - 1, Math.floor(xs[n + 1] - 0.5)); i++) this.px(i, j, c);
      }
    }
  }
  line(pts, c, closed = false, thick = 1) {
    const n = pts.length;
    for (let s = 0; s < (closed ? n : n - 1); s++) {
      const a = pts[s], b = pts[(s + 1) % n];
      const ax = (a[0] - this.x0) * this.scale, az = (a[1] - this.z0) * this.scale;
      const bx = (b[0] - this.x0) * this.scale, bz = (b[1] - this.z0) * this.scale;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(bz - az))));
      for (let k = 0; k <= steps; k++) {
        const x = Math.round(ax + ((bx - ax) * k) / steps), z = Math.round(az + ((bz - az) * k) / steps);
        for (let dx = 0; dx < thick; dx++) for (let dz = 0; dz < thick; dz++) this.px(x + dx, z + dz, c);
      }
    }
  }
  dot(x, z, r, c) {
    const cx = Math.round((x - this.x0) * this.scale), cz = Math.round((z - this.z0) * this.scale);
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (dx * dx + dz * dz <= r * r) this.px(cx + dx, cz + dz, c);
  }
  save(file) {
    fs.writeFileSync(file, encodePNG(this.w, this.h, 3, this.d));
  }
}
