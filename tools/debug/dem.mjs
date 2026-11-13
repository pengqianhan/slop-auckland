// Hillshade pictures of the sampled elevation grids, and spot heights at known places
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../geo-util.mjs';
import { toWorld } from '../akl-frame.mjs';

function load(name) {
  const buf = zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL(`../data/${name}.bin.gz`, import.meta.url))));
  const nl = buf.indexOf(10);
  const grid = JSON.parse(buf.subarray(0, nl).toString());
  const data = new Int16Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + nl + 1 + grid.w * grid.h * 2));
  return { ...grid, data };
}
function shade(name, step, extra = null) {
  const g = load(name);
  const w = Math.floor(g.w / step), h = Math.floor(g.h / step);
  const px = new Uint8Array(w * h * 3);
  const at = (i, j) => { const v = g.data[Math.min(g.h - 1, j) * g.w + Math.min(g.w - 1, i)]; return v === -32768 ? 0 : v / 100; };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const z = at(i * step, j * step);
    const dx = (at(i * step + step, j * step) - at(i * step - step, j * step)) / (2 * step * g.cell);
    const dz = (at(i * step, j * step + step) - at(i * step, j * step - step)) / (2 * step * g.cell);
    const light = Math.max(0, Math.min(1, 0.55 - dx * 1.6 - dz * 1.6));
    const sea = z < 0.8;
    const t = Math.min(1, z / (extra || 120));
    const c = sea ? [40, 70, 110] : [90 + 140 * t, 150 - 20 * t, 80 + 30 * t];
    const k = (j * w + i) * 3;
    px[k] = c[0] * (0.45 + light * 0.9); px[k + 1] = c[1] * (0.45 + light * 0.9); px[k + 2] = c[2] * (0.45 + light * 0.9);
  }
  fs.writeFileSync(fileURLToPath(new URL(`${name}.png`, import.meta.url)), encodePNG(w, h, 3, px));
  console.log(name, w, h);
  return g;
}
const which = process.argv[2] || 'detail';
if (which === 'detail') {
  const g = shade('dem_detail', 2);
  shade('dsm_detail', 2);
  const s = load('dsm_detail');
  const H = (grid, x, z) => grid.data[Math.round((z - grid.z0) / grid.cell) * grid.w + Math.round((x - grid.x0) / grid.cell)] / 100;
  for (const [name, lon, lat] of [['Sky Tower', 174.762191, -36.848448], ['Queen/Customs', 174.7668, -36.8443], ['Albert Park', 174.7679, -36.8506], ['K Road/Pitt', 174.7593, -36.8578], ['Museum', 174.7779, -36.8604],
    ['Grafton Bridge mid', 174.7655, -36.8597], ['Motorway under K Rd', 174.7572, -36.8591], ['Ponsonby Rd', 174.7464, -36.8542], ['Victoria Park', 174.7542, -36.8478], ['Newmarket', 174.7777, -36.8693], ['Queens Wharf', 174.7680, -36.8405], ['Harbour (water)', 174.7700, -36.8350], ['St Marys Bay motorway', 174.7460, -36.8400]]) {
    const [x, z] = toWorld(lon, lat);
    console.log(name.padEnd(24), 'dem', H(g, x, z).toFixed(1), 'dsm', H(s, x, z).toFixed(1));
  }
} else shade('dem_region', 1, 200);
