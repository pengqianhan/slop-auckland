import * as THREE from 'three/webgpu';
import { addBuildingDetails } from './building-details.js';
import {
  Fn,
  vec2,
  color,
  uv,
  normalWorldGeometry,
  abs,
  fract,
  step,
  smoothstep,
  fwidth,
  max,
  min,
  mix,
  length
} from 'three/tsl';
import { ISLAND_BOUNDS } from './city-config.js';
import {
  createPreWarBuildingMaterial,
  createCurtainWallMaterial,
  filteredPulse
} from './tsl-materials.js';
import { REAL_BUILDINGS } from './building-geodata.js';
import { createBuildingFootprints } from './building-footprints.js';
import { polygonBoxOverlaps } from './building-collision.js';
import { terrainHeight } from './terrain.js';
import { buildHouses } from './houses.js';

// Surveyed footprints (OpenStreetMap / LINZ) at their LiDAR heights define the buildings and their collisions; they
// stand on the terrain from the lowest ground under them. Architectural details stream around the player. The houses
// of the suburbs are built by houses.js.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spatial 2D quadtree for range queries around the active player/camera position.
 */
class Quadtree {
  constructor(bounds, capacity = 6, maxDepth = 6, depth = 0) {
    this.bounds = bounds; // { minX, maxX, minZ, maxZ }
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.items = [];
    this.divided = false;
    this.nw = null;
    this.ne = null;
    this.sw = null;
    this.se = null;
  }

