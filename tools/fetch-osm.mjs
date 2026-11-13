// tools/fetch-osm.mjs — downloads the OpenStreetMap extracts the Auckland geodata is built from (Overpass API).
// usage: node tools/fetch-osm.mjs [name ...]      (no names: everything that is missing; --force: download again)
// Output: tools/data/osm_<name>.json.gz
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DETAIL, WIDE, NEAR } from './akl-frame.mjs';

const DATA = fileURLToPath(new URL('data/', import.meta.url));
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const bb = (b, pad = 0) => `${(b.south - pad).toFixed(5)},${(b.west - pad * 1.25).toFixed(5)},${(b.north + pad).toFixed(5)},${(b.east + pad * 1.25).toFixed(5)}`;
const D = bb(DETAIL, 0.003); // ~330 m beyond the detailed area, so roads & blocks are whole at its edge
const W = bb(WIDE);
const N = bb(NEAR);

const QUERIES = {
  // every road, path & track of the detailed area (with node ids: junctions are shared nodes) and its signals
  roads: `[out:json][timeout:240];(way["highway"](${D});node["highway"~"^(traffic_signals|crossing|mini_roundabout|stop|give_way|bus_stop)$"](${D}););out body geom;`,
  // building footprints (ways & multipolygons) of the detailed area
  buildings: `[out:json][timeout:300];(way["building"](${D});relation["building"]["type"="multipolygon"](${D});way["building:part"](${D}););out body geom;`,
  // parks, lawns, woods, water, land use, sports pitches, car parks
  areas: `[out:json][timeout:240];(way["leisure"](${D});relation["leisure"](${D});way["landuse"](${D});relation["landuse"](${D});way["natural"~"^(water|wood|scrub|beach|sand|grassland|wetland|bare_rock|cliff)$"](${D});relation["natural"~"^(water|wood|scrub|beach|sand|wetland)$"](${D});way["amenity"~"^(parking|university|school|hospital|ferry_terminal|marketplace)$"](${D});way["man_made"~"^(pier|breakwater|groyne|quay|bridge)$"](${D});way["highway"="pedestrian"]["area"="yes"](${D});way["railway"](${D});way["waterway"](${D});way["barrier"~"^(wall|retaining_wall|fence)$"]["name"](${D}););out body geom;`,
  // single trees & tree rows, and points of interest
  points: `[out:json][timeout:240];(node["natural"="tree"](${D});way["natural"="tree_row"](${D});node["tourism"](${D});node["amenity"~"^(ferry_terminal|fountain|clock|place_of_worship|theatre|cinema|cafe|restaurant|pub|bar)$"](${D});node["historic"](${D});node["man_made"](${D});node["railway"~"^(station|tram_stop)$"](${D});node["place"~"^(suburb|neighbourhood|quarter)$"](${N}););out body geom;`,
  // the coast of the whole region (islands, the North Shore, both harbours)
  coast: `[out:json][timeout:300];(way["natural"="coastline"](${W}););out body geom;`,
  // big roads, parks & water of the surrounding region, for the low-detail land around the detailed area
  region: `[out:json][timeout:300];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link)$"](${W});way["leisure"~"^(park|golf_course|nature_reserve|pitch|recreation_ground)$"](${W});relation["leisure"~"^(park|golf_course|nature_reserve)$"](${W});way["natural"~"^(wood|water|scrub|wetland|beach|sand)$"](${W});relation["natural"~"^(wood|water|wetland)$"](${W});way["landuse"~"^(forest|industrial|commercial|retail|cemetery|recreation_ground|railway|meadow|grass)$"](${W});node["natural"~"^(peak|volcano)$"](${W});node["place"~"^(suburb|town|island)$"](${W}););out body geom;`,
  // minor streets near the detailed area, for the street pattern on the low-detail land
  nearroads: `[out:json][timeout:300];(way["highway"~"^(residential|unclassified|living_street|tertiary|secondary|primary|trunk|motorway|motorway_link|trunk_link|primary_link|secondary_link)$"](${N}););out skel geom;`,
  // building boxes of the surrounding suburbs (bounding boxes & tags only)
  nearbuildings: `[out:json][timeout:600];(way["building"](${N}););out tags bb;`
};

async function overpass(query, tries = 8) {
  for (let i = 1; i <= tries; i++) {
    for (const ep of ENDPOINTS) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'slop-auckland-build/1.0 (three.js city sim)' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(900000)
        });
        if (res.status === 200) {
          const text = await res.text();
          const data = JSON.parse(text);
          if (Array.isArray(data.elements) && !data.remark) return text;
          console.log(`  try ${i} ${ep} -> remark: ${String(data.remark).slice(0, 120)}`);
        } else console.log(`  try ${i} ${ep} -> ${res.status}`);
      } catch (e) {
        console.log(`  try ${i} ${ep} -> ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, i * 5000));
    }
  }
  throw new Error('Overpass request failed');
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const names = args.filter((a) => !a.startsWith('--'));
fs.mkdirSync(DATA, { recursive: true });
for (const name of names.length ? names : Object.keys(QUERIES)) {
  if (!QUERIES[name]) throw new Error(`unknown extract "${name}" (${Object.keys(QUERIES).join(', ')})`);
  const out = path.join(DATA, `osm_${name}.json.gz`);
  if (fs.existsSync(out) && !force && !names.length) {
    console.log(`${name}: kept ${path.basename(out)}`);
    continue;
  }
  console.log(`${name}: querying...`);
  const text = await overpass(QUERIES[name]);
  fs.writeFileSync(out, zlib.gzipSync(text, { level: 9 }));
  console.log(`${name}: ${JSON.parse(text).elements.length} elements, ${(text.length / 1e6).toFixed(1)} MB -> ${(fs.statSync(out).size / 1e6).toFixed(2)} MB gz`);
}
