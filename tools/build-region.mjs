// tools/build-region.mjs — the low-detail surroundings of the detailed city, from OpenStreetMap:
//   js/region-cover-near.png   land cover of the suburbs around it (6 m cells): R vegetation, G streets, B built-up, A land
//   js/region-cover-wide.png   the same for the whole region out to the horizon (20 m cells)
//   js/region-buildings.bin.gz every building of those suburbs as a box (centre, sides, bearing, height)
//   js/region-geodata.js       where those lie in the world
// usage: node --max-old-space-size=4096 tools/build-region.mjs
// Needs the "region", "nearroads" & "nearbuildings" extracts of tools/fetch-osm.mjs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DETAIL, NEAR, WIDE, rectWorld, toWorld } from './akl-frame.mjs';
import { ROOT, Raster, loadOsm, areaPolygons, wayPts, encodePNG } from './geo-util.mjs';

const log = (...a) => console.log('[region]', ...a);
const D = rectWorld(DETAIL);

// Channel values
const PARK = 90; // lawns, parks, pitches, golf courses, meadows
const BUSH = 255; // woods, forest, scrub, wetland
const ROAD_WIDTH = { motorway: 26, trunk: 19, primary: 15, secondary: 12.5, tertiary: 11, motorway_link: 9, trunk_link: 9, primary_link: 9, secondary_link: 8, residential: 9, unclassified: 9, living_street: 6 };

const region = loadOsm('region');
const nearRoads = loadOsm('nearroads');
const nearBuildings = loadOsm('nearbuildings');
log(`${region.length} regional features, ${nearRoads.length} roads & ${nearBuildings.length} buildings around the city`);

const vegOf = (t) => {
  if (/^(wood|scrub|wetland)$/.test(t.natural || '') || t.landuse === 'forest' || t.leisure === 'nature_reserve') return BUSH;
  if (/^(park|golf_course|pitch|recreation_ground|garden|playground)$/.test(t.leisure || '') || /^(grass|meadow|recreation_ground|cemetery)$/.test(t.landuse || '') || t.natural === 'grass') return PARK;
  return 0;
};
const builtOf = (t) => /^(industrial|commercial|retail|railway)$/.test(t.landuse || '');

// Mean of f x f cells
function shrink(src, w, h, f) {
  const ow = Math.floor(w / f), oh = Math.floor(h / f);
  const out = new Float32Array(ow * oh);
  for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
    let s = 0;
    for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) s += src[(j * f + b) * w + i * f + a];
    out[j * ow + i] = s / (f * f);
  }
  return { d: out, w: ow, h: oh };
}
// Box blur (radius r cells), twice: about a Gaussian
function blur(g, r) {
  const { w, h } = g;
  let a = g.d;
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      let s = 0;
      for (let i = -r; i < w; i++) {
        if (i + r < w) s += a[j * w + i + r];
        if (i - r - 1 >= 0) s -= a[j * w + i - r - 1];
        if (i >= 0) t[j * w + i] = s / (Math.min(w - 1, i + r) - Math.max(0, i - r) + 1);
      }
    }
    const o = new Float32Array(w * h);
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let j = -r; j < h; j++) {
        if (j + r < h) s += t[(j + r) * w + i];
        if (j - r - 1 >= 0) s -= t[(j - r - 1) * w + i];
        if (j >= 0) o[j * w + i] = s / (Math.min(h - 1, j + r) - Math.max(0, j - r) + 1);
      }
    }
    a = o;
  }
  return { d: a, w, h };
}

