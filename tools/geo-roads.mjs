// tools/geo-roads.mjs — the street network of the detailed area from OpenStreetMap.
//   streets: every at-grade public street as a centreline graph (junction nodes & links with curb-to-curb width,
//            lanes, direction of travel), roundabouts drawn together into one junction each
//   motorways: the motorway carriageways & ramps (kept apart: they are grade separated)
//   paths: footpaths, steps & cycleways (park paths, lanes, promenades)
//   signals: junctions with traffic lights
import { rectWorld, DETAIL } from './akl-frame.mjs';
import { loadOsm, wayPts, rdp, polylineLength, log } from './geo-util.mjs';

const R = rectWorld(DETAIL);
const EDGE = 0.5; // streets stop this far inside the detailed area's edge
const inRect = (p, m = EDGE) => p[0] > R.x0 + m && p[0] < R.x1 - m && p[1] > R.z0 + m && p[1] < R.z1 - m;

const STREET = /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|trunk_link|primary_link|secondary_link|tertiary_link|busway)$/;
const MOTORWAY = /^(motorway|motorway_link)$/;
const PATH = /^(footway|path|cycleway|pedestrian|steps)$/;
const CLASS = { trunk: 3, primary: 3, secondary: 2, tertiary: 1, trunk_link: 2, primary_link: 2, secondary_link: 1, tertiary_link: 1, busway: 1 };

const elements = loadOsm('roads');
const ways = elements.filter((e) => e.type === 'way' && e.geometry && e.nodes && e.tags);

function drivable(t) {
  if (!STREET.test(t.highway) || t.area === 'yes') return false;
  if (t.tunnel && t.tunnel !== 'no') return false; // passages under buildings, the motorway tunnel
  const closed = (v) => v === 'no' || v === 'private';
  const bus = t.bus === 'designated' || t.bus === 'yes' || t.psv === 'yes' || t.psv === 'designated' || t.highway === 'busway';
  if ((closed(t.access) || closed(t.motor_vehicle) || closed(t.vehicle)) && !bus) return false;
  return true;
}

// Curb-to-curb width (m) and travel lanes (both ways together) of a street
function carriageway(t, oneWay) {
  const hw = t.highway;
  let lanes = parseInt(t.lanes, 10);
  const minor = /^(residential|unclassified|living_street|tertiary_link|secondary_link)$/.test(hw);
  if (!(lanes > 0)) lanes = oneWay ? (minor || /_link$/.test(hw) ? 1 : 2) : 2;
  lanes = Math.min(lanes, oneWay ? 5 : 8);
  let w;
  if (hw === 'living_street') w = oneWay || lanes < 2 ? 5.6 : 7.0;
  else if (minor && lanes <= 2) w = oneWay ? (lanes === 1 ? 7.0 : 8.6) : 10.4; // with kerbside parking
  else if (lanes <= 2 && !oneWay) w = 11.6; // two-lane arterial with parking / cycle lanes
  else w = lanes * 3.3 + 1.2;
  const tagged = parseFloat(t.width);
  if (tagged >= 4 && tagged <= 40) w = tagged;
  return { w: Math.min(w, 30), lanes };
}

// --- Streets ----------------------------------------------------------------------------------------------------------
const streetWays = [];
const motorwayWays = [];
const pathWays = [];
for (const w of ways) {
  const t = w.tags;
  if (MOTORWAY.test(t.highway)) motorwayWays.push(w);
  else if (drivable(t)) streetWays.push(w);
  else if (PATH.test(t.highway) && t.area !== 'yes' && t.indoor !== 'yes' && !(t.tunnel && t.tunnel !== 'no') && t.access !== 'private' && !t.level) pathWays.push(w);
}

// Node positions & how many street ways use each node (junctions: 2+, or the same way twice)
const pos = new Map();
const uses = new Map();
for (const w of streetWays) {
  w.nodes.forEach((id, i) => {
    const g = w.geometry[i];
    if (!pos.has(id)) pos.set(id, wayPts({ geometry: [g] })[0]);
    const end = i === 0 || i === w.nodes.length - 1;
    uses.set(id, (uses.get(id) || 0) + (end ? 2 : 1)); // way ends are always link ends
  });
}

// Roundabouts: rings of one-way pieces. Each connected ring becomes one junction at its centre.
const ringOf = new Map(); // node id -> ring
const rings = [];
{
  const rb = streetWays.filter((w) => w.tags.junction === 'roundabout' || w.tags.junction === 'circular');
  const parent = new Map();
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  for (const w of rb) for (const id of w.nodes) if (!parent.has(id)) parent.set(id, id);
  for (const w of rb) for (let i = 1; i < w.nodes.length; i++) parent.set(find(w.nodes[i]), find(w.nodes[0]));
  const groups = new Map();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  for (const ids of groups.values()) {
    let x = 0, z = 0;
    for (const id of ids) { x += pos.get(id)[0]; z += pos.get(id)[1]; }
    x /= ids.length; z /= ids.length;
    let rad = 0;
    for (const id of ids) rad += Math.hypot(pos.get(id)[0] - x, pos.get(id)[1] - z);
    rad /= ids.length;
    const ring = { id: `r${rings.length}`, x, z, r: rad, w: 6 };
    for (const w of rb) if (ids.includes(w.nodes[0])) ring.w = Math.max(ring.w, carriageway(w.tags, true).w);
    rings.push(ring);
    for (const id of ids) ringOf.set(id, ring);
  }
}

