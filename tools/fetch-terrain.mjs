// tools/fetch-terrain.mjs — samples LINZ's LiDAR elevation models onto the game's grids.
//   tools/data/dem_detail.bin.gz   ground (DEM) of the detailed area, 2 m cells
//   tools/data/dsm_detail.bin.gz   surface with buildings & trees (DSM), same grid: building heights = DSM - DEM
//   tools/data/dem_region.bin.gz   ground of the whole region, 24 m cells
// Source: LINZ "Auckland LiDAR 1m DEM / DSM" (2024, and 2016-2018 where the 2024 survey has no tile), CC BY 4.0,
// read as cloud-optimised GeoTIFFs from the public bucket s3://nz-elevation (only the overview levels are fetched).
// usage: node tools/fetch-terrain.mjs [detail] [region]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import { DETAIL, WIDE, rectWorld, toLonLat } from './akl-frame.mjs';

const DATA = fileURLToPath(new URL('data/', import.meta.url));
const BUCKET = 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com';
const SURVEYS = ['auckland-part-1_2024', 'auckland-part-2_2024', 'auckland-north_2016-2018', 'auckland-south_2016-2017'];

// --- NZTM2000 (EPSG:2193): transverse Mercator on GRS80, central meridian 173° E -----------------------------------
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996, LON0 = (173 * Math.PI) / 180, FE = 1600000, FN = 10000000;
const E2 = 2 * F - F * F;
const meridian = (phi) => {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) - ((35 * e6) / 3072) * Math.sin(6 * phi));
};
export function toNZTM(lon, lat) {
  const phi = (lat * Math.PI) / 180, w = (lon * Math.PI) / 180 - LON0;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi), t2 = t * t;
  const nu = A / Math.sqrt(1 - E2 * s * s);
  const rho = (A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5);
  const psi = nu / rho;
  const w2 = w * w, c2 = c * c;
  const E = FE + K0 * nu * w * c * (1 + (w2 / 6) * c2 * (psi - t2)
    + (w2 * w2 / 120) * c2 * c2 * (4 * psi ** 3 * (1 - 6 * t2) + psi * psi * (1 + 8 * t2) - 2 * psi * t2 + t2 * t2));
  const N = FN + K0 * (meridian(phi) + nu * s * (w2 / 2) * c * (1 + (w2 / 12) * c2 * (4 * psi * psi + psi - t2)
    + (w2 * w2 / 360) * c2 * c2 * (8 * psi ** 4 * (11 - 24 * t2) - 28 * psi ** 3 * (1 - 6 * t2) + psi * psi * (1 - 32 * t2) - 2 * psi * t2 + t2 * t2)));
  return [E, N];
}

// --- Tiles: NZ Topo50 sheets (24 km x 36 km) cut 5 x 5 into 1:10,000 tiles (4.8 km x 7.2 km) ------------------------
const SHEET_W = 24000, SHEET_H = 36000, TILE_W = 4800, TILE_H = 7200;
// Sheet AZ31's north-west corner (from a tile's georeference): columns count east, row letters run south
const REF = { letters: 'AZ', col: 31, x0: 1732000, top: 5982000 };
const ROWS = [];
for (const a of 'ABC') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') ROWS.push(a + b);
function tileAt(E, N) {
  const sc = Math.floor((E - REF.x0) / SHEET_W), sr = Math.floor((REF.top - N) / SHEET_H);
  const sx0 = REF.x0 + sc * SHEET_W, stop = REF.top - sr * SHEET_H;
  const tc = Math.floor((E - sx0) / TILE_W), tr = Math.floor((stop - N) / TILE_H);
  const letters = ROWS[ROWS.indexOf(REF.letters) + sr];
  return { name: `${letters}${REF.col + sc}_10000_0${tr + 1}0${tc + 1}`, x0: sx0 + tc * TILE_W, top: stop - tr * TILE_H };
}

