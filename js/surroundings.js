import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ISLAND_BOUNDS, REGION_LAND, MOTORWAYS, isLand } from './city-config.js';
import { TERRAIN_REGION, SEABED, terrainHeight, regionHeight } from './terrain.js';
import { createRegionLandMaterial } from './tsl-materials.js';
import { distanceField, dataTexture } from './city-grid.js';
import { REGION_COVER } from './region-geodata.js';
import { buildRegionBuildings } from './region-buildings.js';

// Everything around the detailed city, out to the horizon:
//  - the region's land on its real terrain (the volcanic cones, the North Shore, Rangitoto & the gulf islands), a
//    32 m height grid cut to the coastline by a distance field and coloured from a land-cover map;
//  - the motorways: lanes for the ambient traffic that runs along them (in the cuttings, over the viaducts & the
//    Harbour Bridge, through the Victoria Park Tunnel), their lane paint, and the tunnel's portals.

const up4 = (n) => Math.ceil(n / 4) * 4;

// ---------------------------------------------------------------------------------------------------------------------
// The region's land
// ---------------------------------------------------------------------------------------------------------------------
// A land-cover map of tools/build-region.mjs (north up, so not flipped), with the rectangle of the world it covers
function coverMap(file, { x0, z0, sx, sz }) {
  const tex = new THREE.TextureLoader().load(new URL(`./${file}`, import.meta.url).href);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return { tex, x0, z0, sx, sz };
}