const names = [];
const nameIds = new Map();
const nameId = (n) => {
  if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
  return nameIds.get(n);
};

// Split every street way at its junction nodes into links
let rawLinks = [];
for (const w of streetWays) {
  const t = w.tags;
  if (t.junction === 'roundabout' || t.junction === 'circular') continue;
  const oneWay = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.oneway === '-1';
  const dir = !oneWay ? 0 : t.oneway === '-1' ? -1 : 1;
  const cw = carriageway(t, oneWay);
  const base = { name: t.name || t.ref || '', w: cw.w, lanes: cw.lanes, dir, cls: CLASS[t.highway] || 0, bridge: t.bridge && t.bridge !== 'no' ? 1 : 0, way: w.id, hw: t.highway };
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    const id = w.nodes[i];
    if (i < w.nodes.length - 1 && (uses.get(id) || 0) < 2 && !ringOf.has(id)) continue;
    const ids = w.nodes.slice(start, i + 1);
    start = i;
    if (ids.every((n) => ringOf.has(n))) continue;
    rawLinks.push({ ...base, a: ids[0], b: ids[ids.length - 1], pts: ids.map((n) => pos.get(n).slice()) });
  }
}

// Ends on a roundabout move to its centre
for (const l of rawLinks) {
  for (const end of ['a', 'b']) {
    const ring = ringOf.get(l[end]);
    if (!ring) continue;
    l[end] = ring.id;
    if (end === 'a') l.pts[0] = [ring.x, ring.z];
    else l.pts[l.pts.length - 1] = [ring.x, ring.z];
  }
}
rawLinks = rawLinks.filter((l) => l.a !== l.b || polylineLength(l.pts) > 40);

// Cut at the edge of the detailed area
{
  const out = [];
  let cuts = 0;
  const cross = (p, q) => {
    // point where p (inside) -> q (outside) leaves the rect
    let t = 1;
    const dx = q[0] - p[0], dz = q[1] - p[1];
    if (dx > 0) t = Math.min(t, (R.x1 - EDGE - p[0]) / dx);
    if (dx < 0) t = Math.min(t, (R.x0 + EDGE - p[0]) / dx);
    if (dz > 0) t = Math.min(t, (R.z1 - EDGE - p[1]) / dz);
    if (dz < 0) t = Math.min(t, (R.z0 + EDGE - p[1]) / dz);
    return [p[0] + dx * t, p[1] + dz * t];
  };
  for (const l of rawLinks) {
    const ins = l.pts.map((p) => inRect(p));
    if (ins.every(Boolean)) { out.push(l); continue; }
    if (!ins.some(Boolean)) continue;
    // runs of inside points, extended to the edge
    let run = null;
    for (let i = 0; i < l.pts.length; i++) {
      if (ins[i]) {
        if (!run) {
          run = { pts: [], a: i === 0 ? l.a : `c${cuts++}` };
          if (i > 0) run.pts.push(cross(l.pts[i], l.pts[i - 1]));
        }
        run.pts.push(l.pts[i]);
        if (i === l.pts.length - 1) out.push({ ...l, a: run.a, b: l.b, pts: run.pts });
      } else if (run) {
        run.pts.push(cross(l.pts[i - 1], l.pts[i]));
        out.push({ ...l, a: run.a, b: `c${cuts++}`, pts: run.pts });
        run = null;
      }
    }
  }
  rawLinks = out;
}

// Join links end to end through nodes where nothing else meets and nothing changes
{
  const at = new Map();
  for (const l of rawLinks) for (const n of [l.a, l.b]) {
    if (!at.has(n)) at.set(n, []);
    at.get(n).push(l);
  }
  const same = (p, q) => p.name === q.name && p.w === q.w && p.lanes === q.lanes && p.dir === q.dir && p.cls === q.cls && p.bridge === q.bridge;
  const dead = new Set();
  for (const [n, ls] of at) {
    if (ls.length !== 2 || ls[0] === ls[1] || String(n).startsWith('r')) continue;
    let [p, q] = ls;
    if (dead.has(p) || dead.has(q) || !same(p, q)) continue;
    // orient p to end at n and q to start there
    const flip = (l) => { [l.a, l.b] = [l.b, l.a]; l.pts.reverse(); l.dir = -l.dir; };
    if (p.dir !== 0) {
      // one-way: travel must carry on through n
      if (p.b !== n) [p, q] = [q, p];
      if (p.b !== n || q.a !== n) continue;
    } else {
      if (p.b !== n) flip(p);
      if (q.a !== n) flip(q);
    }
    if (p.a === q.b) continue; // a loop
    p.pts.push(...q.pts.slice(1));
    p.b = q.b;
    dead.add(q);
    const lb = at.get(q.b);
    lb[lb.indexOf(q)] = p;
  }
  rawLinks = rawLinks.filter((l) => !dead.has(l));
}

