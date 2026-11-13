// Close-up of the road network round a point: blocks, placed edges (red: lost, green: kept), lanes, turns made (blue)
// usage: node tools/debug/network-zoom.mjs x z [radius] [picture.png]
import { fileURLToPath } from 'node:url';
import { DebugCanvas } from '../geo-util.mjs';

const { BLOCKS } = await import('../../js/city-config.js');
const { GEO } = await import('../../js/akl-geodata.js');
const { buildRoadNetwork } = await import('../../js/road-network.js');

const X = +process.argv[2], Z = +process.argv[3], R = +(process.argv[4] || 70);
const out = process.argv[5] || `zoom_${Math.round(X)}_${Math.round(Z)}.png`;
const sidewalks = [], footprints = [];
for (const b of BLOCKS) {
  const r = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, polygon: { outer: b.poly, holes: [] } };
  (b.median ? footprints : sidewalks).push(r);
}
const signals = [];
for (let i = 0; i < GEO.roadGraph.signals.length; i += 2) signals.push({ x: GEO.roadGraph.signals[i], z: GEO.roadGraph.signals[i + 1] });
const info = console.info;
console.info = () => {};
const net = buildRoadNetwork(sidewalks, footprints, signals);
console.info = info;
const c = new DebugCanvas(X - R, Z - R, X + R, Z + R, 900 / (2 * R));
c.clear(24, 28, 34);
const near = (x, z, m = 0) => Math.abs(x - X) < R + m && Math.abs(z - Z) < R + m;
for (const b of BLOCKS) if (b.maxX > X - R && b.minX < X + R && b.maxZ > Z - R && b.minZ < Z + R) c.fill(b.poly.map((p) => [p.x, p.z]), b.median ? [110, 96, 40] : [58, 66, 76]);
const kept = new Set(net.edges);
const pt = { x: 0, z: 0, dx: 0, dz: 0 };
for (const e of net.placedEdges) {
  if (!near(e.x0, e.z0, 60)) continue;
  for (const o of e.lanes) c.line([[e.sx + e.rx * o, e.sz + e.rz * o], [e.sx + e.dx * e.len + e.rx * o, e.sz + e.dz * e.len + e.rz * o]], kept.has(e) ? [90, 220, 120] : [230, 70, 70]);
  // arrow head
  const ex = e.sx + e.dx * e.len + e.rx * e.lanes[0], ez = e.sz + e.dz * e.len + e.rz * e.lanes[0];
  c.dot(ex, ez, 2, [255, 255, 255]);
  for (const m of e.moves) for (let i = 0; i < e.lanes.length; i++) {
    if (m.out[i] < 0) continue;
    const cv = net.connector(e, i, m.to, m.out[i]);
    const pts = [];
    for (let k = 0; k <= 12; k++) { net.curvePoint(cv, cv.len * k / 12, pt); pts.push([pt.x, pt.z]); }
    c.line(pts, [90, 150, 255]);
  }
}
for (const n of net.nodes) if (near(n.x, n.z)) c.dot(n.x, n.z, 3, n.signal ? [255, 255, 255] : n.shape ? [150, 150, 150] : [255, 200, 60]);
// the street graph's own links, thin grey, to compare
const G = GEO.roadGraph;
for (const l of G.links) {
  const a = [G.nodes[l[0] * 2], G.nodes[l[0] * 2 + 1]], b = [G.nodes[l[1] * 2], G.nodes[l[1] * 2 + 1]];
  if (near(a[0], a[1], 80)) c.line([a, ...(l[6] || []).reduce((p, v, i, arr) => (i % 2 ? p : [...p, [v, arr[i + 1]]]), []), b], [120, 120, 130]);
}
c.save(fileURLToPath(new URL(out, import.meta.url)));
console.log('wrote', out);
