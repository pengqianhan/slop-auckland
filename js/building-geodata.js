// Building footprints & houses of central Auckland, written by tools/build-geodata.mjs.
// © OpenStreetMap contributors (ODbL), including outlines imported from LINZ & Auckland Council.
// Footprints: 0.25 m coordinates, 0.5 m roof heights, year built (0 unknown). Houses: boxes turned to their footprint.
const response = await fetch(new URL('./building-geodata.bin.gz', import.meta.url));
if (!response.ok) throw new Error(`Building data request failed: ${response.status}`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid building data.');
if (data.length < 12) throw invalidData();
const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
const xStart = 12 + header.getUint32(4, true), zStart = xStart + header.getUint32(8, true);
if (header.getUint32(0, true) !== 0x31424b41 || zStart > data.length) throw invalidData(); // 'AKB1'

// AKB1 stores separate metadata, X and Z streams; signed coordinate deltas use zigzag varints.
function stream(start, end) {
  let cursor = start;
  return {
    uint() {
      let value = 0, shift = 1, byte;
      do {
        if (cursor >= end) throw invalidData();
        byte = data[cursor++];
        value += (byte & 127) * shift;
        shift *= 128;
      } while (byte & 128);
      return value;
    },
    done: () => cursor === end
  };
}
const metadata = stream(12, xStart), xs = stream(xStart, zStart), zs = stream(zStart, data.length);
const uint = () => metadata.uint();
const delta = (s) => { const value = s.uint(); return value % 2 ? -(value + 1) / 2 : value / 2; };
let x = 0, z = 0;

export const REAL_BUILDINGS = Array.from({ length: uint() }, () => {
  const height = uint() * 0.5, year = uint(), shop = uint() === 1, polygons = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let n = uint(); n > 0; n--) {
    const rings = [];
    for (let m = uint(); m > 0; m--) {
      const ring = [];
      for (let k = uint(); k > 0; k--) {
        x += delta(xs); z += delta(zs);
        const point = { x: x * 0.25, z: z * 0.25 };
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
        ring.push(point);
      }
      rings.push(ring);
    }
    polygons.push({ outer: rings[0], holes: rings.slice(1) });
  }
  return { height, year: year ? year + 1800 : 0, shop, polygons, minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
});

// Houses: centre, width (the long side) x depth, heading of the long side (radians from +x towards +z), wall height,
// a style number and whether it is a shed / garage
export const HOUSES = Array.from({ length: uint() }, () => {
  x += delta(xs); z += delta(zs);
  return { x: x * 0.25, z: z * 0.25, w: uint() * 0.25, d: uint() * 0.25, ang: (uint() / 256) * Math.PI, wall: uint() * 0.25, style: uint(), shed: uint() === 1 };
});
if (!metadata.done() || !xs.done() || !zs.done()) throw invalidData();