for (const l of rawLinks) {
  l.pts = rdp(l.pts, 0.35);
  l.len = polylineLength(l.pts);
}

// --- Traffic signals: the junction nearest each signal (signals are mapped at the junction or on its stop lines) ------
const signalNodes = elements.filter((e) => e.type === 'node' && e.tags && e.tags.highway === 'traffic_signals').map((e) => wayPts({ geometry: [e] })[0]);
function markSignals(nodeList, degree) {
  const cells = new Map();
  nodeList.forEach((n, i) => {
    if (degree[i] < 3) return;
    const k = `${Math.floor(n[0] / 40)},${Math.floor(n[1] / 40)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  const signal = new Uint8Array(nodeList.length);
  for (const [x, z] of signalNodes) {
    let best = -1, bd = 34;
    for (let ix = Math.floor((x - 34) / 40); ix <= Math.floor((x + 34) / 40); ix++) {
      for (let iz = Math.floor((z - 34) / 40); iz <= Math.floor((z + 34) / 40); iz++) {
        for (const i of cells.get(`${ix},${iz}`) || []) {
          const d = Math.hypot(nodeList[i][0] - x, nodeList[i][1] - z);
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best >= 0) signal[best] = 1;
  }
  return signal;
}

/** The street graph, to be called once the links' widths are final (geo-blocks.mjs narrows them between buildings) */
export function buildStreetGraph() {
  const q = (v) => Math.round(v * 10) / 10;
  const ids = new Map();
  const nodes = [];
  const idOf = (key, p) => {
    if (!ids.has(key)) { ids.set(key, nodes.length); nodes.push([q(p[0]), q(p[1])]); }
    return ids.get(key);
  };
  const links = [];
  let km = 0;
  for (const l of rawLinks) {
    if (l.dropped) continue;
    const a = idOf(l.a, l.pts[0]);
    const b = idOf(l.b, l.pts[l.pts.length - 1]);
    if (a === b && l.len < 40) continue;
    links.push([a, b, nameId(l.name), q(l.w), l.lanes, l.dir, l.pts.slice(1, -1).flatMap(([x, z]) => [q(x), q(z)]), l.cls, (l.noTraffic ? 1 : 0) | (l.bridge ? 2 : 0)]);
    km += l.len / 1000;
  }
  const degree = new Uint8Array(nodes.length);
  for (const [a, b] of links) { degree[a]++; degree[b]++; }
  const signal = markSignals(nodes, degree);
  const signals = [];
  nodes.forEach((n, i) => { if (signal[i]) signals.push(n[0], n[1]); });
  log(`street graph: ${nodes.length} nodes, ${links.length} links, ${km.toFixed(0)} km, ${names.length} names, ${signals.length / 2} signalised junctions, ${rings.length} roundabouts`);
  return { nodes: nodes.flat(), links, names, signals };
}

// --- Motorways --------------------------------------------------------------------------------------------------------
export const motorways = motorwayWays.map((w) => {
  const t = w.tags;
  const lanes = parseInt(t.lanes, 10) || (t.highway === 'motorway' ? 3 : 1);
  return {
    name: t.name || t.ref || '', link: t.highway === 'motorway_link', lanes, w: Math.max(7.5, lanes * 3.5 + 3),
    bridge: t.bridge && t.bridge !== 'no' ? 1 : 0, tunnel: t.tunnel && t.tunnel !== 'no' ? 1 : 0, layer: parseInt(t.layer, 10) || 0,
    nodes: w.nodes, pts: wayPts(w)
  };
});

// --- Paths ------------------------------------------------------------------------------------------------------------
export const paths = pathWays.map((w) => {
  const t = w.tags;
  const kind = t.highway === 'steps' ? 'steps' : t.highway === 'pedestrian' ? 'mall' : t.highway === 'cycleway' ? 'cycle' : (t.footway === 'sidewalk' || t.footway === 'crossing') ? 'sidewalk' : 'path';
  return { name: t.name || '', kind, bridge: t.bridge && t.bridge !== 'no' ? 1 : 0, pts: wayPts(w) };
}).filter((p) => p.kind !== 'sidewalk' && p.pts.some((q) => inRect(q)));

export { rawLinks as streetLinks, rings as roundabouts, R as detailRect, inRect };
log(`${streetWays.length} street ways -> ${rawLinks.length} links (${(rawLinks.reduce((t, l) => t + l.len, 0) / 1000).toFixed(0)} km); ${motorways.length} motorway pieces; ${paths.length} paths; ${rings.length} roundabouts`);
