import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  ISLAND_BOUNDS,
  LAND_POLYGONS,
  BLOCKS,
  GREENS,
  PARK_PATHS,
  PIERS,
  RAILS,
  MOTORWAYS,
  HARBOUR_BRIDGE,
  blockAt,
  isLand,
  isRegionLand
} from './city-config.js';
import { TERRAIN_DETAIL, DECKS, SEABED, terrainHeight } from './terrain.js';
import {
  createRoadSurfaceMaterial,
  createBlockSurfaceMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial,
  createParkPavingMaterial
} from './tsl-materials.js';
import { createRoadPaintChunkBuilder } from './road-paint.js';

// The ground of the detailed city, on its real terrain:
//  - the land as a grid of height samples (terrain.js) drawn twice: once as roadway (asphalt), and once 22 cm higher
//    as the blocks' surface (footpaths along the kerbs, paving in the city, gardens among the houses, lawns & bush in
//    the parks, yards at the port). Distance-field textures made here from the blocks' and the coast's outlines cut
//    each layer to its shape, so kerbs and quays stay crisp whatever the grid's resolution;
//  - kerb faces along every block and the seawall along the coast;
//  - sports pitches, ponds & beaches, park paths, the railway, piers & pontoons;
//  - bridge decks (terrain.js DECKS) on their piers, with parapets.
// Landmarks, motorway traffic and the land around the detailed city are built in landmarks.js & surroundings.js.

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let centralParkClearings = null;
let parkTreeSites = [];
let parkLampSites = [];
let pavedPlazaRects = [];
let sidewalkBlocks = [];

const SW_TOP = 0.22; // footpaths above the roadway

/** Height of the walking surface on the blocks at (x, z) */
function getStreetGroundHeight(x, z) {
  return terrainHeight(x, z) + SW_TOP;
}

/**
 * Merges static non-instanced THREE.Mesh objects sharing the same material into a single
 * batched BufferGeometry per material to minimize WebGPU render & shadow pass draw calls.
 */
function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------------------
function pointInPolygonXZ(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
const signedArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  return a * 0.5;
};

/** Points along a polyline (closed: a ring) of {x, z} no more than `step` apart, the corners kept */
function densify(pts, step, closed = false) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let s = 0; s < k; s++) out.push({ x: a.x + ((b.x - a.x) * s) / k, z: a.z + ((b.z - a.z) * s) / k });
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

// Triangles collected as flat position arrays; flat-shaded normals are computed when the geometry is made
function triangleSoup() {
  const pos = [];
  return {
    pos,
    tri(ax, ay, az, bx, by, bz, cx, cy, cz) { pos.push(ax, ay, az, bx, by, bz, cx, cy, cz); },
    // quad a-b-c-d (around its rim)
    quad(a, b, c, d) { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]); },
    geometry(smoothUp = false) {
      if (!pos.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (smoothUp) {
        const nor = new Float32Array(pos.length);
        for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      } else g.computeVertexNormals();
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
      return g;
    }
  };
}

/**
 * A ribbon `w` wide along the polyline `pts` ({x, z}), laid on the ground `lift` above it (or at each point's own
 * height + lift where the points carry one: `y`), facing up. uv.x = style.
 */
function ribbonGeometry(pts, w, lift, style = 0, heightOf = terrainHeight) {
  const line = densify(pts, 3.5);
  const n = line.length;
  if (n < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const p = line[Math.max(0, i - 1)], q = line[i], r = line[Math.min(n - 1, i + 1)];
    let tx = r.x - p.x, tz = r.z - p.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    // one height across the ribbon (a path is level from edge to edge), a little into the uphill side
    const y = heightOf(q.x, q.z) + lift;
    left.push([q.x + tz * w * 0.5, y, q.z - tx * w * 0.5]);
    right.push([q.x - tz * w * 0.5, y, q.z + tx * w * 0.5]);
  }
  const soup = triangleSoup();
  for (let i = 0; i + 1 < n; i++) soup.quad(left[i], right[i], right[i + 1], left[i + 1]);
  const g = soup.geometry(true);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, style);
  return g;
}

