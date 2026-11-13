// Trees of central Auckland, written by tools/build-geodata.mjs: the trees surveyed in OpenStreetMap
// (© OpenStreetMap contributors, ODbL) and trees grown by the generator in the mapped woods, parks & gardens.
// Positions on a 0.5 m grid.
const response = await fetch(new URL('./tree-geodata.bin.gz', import.meta.url));
if (!response.ok) throw new Error(`Tree data request failed: ${response.status}`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid tree data.');
if (data.length < 12) throw invalidData();
const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
if (header.getUint32(0, true) !== 0x31544b41) throw invalidData(); // 'AKT1'
const sections = header.getUint32(4, true);
const counts = Array.from({ length: sections }, (_, i) => header.getUint32(8 + i * 4, true));
const xStart = 12 + sections * 4;
const zStart = xStart + header.getUint32(8 + sections * 4, true);
if (sections !== 4 || zStart > data.length) throw invalidData();

function stream(start, end) {
  let cursor = start;
  return {
    delta() {
      let value = 0, shift = 1, byte;
      do {
        if (cursor >= end) throw invalidData();
        byte = data[cursor++];
        value += (byte & 127) * shift;
        shift *= 128;
      } while (byte & 128);
      return value % 2 ? -(value + 1) / 2 : value / 2;
    },
    done: () => cursor === end
  };
}
const xs = stream(xStart, zStart), zs = stream(zStart, data.length);
let x = 0, z = 0;
const [street, park, wood, garden] = counts.map((count) => {
  const points = new Float32Array(count * 2);
  for (let i = 0; i < points.length; i += 2) {
    x += xs.delta(); z += zs.delta();
    points[i] = x * 0.5;
    points[i + 1] = z * 0.5;
  }
  return points;
});
if (!xs.done() || !zs.done()) throw invalidData();

// Flat [x, z, x, z, ...] arrays
export const REAL_TREES = street; // surveyed street & park trees
export const PARK_TREES = park; // scattered over park lawns
export const WOOD_TREES = wood; // woods & bush
export const GARDEN_TREES = garden; // back yards & front yards