const listings = new Map();
async function surveyTiles(survey, kind) {
  const key = `${survey}/${kind}`;
  if (!listings.has(key)) {
    const names = new Set();
    let token = '';
    do {
      const res = await fetch(`${BUCKET}/?list-type=2&prefix=auckland/${survey}/${kind}/2193/&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>[^<]*\/([A-Z]{2}\d{2}_10000_\d{4})\.tiff<\/Key>/g)) names.add(m[1]);
      token = (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || '';
    } while (token);
    listings.set(key, names);
  }
  return listings.get(key);
}

// One overview level of one tile, as a Float32Array (NaN where there is no data): { data, w, h, res }
const cache = new Map();
async function tileLevel(name, kind, res) {
  const key = `${kind}/${name}/${res}`;
  if (cache.has(key)) return cache.get(key);
  // Surveys overlap: where the first one with this tile has no data (it stops part way across), the next fills in
  let out = null;
  for (const survey of SURVEYS) {
    if (!(await surveyTiles(survey, kind)).has(name)) continue;
    const url = `${BUCKET}/auckland/${survey}/${kind}/2193/${name}.tiff`;
    let got = null;
    for (let attempt = 1; attempt <= 4 && !got; attempt++) {
      try {
        const tiff = await fromUrl(url);
        const level = Math.round(Math.log2(res));
        const image = await tiff.getImage(Math.min(level, (await tiff.getImageCount()) - 1));
        const nodata = image.getGDALNoData();
        const raster = (await image.readRasters({ interleave: true }));
        const data = new Float32Array(raster.length);
        for (let i = 0; i < raster.length; i++) data[i] = raster[i] === nodata || raster[i] < -500 ? NaN : raster[i];
        got = { data, w: image.getWidth(), h: image.getHeight(), res: TILE_W / image.getWidth(), survey };
      } catch (e) {
        console.log(`  ${name} (${survey}) attempt ${attempt}: ${e.message}`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
    if (!got) continue;
    if (!out) out = got;
    else if (out.w === got.w && out.h === got.h) {
      let filled = 0;
      for (let i = 0; i < out.data.length; i++) if (Number.isNaN(out.data[i]) && !Number.isNaN(got.data[i])) { out.data[i] = got.data[i]; filled++; }
      if (filled) out.survey += ` + ${survey}`;
    }
    let holes = 0;
    for (let i = 0; i < out.data.length; i += 7) if (Number.isNaN(out.data[i])) holes++;
    if (!holes || res <= 2) break;
  }
  if (out) console.log(`  ${kind} ${name} @ ${out.res} m from ${out.survey}`);
  cache.set(key, out);
  // the 2 m levels are big: keep only a few in memory
  if (res <= 2 && cache.size > 6) cache.delete(cache.keys().next().value);
  return out;
}

/** Samples `kind` ('dem_1m' / 'dsm_1m') on a w x h grid of `cell` m cells from world (x0, z0), bilinear from `res` m data */
async function sampleGrid(kind, x0, z0, w, h, cell, res) {
  const out = new Float32Array(w * h).fill(NaN);
  // Which tile each grid node falls in
  const E = new Float64Array(w * h), N = new Float64Array(w * h);
  const byTile = new Map();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [lon, lat] = toLonLat(x0 + i * cell, z0 + j * cell);
      const [e, n] = toNZTM(lon, lat);
      const k = j * w + i;
      E[k] = e; N[k] = n;
      const t = tileAt(e, n);
      if (!byTile.has(t.name)) byTile.set(t.name, { ...t, cells: [] });
      byTile.get(t.name).cells.push(k);
    }
  }
  console.log(`${kind}: ${w} x ${h} nodes over ${byTile.size} tiles`);
  for (const t of byTile.values()) {
    const tile = await tileLevel(t.name, kind, res);
    if (!tile) continue;
    const { data, w: tw, h: th } = tile;
    for (const k of t.cells) {
      // pixel centres sit half a pixel in from the tile's corner
      const fx = Math.min(tw - 1.001, Math.max(0, (E[k] - t.x0) / tile.res - 0.5));
      const fy = Math.min(th - 1.001, Math.max(0, (t.top - N[k]) / tile.res - 0.5));
      const i = Math.floor(fx), j = Math.floor(fy);
      const a = data[j * tw + i], b = data[j * tw + i + 1], c = data[(j + 1) * tw + i], d = data[(j + 1) * tw + i + 1];
      if (Number.isNaN(a + b + c + d)) {
        // partly no data (water): the nearest valid corner
        const near = [a, b, c, d].filter((v) => !Number.isNaN(v));
        if (near.length) out[k] = near.reduce((s, v) => s + v, 0) / near.length;
        continue;
      }
      const u = fx - i, v = fy - j;
      out[k] = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    }
  }
  return out;
}

// Heights as int16 centimetres (-32768: no data) behind a JSON header line
function save(file, grid, data) {
  const q = new Int16Array(data.length);
  let holes = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number.isNaN(data[i])) { q[i] = -32768; holes++; } else q[i] = Math.max(-32000, Math.min(32767, Math.round(data[i] * 100)));
  }
  const header = Buffer.from(JSON.stringify(grid) + '\n');
  fs.writeFileSync(path.join(DATA, file), zlib.gzipSync(Buffer.concat([header, Buffer.from(q.buffer)]), { level: 9 }));
  console.log(`wrote ${file}: ${grid.w} x ${grid.h} @ ${grid.cell} m, ${((holes / data.length) * 100).toFixed(1)}% without data, ${(fs.statSync(path.join(DATA, file)).size / 1e6).toFixed(1)} MB`);
}

const args = process.argv.slice(2);
const want = (name) => !args.length || args.includes(name);
fs.mkdirSync(DATA, { recursive: true });
if (want('detail')) {
  const R = rectWorld(DETAIL);
  const cell = 2, margin = 80;
  const grid = { x0: Math.floor(R.x0 - margin), z0: Math.floor(R.z0 - margin), cell };
  grid.w = Math.ceil((R.x1 + margin - grid.x0) / cell) + 1;
  grid.h = Math.ceil((R.z1 + margin - grid.z0) / cell) + 1;
  save('dem_detail.bin.gz', grid, await sampleGrid('dem_1m', grid.x0, grid.z0, grid.w, grid.h, cell, 2));
  save('dsm_detail.bin.gz', grid, await sampleGrid('dsm_1m', grid.x0, grid.z0, grid.w, grid.h, cell, 2));
}
if (want('region')) {
  const R = rectWorld(WIDE);
  const cell = 24;
  const grid = { x0: Math.floor(R.x0), z0: Math.floor(R.z0), cell };
  grid.w = Math.ceil((R.x1 - grid.x0) / cell) + 1;
  grid.h = Math.ceil((R.z1 - grid.z0) / cell) + 1;
  save('dem_region.bin.gz', grid, await sampleGrid('dem_1m', grid.x0, grid.z0, grid.w, grid.h, cell, 16));
}
if (want('bridge')) {
  // The Harbour Bridge & Northcote Point, north of the detailed area: ground & surface for the bridge's deck profile
  const cell = 2;
  const grid = { x0: -1960, z0: -3060, cell, w: 561, h: 591 };
  save('dem_bridge.bin.gz', grid, await sampleGrid('dem_1m', grid.x0, grid.z0, grid.w, grid.h, cell, 2));
  save('dsm_bridge.bin.gz', grid, await sampleGrid('dsm_1m', grid.x0, grid.z0, grid.w, grid.h, cell, 2));
}
