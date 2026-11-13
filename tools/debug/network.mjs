// Builds the game's road network outside the browser and reports how much of the street graph traffic can use
// usage: node tools/debug/network.mjs [picture.png]
import { fileURLToPath } from 'node:url';
import { DebugCanvas } from '../geo-util.mjs';

globalThis.__NET_DEBUG = true;
const { BLOCKS, ISLAND_BOUNDS, ROADS } = await import('../../js/city-config.js');
const { GEO } = await import('../../js/akl-geodata.js');
const { buildRoadNetwork } = await import('../../js/road-network.js');

const sidewalks = [], footprints = [];
for (const b of BLOCKS) {
  const r = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, polygon: { outer: b.poly, holes: [] } };
  (b.median ? footprints : sidewalks).push(r);
}
const signals = [];
for (let i = 0; i < GEO.roadGraph.signals.length; i += 2) signals.push({ x: GEO.roadGraph.signals[i], z: GEO.roadGraph.signals[i + 1] });
const info = console.info;
const t0 = Date.now();
const net = buildRoadNetwork(sidewalks, footprints, signals);
console.info = info;
const km = (list) => (list.reduce((t, e) => t + e.len, 0) / 1000).toFixed(1);
console.log(`network: ${net.nodes.length} nodes, ${net.edges.length} edges (${km(net.edges)} km of lanes' roads), ${net.paintEdges.length} painted edges (${km(net.paintEdges)} km); ${net.nodes.filter((n) => n.signal).length} signalised; ${Date.now() - t0} ms`);
const total = ROADS.filter((r) => !r.closed).reduce((t, r) => t + r.pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - r.pts[i].x, p.z - r.pts[i].z), 0) * (r.dir ? 1 : 2), 0) / 1000;
console.log(`street graph offers ${total.toFixed(0)} km of directed carriageway; traffic uses ${(100 * km(net.edges) / total).toFixed(0)}%`);
const lanes = new Map();
for (const e of net.edges) lanes.set(e.lanes.length, (lanes.get(e.lanes.length) || 0) + 1);
console.log('lanes per edge:', [...lanes].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}: ${n}`).join(', '));

if (process.argv[2]) {
  const B = ISLAND_BOUNDS;
  const c = new DebugCanvas(B.minX, B.minZ, B.maxX, B.maxZ, 0.33);
  c.clear(24, 28, 34);
  for (const b of BLOCKS) c.fill(b.poly.map((p) => [p.x, p.z]), b.median ? [90, 80, 40] : [44, 50, 58]);
  for (const e of net.paintEdges) c.line([[e.x0, e.z0], [e.x0 + e.dx * e.span, e.z0 + e.dz * e.span]], [200, 60, 60]);
  for (const e of net.edges) c.line([[e.sx, e.sz], [e.sx + e.dx * e.len, e.sz + e.dz * e.len]], e.bridge ? [255, 220, 80] : [90, 220, 120]);
  for (const n of net.nodes) if (n.signal) c.dot(n.x, n.z, 2, [255, 255, 255]);
  c.save(fileURLToPath(new URL(process.argv[2], import.meta.url)));
  console.log('wrote', process.argv[2], c.w, c.h);
}

// Why edges drop out: no way on (a dead end, or every turn blocked), or not reachable both ways
{
  const kept = new Set(net.edges);
  const lost = net.placedEdges.filter((e) => !kept.has(e));
  const outs = new Map();
  for (const e of net.placedEdges) { if (!outs.has(e.from)) outs.set(e.from, []); outs.get(e.from).push(e); }
  let deadEnd = 0, blockedTurns = 0, other = 0;
  const samples = [];
  for (const e of lost) {
    const cands = (outs.get(e.to) || []).filter((f) => f.to !== e.from);
    if (!cands.length) deadEnd++;
    else if (!(e.movesBefore || e.moves).length) { blockedTurns++; if (samples.length < 12) samples.push(`(${Math.round(e.to.x)}, ${Math.round(e.to.z)}) half ${e.half.toFixed(1)} lanes ${e.lanes.map((l) => l.toFixed(1))} -> ${cands.length} ways, len ${e.len.toFixed(0)}`); }
    else other++;
  }
  console.log(`lost ${lost.length} edges: ${deadEnd} at dead ends, ${blockedTurns} with every way on blocked, ${other} cut off from the rest`);
  console.log(samples.join('\n'));
}

// The strongly connected pieces of the placed edges, and what joins the next biggest ones to the biggest
{
  const E = net.placedEdges;
  const idx = new Map(E.map((e, i) => [e, i]));
  const succ = E.map((e) => (e.movesBefore || e.moves).map((m) => idx.get(m.to)).filter((j) => j !== undefined));
  const pred = E.map(() => []);
  succ.forEach((s, i) => { for (const j of s) pred[j].push(i); });
  const seen = new Uint8Array(E.length), order = [];
  for (let r = 0; r < E.length; r++) {
    if (seen[r]) continue;
    seen[r] = 1;
    const st = [[r, 0]];
    while (st.length) {
      const top = st[st.length - 1];
      if (top[1] < succ[top[0]].length) { const j = succ[top[0]][top[1]++]; if (!seen[j]) { seen[j] = 1; st.push([j, 0]); } } else { order.push(top[0]); st.pop(); }
    }
  }
  const comp = new Int32Array(E.length).fill(-1);
  const sizes = [];
  for (let k = order.length - 1; k >= 0; k--) {
    if (comp[order[k]] >= 0) continue;
    const c = sizes.length;
    const st = [order[k]];
    comp[order[k]] = c;
    let n = 0;
    while (st.length) { const i = st.pop(); n++; for (const p of pred[i]) if (comp[p] < 0) { comp[p] = c; st.push(p); } }
    sizes.push(n);
  }
  const top = sizes.map((n, c) => [n, c]).sort((a, b) => b[0] - a[0]).slice(0, 6);
  const main = top[0][1];
  for (const [n, c] of top) {
    const es = E.filter((_, i) => comp[i] === c);
    const xs = es.map((e) => e.sx), zs = es.map((e) => e.sz);
    let into = 0, outOf = 0;
    const links = [];
    E.forEach((e, i) => {
      for (const j of succ[i]) {
        if (comp[i] === c && comp[j] === main && c !== main) { outOf++; }
        if (comp[i] === main && comp[j] === c && c !== main) { into++; }
      }
    });
    console.log(`component of ${n} edges: x ${Math.round(Math.min(...xs))}..${Math.round(Math.max(...xs))}, z ${Math.round(Math.min(...zs))}..${Math.round(Math.max(...zs))}; moves into it from the main one: ${into}, out of it to the main one: ${outOf}`);
  }
  // one-way streets in the second component's boundary: where does it leave / enter?
  const second = top[1][1];
  const gate = [];
  E.forEach((e, i) => {
    if (comp[i] !== second) return;
    for (const f of (net.placedEdges.filter((g) => g.from === e.to && g.to !== e.from))) {
      const j = idx.get(f);
      if (comp[j] !== second && !(e.movesBefore || e.moves).some((m) => m.to === f)) gate.push(`no move at (${Math.round(e.to.x)}, ${Math.round(e.to.z)}): lanes ${e.lanes.map((l) => l.toFixed(1))} half ${e.half.toFixed(1)} -> lanes ${f.lanes.map((l) => l.toFixed(1))} half ${f.half.toFixed(1)} cross ${(e.dx * f.dz - e.dz * f.dx).toFixed(2)} dot ${(e.dx * f.dx + e.dz * f.dz).toFixed(2)} bridge ${e.bridge}/${f.bridge}`);
    }
  });
  console.log(gate.slice(0, 14).join('\n'));
}

// One-directional pairs, rejected turns, and which way the lost edges hang off the kept network
{
  const E = net.placedEdges;
  const kept = new Set(net.edges);
  const key = (e) => E.indexOf(e);
  const byPair = new Map();
  for (const e of E) { if (!byPair.has(e.from)) byPair.set(e.from, new Map()); byPair.get(e.from).set(e.to, e); }
  let lonely = 0, lonelyOneWay = 0;
  for (const e of E) { const r = byPair.get(e.to) && byPair.get(e.to).get(e.from); if (!r) { lonely++; if (e.oneWayRoad) lonelyOneWay++; } }
  console.log(`edges without their opposite: ${lonely} (${lonelyOneWay} on one-way roads)`);
  const outs = new Map();
  for (const e of E) { if (!outs.has(e.from)) outs.set(e.from, []); outs.get(e.from).push(e); }
  let cand = 0, made = 0, sharp = 0;
  const rejected = [];
  for (const e of E) for (const f of outs.get(e.to) || []) {
    if (f.to === e.from) continue;
    if (e.dx * f.dx + e.dz * f.dz < -0.8) { sharp++; continue; }
    cand++;
    if ((e.movesBefore || e.moves).some((m) => m.to === f)) made++; else rejected.push([e, f]);
  }
  console.log(`turns: ${cand} candidates, ${made} made, ${rejected.length} rejected, ${sharp} too sharp`);
  const short = rejected.filter(([e, f]) => e.len < 6 || f.len < 6).length;
  console.log(`rejected turns with an edge under 6 m long: ${short}`);
  // forward / backward reach against the kept set
  const succ = new Map(E.map((e) => [e, (e.movesBefore || e.moves).map((m) => m.to)]));
  const pred = new Map(E.map((e) => [e, []]));
  for (const e of E) for (const f of succ.get(e)) pred.get(f).push(e);
  const reach = (start, next) => { const s = new Set(start); const st = [...start]; while (st.length) { const e = st.pop(); for (const f of next.get(e)) if (!s.has(f)) { s.add(f); st.push(f); } } return s; };
  const fromMain = reach(kept, succ), toMain = reach(kept, pred);
  let sink = 0, source = 0, island = 0;
  for (const e of E) { if (kept.has(e)) continue; if (fromMain.has(e)) sink++; else if (toMain.has(e)) source++; else island++; }
  console.log(`lost edges: ${sink} reached from the network but with no way back, ${source} leading into it but not reached, ${island} neither`);
  for (const [e, f] of rejected.slice(0, 40)) {
    console.log(`rejected at (${Math.round(e.to.x)}, ${Math.round(e.to.z)}): half ${e.half.toFixed(1)} lanes ${e.lanes.map((l) => l.toFixed(1))} len ${e.len.toFixed(0)} -> half ${f.half.toFixed(1)} lanes ${f.lanes.map((l) => l.toFixed(1))} len ${f.len.toFixed(0)} cross ${(e.dx * f.dz - e.dz * f.dx).toFixed(2)}`);
  }
}

// How much of the loss is cul-de-sacs (trees hanging off the network: no U-turns, so no traffic) and how much is not
{
  const E = net.placedEdges;
  const kept = new Set(net.edges);
  const B = ISLAND_BOUNDS;
  const atEdge = (n) => n.x < B.minX + 6 || n.x > B.maxX - 6 || n.z < B.minZ + 6 || n.z > B.maxZ - 6;
  const nb = new Map();
  const add = (a, b) => { if (!nb.has(a)) nb.set(a, new Set()); nb.get(a).add(b); };
  for (const e of E) { add(e.from, e.to); add(e.to, e.from); }
  const edgeNodes = [...nb.keys()].filter(atEdge);
  console.log(`nodes on the edge of the map: ${edgeNodes.length}`);
  for (const pass of ['as is', 'with the map-edge ends counted as through roads']) {
    const deg = new Map([...nb].map(([n, s]) => [n, new Set(s)]));
    const q = [...deg].filter(([n, s]) => s.size <= 1 && !(pass !== 'as is' && atEdge(n))).map(([n]) => n);
    const gone = new Set();
    while (q.length) {
      const n = q.pop();
      if (gone.has(n)) continue;
      gone.add(n);
      for (const m of deg.get(n)) { deg.get(m).delete(n); if (deg.get(m).size <= 1 && !(pass !== 'as is' && atEdge(m))) q.push(m); }
    }
    const lost = E.filter((e) => !kept.has(e));
    const tree = lost.filter((e) => gone.has(e.from) || gone.has(e.to));
    const km = (l) => (l.reduce((t, e) => t + e.len, 0) / 1000).toFixed(1);
    console.log(`${pass}: ${tree.length} lost edges (${km(tree)} km) are on cul-de-sacs, ${lost.length - tree.length} (${km(lost.filter((e) => !(gone.has(e.from) || gone.has(e.to))))} km) are on roads that go round`);
  }
}

// Picture of the losses: kept green; lost on cul-de-sacs dark red; lost on through roads: reached but no way back
// magenta, leading in but not reached cyan, neither yellow; white dots where a two-way run has only one direction
if (process.argv[3]) {
  const E = net.placedEdges;
  const kept = new Set(net.edges);
  const B = ISLAND_BOUNDS;
  const [qx, qz] = (process.argv[4] || '0,0').split(',').map(Number); // which quarter
  const mx = (B.minX + B.maxX) / 2, mz = (B.minZ + B.maxZ) / 2;
  const x0 = qx ? mx - 200 : B.minX, x1 = qx ? B.maxX : mx + 200, z0 = qz ? mz - 200 : B.minZ + 900, z1 = qz ? B.maxZ : mz + 200;
  const c = new DebugCanvas(x0, z0, x1, z1, 0.62);
  c.clear(24, 28, 34);
  for (const b of BLOCKS) c.fill(b.poly.map((p) => [p.x, p.z]), b.median ? [90, 80, 40] : [44, 50, 58]);
  const nb = new Map();
  const add = (a, b) => { if (!nb.has(a)) nb.set(a, new Set()); nb.get(a).add(b); };
  for (const e of E) { add(e.from, e.to); add(e.to, e.from); }
  const q = [...nb].filter(([n, s]) => s.size <= 1).map(([n]) => n);
  const gone = new Set();
  while (q.length) { const n = q.pop(); if (gone.has(n)) continue; gone.add(n); for (const m of nb.get(n)) { nb.get(m).delete(n); if (nb.get(m).size <= 1) q.push(m); } }
  const succ = new Map(E.map((e) => [e, (e.movesBefore || e.moves).map((m) => m.to)]));
  const pred = new Map(E.map((e) => [e, []]));
  for (const e of E) for (const f of succ.get(e)) pred.get(f).push(e);
  const reach = (start, next) => { const s = new Set(start); const st = [...start]; while (st.length) { const e = st.pop(); for (const f of next.get(e)) if (!s.has(f)) { s.add(f); st.push(f); } } return s; };
  const fromMain = reach(kept, succ), toMain = reach(kept, pred);
  const pair = new Set(E.map((e) => E.indexOf(e)));
  const has = new Map();
  for (const e of E) { if (!has.has(e.from)) has.set(e.from, new Set()); has.get(e.from).add(e.to); }
  for (const e of E) {
    const o = e.lanes[0];
    const col = kept.has(e) ? [70, 190, 100] : gone.has(e.from) || gone.has(e.to) ? [120, 40, 40] : fromMain.has(e) ? [255, 60, 255] : toMain.has(e) ? [60, 230, 255] : [255, 230, 60];
    c.line([[e.sx + e.rx * o, e.sz + e.rz * o], [e.sx + e.dx * e.len + e.rx * o, e.sz + e.dz * e.len + e.rz * o]], col);
    if (!e.oneWayRoad && !(has.get(e.to) && has.get(e.to).has(e.from))) c.dot(e.sx + e.dx * e.len / 2, e.sz + e.dz * e.len / 2, 2, [255, 255, 255]);
  }
  c.save(fileURLToPath(new URL(process.argv[3], import.meta.url)));
  console.log('wrote', process.argv[3], c.w, c.h);
}
