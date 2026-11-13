import { blocks, greens, parkPaths, piers, decks, landPolys } from '../geo-blocks.mjs';
import { streetLinks, detailRect as R } from '../geo-roads.mjs';
import { buildings } from '../geo-buildings.mjs';
import { DebugCanvas } from '../geo-util.mjs';
import { fileURLToPath } from 'node:url';
const out = (n) => fileURLToPath(new URL(n, import.meta.url));
function draw(name, x0, z0, x1, z1, scale) {
  const c = new DebugCanvas(x0, z0, x1, z1, scale);
  c.clear(40, 70, 110);
  for (const p of landPolys) c.fill(p.outer, [70, 70, 74]);
  for (const d of decks) c.line(d.pts, [200, 60, 200], false, 3);
  const cols = [[196, 190, 180], [150, 185, 130], [90, 160, 80], [150, 150, 160]];
  for (const b of blocks) c.fill(b.poly, b.island ? [230, 200, 80] : cols[b.kind]);
  for (const g of greens) c.fill(g.ring, g.kind === 4 ? [60, 110, 180] : g.kind === 2 ? [50, 120, 60] : g.kind === 5 ? [230, 220, 170] : g.kind === 3 ? [120, 200, 110] : [110, 175, 95]);
  for (const p of parkPaths) c.line(p.pts, [235, 225, 200]);
  for (const p of piers) c.fill(p.ring, [140, 110, 80]);
  for (const b of buildings) for (const p of b.polys) c.fill(p.outer, b.height || b.levels ? [200, 90, 70] : [120, 100, 90]);
  if (scale >= 1) for (const b of blocks) c.line(b.poly, [20, 20, 20], true);
  for (const l of streetLinks) if (scale >= 1) c.line(l.pts, l.dropped ? [255, 0, 0] : l.noTraffic ? [255, 160, 0] : l.dir ? [255, 255, 120] : [255, 255, 255]);
  c.save(out(name));
  console.log(name, c.w, c.h);
}
draw('blocks-all.png', R.x0, R.z0, R.x1, R.z1, 0.25);
draw('blocks-cbd.png', -700, -700, 700, 500, 1.0);
draw('blocks-ponsonby.png', -2300, -300, -1100, 800, 1.0);
