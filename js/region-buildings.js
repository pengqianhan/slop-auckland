import * as THREE from 'three/webgpu';
import { attribute, color, float, vec2, vec3, floor, fract, sin, dot, step, mix, smoothstep, positionWorld } from 'three/tsl';
import { regionHeight } from './terrain.js';
import { cityUniforms } from './tsl-materials.js';

// The suburbs around the detailed city: some ninety thousand buildings as plain boxes, the houses under hipped roofs,
// the big sheds, shops & blocks flat-topped. tools/build-region.mjs made them from OpenStreetMap's building outlines
// (© OpenStreetMap contributors, ODbL): centre, sides, bearing & a height guessed from size where none is mapped.
// Instanced per 1.2 km cell, drawn out to a few kilometres from the camera, loaded after everything else.

const CELL = 1200;
const REACH = 3800;
const WALLS = [0xf1eee4, 0xe9e3d2, 0xdcd7ca, 0xcbd3d6, 0xc2c9b8, 0xe7dac2, 0xa9adac, 0x6a6e70, 0xd8cdb6, 0xa5624e, 0xb8c0c4, 0xefe9da];
const ROOFS = [0x5c6165, 0x43474c, 0x7b3d33, 0x40584a, 0x979da1, 0x6a4c3d, 0x4c5054, 0x83888c, 0x8a4a3c];
const FLATS = [0x8e9194, 0x9d9f9c, 0x777b80, 0xb0b1ac, 0x6c7074];
const BIG_WALLS = [0xc9c6bc, 0xb4b7b6, 0xd9d4c6, 0x9aa1a6, 0xa58c78, 0xe2ded2, 0x8d9499];

// Unit building: walls from y = 0 to 1 on a 1 x 1 footprint, under a hipped roof (ridge along x) or a flat one
function unitGeometry(hipped) {
  const pos = [], nor = [], roof = [];
  const quad = (a, b, c, d, isRoof) => {
    const n = new THREE.Vector3().subVectors(new THREE.Vector3(...b), new THREE.Vector3(...a)).cross(new THREE.Vector3().subVectors(new THREE.Vector3(...d), new THREE.Vector3(...a))).normalize();
    for (const p of [a, b, c, a, c, d]) {
      pos.push(...p);
      nor.push(n.x, n.y, n.z);
      roof.push(isRoof);
    }
  };
  const tri = (a, b, c) => quad(a, b, c, c, 1);
  const h = 0.5;
  // walls (outward)
  quad([-h, 0, h], [h, 0, h], [h, 1, h], [-h, 1, h], 0);
  quad([h, 0, -h], [-h, 0, -h], [-h, 1, -h], [h, 1, -h], 0);
  quad([h, 0, h], [h, 0, -h], [h, 1, -h], [h, 1, h], 0);
  quad([-h, 0, -h], [-h, 0, h], [-h, 1, h], [-h, 1, -h], 0);
  if (hipped) {
    const o = 0.54, r = 0.2, top = 1.42, eave = 0.98;
    quad([-o, eave, o], [o, eave, o], [r, top, 0], [-r, top, 0], 1);
    quad([o, eave, -o], [-o, eave, -o], [-r, top, 0], [r, top, 0], 1);
    tri([o, eave, o], [o, eave, -o], [r, top, 0]);
    tri([-o, eave, -o], [-o, eave, o], [-r, top, 0]);
  } else {
    quad([-h, 1, h], [h, 1, h], [h, 1, -h], [-h, 1, -h], 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('roof', new THREE.Float32BufferAttribute(roof, 1));
  return g;
}

function createMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.0 });
  const isRoof = attribute('roof', 'float');
  mat.colorNode = mix(attribute('wallTint', 'vec3'), attribute('roofTint', 'vec3'), isRoof);
  mat.roughnessNode = mix(float(0.85), float(0.6), isRoof);
  // a few lit windows after dark
  const cell = vec3(floor(positionWorld.x.div(2.6)), floor(positionWorld.y.div(2.7)), floor(positionWorld.z.div(2.6)));
  const lit = step(0.9, fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))).mul(43758.5453)));
  mat.emissiveNode = color(0xffcf8f).mul(lit).mul(float(1.0).sub(isRoof)).mul(smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow)).mul(0.55);
  void vec2;
  return mat;
}

