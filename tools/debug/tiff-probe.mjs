import { fromUrl } from 'geotiff';
const url = process.argv[2];
const tiff = await fromUrl(url);
const n = await tiff.getImageCount();
for (let i = 0; i < n; i++) {
  const im = await tiff.getImage(i);
  console.log(i, im.getWidth(), im.getHeight(), 'tile', im.getTileWidth(), im.getTileHeight(), 'comp', im.fileDirectory.Compression, 'bps', im.fileDirectory.BitsPerSample, 'fmt', im.fileDirectory.SampleFormat, i === 0 ? JSON.stringify({ origin: im.getOrigin(), res: im.getResolution(), bbox: im.getBoundingBox(), nodata: im.getGDALNoData() }) : '');
}
const last = await tiff.getImage(n - 1);
const t0 = Date.now();
const r = await last.readRasters({ interleave: true });
let mn = Infinity, mx = -Infinity; for (const v of r) { if (v > -1000) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }
console.log('overview read', r.length, r.constructor.name, 'min', mn, 'max', mx, Date.now() - t0, 'ms');