/** A polygon ({x, z} outline, optional holes) laid on the ground `lift` above it: its outline in 6 m steps, each vertex at the ground's height */
function drapedPolygonGeometry(outer, holes, lift, level = false) {
  const ring = densify(outer, 6, true).map((p) => new THREE.Vector2(p.x, p.z));
  const holeRings = (holes || []).map((h) => densify(h, 6, true).map((p) => new THREE.Vector2(p.x, p.z)));
  if (THREE.ShapeUtils.isClockWise(ring)) ring.reverse();
  for (const h of holeRings) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
  const faces = THREE.ShapeUtils.triangulateShape(ring, holeRings);
  const all = [ring, ...holeRings].flat();
  let flatY = -Infinity;
  if (level) for (const p of all) flatY = Math.max(flatY, terrainHeight(p.x, p.y));
  const soup = triangleSoup();
  for (const [a, b, c] of faces) {
    const P = [all[a], all[b], all[c]].map((p) => [p.x, (level ? flatY : terrainHeight(p.x, p.y)) + lift, p.y]);
    // facing up whichever way the triangulation wound it
    const up = (P[1][2] - P[0][2]) * (P[2][0] - P[0][0]) - (P[1][0] - P[0][0]) * (P[2][2] - P[0][2]) > 0;
    if (up) soup.tri(...P[0], ...P[1], ...P[2]);
    else soup.tri(...P[0], ...P[2], ...P[1]);
  }
  return soup.geometry(true);
}

/** A flat polygon at height y with vertical sides down to y - depth (piers & pontoons over the water) */
function slabGeometry(pts, y, depth) {
  const shape = new THREE.Shape();
  pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y - depth, 0);
  return geo;
}

