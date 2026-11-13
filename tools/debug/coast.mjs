import { regionLand, detailLand, wideRect, detailRect } from '../geo-coast.mjs';
import { DebugCanvas } from '../geo-util.mjs';
import { fileURLToPath } from 'node:url';
const out = (n) => fileURLToPath(new URL(n, import.meta.url));
{
  const c = new DebugCanvas(wideRect.x0, wideRect.z0, wideRect.x1, wideRect.z1, 0.04);
  c.clear(40, 70, 110);
  for (const p of regionLand) { c.fill(p.outer, [150, 170, 120]); for (const h of p.holes) c.fill(h, [40, 70, 110]); }
  const r = detailRect;
  c.line([[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]], [255, 60, 60], true);
  c.dot(0, 0, 3, [255, 255, 0]);
  c.save(out('coast-wide.png'));
  console.log('wide', c.w, c.h);
}
{
  const c = new DebugCanvas(detailRect.x0 - 100, detailRect.z0 - 100, detailRect.x1 + 100, detailRect.z1 + 100, 0.22);
  c.clear(40, 70, 110);
  for (const p of detailLand) { c.fill(p.outer, [150, 170, 120]); for (const h of p.holes) c.fill(h, [40, 70, 110]); c.line(p.outer, [20, 20, 20], true); }
  c.dot(0, 0, 3, [255, 255, 0]);
  c.save(out('coast-detail.png'));
  console.log('detail', c.w, c.h, detailLand.map(p => Math.round(p.area)).join(' '));
}
