import { GEO } from './akl-geodata.js';

// The ground's height, from LINZ's Auckland LiDAR elevation models (CC BY 4.0), written by tools/build-geodata.mjs:
// a 5 m grid of the detailed city and a 32 m grid of the whole region. Heights are world y: metres above the quays
// (elevation - GEO.frame.sea), the harbour's surface is drawn at y = -2.2.
// Bridge decks (GEO.decks) carry streets & motorways over the gullies, the motorway cuttings and the harbour: they
// are a second surface above the ground, so height lookups take the height the asker is at.

const response = await fetch(new URL('./terrain-geodata.bin.gz', import.meta.url));
if (!response.ok) throw new Error(`Terrain data request failed: ${response.status}`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid terrain data.');
const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
if (data.length < 24 || view.getUint32(0, true) !== 0x31484b41) throw invalidData(); // 'AKH1'

// A grid: x0, z0 (m), cell (cm), w, h, then rows of uint16 heights (2 cm steps above -40 m), each row stored as its
// differences from the row above
let cursor = 4;
function readGrid() {
  const x0 = view.getInt32(cursor, true), z0 = view.getInt32(cursor + 4, true);
  const cell = view.getUint32(cursor + 8, true) / 100, w = view.getUint32(cursor + 12, true), h = view.getUint32(cursor + 16, true);
  cursor += 20;
  if (cursor + w * h * 2 > data.length) throw invalidData();
  const heights = new Float32Array(w * h);
  const row = new Uint16Array(w);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      row[i] = (row[i] + view.getUint16(cursor, true)) & 0xffff;
      cursor += 2;
      heights[j * w + i] = row[i] / 50 - 40;
    }
  }
  return { x0, z0, cell, w, h, heights, x1: x0 + (w - 1) * cell, z1: z0 + (h - 1) * cell };
}
const DETAIL = readGrid();
const REGION = readGrid();
const [RX0, RX1, RZ0, RZ1] = GEO.frame.rect;
const SEABED = -3.6;

// Height on a grid: every cell is two triangles split along its (i, j)-(i + 1, j + 1) diagonal, exactly as the ground
// meshes draw it
function gridHeight(g, x, z) {
  const fx = Math.max(0, Math.min(g.w - 1.0001, (x - g.x0) / g.cell));
  const fz = Math.max(0, Math.min(g.h - 1.0001, (z - g.z0) / g.cell));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * g.w + i;
  const H = g.heights;
  const a = H[k], d = H[k + g.w + 1];
  return u >= v ? a + (H[k + 1] - a) * u + (d - H[k + 1]) * v : a + (H[k + g.w] - a) * v + (d - H[k + g.w]) * u;
}

const inDetail = (x, z) => x >= RX0 && x <= RX1 && z >= RZ0 && z <= RZ1;

/** Height of the ground at (x, z): the detailed city's inside its rectangle, the region's beyond */
function terrainHeight(x, z) {
  return inDetail(x, z) ? gridHeight(DETAIL, x, z) : gridHeight(REGION, x, z);
}
const regionHeight = (x, z) => gridHeight(REGION, x, z);

/** Unit normal of the ground at (x, z) into out = { x, y, z } (over a 4 m stencil: slopes, not kerbs) */
function terrainNormal(x, z, out = { x: 0, y: 1, z: 0 }) {
  const e = 2;
  const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  const l = Math.hypot(dx, 2 * e, dz);
  out.x = -dx / l;
  out.y = (2 * e) / l;
  out.z = -dz / l;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bridge decks
//   kind: 0 a street's (part of the street network), 1 a motorway's; half: half width; pts: [{ x, z, y }] centre line
// ---------------------------------------------------------------------------------------------------------------------
const DECKS = GEO.decks.map(([kind, w, flat], id) => {
  const pts = [];
  for (let i = 0; i < flat.length; i += 3) pts.push({ x: flat[i], z: flat[i + 1], y: flat[i + 2] });
  return { id, kind, half: w / 2, pts };
});
const DECK_CELL = 48;
const deckCells = new Map();
for (const d of DECKS) {
  for (let i = 0; i + 1 < d.pts.length; i++) {
    const a = d.pts[i], b = d.pts[i + 1];
    const seg = { d, a, b };
    for (let ix = Math.floor((Math.min(a.x, b.x) - d.half) / DECK_CELL); ix <= Math.floor((Math.max(a.x, b.x) + d.half) / DECK_CELL); ix++) {
      for (let iz = Math.floor((Math.min(a.z, b.z) - d.half) / DECK_CELL); iz <= Math.floor((Math.max(a.z, b.z) + d.half) / DECK_CELL); iz++) {
        const k = (ix + 2048) * 4096 + iz + 2048;
        if (!deckCells.has(k)) deckCells.set(k, []);
        deckCells.get(k).push(seg);
      }
    }
  }
}

/**
 * Height of the bridge deck over (x, z), or -Infinity where there is none: the highest deck no more than 2.5 m above
 * `yRef` (the height the asker is at: someone under a bridge stays under it). `kinds`: 1 street decks, 2 motorway
 * decks, 3 both. `margin` widens the decks (m).
 */
function deckHeight(x, z, yRef = Infinity, kinds = 3, margin = 0) {
  const list = deckCells.get((Math.floor(x / DECK_CELL) + 2048) * 4096 + Math.floor(z / DECK_CELL) + 2048);
  if (!list) return -Infinity;
  let best = -Infinity;
  for (const s of list) {
    if (!((s.d.kind + 1) & kinds)) continue;
    const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = ((x - s.a.x) * dx + (z - s.a.z) * dz) / L2;
    if (t < -0.02 || t > 1.02) continue;
    const tc = Math.max(0, Math.min(1, t));
    const px = s.a.x + dx * tc - x, pz = s.a.z + dz * tc - z;
    const reach = s.d.half + margin;
    if (px * px + pz * pz > reach * reach) continue;
    const y = s.a.y + (s.b.y - s.a.y) * tc;
    if (y <= yRef + 2.5 && y > best) best = y;
  }
  return best;
}

/**
 * Height of the surface to stand or drive on at (x, z) for someone at height yRef: a bridge deck if one is there (and
 * not far overhead), else the ground. Without yRef: the topmost surface.
 */
function surfaceHeight(x, z, yRef = Infinity, kinds = 3) {
  const ground = terrainHeight(x, z);
  const deck = deckHeight(x, z, yRef, kinds);
  return deck > ground ? deck : ground;
}

/** The surface the street network runs on: street bridges where they are, the ground elsewhere (never a motorway viaduct overhead) */
const streetHeight = (x, z) => surfaceHeight(x, z, Infinity, 1);

export { DETAIL as TERRAIN_DETAIL, REGION as TERRAIN_REGION, SEABED, DECKS, terrainHeight, regionHeight, terrainNormal, deckHeight, surfaceHeight, streetHeight, inDetail };