// Geometries collected per material & 800 m cell, merged into one mesh each (so far cells are culled as a whole)
function createBatcher(group) {
  const CELL = 800;
  const buckets = new Map();
  return {
    add(material, geometry, x, z, cast = false) {
      if (!geometry) return;
      const g = geometry.index ? geometry.toNonIndexed() : geometry;
      for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
      const key = `${material.uuid}:${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material, geos: [], cast }));
      b.geos.push(g);
      b.cast = b.cast || cast;
    },
    build() {
      const first = new Map();
      for (const b of buckets.values()) {
        const merged = mergeGeometries(b.geos, false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, b.material);
        mesh.receiveShadow = true;
        mesh.castShadow = b.cast;
        if (first.has(b.material)) mesh.userData.sharesPipelineWith = first.get(b.material);
        else first.set(b.material, mesh);
        group.add(mesh);
        for (const g of b.geos) g.dispose();
      }
      buckets.clear();
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Distance-field & cover textures over the detailed rectangle
// ---------------------------------------------------------------------------------------------------------------------
const up4 = (n) => Math.ceil(n / 4) * 4;

// Scanline fill of rings (even-odd) on a w x h raster of `res` m cells from (x0, z0): put(k) for every cell inside
function fillRings(rings, x0, z0, res, w, h, put) {
  let minZ = Infinity, maxZ = -Infinity;
  for (const ring of rings) for (const p of ring) { if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
  const j0 = Math.max(0, Math.floor((minZ - z0) / res)), j1 = Math.min(h - 1, Math.ceil((maxZ - z0) / res));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * res;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const a = ring[k], b = ring[i];
        if ((a.z > z) !== (b.z > z)) xs.push(a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z));
      }
    }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
      for (let i = i0; i <= i1; i++) put(j * w + i);
    }
  }
}

/**
 * Signed distance to the outlines of `polygons` ([{ outer, holes }]) as a w x h byte raster: 128 on the outline,
 * +-`scale` per metre (more inside), saturating `reach` m away.
 */
function distanceField(polygons, x0, z0, res, w, h, reach) {
  const scale = 127 / reach;
  const field = new Uint8Array(w * h); // 0: far outside
  for (const p of polygons) fillRings([p.outer, ...(p.holes || [])], x0, z0, res, w, h, (k) => { field[k] = 255; });
  for (const p of polygons) {
    for (const ring of [p.outer, ...(p.holes || [])]) {
      for (let s = 0, t = ring.length - 1; s < ring.length; t = s++) {
        const a = ring[t], b = ring[s];
        const dx = b.x - a.x, dz = b.z - a.z;
        const L2 = dx * dx + dz * dz || 1e-9;
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - x0) / res)), i1 = Math.min(w - 1, Math.ceil((Math.max(a.x, b.x) + reach - x0) / res));
        const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - z0) / res)), j1 = Math.min(h - 1, Math.ceil((Math.max(a.z, b.z) + reach - z0) / res));
        for (let j = j0; j <= j1; j++) {
          const pz = z0 + (j + 0.5) * res;
          for (let i = i0; i <= i1; i++) {
            const px = x0 + (i + 0.5) * res;
            let u = ((px - a.x) * dx + (pz - a.z) * dz) / L2;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const d = Math.hypot(a.x + dx * u - px, a.z + dz * u - pz);
            if (d >= reach) continue;
            const k = j * w + i;
            const v = field[k];
            if (v >= 128) {
              const nv = Math.round(128 + d * scale);
              if (nv < v) field[k] = nv;
            } else {
              const nv = Math.round(128 - d * scale);
              if (nv > v) field[k] = nv;
            }
          }
        }
      }
    }
  }
  return field;
}

function dataTexture(data, w, h, format) {
  const tex = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function buildGroundTextures() {
  const X0 = ISLAND_BOUNDS.minX, Z0 = ISLAND_BOUNDS.minZ;
  const spanX = ISLAND_BOUNDS.maxX - X0, spanZ = ISLAND_BOUNDS.maxZ - Z0;

  // Blocks: 1 m cells, +-4 m. Traffic islands count: they are raised too.
  const BRES = 1, BREACH = 4;
  const bw = up4(spanX / BRES), bh = up4(spanZ / BRES);
  const blockField = distanceField(BLOCKS.map((b) => ({ outer: b.poly })), X0, Z0, BRES, bw, bh, BREACH);

  // The coast: 2 m cells, +-8 m
  const LRES = 2, LREACH = 8;
  const lw = up4(spanX / LRES), lh = up4(spanZ / LRES);
  const landField = distanceField(LAND_POLYGONS, X0, Z0, LRES, lw, lh, LREACH);

  // What covers the blocks: 3 m cells. R lawn, G bush (the floor of the woods), B yard asphalt, A width of the
  // footpath along the kerb (255 = 3 m); none of R, G, B: paving
  const KRES = 3;
  const kw = up4(spanX / KRES), kh = up4(spanZ / KRES);
  const cover = new Uint8Array(kw * kh * 4);
  const paint = (rings, r, g, b, a) => fillRings(rings, X0, Z0, KRES, kw, kh, (k) => {
    if (r >= 0) { cover[k * 4] = r; cover[k * 4 + 1] = g; cover[k * 4 + 2] = b; }
    if (a >= 0) cover[k * 4 + 3] = a;
  });
  for (const b of BLOCKS) {
    if (b.median || b.kind === 0) paint([b.poly], 0, 0, 0, 0);
    else if (b.kind === 3) paint([b.poly], 0, 0, 255, 0);
    else paint([b.poly], 255, 0, 0, b.kind === 2 ? 180 : 220);
  }
  for (const g of GREENS) {
    if (g.kind === 2) paint([g.outer, ...g.holes], 0, 255, 0, -1);
    else if (g.kind === 1 || g.kind === 3) paint([g.outer, ...g.holes], 255, 0, 0, -1);
  }
  // No footpaths along the motorways: their verges run to the kerb
  for (const m of MOTORWAYS) {
    const reach = m.lanes * 1.8 + 16;
    for (let i = 0; i + 1 < m.pts.length; i++) {
      const a = m.pts[i], b = m.pts[i + 1];
      if (a.x < X0 - 50 || a.x > X0 + spanX + 50 || a.z < Z0 - 50 || a.z > Z0 + spanZ + 50) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      const nx = (-dz / L) * reach, nz = (dx / L) * reach;
      paint([[{ x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz }, { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz }]], -1, 0, 0, 0);
    }
  }

  const rect = (w, h, res) => ({ x0: X0, z0: Z0, sx: w * res, sz: h * res });
  return {
    block: { tex: dataTexture(blockField, bw, bh, THREE.RedFormat), reach: BREACH, ...rect(bw, bh, BRES) },
    land: { tex: dataTexture(landField, lw, lh, THREE.RedFormat), reach: LREACH, ...rect(lw, lh, LRES) },
    cover: { tex: dataTexture(cover, kw, kh, THREE.RGBAFormat), ...rect(kw, kh, KRES) }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The terrain as chunks of the height grid, each at two levels of detail
// ---------------------------------------------------------------------------------------------------------------------
const CHUNK = 96; // cells a side (480 m)
const COARSE = 4; // the far level skips to every 4th sample
const LOD_NEAR = 620; // m: chunks nearer than this draw every sample
const SKIRT = 5; // m: flaps hung from every chunk's rim hide the cracks between levels of detail

function buildTerrainChunks(group, roadMat, blockMat) {
  const G = TERRAIN_DETAIL;
  const H = G.heights;
  const hAt = (i, j) => H[Math.min(G.h - 1, Math.max(0, j)) * G.w + Math.min(G.w - 1, Math.max(0, i))];
  // which chunks hold any block (the rest need no block layer)
  const chunksX = Math.ceil((G.w - 1) / CHUNK), chunksZ = Math.ceil((G.h - 1) / CHUNK);
  const hasBlock = new Uint8Array(chunksX * chunksZ);
  for (const b of BLOCKS) {
    const c0 = Math.max(0, Math.floor((b.minX - G.x0) / (CHUNK * G.cell))), c1 = Math.min(chunksX - 1, Math.floor((b.maxX - G.x0) / (CHUNK * G.cell)));
    const r0 = Math.max(0, Math.floor((b.minZ - G.z0) / (CHUNK * G.cell))), r1 = Math.min(chunksZ - 1, Math.floor((b.maxZ - G.z0) / (CHUNK * G.cell)));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) hasBlock[r * chunksX + c] = 1;
  }

  function geometry(i0, j0, ni, nj, stride) {
    const cols = Math.floor(ni / stride) + 1, rows = Math.floor(nj / stride) + 1;
    const count = cols * rows;
    const rim = 2 * (cols + rows) - 4;
    const pos = new Float32Array((count + rim) * 3);
    const nor = new Float32Array((count + rim) * 3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = i0 + c * stride, j = j0 + r * stride;
        const k = (r * cols + c) * 3;
        pos[k] = G.x0 + i * G.cell;
        pos[k + 1] = hAt(i, j);
        pos[k + 2] = G.z0 + j * G.cell;
        const dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * G.cell), dz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * G.cell);
        const l = Math.hypot(dx, 1, dz);
        nor[k] = -dx / l; nor[k + 1] = 1 / l; nor[k + 2] = -dz / l;
      }
    }
    const idx = [];
    for (let r = 0; r + 1 < rows; r++) {
      for (let c = 0; c + 1 < cols; c++) {
        const a = r * cols + c, b = a + 1, cc = a + cols, d = cc + 1;
        idx.push(a, cc, d, a, d, b); // split along a-d, as terrain.js reads heights
      }
    }
    // skirt: the rim's vertices again, lower, joined to the rim
    const ring = [];
    for (let c = 0; c < cols; c++) ring.push(c);
    for (let r = 1; r < rows; r++) ring.push(r * cols + cols - 1);
    for (let c = cols - 2; c >= 0; c--) ring.push((rows - 1) * cols + c);
    for (let r = rows - 2; r >= 1; r--) ring.push(r * cols);
    ring.forEach((v, n) => {
      const k = (count + n) * 3;
      pos[k] = pos[v * 3]; pos[k + 1] = pos[v * 3 + 1] - SKIRT; pos[k + 2] = pos[v * 3 + 2];
      nor[k] = nor[v * 3]; nor[k + 1] = nor[v * 3 + 1]; nor[k + 2] = nor[v * 3 + 2];
    });
    for (let n = 0; n < ring.length; n++) {
      const a = ring[n], b = ring[(n + 1) % ring.length], la = count + n, lb = count + ((n + 1) % ring.length);
      idx.push(a, b, lb, a, lb, la);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(count + rim > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  const chunks = [];
  let firstRoad = null, firstBlock = null;
  for (let r = 0; r < chunksZ; r++) {
    for (let c = 0; c < chunksX; c++) {
      const i0 = c * CHUNK, j0 = r * CHUNK;
      const ni = Math.min(CHUNK, G.w - 1 - i0), nj = Math.min(CHUNK, G.h - 1 - j0);
      if (ni < COARSE || nj < COARSE) continue;
      // open water: nothing to draw
      let land = false;
      for (let j = j0; j <= j0 + nj && !land; j += 2) for (let i = i0; i <= i0 + ni; i += 2) if (hAt(i, j) > SEABED + 0.01) { land = true; break; }
      if (!land) continue;
      const near = geometry(i0, j0, ni, nj, 1);
      // the far level stops at the last whole coarse cell; the near one's last cells show beyond it only up close
      const far = geometry(i0, j0, Math.ceil(ni / COARSE) * COARSE, Math.ceil(nj / COARSE) * COARSE, COARSE);
      const chunk = { cx: near.boundingSphere.center.x, cz: near.boundingSphere.center.z, radius: near.boundingSphere.radius, near: [], far: [], isNear: true };
      for (const [geo, list] of [[near, chunk.near], [far, chunk.far]]) {
        const road = new THREE.Mesh(geo, roadMat);
        road.receiveShadow = true;
        if (firstRoad) road.userData.sharesPipelineWith = firstRoad;
        else firstRoad = road;
        list.push(road);
        if (hasBlock[r * chunksX + c]) {
          const block = new THREE.Mesh(geo, blockMat);
          block.position.y = SW_TOP;
          block.receiveShadow = true;
          if (firstBlock) block.userData.sharesPipelineWith = firstBlock;
          else firstBlock = block;
          list.push(block);
        }
      }
      for (const m of chunk.far) m.visible = false;
      group.add(...chunk.near, ...chunk.far);
      chunks.push(chunk);
    }
  }

  function update(camera) {
    const cx = camera.x, cz = camera.z;
    for (const ch of chunks) {
      const d = Math.hypot(ch.cx - cx, ch.cz - cz) - ch.radius;
      const near = ch.isNear ? d < LOD_NEAR + 60 : d < LOD_NEAR;
      if (near === ch.isNear) continue;
      ch.isNear = near;
      for (const m of ch.near) m.visible = near;
      for (const m of ch.far) m.visible = !near;
    }
  }
  return { chunks, update };
}

function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'AucklandCityGrid';
  const batch = createBatcher(group);

  // Ground footprints that traffic and pedestrians must keep clear of (traffic islands)
  const footprints = [];
  const colliders = [];

  // =========================================================================
  // 1. THE WAITEMATĀ HARBOUR & HAURAKI GULF
  // =========================================================================
  const waterMat = createWaterMaterial();
  const waterGeo = new THREE.PlaneGeometry(90000, 90000, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(0, ISLAND_BOUNDS.waterLevel, 0);
  group.add(water);

  // =========================================================================
  // 2. THE LAND: ROADWAY & BLOCK SURFACES ON THE TERRAIN
  // =========================================================================
  const textures = buildGroundTextures();
  const roadMat = createRoadSurfaceMaterial({ land: textures.land });
  const blockMat = createBlockSurfaceMaterial(textures);
  const terrainGroup = new THREE.Group();
  terrainGroup.name = 'AucklandTerrain';
  const terrain = buildTerrainChunks(terrainGroup, roadMat, blockMat);
  scene.add(terrainGroup);

  // Seawall along the coast: from the sea bed up to the quay, under a concrete coping
  const seawallMat = new THREE.MeshStandardNodeMaterial({ color: 0x5c5a55, roughness: 0.82, metalness: 0.1 });
  const copingMat = new THREE.MeshStandardNodeMaterial({ color: 0x8b887f, roughness: 0.86 });
  const outsideRect = (p) => p.x <= ISLAND_BOUNDS.minX + 0.6 || p.x >= ISLAND_BOUNDS.maxX - 0.6 || p.z <= ISLAND_BOUNDS.minZ + 0.6 || p.z >= ISLAND_BOUNDS.maxZ - 0.6;
  for (const land of LAND_POLYGONS) {
    for (const ring of [land.outer, ...land.holes]) {
      const pts = densify(ring, 5, true);
      const inward = signedArea(ring) > 0 ? 1 : -1; // which side of the walk is land
      const n = pts.length;
      let wall = triangleSoup(), cope = triangleSoup(), started = pts[0];
      const flush = () => {
        batch.add(seawallMat, wall.geometry(), started.x, started.z);
        batch.add(copingMat, cope.geometry(true), started.x, started.z);
        wall = triangleSoup();
        cope = triangleSoup();
      };
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if (outsideRect(a) && outsideRect(b)) continue; // the cut edge of the detailed area, not a shore
        if (Math.hypot(a.x - started.x, a.z - started.z) > 500) { flush(); started = a; }
        const ya = terrainHeight(a.x, a.z) + 0.05, yb = terrainHeight(b.x, b.z) + 0.05;
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        // towards the land
        const nx = (-(b.z - a.z) / L) * inward, nz = ((b.x - a.x) / L) * inward;
        // wall facing the water (winding chosen by the side the land is on)
        if (inward > 0) wall.quad([a.x, ya, a.z], [b.x, yb, b.z], [b.x, SEABED, b.z], [a.x, SEABED, a.z]);
        else wall.quad([b.x, yb, b.z], [a.x, ya, a.z], [a.x, SEABED, a.z], [b.x, SEABED, b.z]);
        // coping: 1.3 m of concrete along the edge
        const ia = [a.x + nx * 1.3, terrainHeight(a.x + nx * 1.3, a.z + nz * 1.3) + 0.05, a.z + nz * 1.3];
        const ib = [b.x + nx * 1.3, terrainHeight(b.x + nx * 1.3, b.z + nz * 1.3) + 0.05, b.z + nz * 1.3];
        if (inward > 0) cope.quad([a.x, ya, a.z], [ia[0], ia[1], ia[2]], [ib[0], ib[1], ib[2]], [b.x, yb, b.z]);
        else cope.quad([b.x, yb, b.z], [ib[0], ib[1], ib[2]], [ia[0], ia[1], ia[2]], [a.x, ya, a.z]);
      }
      flush();
    }
  }

  // =========================================================================
  // 3. BLOCKS: KERB FACES (the tops are the block layer of the terrain)
  // =========================================================================
  const curbMat = createCurbMaterial();
  const roadSidewalks = []; // the kerbs that bound the roads (road-network.js)
  const blockSidewalks = [];
  for (const b of BLOCKS) {
    const polygon = { outer: b.poly, holes: [] };
    const bounds = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, polygon };
    if (b.median) footprints.push(bounds);
    else roadSidewalks.push(bounds);
    blockSidewalks.push({ cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b, cover: true });

    const pts = densify(b.poly, 4, true);
    const outward = signedArea(b.poly) > 0 ? -1 : 1;
    const soup = triangleSoup();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const yp = terrainHeight(p.x, p.z), yq = terrainHeight(q.x, q.z);
      const top = SW_TOP + 0.004, foot = -0.14;
      if (outward > 0) soup.quad([q.x, yq + top, q.z], [p.x, yp + top, p.z], [p.x, yp + foot, p.z], [q.x, yq + foot, q.z]);
      else soup.quad([p.x, yp + top, p.z], [q.x, yq + top, q.z], [q.x, yq + foot, q.z], [p.x, yp + foot, p.z]);
    }
    batch.add(curbMat, soup.geometry(), b.cx, b.cz);
  }

  // =========================================================================
  // 4. PITCHES, PONDS & BEACHES ON THE BLOCKS; PARK PATHS
  // =========================================================================
  const meadowMat = createParkLawnMaterial(true);
  const sandMat = new THREE.MeshStandardNodeMaterial({ color: 0xcdbd98, roughness: 0.93 });
  const pavingMat = createParkPavingMaterial();
  pavingMat.polygonOffset = true;
  pavingMat.polygonOffsetFactor = -2;
  pavingMat.polygonOffsetUnits = -2;
  const centre = (pts) => {
    let x = 0, z = 0;
    for (const p of pts) { x += p.x; z += p.z; }
    return { x: x / pts.length, z: z / pts.length };
  };
  for (const g of GREENS) {
    if (g.kind !== 3 && g.kind !== 4 && g.kind !== 5) continue;
    const c = centre(g.outer);
    let geo = null;
    try {
      // ponds lie level; pitches & beaches follow the ground
      geo = drapedPolygonGeometry(g.outer, g.holes, SW_TOP + (g.kind === 4 ? 0.02 : 0.05), g.kind === 4);
    } catch {
      continue;
    }
    if (!geo) continue;
    if (g.kind === 4) {
      const pond = new THREE.Mesh(geo, waterMat);
      pond.receiveShadow = true;
      group.add(pond);
    } else batch.add(g.kind === 5 ? sandMat : meadowMat, geo, c.x, c.z);
  }
  for (const p of PARK_PATHS) {
    const c = p.pts[Math.floor(p.pts.length / 2)];
    batch.add(pavingMat, ribbonGeometry(p.pts, p.w, SW_TOP + 0.05, p.w > 4 ? 1 : 0), c.x, c.z);
  }

  // =========================================================================
  // 5. PIERS, PONTOONS & BREAKWATERS
  // =========================================================================
  const timberMat = new THREE.MeshStandardNodeMaterial({ color: 0x8d8272, roughness: 0.86 });
  const rockMat = new THREE.MeshStandardNodeMaterial({ color: 0x55534f, roughness: 0.95 });
  const pontoons = [];
  for (const p of PIERS) {
    const c = centre(p.ring);
    const area = Math.abs(signedArea(p.ring));
    if (area < 4) continue;
    // marina fingers float just above the water; fixed piers stand at quay height; breakwaters are rock
    let per = 0;
    for (let i = 0; i < p.ring.length; i++) per += Math.hypot(p.ring[(i + 1) % p.ring.length].x - p.ring[i].x, p.ring[(i + 1) % p.ring.length].z - p.ring[i].z);
    const slim = area / per < 2.6; // a narrow finger
    const floating = p.floating || (slim && !p.breakwater);
    const topY = p.breakwater ? 0.6 : floating ? ISLAND_BOUNDS.waterLevel + 0.55 : 0.25;
    const depth = p.breakwater ? 3.6 : floating ? 0.7 : 0.8;
    try {
      batch.add(p.breakwater ? rockMat : timberMat, slabGeometry(p.ring, topY, depth), c.x, c.z, !floating);
    } catch {
      continue;
    }
    if (floating) pontoons.push(p);
  }

  // =========================================================================
  // 6. THE RAILWAY: ballast beds with their rails, where the line runs in the open on the blocks
  // =========================================================================
  const ballastMat = new THREE.MeshStandardNodeMaterial({ color: 0x4f4a45, roughness: 0.96 });
  ballastMat.polygonOffset = true;
  ballastMat.polygonOffsetFactor = -2;
  ballastMat.polygonOffsetUnits = -2;
  const railMat = new THREE.MeshStandardNodeMaterial({ color: 0x6a6660, roughness: 0.45, metalness: 0.8 });
  for (const r of RAILS) {
    const c = r[Math.floor(r.length / 2)];
    if (!blockAt(c.x, c.z)) continue;
    batch.add(ballastMat, ribbonGeometry(r, 3.4, SW_TOP + 0.05), c.x, c.z);
    for (const side of [-0.72, 0.72]) {
      const off = r.map((p, i) => {
        const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return { x: p.x - ((b.z - a.z) / L) * side, z: p.z + ((b.x - a.x) / L) * side };
      });
      batch.add(railMat, ribbonGeometry(off, 0.09, SW_TOP + 0.17), c.x, c.z);
    }
  }

  // =========================================================================
  // 7. BRIDGE DECKS: slab, parapets and piers down to the ground (or the sea bed)
  // =========================================================================
  const deckMat = createRoadSurfaceMaterial();
  const concreteMat = new THREE.MeshStandardNodeMaterial({ color: 0x8f8d86, roughness: 0.84 });
  for (const d of DECKS) {
    const n = d.pts.length;
    if (n < 2) continue;
    const mid = d.pts[Math.floor(n / 2)];
    const top = triangleSoup(), body = triangleSoup();
    // stations: position, lateral unit vector (to the right of the direction of travel)
    const st = d.pts.map((p, i) => {
      const a = d.pts[Math.max(0, i - 1)], b = d.pts[Math.min(n - 1, i + 1)];
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: p.x, y: p.y, z: p.z, rx: -(b.z - a.z) / L, rz: (b.x - a.x) / L };
    });
    const at = (s, o, dy) => [s.x + s.rx * o, s.y + dy, s.z + s.rz * o];
    const h = d.half, THICK = d.kind === 1 ? 1.5 : 1.1, WALL = 0.28, RAIL = d.kind === 1 ? 0.95 : 1.15;
    let run = 0;
    let nextPier = 12;
    for (let i = 0; i + 1 < n; i++) {
      const a = st[i], b = st[i + 1];
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      // where the deck is on the ground it is only a road: nothing to build
      const ga = terrainHeight(a.x, a.z), gb = terrainHeight(b.x, b.z);
      const lifted = a.y - ga > 0.5 || b.y - gb > 0.5;
      if (lifted) {
        top.quad(at(a, -h, 0.02), at(a, h, 0.02), at(b, h, 0.02), at(b, -h, 0.02));
        // underside & edge beams
        body.quad(at(a, h, -THICK), at(a, -h, -THICK), at(b, -h, -THICK), at(b, h, -THICK));
        for (const s of [-1, 1]) {
          const o0 = s * h, o1 = s * (h - WALL);
          const face = (p0, p1, p2, p3) => (s > 0 ? body.quad(p0, p1, p2, p3) : body.quad(p3, p2, p1, p0));
          face(at(a, o0, -THICK), at(b, o0, -THICK), at(b, o0, RAIL), at(a, o0, RAIL)); // outer face
          face(at(a, o0, RAIL), at(b, o0, RAIL), at(b, o1, RAIL), at(a, o1, RAIL)); // top of the parapet
          face(at(a, o1, RAIL), at(b, o1, RAIL), at(b, o1, 0), at(a, o1, 0)); // inner face
          // the parapet stops the player (and anything else that asks the colliders)
          const cx = (a.x + b.x) / 2 + ((a.rx + b.rx) / 2) * s * (h - WALL / 2), cz = (a.z + b.z) / 2 + ((a.rz + b.rz) / 2) * s * (h - WALL / 2);
          const ux = (b.x - a.x) / (span || 1), uz = (b.z - a.z) / (span || 1);
          const ex = Math.abs(ux) * span * 0.5 + Math.abs(uz) * WALL, ez = Math.abs(uz) * span * 0.5 + Math.abs(ux) * WALL;
          colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: Math.min(a.y, b.y) - 0.5, maxY: Math.max(a.y, b.y) + RAIL,
            obb: { cx, cz, hx: WALL / 2 + 0.05, hz: span / 2, cs: uz, sn: ux } });
        }
      }
      // piers
      while (run + span > nextPier) {
        const t = (nextPier - run) / (span || 1);
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t, py = a.y + (b.y - a.y) * t;
        const inCity = px > ISLAND_BOUNDS.minX && px < ISLAND_BOUNDS.maxX && pz > ISLAND_BOUNDS.minZ && pz < ISLAND_BOUNDS.maxZ;
        const land = inCity ? isLand(px, pz) : isRegionLand(px, pz);
        // over the harbour the spans are long, and only the main deck stands on piers (the clip-ons hang off them)
        nextPier += !land ? 112 : d.kind === 1 ? 34 : 26;
        const ground = land ? terrainHeight(px, pz) : SEABED;
        if (py - THICK - ground < 2.5) continue;
        if (!land && (d.half < 8 || Math.hypot(px - (HARBOUR_BRIDGE.a.x + HARBOUR_BRIDGE.b.x) / 2, pz - (HARBOUR_BRIDGE.a.z + HARBOUR_BRIDGE.b.z) / 2) < HARBOUR_BRIDGE.span / 2 - 8)) continue;
        // on land a pier stands on a block (the verge, a median), never in a carriageway
        if (land && inCity && !blockAt(px, pz)) continue;
        const wide = !land ? d.half * 3.1 : d.kind === 1 ? Math.min(d.half * 1.3, 9) : Math.min(d.half * 1.1, 5);
        const pier = new THREE.BoxGeometry(wide, py - THICK - ground + 1, !land ? 4.5 : d.kind === 1 ? 1.8 : 1.3);
        pier.rotateY(Math.atan2(a.rx, a.rz) + Math.PI / 2);
        pier.translate(px, (py - THICK + ground - 1) / 2, pz);
        batch.add(concreteMat, pier, mid.x, mid.z, true);
        if (land) {
          const r = Math.max(wide, 1.8) / 2;
          colliders.push({ minX: px - r, maxX: px + r, minZ: pz - r, maxZ: pz + r, minY: ground - 1, maxY: py - THICK });
        }
      }
      run += span;
    }
    const tg = top.geometry(true);
    if (tg) {
      const mesh = new THREE.Mesh(tg, deckMat);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      group.add(mesh);
    }
    batch.add(concreteMat, body.geometry(), mid.x, mid.z, true);
  }

  batch.build();

  parkTreeSites = [];
  parkLampSites = [];
  pavedPlazaRects = [];
  sidewalkBlocks = blockSidewalks;

  const roadPaint = createRoadPaintChunkBuilder('RoadMarkings');
  scene.add(group);
  return {
    group, terrainGroup, sidewalks: roadSidewalks, footprints, highwayLanes: [], colliders, roadPaint, pontoons,
    update: (cameraPosition) => terrain.update(cameraPosition),
    materials: { seawallMat, roadMat, timberMat, concreteMat }
  };
}

export {
  buildCityGrid,
  getStreetGroundHeight,
  batchStaticGroupMeshes,
  ribbonGeometry,
  drapedPolygonGeometry,
  triangleSoup,
  densify,
  pointInPolygonXZ,
  distanceField,
  dataTexture,
  SW_TOP,
  centralParkClearings,
  parkTreeSites,
  parkLampSites,
  pavedPlazaRects,
  sidewalkBlocks
};
