import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, color, uv, attribute, positionWorld, cameraPosition, fract, floor, abs, step, smoothstep, mix, max, min, sin, dot, length, fwidth } from 'three/tsl';
import { HOUSES } from './building-geodata.js';
import { terrainHeight } from './terrain.js';
import { cityUniforms } from './tsl-materials.js';

// The houses of the inner suburbs: villas, bungalows, townhouses, sheds & garages. Each is the box of its surveyed
// footprint (turned to it), weatherboard walls from the lowest ground under it to the eaves, under a hipped or gabled
// corrugated-iron roof. All of them are merged into a mesh per 700 m cell.

const WALLS = [0xf1eee4, 0xe9e3d2, 0xdcd7ca, 0xcbd3d6, 0xc2c9b8, 0xe7dac2, 0x9aa0a2, 0x54585c, 0xf1eee4, 0xd8cdb6, 0xa5624e, 0xb8c0c4];
const ROOFS = [0x5c6165, 0x3d4146, 0x7b3d33, 0x40584a, 0x979da1, 0x6a4c3d, 0x4c5054, 0x83888c];

function createHouseWallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0 });
  const tint = attribute('color', 'vec3');
  // uv: metres along the wall, metres above the floor; uv2: a number per house
  const u = uv().x;
  const v = uv().y;
  const seed = attribute('house', 'float');
  const camDist = length(positionWorld.sub(cameraPosition));
  const detail = smoothstep(140.0, 30.0, camDist);
  // sash windows: a bay every 3.3 m, a storey every 2.8 m
  const bay = u.div(3.3).add(seed.mul(0.37));
  const storey = v.div(2.8);
  const bu = fract(bay);
  const sv = fract(storey);
  const fw = fwidth(vec2(bay, storey)).max(0.0001);
  const inWindow = smoothstep(0.27, float(0.27).add(fw.x), bu).mul(smoothstep(0.73, float(0.73).sub(fw.x), bu))
    .mul(smoothstep(0.34, float(0.34).add(fw.y), sv)).mul(smoothstep(0.8, float(0.8).sub(fw.y), sv)).mul(step(0.0, v));
  const inGlass = smoothstep(0.3, float(0.3).add(fw.x), bu).mul(smoothstep(0.7, float(0.7).sub(fw.x), bu))
    .mul(smoothstep(0.37, float(0.37).add(fw.y), sv)).mul(smoothstep(0.77, float(0.77).sub(fw.y), sv)).mul(step(0.0, v));
  // every third bay or so is blank wall
  const cell = vec2(floor(bay), floor(storey).add(seed.mul(7.0)));
  const hasWindow = step(0.3, fract(sin(dot(cell, vec2(127.1, 311.7))).mul(43758.5453)));
  const lit = step(0.62, fract(sin(dot(cell, vec2(269.5, 183.3))).mul(43758.5453)));
  const window = inWindow.mul(hasWindow);
  const glass = inGlass.mul(hasWindow);
  // weatherboards: a shadow line under every board
  const board = smoothstep(0.82, 1.0, fract(v.div(0.17))).mul(detail).mul(0.16);
  // below the floor: base boards & piles, darker
  const base = step(v, 0.0);
  mat.colorNode = Fn(() => {
    const wall = tint.mul(float(1.0).sub(board)).mul(mix(float(1.0), float(0.55), base));
    const frame = mix(wall, vec3(0.93, 0.92, 0.88), window);
    return mix(frame, color(0x1c2733), glass);
  })();
  mat.roughnessNode = mix(float(0.84), float(0.22), glass);
  mat.emissiveNode = color(0xffcf8f).mul(glass).mul(lit).mul(smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow)).mul(0.9);
  return mat;
}

function createHouseRoofMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.35 });
  const tint = attribute('color', 'vec3');
  const camDist = length(positionWorld.sub(cameraPosition));
  const detail = smoothstep(110.0, 25.0, camDist);
  // corrugated iron: ribs every 76 mm are far too fine; long-run trays every 0.3 m read from the street
  const rib = abs(fract(uv().x.div(0.3)).sub(0.5)).mul(2.0);
  const weather = fract(sin(dot(floor(positionWorld.xz.div(1.7)), vec2(12.9898, 78.233))).mul(43758.5453));
  mat.colorNode = tint.mul(mix(float(1.0), rib.mul(0.22).add(0.86), detail)).mul(weather.mul(0.08).add(0.95));
  mat.roughnessNode = mix(float(0.6), float(0.42), max(float(0.0), min(float(1.0), tint.r.sub(0.4).mul(3.0))));
  return mat;
}

