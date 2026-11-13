import * as THREE from 'three/webgpu';
import { Fn, float, color, attribute, uniform, mod, fract, step, smoothstep, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO } from './akl-geodata.js';
import { KEEP, SIGNAL_TIMING, BLOCKS, blockAt } from './city-config.js';
import { cityUniforms, createTreeGrateMaterial } from './tsl-materials.js';
import { createTreeField } from './trees.js';
import { REAL_TREES, PARK_TREES, WOOD_TREES, GARDEN_TREES } from './tree-geodata.js';
import { placeStreetTrees } from './tree-placements.js';
import { terrainHeight, streetHeight } from './terrain.js';

// Instanced street furniture on the terrain: streetlights along the kerbs, traffic signals at the junctions the map
// has them at (one head per approach, on the kerb at its stop line), trees, and the pools of light under the lamps
// nearest the camera.

const SW = 0.22; // footpaths above the roadway

/**
 * TSL 3-aspect signal lens material. Every lens carries which aspect it is (attribute `lens`: 0 red, 1 amber, 2 green);
 * the shared signal clock and SIGNAL_TIMING (city-config.js), which js/traffic.js obeys, light the right one.
 */
function createTrafficSignalLensMaterial(isMainRoadHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const lens = attribute('lens', 'float');
    const isRed = float(1.0).sub(step(0.5, lens));
    const isGreen = step(1.5, lens);
    const isAmber = float(1.0).sub(isRed).sub(isGreen);

    // Main road phase: green, then amber from avenueAmber, red from avenueRed
    // Side street phase: red until avenueRed, then green, amber from streetAmber
    const greenActive = isMainRoadHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isMainRoadHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isMainRoadHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isRed.mul(redActive).add(isAmber.mul(amberActive)).add(isGreen.mul(greenActive));
    const lensHue = mix(mix(color(0x18ff68), color(0xffaa10), isAmber), color(0xff2424), isRed);
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

// Pedestrian signal: the green man on the WALK, then a flashing and finally a steady red man
function createWalkSignalMaterial(clock) {
  const { cycle, avenueAmber, walk } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const isWalk = float(1.0).sub(step(walk, t));
    const isFlashing = step(walk, t).mul(float(1.0).sub(step(avenueAmber, t)));
    const handLit = float(1.0).sub(isFlashing.mul(step(0.5, fract(t))));
    const hand = mix(color(0x14181e), color(0xff3a18), handLit);
    return mix(hand, color(0x38ff7a), isWalk);
  })();
  return mat;
}