function buildRegionLand(group, coverTexture) {
  const G = TERRAIN_REGION;
  const H = G.heights;
  // Coastline of the whole region as a distance field: 12 m cells, +-40 m
  const CRES = 12, CREACH = 40;
  const cw = up4(((G.w - 1) * G.cell) / CRES), ch = up4(((G.h - 1) * G.cell) / CRES);
  const coast = distanceField(REGION_LAND.map((outer) => ({ outer })), G.x0, G.z0, CRES, cw, ch, CREACH);
  const textures = {
    coast: { tex: dataTexture(coast, cw, ch, THREE.RedFormat), x0: G.x0, z0: G.z0, sx: cw * CRES, sz: ch * CRES },
    cover: coverTexture || coverMap('region-cover-wide.png', REGION_COVER.wide),
    coverNear: coverTexture ? null : coverMap('region-cover-near.png', REGION_COVER.near)
  };
  const material = createRegionLandMaterial(textures);

  const B = ISLAND_BOUNDS;
  const inDetail = (x, z, m) => x > B.minX + m && x < B.maxX - m && z > B.minZ + m && z < B.maxZ - m;
  const hAt = (i, j) => H[Math.min(G.h - 1, Math.max(0, j)) * G.w + Math.min(G.w - 1, Math.max(0, i))];
  const SINK = 1.8; // under the detailed city the regional ground lies low, out of its way
  const CHUNK = 60; // cells (1.92 km)
  const SKIRT = 12;
  let first = null;
  for (let j0 = 0; j0 < G.h - 1; j0 += CHUNK) {
    for (let i0 = 0; i0 < G.w - 1; i0 += CHUNK) {
      const ni = Math.min(CHUNK, G.w - 1 - i0), nj = Math.min(CHUNK, G.h - 1 - j0);
      const mx = G.x0 + (i0 + ni / 2) * G.cell, mz = G.z0 + (j0 + nj / 2) * G.cell;
      // every sample within ~5 km of the city, every third beyond
      const stride = Math.hypot(mx, mz) < 5200 ? 1 : 3;
      const cols = Math.floor(ni / stride) + 1, rows = Math.floor(nj / stride) + 1;
      if (cols < 2 || rows < 2) continue;
      const pos = [], nor = [], idx = [];
      const vert = new Int32Array(cols * rows).fill(-1);
      const node = (c, r) => {
        const k = r * cols + c;
        if (vert[k] >= 0) return vert[k];
        const i = i0 + c * stride, j = j0 + r * stride;
        const x = G.x0 + i * G.cell, z = G.z0 + j * G.cell;
        const sunk = inDetail(x, z, 1) ? SINK : 0;
        pos.push(x, hAt(i, j) - sunk, z);
        const dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * G.cell), dz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * G.cell);
        const l = Math.hypot(dx, 1, dz);
        nor.push(-dx / l, 1 / l, -dz / l);
        return (vert[k] = pos.length / 3 - 1);
      };
      const rim = [];
      for (let r = 0; r + 1 < rows; r++) {
        for (let c = 0; c + 1 < cols; c++) {
          const i = i0 + c * stride, j = j0 + r * stride;
          const x = G.x0 + i * G.cell, z = G.z0 + j * G.cell, s = stride * G.cell;
          // open sea, or wholly under the detailed city: nothing to draw
          if (hAt(i, j) <= SEABED + 0.01 && hAt(i + stride, j) <= SEABED + 0.01 && hAt(i, j + stride) <= SEABED + 0.01 && hAt(i + stride, j + stride) <= SEABED + 0.01) continue;
          if (inDetail(x, z, 40) && inDetail(x + s, z, 40) && inDetail(x, z + s, 40) && inDetail(x + s, z + s, 40)) continue;
          const a = node(c, r), b = node(c + 1, r), cc = node(c, r + 1), d = node(c + 1, r + 1);
          idx.push(a, cc, d, a, d, b);
          // skirts along the chunk's rim
          if (r === 0) rim.push([a, b]);
          if (r === rows - 2) rim.push([d, cc]);
          if (c === 0) rim.push([cc, a]);
          if (c === cols - 2) rim.push([b, d]);
        }
      }
      if (!idx.length) continue;
      for (const [a, b] of rim) {
        const la = pos.length / 3;
        pos.push(pos[a * 3], pos[a * 3 + 1] - SKIRT, pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1] - SKIRT, pos[b * 3 + 2]);
        nor.push(nor[a * 3], nor[a * 3 + 1], nor[a * 3 + 2], nor[b * 3], nor[b * 3 + 1], nor[b * 3 + 2]);
        idx.push(a, b, la + 1, a, la + 1, la);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      if (first) mesh.userData.sharesPipelineWith = first;
      else first = mesh;
      group.add(mesh);
    }
  }

  // The region's shores: a bank from the land's edge down into the water, all along the coastline
  const bankMat = new THREE.MeshStandardNodeMaterial({ color: 0x57503f, roughness: 0.95, side: THREE.DoubleSide });
  const banks = [];
  for (const ring of REGION_LAND) {
    const pos = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      // (the detailed city has its own seawall; the map's straight edges out at the horizon aren't shores)
      if (inDetail(a.x, a.z, -5) && inDetail(b.x, b.z, -5)) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len > 1500) continue;
      const ya = regionHeight(a.x, a.z) + 0.3, yb = regionHeight(b.x, b.z) + 0.3;
      pos.push(a.x, ya, a.z, b.x, yb, b.z, b.x, SEABED, b.z, a.x, ya, a.z, b.x, SEABED, b.z, a.x, SEABED, a.z);
    }
    if (!pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    banks.push(g);
  }
  if (banks.length) {
    const mesh = new THREE.Mesh(mergeGeometries(banks), bankMat);
    mesh.name = 'RegionShores';
    group.add(mesh);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Motorways
// ---------------------------------------------------------------------------------------------------------------------
const WHITE = new THREE.Color(0xe6e2d6);
const LANE_W = 3.5;

function buildMotorways(group, roadPaint) {
  const lanes = [];
  const portalParts = [];
  for (const m of MOTORWAYS) {
    const P = m.pts;
    const n = P.length;
    if (n < 2) continue;
    // to the right of the direction of travel
    const right = P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: -(b.z - a.z) / L, z: (b.x - a.x) / L };
    });
    const offsetLine = (o, lift) => P.map((p, i) => {
      const v = new THREE.Vector3(p.x + right[i].x * o, p.y + lift, p.z + right[i].z * o);
      v.hidden = p.kind === 2;
      return v;
    });
    // traffic: a lane every 3.5 m about the carriageway's centre line; the lanes to the right run faster (keep left)
    for (let k = 0; k < m.lanes; k++) {
      const o = (k - (m.lanes - 1) / 2) * LANE_W;
      lanes.push({ pts: offsetLine(o, 0.0), speed: 23 + 2.2 * k + (m.lanes === 1 ? -4 : 0) });
    }
    // paint: dashed lane lines, solid edge lines (not in the tunnel)
    for (let k = 0; k <= m.lanes; k++) {
      const o = (k - m.lanes / 2) * LANE_W;
      const line = offsetLine(o, 0.05);
      const edge = k === 0 || k === m.lanes;
      for (let i = 0; i + 1 < n; i++) {
        if (line[i].hidden || line[i + 1].hidden) continue;
        const a = line[i], b = line[i + 1];
        if (edge) roadPaint.strip3D(a.x, a.y, a.z, b.x, b.y, b.z, 0.16, WHITE);
        else roadPaint.strip3D(a.x, a.y, a.z, b.x, b.y, b.z, 0.14, WHITE, 12, 0.25, i * 10);
      }
    }
    // tunnel portals: a concrete frame around a dark mouth where the carriageway goes under
    for (let i = 1; i < n; i++) {
      if ((P[i].kind === 2) === (P[i - 1].kind === 2)) continue;
      const inside = P[i].kind === 2 ? P[i] : P[i - 1];
      const outside = P[i].kind === 2 ? P[i - 1] : P[i];
      const dx = inside.x - outside.x, dz = inside.z - outside.z;
      const L = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(dx / L, dz / L);
      const w = m.lanes * LANE_W + 3;
      const mouth = new THREE.BoxGeometry(w, 6, 1.2);
      mouth.rotateY(yaw);
      mouth.translate(outside.x + (dx / L) * 2, outside.y + 3, outside.z + (dz / L) * 2);
      portalParts.push(mouth);
    }
  }
  if (portalParts.length) {
    const dark = new THREE.MeshBasicNodeMaterial({ color: 0x050607 });
    const mesh = new THREE.Mesh(mergeGeometries(portalParts), dark);
    mesh.name = 'TunnelPortals';
    group.add(mesh);
  }
  return lanes;
}

function buildSurroundings(scene, { roadPaint, coverTexture = null } = {}) {
  const group = new THREE.Group();
  group.name = 'AucklandSurroundings';
  buildRegionLand(group, coverTexture);
  const highwayLanes = buildMotorways(group, roadPaint);
  const buildings = buildRegionBuildings(group);
  scene.add(group);
  void isLand;
  void terrainHeight;
  return { group, colliders: [], highwayLanes, update: (cameraPos) => buildings.update(cameraPos), setReach: (share) => buildings.setReach(share) };
}

export { buildSurroundings };