function cover(rect, fine, factor, { roads, buildings }) {
  const R = () => new Raster(rect.x0, rect.z0, rect.x1, rect.z1, fine);
  const veg = R(), road = R(), zone = R(), water = R();
  // parks first, bush over them, water over both
  const areas = region.filter((e) => e.tags && (e.type === 'way' || e.type === 'relation'));
  for (const pass of [PARK, BUSH]) {
    for (const e of areas) {
      if (vegOf(e.tags) !== pass) continue;
      for (const p of areaPolygons(e)) veg.fillPolygon(p, pass);
    }
  }
  for (const e of areas) {
    if (builtOf(e.tags)) for (const p of areaPolygons(e)) zone.fillPolygon(p, 255);
    if (e.tags.natural === 'water') for (const p of areaPolygons(e)) water.fillPolygon(p, 255);
  }
  for (const e of roads) {
    const hw = e.tags ? e.tags.highway : null;
    const wide = ROAD_WIDTH[hw] || (e.tags ? 0 : 9); // ("out skel" roads carry no tags: streets)
    if (!wide || (e.tags && (e.tags.tunnel === 'yes' || e.tags.area === 'yes'))) continue;
    road.stampPolyline(wayPts(e), Math.max(wide / 2, fine * 0.75), 255);
  }
  const W = veg.w, H = veg.h;
  const sv = shrink(veg.d, W, H, factor), sr = shrink(road.d, W, H, factor), sz = shrink(zone.d, W, H, factor), sw = shrink(water.d, W, H, factor);
  const w = sv.w, h = sv.h, cell = fine * factor;
  // built-up land: how much of the ground around is under roofs (or, out where no buildings were fetched, how near
  // the next through road is)
  let built;
  if (buildings) {
    const roof = R();
    for (const b of buildings) {
      const k = b.bounds;
      if (!k) continue;
      const [x0, z1] = toWorld(k.minlon, k.minlat), [x1, z0] = toWorld(k.maxlon, k.maxlat);
      const i0 = Math.max(0, Math.round((x0 - roof.x0) / fine)), i1 = Math.min(roof.w, Math.round((x1 - roof.x0) / fine));
      const j0 = Math.max(0, Math.round((z0 - roof.z0) / fine)), j1 = Math.min(roof.h, Math.round((z1 - roof.z0) / fine));
      for (let j = j0; j < j1; j++) roof.d.fill(255, j * roof.w + i0, j * roof.w + Math.max(i0, i1));
    }
    built = blur(shrink(roof.d, W, H, factor), Math.round(36 / cell));
    for (let k = 0; k < built.d.length; k++) built.d[k] = Math.min(140, built.d[k] * 2.6);
  } else {
    const near = new Raster(rect.x0, rect.z0, rect.x1, rect.z1, cell);
    for (const e of roads) if (e.tags && ROAD_WIDTH[e.tags.highway] && !/motorway/.test(e.tags.highway)) near.stampPolyline(wayPts(e), 320, 255);
    built = blur({ d: Float32Array.from(near.d), w: near.w, h: near.h }, Math.round(160 / cell));
    // (same raster origin; cut to the shrunk grid)
    const cut = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cut[j * w + i] = Math.min(125, built.d[Math.min(near.h - 1, j) * near.w + Math.min(near.w - 1, i)] * 0.5);
    built = { d: cut, w, h };
  }
  const px = new Uint8Array(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    const v = sv.d[k];
    px[k * 4] = Math.round(v);
    px[k * 4 + 1] = Math.round(sr.d[k]);
    // parks & bush aren't built on, zoned land is
    px[k * 4 + 2] = Math.round(Math.max(built.d[k] * (1 - Math.min(1, v / 120)), sz.d[k] * 0.92));
    px[k * 4 + 3] = 255 - Math.round(sw.d[k]);
  }
  return { px, w, h, x0: veg.x0, z0: veg.z0, sx: w * cell, sz: h * cell, cell };
}

