// Why is a turn at (x, z) rejected: samples along each lane-to-lane curve of the rejected moves there
globalThis.__NET_DEBUG = true;
const { BLOCKS } = await import('../../js/city-config.js');
const { buildRoadNetwork } = await import('../../js/road-network.js');
const sidewalks = [], footprints = [];
for (const b of BLOCKS) {
  const r = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, polygon: { outer: b.poly, holes: [] } };
  (b.median ? footprints : sidewalks).push(r);
}
const info = console.info; console.info = () => {};
const net = buildRoadNetwork(sidewalks, footprints, []);
console.info = info;
const X = +process.argv[2], Z = +process.argv[3];
const p = { x: 0, z: 0, dx: 0, dz: 0 };
for (const e of net.placedEdges) {
  if (Math.hypot(e.to.x - X, e.to.z - Z) > 3) continue;
  for (const f of net.placedEdges) {
    if (f.from !== e.to || f.to === e.from) continue;
    const made = (e.movesBefore || e.moves).some((m) => m.to === f);
    console.log(`from (${Math.round(e.x0)}, ${Math.round(e.z0)}) len ${e.len.toFixed(1)} span ${e.span.toFixed(1)} to (${Math.round(f.to.x)}, ${Math.round(f.to.z)}) len ${f.len.toFixed(1)} span ${f.span.toFixed(1)}: ${made ? 'made' : 'REJECTED'} dot ${(e.dx * f.dx + e.dz * f.dz).toFixed(2)}`);
    if (made) continue;
    for (let i = 0; i < e.lanes.length; i++) for (let j = 0; j < f.lanes.length; j++) {
      const c = net.connector(e, i, f, j);
      const row = [];
      for (let k = 1; k < 10; k++) { net.curvePoint(c, c.len * k / 10, p); row.push(net.isRoadClear(p.x, p.z, 0.55) ? '.' : net.isRoadClear(p.x, p.z, 0) ? 'x' : 'X'); }
      console.log(`   lane ${i} -> ${j}: curve ${c.len.toFixed(1)} m ${row.join('')}  start (${c.x0.toFixed(1)}, ${c.z0.toFixed(1)}) end (${c.x3.toFixed(1)}, ${c.z3.toFixed(1)})`);
    }
  }
}
