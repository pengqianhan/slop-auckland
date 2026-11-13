// DEM / DSM profiles along mapped bridges: does the ground model keep the bridge decks?
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadOsm, wayPts, polylineLength } from '../geo-util.mjs';

function load(name) {
  const buf = zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL(`../data/${name}.bin.gz`, import.meta.url))));
  const nl = buf.indexOf(10);
  const grid = JSON.parse(buf.subarray(0, nl).toString());
  return { ...grid, data: new Int16Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + nl + 1 + grid.w * grid.h * 2)) };
}
const dem = load('dem_detail'), dsm = load('dsm_detail');
const H = (g, x, z) => g.data[Math.round((z - g.z0) / g.cell) * g.w + Math.round((x - g.x0) / g.cell)] / 100;
const ways = loadOsm('roads').filter((e) => e.type === 'way' && e.tags && e.tags.bridge && e.tags.bridge !== 'no' && /^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)/.test(e.tags.highway));
const seen = new Set();
for (const w of ways) {
  const pts = wayPts(w);
  const L = polylineLength(pts);
  const name = `${w.tags.name || w.tags.ref || '-'} (${w.tags.highway}, layer ${w.tags.layer || 0})`;
  if (L < 60 || seen.has(name)) continue;
  seen.add(name);
  const prof = [];
  for (let k = 0; k <= 8; k++) {
    let s = (L * k) / 8, i = 0;
    while (i + 2 < pts.length && s > Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])) { s -= Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); i++; }
    const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) || 1;
    const x = pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * s) / seg, z = pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * s) / seg;
    prof.push(`${H(dem, x, z).toFixed(0)}/${H(dsm, x, z).toFixed(0)}`);
  }
  console.log(name.padEnd(52), Math.round(L).toString().padStart(4), 'm  dem/dsm:', prof.join(' '));
}