function hashPos(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function buildStreetDetails(scene, colliders = []) {
  const group = new THREE.Group();
  group.name = 'AucklandStreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d, pedestrianOnly = false) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, pedestrianOnly });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // Shared materials
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({ color: 0x4a4f55, roughness: 0.45, metalness: 0.78 });
  const signalHousingMat = new THREE.MeshStandardNodeMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const backboardMat = new THREE.MeshStandardNodeMaterial({ color: 0x0f1113, roughness: 0.7 });
  const mainSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const sideSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  const walkSignalGlow = createWalkSignalMaterial(signalClock);
  // LED streetlight lens: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));

  // Three-aspect signal head (origin at its centre, facing +z): black housing on a backboard, a visor over each lens
  const HEAD_W = 0.36;
  const HEAD_H = 1.05;
  const HEAD_D = 0.24;
  const LENS_R = 0.13;
  const LENS_Y = [0.33, 0, -0.33];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    ...LENS_Y.map((ly) => new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.2, 14, 1, true, Math.PI / 2, Math.PI)
      .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.1))
  ]);
  const backboardGeo = new THREE.BoxGeometry(0.74, 1.4, 0.03).translate(0, 0, -HEAD_D / 2 - 0.02);
  const signalLensGeo = mergeGeometries(LENS_Y.map((ly, k) => {
    const g = new THREE.CircleGeometry(LENS_R, 16).translate(0, ly, HEAD_D / 2 + 0.004);
    g.setAttribute('lens', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(k), 1));
    return g;
  }));
  const walkHousingGeo = new THREE.BoxGeometry(0.3, 0.34, 0.2);
  const walkPanelGeo = new THREE.PlaneGeometry(0.23, 0.27).translate(0, 0, 0.105);
  // Luminaire on the end of the arm: flattened grey housing, flat lens underneath
  const lampHousingGeo = new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.62, 0.16, 0.26);
  const lampLensGeo = new THREE.CircleGeometry(1, 16).rotateX(Math.PI / 2).scale(0.52, 1, 0.2).translate(0, -0.005, 0);

  const poleMatrices = [];
  const armMatrices = [];
  const lampHeadMatrices = [];
  const cobraLampSites = [];
  const streetPointSites = [];
  const audioSignals = [];
  // Only nearby poles can conflict, even with street furniture across the whole city.
  const POLE_CELL = 8;
  const poleCells = new Map();
  function addPole(x, z, width) {
    const key = Math.floor(x / POLE_CELL) + ',' + Math.floor(z / POLE_CELL);
    let cell = poleCells.get(key);
    if (!cell) poleCells.set(key, cell = []);
    cell.push({ x, z });
    // Poles stand on kerbs: pedestrians avoid them, but they must not narrow the roads.
    addFootprint(x, z, width, width, true);
  }
  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    for (let ix = Math.floor((x - minDist) / POLE_CELL); ix <= Math.floor((x + minDist) / POLE_CELL); ix++) {
      for (let iz = Math.floor((z - minDist) / POLE_CELL); iz <= Math.floor((z + minDist) / POLE_CELL); iz++) {
        for (const p of poleCells.get(ix + ',' + iz) || []) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < md2) return false;
        }
      }
    }
    return true;
  };
  // True only when (x, z) and the pad around it sit on one kerbed block (never in a road or on a traffic island)
  const isOnKerb = (x, z, pad = 0.5) => {
    const b = blockAt(x, z);
    if (!b || b.median) return false;
    return blockAt(x - pad, z) === b && blockAt(x + pad, z) === b && blockAt(x, z - pad) === b && blockAt(x, z + pad) === b;
  };

  // =========================================================================
  // 1. STREETLIGHTS along the kerbs: a pole every ~46 m of every block edge that fronts a roadway, its arm reaching
  //    out over the street
  // =========================================================================
  const POLE_H = 8.2;
  for (const b of BLOCKS) {
    if (b.median || b.poly.length < 3) continue;
    const poly = b.poly;
    let carry = 12 + hashPos(b.cx, 1.7, b.cz) * 30; // along the outline to the next pole
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const ux = dx / len, uz = dz / len;
      while (carry < len) {
        const cx = p0.x + ux * carry, cz = p0.z + uz * carry;
        carry += 46;
        // which side is the block's inside
        let inx = -uz, inz = ux;
        if (blockAt(cx + inx * 1.4, cz + inz * 1.4) !== b) { inx = uz; inz = -ux; }
        if (blockAt(cx + inx * 1.4, cz + inz * 1.4) !== b) continue;
        const outX = -inx, outZ = -inz;
        const lx = cx + inx * 0.75, lz = cz + inz * 0.75;
        // a roadway in front (not the water, not the edge of the detailed city) and room for the pole
        if (blockAt(cx + outX * 2.5, cz + outZ * 2.5) || !isOnKerb(lx, lz, 0.45) || !isClearOfPoles(lx, lz, 14)) continue;
        const y = terrainHeight(lx, lz) + SW;
        addPole(lx, lz, 0.4);
        const armYaw = Math.atan2(-outZ, outX);
        dummy.position.set(lx, y + POLE_H / 2, lz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0.1, POLE_H, 0.1);
        dummy.updateMatrix();
        poleMatrices.push(dummy.matrix.clone());

        dummy.position.set(lx + outX * 1.1, y + POLE_H - 0.1, lz + outZ * 1.1);
        dummy.rotation.set(0, armYaw, 0);
        dummy.scale.set(2.2, 0.08, 0.08);
        dummy.updateMatrix();
        armMatrices.push(dummy.matrix.clone());

        const headX = lx + outX * 2.4, headZ = lz + outZ * 2.4;
        dummy.position.set(headX, y + POLE_H - 0.18, headZ);
        dummy.rotation.set(0, armYaw, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        lampHeadMatrices.push(dummy.matrix.clone());
        dummy.rotation.set(0, 0, 0);
        cobraLampSites.push({ x: headX, y: y + POLE_H - 0.24, z: headZ, tx: lx + outX * 3.6, ty: y - SW, tz: lz + outZ * 3.6 });
      }
      carry -= len;
    }
  }

  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true, parent = group) {
    if (matrices.length === 0) return null;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    parent.add(inst);
    return inst;
  }

  addMatrixArrayInstanced(unitCyl, poleMetalMat, poleMatrices);
  addMatrixArrayInstanced(unitBox, poleMetalMat, armMatrices);
  addMatrixArrayInstanced(lampHousingGeo, poleMetalMat, lampHeadMatrices);
  addMatrixArrayInstanced(lampLensGeo, lampBulbGlow, lampHeadMatrices, false);

  // =========================================================================
  // 2. TREES: the surveyed street trees fitted to the kerbs, the bush of the gullies & parks, park trees, gardens
  //    (one unified trunk + crown instanced mesh per species & band, trees.js)
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species, tier }
  const addTrees = (points, tier, scale0, scale1, speciesOf) => {
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i], z = points[i + 1];
      const r = hashPos(x, 6.6, z);
      treePositions.push({ x, y: terrainHeight(x, z) + SW, z, scale: scale0 + r * (scale1 - scale0), species: speciesOf(hashPos(x, 4.4, z)), tier });
    }
  };
  // bush: tall & close; park trees: big specimens; gardens: smaller
  addTrees(WOOD_TREES, 0, 0.7, 1.35, (r) => (r < 0.25 ? 0 : r < 0.5 ? 1 : 2));
  addTrees(PARK_TREES, 0, 0.9, 1.5, (r) => (r < 0.45 ? 0 : r < 0.6 ? 1 : 2));
  addTrees(GARDEN_TREES, 2, 0.45, 0.9, (r) => (r < 0.3 ? 0 : r < 0.7 ? 1 : 2));

  // Surveyed street trees: moved onto the kerb where they stand in the modelled roadway
  let sidewalkTreePositions = placeStreetTrees(REAL_TREES, treePositions, (x, z) => isClearOfPoles(x, z, 2.2));
  for (const tree of sidewalkTreePositions) treePositions.push(tree);
  const treeField = createTreeField(scene, treePositions, colliders);
  group.add(treeField.group);
  sidewalkTreePositions = sidewalkTreePositions.filter((t) => treeField.sites.has(t) && t.pit);
  console.info(`[streetDetails] ${treeField.stats.trees} trees (${sidewalkTreePositions.length} in footpath pits), ${poleMatrices.length} streetlights`);

  // Tree pits in the paved footpaths: a kerbed bed of soil under a cast-iron grate
  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x484642, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });
  const pitCurbGeo = new THREE.BoxGeometry(1.5, 0.12, 1.5);
  const pitSoilGeo = new THREE.BoxGeometry(1.2, 0.13, 1.2);
  const pitGrateGeo = new THREE.RingGeometry(0.22, 0.6, 12, 1).rotateX(-Math.PI / 2);
  const pitCount = Math.max(1, sidewalkTreePositions.length);
  const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, pitCount);
  const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, pitCount);
  const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, pitCount);
  pitCurbInst.receiveShadow = pitSoilInst.receiveShadow = pitGrateInst.receiveShadow = true;
  pitCurbInst.count = pitSoilInst.count = pitGrateInst.count = sidewalkTreePositions.length;
  sidewalkTreePositions.forEach((t, i) => {
    dummy.rotation.set(0, t.pitRot || 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.position.set(t.x, t.y, t.z);
    dummy.updateMatrix();
    pitCurbInst.setMatrixAt(i, dummy.matrix);
    dummy.position.set(t.x, t.y + 0.005, t.z);
    dummy.updateMatrix();
    pitSoilInst.setMatrixAt(i, dummy.matrix);
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, t.y + 0.075, t.z);
    dummy.updateMatrix();
    pitGrateInst.setMatrixAt(i, dummy.matrix);
  });
  for (const pit of [pitCurbInst, pitSoilInst, pitGrateInst]) {
    pit.instanceMatrix.needsUpdate = true;
    pit.computeBoundingSphere();
    pit.userData.cullDistance = 950;
  }
  group.add(pitCurbInst, pitSoilInst, pitGrateInst);

  // =========================================================================
  // 3. TRAFFIC SIGNALS, mounted once the road network knows every junction's approaches (main.js: addSignals)
  // =========================================================================
  const signalGroup = new THREE.Group();
  signalGroup.name = 'TrafficSignals';
  group.add(signalGroup);
  function addSignals(network) {
    const poles = [], housings = [], mainLenses = [], sideLenses = [], walkBoxes = [];
    for (const n of network.nodes) {
      if (!n.signal) continue;
      for (const e of n.in || []) {
        // the end of the approach's stop line on the side traffic keeps to, a step back from the crossing
        const sx = e.sx + e.dx * (e.len - 0.4), sz = e.sz + e.dz * (e.len - 0.4);
        let px = 0, pz = 0, found = false;
        for (const out of [0.7, 1.3, 2.0, 2.8]) {
          px = sx + e.rx * KEEP * (e.half + out);
          pz = sz + e.rz * KEEP * (e.half + out);
          if (isOnKerb(px, pz, 0.3)) { found = true; break; }
        }
        if (!found) continue;
        const ground = (e.bridge ? streetHeight(sx, sz) : terrainHeight(px, pz)) + SW;
        addFootprint(px, pz, 0.4, 0.4, true);
        const yaw = Math.atan2(-e.dx, -e.dz); // facing the traffic coming up the approach
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(px, ground + 2.3, pz);
        dummy.scale.set(0.085, 4.6, 0.085);
        dummy.updateMatrix();
        poles.push(dummy.matrix.clone());
        dummy.rotation.set(0, yaw, 0);
        dummy.position.set(px - e.dx * 0.2, ground + 3.75, pz - e.dz * 0.2);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        housings.push(dummy.matrix.clone());
        (e.axisIndex === 0 ? mainLenses : sideLenses).push(dummy.matrix.clone());
        // the pedestrian signal for the crossing over this approach, facing along the kerb line across the road
        dummy.rotation.set(0, Math.atan2(-e.rx * KEEP, -e.rz * KEEP), 0);
        dummy.position.set(px, ground + 2.5, pz);
        dummy.updateMatrix();
        walkBoxes.push(dummy.matrix.clone());
        audioSignals.push({ x: px, y: ground + 2.5, z: pz, isAvenue: e.axisIndex !== 0 });
      }
    }
    addMatrixArrayInstanced(unitCyl, poleMetalMat, poles, true, signalGroup);
    addMatrixArrayInstanced(signalHousingGeo, signalHousingMat, housings, true, signalGroup);
    addMatrixArrayInstanced(backboardGeo, backboardMat, housings, true, signalGroup);
    addMatrixArrayInstanced(signalLensGeo, mainSignalLensMat, mainLenses, false, signalGroup);
    addMatrixArrayInstanced(signalLensGeo, sideSignalLensMat, sideLenses, false, signalGroup);
    addMatrixArrayInstanced(walkHousingGeo, signalHousingMat, walkBoxes, true, signalGroup);
    addMatrixArrayInstanced(walkPanelGeo, walkSignalGlow, walkBoxes, false, signalGroup);
    console.info(`[streetDetails] ${housings.length} signal heads at ${network.nodes.filter((n) => n.signal).length} junctions`);
  }
  // Junctions with traffic lights, as mapped (the road network marks its nodes from these)
  const signalIntersections = [];
  for (let i = 0; i < GEO.roadGraph.signals.length; i += 2) signalIntersections.push({ x: GEO.roadGraph.signals[i], z: GEO.roadGraph.signals[i + 1] });

  // =========================================================================
  // 4. CLUSTERED STREETLIGHT POOLS around the camera
  // =========================================================================
  const STREETLIGHT_SPOT_POOL = 36;
  const STREET_POINT_POOL = 24;
  const STREETLIGHT_DIST = 115;
  const STREET_POINT_DIST = 110;

  const streetLightsGroup = new THREE.Group();
  streetLightsGroup.name = 'StreetClusteredLights';
  scene.add(streetLightsGroup);

  const streetlightSpotPool = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // LED luminaire: wide downward spread (0.96 rad half-angle) illuminating both road and footpath
    const spot = new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    streetLightsGroup.add(spot, spot.target);
    streetlightSpotPool.push(spot);
  }

  const streetPointPool = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const pt = new THREE.PointLight(0xffe4b4, 0, 12, 1.35);
    pt.position.set(0, -1000, 0);
    streetLightsGroup.add(pt);
    streetPointPool.push(pt);
  }

  // Source positions are static. Query nearby cells instead of scanning the city every frame.
  const LIGHT_CELL = 128;
  function indexLights(sites) {
    const cells = new Map();
    for (const s of sites) {
      const key = Math.floor(s.x / LIGHT_CELL) + ',' + Math.floor(s.z / LIGHT_CELL);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = []);
      cell.push(s);
    }
    return cells;
  }
  const cobraCells = indexLights(cobraLampSites);
  const pointCells = indexLights(streetPointSites);

  function nearbyLights(cells, camera, range, active) {
    const { x: cx, y: cy, z: cz } = camera.position;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8], fwdZ = -me[10];
    let count = 0;
    for (let ix = Math.floor((cx - range) / LIGHT_CELL); ix <= Math.floor((cx + range) / LIGHT_CELL); ix++) {
      for (let iz = Math.floor((cz - range) / LIGHT_CELL); iz <= Math.floor((cz + range) / LIGHT_CELL); iz++) {
        for (const s of cells.get(ix + ',' + iz) || []) {
          const dx = s.x - cx, dz = s.z - cz, dy = s.y - cy;
          const d2 = dx * dx + dz * dz + dy * dy;
          if (d2 > range * range) continue;
          const effDist = Math.sqrt(d2) + Math.max(0, 6.0 - dx * fwdX - dz * fwdZ) * 2.8;
          if (effDist >= range) continue;
          s._effDist = effDist;
          active[count++] = s;
        }
      }
    }
    active.length = count;
    if (count > 1) active.sort((a, b) => a._effDist - b._effDist);
    return count;
  }

  const activeCobras = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function update(camera) {
    if (!camera) return;
    treeField.update(camera.position);
    const glow = cityUniforms.uInteriorGlow.value;
    // Increase streetlight intensity toward dusk.
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < STREET_POINT_POOL; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cobraCount = nearbyLights(cobraCells, camera, STREETLIGHT_DIST, activeCobras);
    const cobraCutoff = cobraCount > STREETLIGHT_SPOT_POOL
      ? Math.min(STREETLIGHT_DIST, activeCobras[STREETLIGHT_SPOT_POOL]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(cobraCount, STREETLIGHT_SPOT_POOL);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeCobras[i];
      const fade = smoothFade(s._effDist, cobraCutoff * 0.62, cobraCutoff);
      const spot = streetlightSpotPool[i];
      spot.position.set(s.x, s.y, s.z);
      spot.target.position.set(s.tx, s.ty, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < STREETLIGHT_SPOT_POOL; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    const ptCount = nearbyLights(pointCells, camera, STREET_POINT_DIST, activePoints);
    const ptCutoff = ptCount > STREET_POINT_POOL
      ? Math.min(STREET_POINT_DIST, activePoints[STREET_POINT_POOL]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, STREET_POINT_POOL);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      pt.position.set(s.x, s.y, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < STREET_POINT_POOL; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  return { group, footprints, signalClock, signalIntersections, audioSignals, treeField, update, addSignals };
}

export { buildStreetDetails };