function buildHouses(group) {
  const CELL = 700;
  const cells = new Map();
  const colliders = [];
  const bucket = (x, z) => {
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { wall: { pos: [], uv: [], col: [], id: [] }, roof: { pos: [], uv: [], col: [] } }));
    return c;
  };
  const col = new THREE.Color();
  const tri = (b, P, U, c, id) => {
    for (let k = 0; k < 3; k++) {
      b.pos.push(P[k][0], P[k][1], P[k][2]);
      b.uv.push(U[k][0], U[k][1]);
      b.col.push(c.r, c.g, c.b);
      if (b.id) b.id.push(id);
    }
  };
  const quad = (b, p0, p1, p2, p3, u0, u1, u2, u3, c, id) => {
    tri(b, [p0, p1, p2], [u0, u1, u2], c, id);
    tri(b, [p0, p2, p3], [u0, u2, u3], c, id);
  };

  for (const h of HOUSES) {
    const ux = Math.cos(h.ang), uz = Math.sin(h.ang); // along the long side
    const vx = -uz, vz = ux; // across
    const hw = h.w / 2, hd = h.d / 2;
    const at = (a, b) => [h.x + ux * a + vx * b, h.z + uz * a + vz * b];
    const corners = [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)];
    let low = Infinity, high = -Infinity;
    for (const [x, z] of corners) {
      const g = terrainHeight(x, z);
      low = Math.min(low, g);
      high = Math.max(high, g);
    }
    // the floor sits at the uphill ground (on a steep section, no more than a storey above the downhill side)
    const floorY = Math.min(high, low + 2.6) + 0.3;
    const baseY = low - 0.3;
    const eaveY = floorY + h.wall;
    const c = bucket(h.x, h.z);
    const wallCol = col.setHex(h.shed ? [0xd9d6cc, 0x9a9d9c, 0xcfc9b8, 0x6c7072][h.style % 4] : WALLS[h.style % WALLS.length]).clone();
    const roofCol = col.setHex(ROOFS[(h.style * 7 + 3) % ROOFS.length]).clone();
    const id = h.style + (h.x % 13);

    // walls (outward faces)
    const wallFace = (a, b, len) => {
      quad(c.wall, [a[0], baseY, a[1]], [b[0], baseY, b[1]], [b[0], eaveY, b[1]], [a[0], eaveY, a[1]],
        [0, baseY - floorY], [len, baseY - floorY], [len, h.wall], [0, h.wall], wallCol, id);
    };
    wallFace(corners[1], corners[0], h.w); // -v side
    wallFace(corners[3], corners[2], h.w); // +v side
    wallFace(corners[2], corners[1], h.d); // +u end
    wallFace(corners[0], corners[3], h.d); // -u end

    // roof
    const o = h.shed ? 0.2 : 0.45; // eaves
    const pitch = h.shed ? 0.2 : 0.42 + (h.style % 5) * 0.045; // rise over run
    const ey = eaveY - 0.08;
    const E = [at(-hw - o, -hd - o), at(hw + o, -hd - o), at(hw + o, hd + o), at(-hw - o, hd + o)].map(([x, z]) => [x, ey, z]);
    const run = hd + o;
    const ridgeY = ey + run * pitch;
    const slope = Math.hypot(run, run * pitch);
    const gable = h.shed || h.style % 4 === 0 || h.w - h.d < 1.2;
    const rh = gable ? hw + o : Math.max(0.2, hw - hd); // half length of the ridge
    const R0 = [h.x - ux * rh, ridgeY, h.z - uz * rh], R1 = [h.x + ux * rh, ridgeY, h.z + uz * rh];
    const L = 2 * (hw + o);
    const inset = hw + o - rh;
    // the two long faces
    quad(c.roof, E[1], E[0], R0, R1, [L, 0], [0, 0], [inset, slope], [L - inset, slope], roofCol);
    quad(c.roof, E[3], E[2], R1, R0, [L, 0], [0, 0], [inset, slope], [L - inset, slope], roofCol);
    if (gable) {
      // gable ends in the wall's colour, up to the ridge
      const g0 = [h.x - ux * hw, ridgeY - o * pitch, h.z - uz * hw], g1 = [h.x + ux * hw, ridgeY - o * pitch, h.z + uz * hw];
      tri(c.wall, [[corners[0][0], eaveY, corners[0][1]], [corners[3][0], eaveY, corners[3][1]], g0], [[0, h.wall], [h.d, h.wall], [hd, h.wall + hd * pitch]], wallCol, id);
      tri(c.wall, [[corners[2][0], eaveY, corners[2][1]], [corners[1][0], eaveY, corners[1][1]], g1], [[0, h.wall], [h.d, h.wall], [hd, h.wall + hd * pitch]], wallCol, id);
    } else {
      // hips
      const hs = Math.hypot(inset, run * pitch);
      tri(c.roof, [E[0], E[3], R0], [[0, 0], [2 * run, 0], [run, hs]], roofCol);
      tri(c.roof, [E[2], E[1], R1], [[0, 0], [2 * run, 0], [run, hs]], roofCol);
    }

    const cs = ux, sn = -uz;
    const ex = Math.abs(ux) * hw + Math.abs(vx) * hd, ez = Math.abs(uz) * hw + Math.abs(vz) * hd;
    colliders.push({ minX: h.x - ex, maxX: h.x + ex, minZ: h.z - ez, maxZ: h.z + ez, minY: baseY, maxY: ridgeY, obb: { cx: h.x, cz: h.z, hx: hw, hz: hd, cs, sn } });
  }

  const wallMat = createHouseWallMaterial();
  const roofMat = createHouseRoofMaterial();
  wallMat.side = roofMat.side = THREE.DoubleSide;
  const houses = new THREE.Group();
  houses.name = 'Houses';
  let firstWall = null, firstRoof = null;
  for (const c of cells.values()) {
    for (const [b, mat] of [[c.wall, wallMat], [c.roof, roofMat]]) {
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      if (b.id) g.setAttribute('house', new THREE.Float32BufferAttribute(b.id, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.shadowStandIn = true;
      if (mat === wallMat) {
        if (firstWall) mesh.userData.sharesPipelineWith = firstWall;
        else firstWall = mesh;
      } else if (firstRoof) mesh.userData.sharesPipelineWith = firstRoof;
      else firstRoof = mesh;
      houses.add(mesh);
    }
  }
  group.add(houses);
  return { group: houses, colliders };
}

export { buildHouses };