const out = (name) => path.join(ROOT, 'js', name);
const meta = {};
{
  const c = cover(rectWorld(NEAR), 2, 3, { roads: nearRoads.concat(region.filter((e) => e.tags && /^motorway/.test(e.tags.highway || ''))), buildings: nearBuildings });
  const png = encodePNG(c.w, c.h, 4, c.px);
  fs.writeFileSync(out('region-cover-near.png'), png);
  meta.near = { x0: c.x0, z0: c.z0, sx: c.sx, sz: c.sz, w: c.w, h: c.h };
  log(`near cover: ${c.w} x ${c.h} cells of ${c.cell} m, ${(png.length / 1024).toFixed(0)} KB`);
}
{
  const c = cover(rectWorld(WIDE), 5, 4, { roads: region.filter((e) => e.type === 'way' && e.tags && e.tags.highway), buildings: null });
  const png = encodePNG(c.w, c.h, 4, c.px);
  fs.writeFileSync(out('region-cover-wide.png'), png);
  meta.wide = { x0: c.x0, z0: c.z0, sx: c.sx, sz: c.sz, w: c.w, h: c.h };
  log(`wide cover: ${c.w} x ${c.h} cells of ${c.cell} m, ${(png.length / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Buildings of the suburbs around the detailed city: OSM gives their bounding boxes here; each is turned to the street
// it stands on and sized to fill that box
// ---------------------------------------------------------------------------------------------------------------------
{
  const CELL = 64;
  const grid = new Map();
  for (const e of nearRoads) {
    const pts = wayPts(e);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      const seg = [ax, az, bx, bz];
      for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz++) {
          const k = ix * 100003 + iz;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(seg);
        }
      }
    }
  }
  const bearing = (x, z) => {
    let best = null, bd = 90;
    for (let ix = Math.floor((x - 90) / CELL); ix <= Math.floor((x + 90) / CELL); ix++) {
      for (let iz = Math.floor((z - 90) / CELL); iz <= Math.floor((z + 90) / CELL); iz++) {
        for (const s of grid.get(ix * 100003 + iz) || []) {
          const dx = s[2] - s[0], dz = s[3] - s[1];
          const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / (dx * dx + dz * dz)));
          const d = Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z);
          if (d < bd) { bd = d; best = s; }
        }
      }
    }
    return best ? Math.atan2(best[3] - best[1], best[2] - best[0]) : 0;
  };
  const hash = (x, z) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };
  const N = rectWorld(NEAR);
  const rec = [];
  for (const b of nearBuildings) {
    const k = b.bounds;
    if (!k) continue;
    const [x0, z1] = toWorld(k.minlon, k.minlat), [x1, z0] = toWorld(k.maxlon, k.maxlat);
    const x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    // (those of the detailed city are drawn from their surveyed footprints)
    if (x > D.x0 - 2 && x < D.x1 + 2 && z > D.z0 - 2 && z < D.z1 + 2) continue;
    if (x < N.x0 || x > N.x1 || z < N.z0 || z > N.z1) continue;
    const W = x1 - x0, H = z1 - z0;
    if (W < 2.5 || H < 2.5 || W > 250 || H > 250) continue;
    // the rectangle a x b at bearing th whose bounding box is W x H
    let th = bearing(x, z);
    th -= Math.round(th / (Math.PI / 2)) * (Math.PI / 2); // (a rectangle: quarter turns are the same)
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    let a = W, d = H;
    if (c * c - s * s > 0.25) {
      a = (W * c - H * s) / (c * c - s * s);
      d = (H * c - W * s) / (c * c - s * s);
    }
    if (!(a > 2 && d > 2 && a < 1.05 * W + 1 && d < 1.05 * H + 1)) {
      // (not a rectangle standing that way: a box in its bounding box)
      a = W * 0.86;
      d = H * 0.86;
      th = 0;
    }
    const t = b.tags || {};
    const levels = parseFloat(t['building:levels']);
    const tagged = parseFloat(t.height);
    const area = a * d;
    const r = hash(x, z);
    let high = tagged > 2 ? tagged : levels > 0 ? levels * 3.1 + 0.6 : area < 45 ? 2.6 : area < 320 ? (r < 0.62 ? 3.1 : 5.8) + r * 0.6 : area < 1200 ? 6.5 + r * 3 : 8 + r * 4;
    if (/^(industrial|warehouse|retail|commercial)$/.test(t.building || '') && !(tagged > 2) && !(levels > 0)) high = Math.max(high, 7 + r * 3);
    rec.push([x, z, a, d, th, Math.min(high, 127)]);
  }
  const buf = Buffer.alloc(8 + rec.length * 8);
  buf.write('AKR1', 0, 'ascii');
  buf.writeUInt32LE(rec.length, 4);
  rec.forEach(([x, z, a, d, th, high], i) => {
    const o = 8 + i * 8;
    buf.writeInt16LE(Math.round(x * 4), o);
    buf.writeInt16LE(Math.round(z * 4), o + 2);
    buf.writeUInt8(Math.max(1, Math.min(255, Math.round(a * 2))), o + 4);
    buf.writeUInt8(Math.max(1, Math.min(255, Math.round(d * 2))), o + 5);
    buf.writeInt8(Math.max(-127, Math.min(127, Math.round((th / (Math.PI / 4)) * 127))), o + 6);
    buf.writeUInt8(Math.max(1, Math.min(255, Math.round(high * 2))), o + 7);
  });
  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(out('region-buildings.bin.gz'), gz);
  log(`${rec.length} buildings, ${(gz.length / 1024).toFixed(0)} KB`);
}

fs.writeFileSync(out('region-geodata.js'), `// Generated by tools/build-region.mjs: where the land-cover maps of the surroundings lie (world metres)
// Map data © OpenStreetMap contributors (ODbL)
export const REGION_COVER = ${JSON.stringify(meta)};
`);
log('wrote js/region-geodata.js');