async function loadRecords() {
  const response = await fetch(new URL('./region-buildings.bin.gz', import.meta.url));
  if (!response.ok) throw new Error(`Region buildings request failed: ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  const data = body[0] === 0x1f && body[1] === 0x8b
    ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : body;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 8 || view.getUint32(0, true) !== 0x31524b41) throw new Error('Invalid region buildings data.'); // 'AKR1'
  const n = Math.min(view.getUint32(4, true), Math.floor((data.length - 8) / 8));
  return { view, n };
}

function buildRegionBuildings(parent) {
  const group = new THREE.Group();
  group.name = 'RegionBuildings';
  parent.add(group);
  const cells = [];
  loadRecords().then(({ view, n }) => {
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const o = 8 + i * 8;
      const x = view.getInt16(o, true) / 4, z = view.getInt16(o + 2, true) / 4;
      const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { house: [], block: [] }));
      let a = view.getUint8(o + 4) / 2, d = view.getUint8(o + 5) / 2, th = (view.getInt8(o + 6) / 127) * (Math.PI / 4);
      const high = view.getUint8(o + 7) / 2;
      if (d > a) {
        // the long side along x: the ridge runs that way
        [a, d] = [d, a];
        th += Math.PI / 2;
      }
      (a * d < 330 && high < 7.5 ? b.house : b.block).push(x, z, a, d, th, high);
    }
    const material = createMaterial();
    const geometries = { house: unitGeometry(true), block: unitGeometry(false) };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    let first = null;
    for (const [key, b] of buckets) {
      const [cx, cz] = key.split(',').map(Number);
      for (const kind of ['house', 'block']) {
        const list = b[kind];
        const count = list.length / 6;
        if (!count) continue;
        const g = geometries[kind].clone();
        const wall = new Float32Array(count * 3), roof = new Float32Array(count * 3);
        const mesh = new THREE.InstancedMesh(g, material, count);
        for (let i = 0; i < count; i++) {
          const [x, z, a, d, th, high] = list.slice(i * 6, i * 6 + 6);
          const cs = Math.cos(th) * a * 0.5, sn = Math.sin(th) * a * 0.5;
          // from the lowest ground under it
          const ground = Math.min(regionHeight(x, z), regionHeight(x + cs, z + sn), regionHeight(x - cs, z - sn)) - 0.6;
          const top = Math.max(regionHeight(x, z), ground) + high;
          p.set(x, ground, z);
          q.setFromAxisAngle(up, -th);
          s.set(a, top - ground, d);
          mesh.setMatrixAt(i, m.compose(p, q, s));
          const r = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
          const r2 = Math.abs(Math.sin(x * 39.346 + z * 11.135) * 24634.6345) % 1;
          tint.setHex(kind === 'house' ? WALLS[Math.floor(r * WALLS.length)] : BIG_WALLS[Math.floor(r * BIG_WALLS.length)]).toArray(wall, i * 3);
          tint.setHex(kind === 'house' ? ROOFS[Math.floor(r2 * ROOFS.length)] : FLATS[Math.floor(r2 * FLATS.length)]).toArray(roof, i * 3);
        }
        g.setAttribute('wallTint', new THREE.InstancedBufferAttribute(wall, 3));
        g.setAttribute('roofTint', new THREE.InstancedBufferAttribute(roof, 3));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.visible = false;
        if (first) mesh.userData.sharesPipelineWith = first;
        else first = mesh;
        group.add(mesh);
        cells.push({ mesh, x: (cx + 0.5) * CELL, z: (cz + 0.5) * CELL });
      }
    }
    console.info(`[region] ${n} buildings of the surrounding suburbs in ${cells.length} batches`);
  }).catch((err) => console.warn('[region] buildings of the surroundings not loaded:', err));

  let reach = REACH;
  return {
    group,
    update(cameraPos) {
      for (const c of cells) c.mesh.visible = Math.hypot(c.x - cameraPos.x, c.z - cameraPos.z) < reach + CELL * 0.71 + cameraPos.y * 2;
    },
    /** A share of the full distance they are drawn to (the graphics quality sets it) */
    setReach(share) {
      reach = REACH * share;
    }
  };
}

export { buildRegionBuildings };