  containsPoint(x, z) {
    const b = this.bounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  intersectsCircle(cx, cz, radius) {
    const b = this.bounds;
    const closestX = Math.max(b.minX, Math.min(cx, b.maxX));
    const closestZ = Math.max(b.minZ, Math.min(cz, b.maxZ));
    const dx = cx - closestX;
    const dz = cz - closestZ;
    return (dx * dx + dz * dz) <= (radius * radius);
  }

  subdivide() {
    const b = this.bounds;
    const midX = (b.minX + b.maxX) * 0.5;
    const midZ = (b.minZ + b.maxZ) * 0.5;
    const nextDepth = this.depth + 1;

    this.nw = new Quadtree({ minX: b.minX, maxX: midX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.ne = new Quadtree({ minX: midX, maxX: b.maxX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.sw = new Quadtree({ minX: b.minX, maxX: midX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.se = new Quadtree({ minX: midX, maxX: b.maxX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.divided = true;

    for (const item of this.items) {
      this._insertIntoChildren(item);
    }
    this.items.length = 0;
  }

  _insertIntoChildren(item) {
    if (this.nw.containsPoint(item.cx, item.cz)) return this.nw.insert(item);
    if (this.ne.containsPoint(item.cx, item.cz)) return this.ne.insert(item);
    if (this.sw.containsPoint(item.cx, item.cz)) return this.sw.insert(item);
    if (this.se.containsPoint(item.cx, item.cz)) return this.se.insert(item);
    return false;
  }

  insert(item) {
    if (!this.containsPoint(item.cx, item.cz)) return false;

    if (!this.divided) {
      if (this.items.length < this.capacity || this.depth >= this.maxDepth) {
        this.items.push(item);
        return true;
      }
      this.subdivide();
    }
    return this._insertIntoChildren(item);
  }

  queryRange(cx, cz, radius, found = []) {
    if (!this.intersectsCircle(cx, cz, radius)) return found;

    const rSq = radius * radius;
    if (!this.divided) {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const dx = item.cx - cx;
        const dz = item.cz - cz;
        if (dx * dx + dz * dz <= rSq) {
          found.push(item);
        }
      }
      return found;
    }

    this.nw.queryRange(cx, cz, radius, found);
    this.ne.queryRange(cx, cz, radius, found);
    this.sw.queryRange(cx, cz, radius, found);
    this.se.queryRange(cx, cz, radius, found);
    return found;
  }
}

function buildCityBlocks(scene, landmarkColliders = []) {
  const group = new THREE.Group();
  group.name = 'AucklandCityBlocks';
  const colliders = [];

  // Stream nearby architectural details.
  const quadtree = new Quadtree({
    minX: ISLAND_BOUNDS.minX - 50,
    maxX: ISLAND_BOUNDS.maxX + 50,
    minZ: ISLAND_BOUNDS.minZ - 50,
    maxZ: ISLAND_BOUNDS.maxZ + 50
  }, 6, 9);
  const allBlocks = [];

  const facades = [
    // 0: Plastered & stone-faced masonry (Queen St's Edwardian blocks, the old warehouses, plain suburban shops)
    [createPreWarBuildingMaterial, {
      stoneColor: 0xd9d2c2,
      trimColor: 0xa39a88,
      windowGlassColor: 0x1a2836,
      windowWidth: 2.6,
      floorHeight: 3.6,
      litProbability: 0.5,
      warmth: 0.80,
      seed: 12.4
    }],
    // 1: Red brick with pale trim (Britomart's warehouses, K Road, the university's old buildings)
    [createPreWarBuildingMaterial, {
      stoneColor: 0x9c5746,
      trimColor: 0xcab9a0,
      windowGlassColor: 0x16222e,
      windowWidth: 2.4,
      floorHeight: 3.5,
      litProbability: 0.52,
      warmth: 0.86,
      seed: 27.8
    }],
    // 2: Blue-green curtain wall (the downtown office towers)
    [createCurtainWallMaterial, {
      glassTint: 0x1a3a52,
      frameTint: 0x3b4c5b,
      windowWidth: 2.7,
      floorHeight: 3.9,
      litProbability: 0.60,
      warmth: 0.52,
      reflectivity: 0.92,
      seed: 63.5
    }],
    // 3: Dark bronze glass & concrete frames (the 1970s & 80s towers and apartment slabs)
    [createCurtainWallMaterial, {
      glassTint: 0x242220,
      frameTint: 0x3c3631,
      windowWidth: 2.5,
      floorHeight: 3.4,
      litProbability: 0.64,
      warmth: 0.72,
      reflectivity: 0.88,
      seed: 81.9
    }],
    // 4: Silver & ice-blue glass (Commercial Bay, the newest apartment towers)
    [createCurtainWallMaterial, {
      glassTint: 0x264664,
      frameTint: 0xb0bcc8,
      windowWidth: 2.9,
      floorHeight: 3.8,
      litProbability: 0.58,
      warmth: 0.48,
      reflectivity: 0.95,
      seed: 94.3
    }]
  ];
  const materials = facades.map(([create, opts]) => create({ ...opts, footprintLocal: true }));

  // Keep authored landmarks clear of surveyed buildings and architectural details.
  const surveyedBuildings = REAL_BUILDINGS.filter((b) => !landmarkColliders.some((c) => c.reserve !== false &&
    b.minX < c.maxX && b.maxX > c.minX && b.minZ < c.maxZ && b.maxZ > c.minZ
    && b.polygons.some((p) => polygonBoxOverlaps(p, (c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2,
      (c.maxX - c.minX) / 2, (c.maxZ - c.minZ) / 2))));
  const landmarkReserves = landmarkColliders.filter((c) => c.reserve !== false).map((c) =>
    ({ x0: c.minX, x1: c.maxX, z0: c.minZ, z1: c.maxZ, height: c.maxY ?? Infinity }));
  const hitR = (a, x0, x1, z0, z1) => a.x0 < x1 && a.x1 > x0 && a.z0 < z1 && a.z1 > z0;
  const buildingReserves = [];
  const reserveCells = new Map();
  function addReserve(r) {
    const index = buildingReserves.length;
    buildingReserves.push(r);
    for (let ix = Math.floor(r.x0 / 128); ix <= Math.floor(r.x1 / 128); ix++) {
      for (let iz = Math.floor(r.z0 / 128); iz <= Math.floor(r.z1 / 128); iz++) {
        const key = ix + ',' + iz;
        if (!reserveCells.has(key)) reserveCells.set(key, []);
        reserveCells.get(key).push(index);
      }
    }
  }
  // Where each building stands: walls from 0.4 m under the lowest ground at its outline up to its surveyed height
  // above that ground (base, top: world heights)
  for (const b of surveyedBuildings) {
    let low = Infinity;
    for (const p of b.polygons) for (const v of p.outer) low = Math.min(low, terrainHeight(v.x, v.z));
    b.ground = low;
    b.base = low - 0.4;
    b.top = low + 0.22 + b.height;
    addReserve({ x0: b.minX, x1: b.maxX, z0: b.minZ, z1: b.maxZ, height: b.top, polygons: b.polygons });
  }
  function nearbyReserves(b, padding = 0) {
    const minX = b.minX - padding, maxX = b.maxX + padding;
    const minZ = b.minZ - padding, maxZ = b.maxZ + padding;
    const found = new Set();
    for (let ix = Math.floor(minX / 128); ix <= Math.floor(maxX / 128); ix++) {
      for (let iz = Math.floor(minZ / 128); iz <= Math.floor(maxZ / 128); iz++) {
        for (const index of reserveCells.get(ix + ',' + iz) || []) {
          if (hitR(buildingReserves[index], minX, maxX, minZ, maxZ)) found.add(index);
        }
      }
    }
    return Array.from(found, (index) => buildingReserves[index]);
  }

  for (const r of landmarkReserves) {
    addReserve({ ...r, polygons: [{ outer: [
      { x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 }, { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 }
    ], holes: [] }] });
  }

  const surveyedBuckets = materials.map(() => []);
  const detailsToPlace = [];
  for (const b of surveyedBuildings) {
    const seed = Math.round(b.cx * 31 + b.cz * 17);
    const rand = mulberry32(seed);
    const tone = rand();
    // Facade by age and size: masonry for the old and the low, glass for the towers
    const mat = b.year && b.year < 1945 ? (tone < 0.62 ? 0 : 1)
      : b.height < 13 ? (tone < 0.72 ? 0 : tone < 0.92 ? 1 : 4)
        : b.year && b.year < 1985 ? (tone < 0.5 ? 0 : tone < 0.75 ? 3 : 2)
          : b.height < 26 ? (tone < 0.42 ? 0 : tone < 0.55 ? 1 : tone < 0.8 ? 2 : 4)
            : tone < 0.42 ? 2 : tone < 0.82 ? 4 : 3;
    // Shops along the streets of the paved blocks (the survey has no building-use data)
    const storefronts = b.shop && b.height >= 5 && mulberry32(seed ^ 0x53544f52)() < 0.6;
    const record = { ...b, tone, storefronts };
    surveyedBuckets[mat].push(record);
    const detail = {
      cx: b.cx, cz: b.cz, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ,
      cornices: [], hvacUnits: [], awnings: [], footprints: []
    };
    for (const polygon of b.polygons) {
      const xs = polygon.outer.map((p) => p.x), zs = polygon.outer.map((p) => p.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      colliders.push({ minX, maxX, minZ, maxZ, minY: b.base, maxY: b.top, polygon });
      detail.footprints.push({ h: b.top, pts: polygon.outer, holes: polygon.holes });
    }
    detailsToPlace.push({ b: record, detail, masonry: mat < 2, rand });
    allBlocks.push(detail);
  }
  for (const { b, detail, masonry, rand } of detailsToPlace) {
    const neighbours = nearbyReserves(b, 6);
    for (const reserve of addBuildingDetails(b, detail, { masonry, rand, neighbours, groundAt: terrainHeight })) addReserve(reserve);
    quadtree.insert(detail);
  }
  surveyedBuckets.forEach((items, i) => {
    if (!items.length) return;
    group.add(createBuildingFootprints(materials[i], items, i < 2 ? b => nearbyReserves(b, 2) : undefined));
  });

  // The suburbs' houses
  const houses = buildHouses(group);
  colliders.push(...houses.colliders);

  // ============================================================================
  // STREAMED ARCHITECTURAL DETAILS
  // ============================================================================
  const MAX_CORNICES = 7000;
  const MAX_HVAC = 1600;
  const MAX_AWNINGS = 1800;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();

  // 1. Projecting horizontal stone cornices & parapet ledges
  const corniceMat = new THREE.MeshStandardNodeMaterial({ color: 0xc8bca6, roughness: 0.78, metalness: 0.08 });
  const corniceInst = new THREE.InstancedMesh(unitBox, corniceMat, MAX_CORNICES);
  corniceInst.castShadow = true;
  corniceInst.receiveShadow = true;
  corniceInst.frustumCulled = false;
  group.add(corniceInst);

  // 2. Rooftop mechanical penthouses & HVAC chillers with top exhaust fans & side louvers
  const hvacMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0.45 });
  hvacMat.colorNode = Fn(() => {
    const u = uv();
    const isTop = step(0.7, normalWorldGeometry.y);
    const fan1 = length(u.sub(vec2(0.3, 0.5)));
    const fan2 = length(u.sub(vec2(0.7, 0.5)));
    const fanDist = min(fan1, fan2);
    const inFanWell = smoothstep(0.19, 0.17, fanDist);
    // Average subpixel slats and fan rings instead of letting them shimmer at a distance.
    const fanCoord = fanDist.mul(16.0);
    const fanRing = filteredPulse(fract(fanCoord), 0.4835, 0.5165, fwidth(fanCoord)).mul(inFanWell);
    const topCol = mix(color(0x889098), color(0x1b2026), inFanWell.mul(0.82).sub(fanRing.mul(0.45)));

    const inLouverBox = step(0.12, u.x).mul(step(u.x, 0.88)).mul(step(0.18, u.y)).mul(step(u.y, 0.82));
    const slatCoord = u.y.mul(14.0);
    const louverSlat = filteredPulse(fract(slatCoord), 0.45, 1.0, fwidth(slatCoord)).mul(inLouverBox);
    const panelSeam = smoothstep(0.03, 0.0, abs(fract(u.x.mul(3.0)).sub(0.5)));
    const sideCol = mix(color(0x7c848c), color(0x282e36), max(louverSlat.mul(0.72), panelSeam.mul(0.35)));
    return mix(sideCol, topCol, isTop);
  })();
  const hvacInst = new THREE.InstancedMesh(unitBox, hvacMat, MAX_HVAC);
  hvacInst.castShadow = hvacInst.receiveShadow = true;
  hvacInst.frustumCulled = false;
  group.add(hvacInst);

  // 3. Shop verandahs over the footpath & illuminated fascia signs
  const awningMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.65 });
  const awningPalette = [
    new THREE.Color(0x8c2a2e),
    new THREE.Color(0x24503a),
    new THREE.Color(0x26405f),
    new THREE.Color(0xb9bcb8),
    new THREE.Color(0x2d2d32)
  ];
  const awningInst = new THREE.InstancedMesh(unitBox, awningMat, MAX_AWNINGS);
  awningInst.castShadow = awningInst.receiveShadow = true;
  awningInst.frustumCulled = false;
  // Pre-initialize instanceColor buffer so dynamic updates work cleanly
  for (let i = 0; i < MAX_AWNINGS; i++) {
    awningInst.setColorAt(i, awningPalette[i % awningPalette.length]);
  }
  group.add(awningInst);

  const signThemes = [
    { bg: '#161210', border: '#c89d54', text: 'QUEEN ST BISTRO · EST. 1928', color: '#ffe4a8' },
    { bg: '#0c2244', border: '#38b6ff', text: 'HARBOUR PHARMACY', color: '#ffffff' },
    { bg: '#142b20', border: '#d4af37', text: 'FLAT WHITE & BOOKS', color: '#fff2cc' },
    { bg: '#280a10', border: '#ff5252', text: 'FISH & CHIPS · PIES · 24HR', color: '#ffd180' },
    { bg: '#101318', border: '#e0e6ed', text: 'KIA ORA DAIRY · OPEN 7 DAYS', color: '#f5f9ff' }
  ];
  const MAX_SIGNS_PER_THEME = Math.ceil(MAX_AWNINGS / signThemes.length) + 32;
  const signInsts = signThemes.map((st) => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = st.border;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 500, 84);
    ctx.fillStyle = st.color;
    ctx.font = '800 26px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.text, 256, 50);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sMat = new THREE.MeshBasicNodeMaterial({ map: tex });
    const sInst = new THREE.InstancedMesh(unitBox, sMat, MAX_SIGNS_PER_THEME);
    sInst.frustumCulled = false;
    group.add(sInst);
    return sInst;
  });

  // 4. Ground-floor storefront clustered SpotLights (verandahs / fascia signs)
  const storeLightGroup = new THREE.Group();
  storeLightGroup.name = 'StoreClusteredLights';
  scene.add(storeLightGroup);

  const storeThemeColors = [
    new THREE.Color(0xffd896), // Bistro warm gold
    new THREE.Color(0xd8eeff), // Pharmacy crisp cool white
    new THREE.Color(0xffe4ad), // Bookstore warm amber
    new THREE.Color(0xffbe88), // Takeaway warm orange-gold
    new THREE.Color(0xfff2d6)  // Dairy warm ivory
  ];

  const STORE_SPOT_POOL = 28;
  const STORE_SPOT_INTENSITY = 46 * ((0.85 - 0.15) / 0.90);
  const storeSpotPool = [];
  for (let i = 0; i < STORE_SPOT_POOL; i++) {
    const spot = new THREE.SpotLight(0xffd896, 0, 12.0, 0.84, 0.80, 1.30);
    spot.castShadow = false;
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    storeLightGroup.add(spot);
    storeLightGroup.add(spot.target);
    storeSpotPool.push(spot);
  }

  const activeAwnings = [];
  const spotCandidates = [];

  // ============================================================================
  // STREAMING AROUND THE PLAYER / CAMERA
  // ============================================================================
  let lastStreamX = Infinity;
  let lastStreamZ = Infinity;
  const STREAM_RADIUS = 560; // High-detail architectural radius around player in meters

  // Streaming rewrites only the active prefix; unused pool capacity need not cross the GPU queue.
  function flagRange(attribute, count) {
    if (count === 0) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function update(focusX, focusZ, force = false) {
    const dx = focusX - lastStreamX;
    const dz = focusZ - lastStreamZ;
    if (!force && (dx * dx + dz * dz) < 324) {
      // Player moved less than 18m since last Quadtree stream update
      return;
    }
    lastStreamX = focusX;
    lastStreamZ = focusZ;

    const nearbyBlocks = quadtree.queryRange(focusX, focusZ, STREAM_RADIUS);
    // Sort closest blocks first so if any pool hits capacity, closest blocks around the player always win
    nearbyBlocks.sort((a, b) => {
      const da = (a.cx - focusX) * (a.cx - focusX) + (a.cz - focusZ) * (a.cz - focusZ);
      const db = (b.cx - focusX) * (b.cx - focusX) + (b.cz - focusZ) * (b.cz - focusZ);
      return da - db;
    });
    activeAwnings.length = 0;

    let corniceCount = 0;
    let hvacCount = 0;
    let awningCount = 0;
    let awningBlocks = 0;
    const signCounts = signInsts.map(() => 0);

    for (const blk of nearbyBlocks) {
      const collectNearLights = blk.awnings.length > 0 && awningBlocks++ < 20;

      // 1. Stone cornices & setback ledges, hung just below their roof line (top 0.1h under it, so no two ledges or
      //    roofs share a plane) so roofs & terraces keep their own roofing instead of a stone lid
      for (let i = 0; i < blk.cornices.length && corniceCount < MAX_CORNICES; i++) {
        const c = blk.cornices[i];
        dummy.rotation.set(0, c.ry || 0, 0);
        dummy.position.set(c.x, c.y - c.h * 0.6, c.z);
        dummy.scale.set(c.w, c.h, c.d);
        dummy.updateMatrix();
        corniceInst.setMatrixAt(corniceCount++, dummy.matrix);
      }

      // 2. Rooftop HVAC & mechanical bulkheads
      for (let i = 0; i < blk.hvacUnits.length && hvacCount < MAX_HVAC; i++) {
        const u = blk.hvacUnits[i];
        dummy.rotation.set(0, u.ry || 0, 0);
        dummy.position.set(u.x, u.y + u.h * 0.5, u.z);
        dummy.scale.set(u.w, u.h, u.d);
        dummy.updateMatrix();
        hvacInst.setMatrixAt(hvacCount++, dummy.matrix);
      }

      // 3. Verandahs & illuminated storefront fascia signs
      for (let i = 0; i < blk.awnings.length && awningCount < MAX_AWNINGS; i++) {
        const a = blk.awnings[i];
        dummy.rotation.set(0, a.ry || 0, 0);
        dummy.position.set(a.x, a.y, a.z);
        dummy.scale.set(a.w, 0.28, a.d);
        dummy.updateMatrix();
        awningInst.setMatrixAt(awningCount, dummy.matrix);
        awningInst.setColorAt(awningCount, awningPalette[a.colorIdx % awningPalette.length]);

        const themeIdx = a.colorIdx % signInsts.length;
        if (signCounts[themeIdx] < MAX_SIGNS_PER_THEME) {
          dummy.position.set(a.x, a.y + 0.62, a.z);
          dummy.scale.set(0.28, 0.86, a.d * 0.92);
          dummy.updateMatrix();
          signInsts[themeIdx].setMatrixAt(signCounts[themeIdx]++, dummy.matrix);
        }
        if (collectNearLights) {
          activeAwnings.push({ a, themeIdx, ry: a.ry || 0 });
        }
        awningCount++;
      }
    }
    dummy.rotation.set(0, 0, 0);

    corniceInst.count = corniceCount;
    flagRange(corniceInst.instanceMatrix, corniceCount);

    hvacInst.count = hvacCount;
    flagRange(hvacInst.instanceMatrix, hvacCount);

    awningInst.count = awningCount;
    flagRange(awningInst.instanceMatrix, awningCount);
    if (awningInst.instanceColor) flagRange(awningInst.instanceColor, awningCount);

    signInsts.forEach((sInst, idx) => {
      sInst.count = signCounts[idx];
      flagRange(sInst.instanceMatrix, signCounts[idx]);
    });
  }

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function updateLights(camera) {
    if (!camera) {
      for (let i = 0; i < STORE_SPOT_POOL; i++) {
        storeSpotPool[i].intensity = 0;
        storeSpotPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const e = camera.matrixWorld.elements;
    const fwdLen = Math.hypot(e[8], e[10]) || 1;
    const fwdX = -e[8] / fwdLen;
    const fwdZ = -e[10] / fwdLen;
    const STORE_MAX_DIST = 115;

    spotCandidates.length = 0;
    for (let i = 0; i < activeAwnings.length; i++) {
      const item = activeAwnings[i];
      const a = item.a;
      const dx = a.x - camX;
      const dy = a.y - camY;
      const dz = a.z - camZ;
      const d2 = dx * dx + dz * dz + dy * dy;
      if (d2 > STORE_MAX_DIST * STORE_MAX_DIST) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STORE_MAX_DIST) continue;
      spotCandidates.push({ item, effDist });
    }
    spotCandidates.sort((a, b) => a.effDist - b.effDist);

    const storeCutoff = spotCandidates.length > STORE_SPOT_POOL
      ? Math.min(STORE_MAX_DIST, spotCandidates[STORE_SPOT_POOL].effDist)
      : STORE_MAX_DIST;
    const activeSpots = Math.min(STORE_SPOT_POOL, spotCandidates.length);
    for (let i = 0; i < STORE_SPOT_POOL; i++) {
      const spot = storeSpotPool[i];
      if (i < activeSpots) {
        const cand = spotCandidates[i];
        const { a, themeIdx, ry } = cand.item;
        const fade = smoothFade(cand.effDist, storeCutoff * 0.62, storeCutoff);
        const outX = Math.cos(ry);
        const outZ = -Math.sin(ry);
        spot.position.set(a.x + outX * 0.45, a.y + 0.55, a.z + outZ * 0.45);
        spot.target.position.set(a.x + outX * 1.85, a.y - 3.8, a.z + outZ * 1.85);
        spot.target.updateMatrixWorld();
        spot.color.copy(storeThemeColors[themeIdx % storeThemeColors.length]);
        spot.intensity = STORE_SPOT_INTENSITY * fade;
      } else {
        spot.intensity = 0;
        spot.position.set(0, -1000, 0);
      }
    }
  }

  update(0, 0, true);

  scene.add(group);
  return {
    group,
    colliders,
    allBlocks,
    update,
    updateLights
  };
}

export { buildCityBlocks };
