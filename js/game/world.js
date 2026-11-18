import { terrainHeight, deckHeight, terrainNormal } from '../terrain.js';
import { ISLAND_BOUNDS, blockAt, isLand } from '../city-config.js';
import { polygonContains } from '../building-collision.js';

// The world as the game sees it: one query & command surface over the engine, so weapons, police and missions never
// reach into traffic.js or the crowd. Every pedestrian and traffic vehicle has a stable id (its index) and a "view"
// refreshed each frame (positions, velocities, sizes); a raycast finds the first building, ground, water, vehicle,
// pedestrian or player along a ray without allocating (static cells for the buildings, a grid of dynamic cells
// around the player rebuilt each frame, a stepped march over the terrain); and commands hurt, kill or frighten
// people, stop or scare drivers, and blow things up.

const MASK = { BUILDINGS: 1, TERRAIN: 2, WATER: 4, VEHICLES: 8, PEDS: 16, PLAYER: 32 };
MASK.STATIC = MASK.BUILDINGS | MASK.TERRAIN | MASK.WATER;
MASK.ALL = MASK.STATIC | MASK.VEHICLES | MASK.PEDS | MASK.PLAYER;

const BUILDING_CELL = 32;
const DYN_CELL = 8;
const DYN_N = 128; // dynamic cells a side: 1 km around the player
const DYN_CAP = 6144; // entries (an object spanning several cells takes several)
const WATER_Y = ISLAND_BOUNDS.waterLevel;
// Body heights of the vehicle kinds (m above the road), for raycasts
const CAR_HEIGHT = { taxi: 1.55, sedan: 1.45, suv: 1.78, minivan: 1.8, pickup: 1.85, van: 2.45, bus: 3.25 };

function createWorld(game, { controllerManager, trafficSystem, colliders, cameraSystem }) {
  const traffic = trafficSystem;
  const peds = traffic.pedestrians;
  const network = traffic.network;
  const records = traffic.vehicles; // cars, the game's reserve cars, then buses
  traffic.pedestrians.setFreeCollider((pos, radius) => controllerManager.pushOutOfBuildings(pos, radius));

  // =================================================================================================================
  // VIEWS: stable ids, fresh positions & velocities each frame (read-only for everyone but this module)
  // =================================================================================================================
  const pedViews = peds.peds.map((p, id) => ({
    id, type: 'ped', active: false, alive: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, heading: 0, radius: 0.32, height: 1.75,
    health: 100, fleeing: false, free: false, record: p, _px: NaN, _pz: NaN, _rs: 0
  }));
  const carViews = records.map((r, id) => ({
    id, type: 'traffic', active: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, heading: 0, speed: 0,
    halfW: r.halfWidth, halfL: r.halfL ?? r.half, height: r.bus ? CAR_HEIGHT.bus : CAR_HEIGHT[r.bodyType] || 1.5,
    kind: r.bus ? 'bus' : r.bodyType, police: !!r.isPolice, health: 100, record: r, _rs: 0
  }));
  for (const view of carViews) view.record.view = view;
  // the player's body on foot (a raycast target), kept in step by update()
  const playerView = { type: 'player', active: false, x: 0, y: 0, z: 0, radius: 0.36, height: 1.8, _rs: 0 };

  function refreshViews(dt) {
    const inv = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < pedViews.length; i++) {
      const v = pedViews[i];
      const p = v.record;
      v.active = p.placed;
      if (!p.placed) {
        v._px = NaN;
        continue;
      }
      v.alive = !p.dead;
      v.x = p.x;
      v.z = p.z;
      v.y = p.rig.placed ? Math.min(p.rig.feet[0].py, p.rig.feet[1].py) : terrainHeight(p.x, p.z) + 0.22;
      v.height = 1.75 * p.rig.s;
      v.vx = Number.isFinite(v._px) ? (p.x - v._px) * inv : 0;
      v.vz = Number.isFinite(v._pz) ? (p.z - v._pz) * inv : 0;
      v._px = p.x;
      v._pz = p.z;
      v.heading = p.dead ? p.deathYaw : p.rig.yaw;
      v.health = p.hp;
      v.fleeing = traffic.game.clock < p.fleeUntil;
      v.free = p.free;
    }
    for (let i = 0; i < carViews.length; i++) {
      const v = carViews[i];
      const r = v.record;
      v.active = !!r.edge;
      if (!v.active) continue;
      v.x = r.x;
      v.z = r.z;
      v.y = r.gy;
      v.heading = r.yaw + r.yawOffset;
      v.speed = r.speed;
      v.vx = Math.sin(v.heading) * r.speed + r.vx;
      v.vz = Math.cos(v.heading) * r.speed + r.vz;
      v.health = r.health ?? 100;
      v.police = !!r.isPolice;
    }
    const pe = controllerManager.entities.person;
    playerView.active = controllerManager.activeMode === 'person' && !pe.hidden;
    playerView.x = pe.position.x;
    playerView.y = pe.position.y;
    playerView.z = pe.position.z;
    playerView.height = game.player?.dead ? 0.45 : 1.8;
  }

  // =================================================================================================================
  // STATIC CELLS: every building, house, wall & parapet collider indexed into 32 m cells once
  // =================================================================================================================
  const buildingCells = new Map();
  const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  for (const c of colliders) {
    if (!Number.isFinite(c.minX) || !Number.isFinite(c.maxX)) continue;
    c._rayStamp = 0;
    for (let ix = Math.floor(c.minX / BUILDING_CELL); ix <= Math.floor(c.maxX / BUILDING_CELL); ix++) {
      for (let iz = Math.floor(c.minZ / BUILDING_CELL); iz <= Math.floor(c.maxZ / BUILDING_CELL); iz++) {
        const k = cellKey(ix, iz);
        let list = buildingCells.get(k);
        if (!list) buildingCells.set(k, (list = []));
        list.push(c);
      }
    }
  }

  // =================================================================================================================
  // DYNAMIC CELLS: pedestrians, traffic, world vehicles & the player, rebuilt every frame around the player
  // (typed-array linked lists; an object reaching into several cells is in each)
  // =================================================================================================================
  const dynHead = new Int32Array(DYN_N * DYN_N).fill(-1);
  const dynNext = new Int32Array(DYN_CAP);
  const dynItem = new Array(DYN_CAP).fill(null);
  const dynTouched = new Int32Array(DYN_CAP);
  let dynCount = 0;
  let dynTouchedCount = 0;
  let dynX0 = 0;
  let dynZ0 = 0;

  function dynInsert(obj, x, z, r) {
    const ix0 = Math.max(0, Math.floor((x - r - dynX0) / DYN_CELL));
    const ix1 = Math.min(DYN_N - 1, Math.floor((x + r - dynX0) / DYN_CELL));
    const iz0 = Math.max(0, Math.floor((z - r - dynZ0) / DYN_CELL));
    const iz1 = Math.min(DYN_N - 1, Math.floor((z + r - dynZ0) / DYN_CELL));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (dynCount >= DYN_CAP) return;
        const cell = iz * DYN_N + ix;
        if (dynHead[cell] === -1) dynTouched[dynTouchedCount++] = cell;
        dynNext[dynCount] = dynHead[cell];
        dynItem[dynCount] = obj;
        dynHead[cell] = dynCount++;
      }
    }
  }

  function rebuildDynamic() {
    for (let i = 0; i < dynTouchedCount; i++) dynHead[dynTouched[i]] = -1;
    for (let i = 0; i < dynCount; i++) dynItem[i] = null;
    dynTouchedCount = 0;
    dynCount = 0;
    const focus = controllerManager.getActiveEntity().position;
    dynX0 = Math.floor(focus.x / DYN_CELL) * DYN_CELL - (DYN_N / 2) * DYN_CELL;
    dynZ0 = Math.floor(focus.z / DYN_CELL) * DYN_CELL - (DYN_N / 2) * DYN_CELL;
    for (let i = 0; i < pedViews.length; i++) {
      const v = pedViews[i];
      if (v.active) dynInsert(v, v.x, v.z, v.alive ? 0.4 : 1.3);
    }
    for (let i = 0; i < carViews.length; i++) {
      const v = carViews[i];
      if (v.active) dynInsert(v, v.x, v.z, v.halfL + 0.2);
    }
    const list = game.vehicles ? game.vehicles.list() : null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (!w.hidden) dynInsert(w, w.entity.position.x, w.entity.position.z, w.halfL + 0.3);
      }
    }
    if (playerView.active) dynInsert(playerView, playerView.x, playerView.z, 0.5);
  }

  // =================================================================================================================
  // RAYCAST
  // =================================================================================================================
  const hit = {
    kind: null, distance: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, target: null, id: -1, material: 'concrete'
  };
  const bestHit = { t: Infinity, kind: null, nx: 0, ny: 0, nz: 0, target: null, material: '' };
  const tmpNormal = { x: 0, y: 1, z: 0 };
  const crossT = new Float64Array(512);
  const crossN = new Float64Array(1024);
  let stamp = 1;
  let rayIgnore = null;
  let rayIgnore2 = null;

  const ignored = (obj) => obj === rayIgnore || obj === rayIgnore2
    || (rayIgnore && obj.type === 'world' && rayIgnore.entity && obj.entity === rayIgnore.entity);

  function record(t, kind, nx, ny, nz, target, material) {
    if (t >= bestHit.t) return;
    bestHit.t = t;
    bestHit.kind = kind;
    bestHit.nx = nx;
    bestHit.ny = ny;
    bestHit.nz = nz;
    bestHit.target = target;
    bestHit.material = material;
  }

  // Vertical prism (footprint polygon, oriented box or box between minY and maxY) against the ray
  function rayCollider(c, ox, oy, oz, dx, dy, dz, tMax) {
    const minY = c.minY ?? 0, maxY = c.maxY;
    let ty0 = -Infinity, ty1 = Infinity;
    if (Math.abs(dy) < 1e-9) {
      if (oy < minY || oy > maxY) return;
    } else {
      const a = (minY - oy) / dy, b = (maxY - oy) / dy;
      ty0 = Math.min(a, b);
      ty1 = Math.max(a, b);
      if (ty1 < 0 || ty0 > tMax) return;
    }
    // the bounding box first
    let t0 = 0, t1 = tMax;
    if (Math.abs(dx) < 1e-9) {
      if (ox < c.minX || ox > c.maxX) return;
    } else {
      const a = (c.minX - ox) / dx, b = (c.maxX - ox) / dx;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (Math.abs(dz) < 1e-9) {
      if (oz < c.minZ || oz > c.maxZ) return;
    } else {
      const a = (c.minZ - oz) / dz, b = (c.maxZ - oz) / dz;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1 || t1 < ty0 || t0 > ty1) return;

    if (c.polygon) return rayPolygon(c, ox, oy, oz, dx, dy, dz, Math.max(t0, 0), Math.min(t1, tMax), ty0, ty1);
    let nx = 0, nz = 0, tEnter = t0;
    if (c.obb) {
      // the house's box in its own frame (as controllers.js buildingContact turns it)
      const o = c.obb;
      const px = ox - o.cx, pz = oz - o.cz;
      const lx = px * o.cs - pz * o.sn, lz = px * o.sn + pz * o.cs;
      const ldx = dx * o.cs - dz * o.sn, ldz = dx * o.sn + dz * o.cs;
      let a0 = 0, a1 = tMax, ax = 0, az = 0;
      if (Math.abs(ldx) < 1e-9) {
        if (Math.abs(lx) > o.hx) return;
      } else {
        const a = (-o.hx - lx) / ldx, b = (o.hx - lx) / ldx;
        if (Math.min(a, b) > a0) { a0 = Math.min(a, b); ax = ldx > 0 ? -1 : 1; az = 0; }
        a1 = Math.min(a1, Math.max(a, b));
      }
      if (Math.abs(ldz) < 1e-9) {
        if (Math.abs(lz) > o.hz) return;
      } else {
        const a = (-o.hz - lz) / ldz, b = (o.hz - lz) / ldz;
        if (Math.min(a, b) > a0) { a0 = Math.min(a, b); ax = 0; az = ldz > 0 ? -1 : 1; }
        a1 = Math.min(a1, Math.max(a, b));
      }
      if (a0 > a1) return;
      tEnter = a0;
      t1 = a1;
      nx = ax * o.cs + az * o.sn;
      nz = -ax * o.sn + az * o.cs;
    } else {
      // plain box: which slab did it enter by?
      const ax = Math.abs(dx) < 1e-9 ? -Infinity : Math.min((c.minX - ox) / dx, (c.maxX - ox) / dx);
      const az = Math.abs(dz) < 1e-9 ? -Infinity : Math.min((c.minZ - oz) / dz, (c.maxZ - oz) / dz);
      if (ax > az) nx = dx > 0 ? -1 : 1;
      else nz = dz > 0 ? -1 : 1;
    }
    const enter = Math.max(tEnter, ty0, 0);
    if (enter > Math.min(t1, ty1) || enter > tMax) return;
    if (enter === ty0 && ty0 > tEnter) record(enter, 'building', 0, dy < 0 ? 1 : -1, 0, c, 'concrete');
    else if (enter <= 0) record(0, 'building', -dx, -dy, -dz, c, 'concrete');
    else record(enter, 'building', nx, 0, nz, c, 'concrete');
  }

  // A footprint polygon (with courtyards): the ray is inside it between alternate crossings of its rings
  function rayPolygon(c, ox, oy, oz, dx, dy, dz, tA, tB, ty0, ty1) {
    const poly = c.polygon;
    let n = 0;
    for (let r = -1; r < poly.holes.length && n < 510; r++) {
      const ring = r < 0 ? poly.outer : poly.holes[r];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        const ex = b.x - a.x, ez = b.z - a.z;
        const cross = dx * ez - dz * ex;
        if (Math.abs(cross) < 1e-12) continue;
        const qx = a.x - ox, qz = a.z - oz;
        const t = (qx * ez - qz * ex) / cross;
        const u = (qx * dz - qz * dx) / cross;
        if (u < 0 || u > 1 || t < tA - 1e-6 || t > tB + 1e-6) continue;
        // insertion sort by t; the edge's normal (facing the ray) alongside
        let k = n++;
        while (k > 0 && crossT[k - 1] > t) {
          crossT[k] = crossT[k - 1];
          crossN[k * 2] = crossN[k * 2 - 2];
          crossN[k * 2 + 1] = crossN[k * 2 - 1];
          k--;
        }
        const len = Math.hypot(ex, ez) || 1;
        let nx = -ez / len, nz = ex / len;
        if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; }
        crossT[k] = t;
        crossN[k * 2] = nx;
        crossN[k * 2 + 1] = nz;
        if (n >= 510) break;
      }
    }
    let inside = polygonContains(poly, ox + dx * tA, oz + dz * tA);
    let start = tA;
    let nx = 0, nz = 0, fromWall = false;
    for (let k = 0; k <= n; k++) {
      const end = k < n ? crossT[k] : tB;
      if (inside) {
        const enter = Math.max(start, ty0, 0);
        if (enter <= Math.min(end, ty1)) {
          if (enter === start && fromWall) record(enter, 'building', nx, 0, nz, c, 'concrete');
          else if (enter === ty0 && ty0 > start) record(enter, 'building', 0, dy < 0 ? 1 : -1, 0, c, 'concrete');
          else record(enter, 'building', -dx, -dy, -dz, c, 'concrete');
          return;
        }
      }
      if (k < n) {
        inside = !inside;
        start = end;
        nx = crossN[k * 2];
        nz = crossN[k * 2 + 1];
        fromWall = true;
      }
    }
  }

  // Grid walk (Amanatides & Woo) over square cells of `size` along the ray's ground track, calling visit(ix, iz,
  // tEnter) until it returns true or the ray passes tMax
  function walkCells(ox, oz, dx, dz, tMax, size, x0, z0, visit) {
    let ix = Math.floor((ox - x0) / size), iz = Math.floor((oz - z0) / size);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) < 1e-12 ? Infinity : size / Math.abs(dx);
    const tdz = Math.abs(dz) < 1e-12 ? Infinity : size / Math.abs(dz);
    let tx = Math.abs(dx) < 1e-12 ? Infinity : ((dx > 0 ? (ix + 1) * size + x0 - ox : ox - (ix * size + x0)) / Math.abs(dx));
    let tz = Math.abs(dz) < 1e-12 ? Infinity : ((dz > 0 ? (iz + 1) * size + z0 - oz : oz - (iz * size + z0)) / Math.abs(dz));
    let t = 0;
    for (let guard = 0; guard < 4096; guard++) {
      if (visit(ix, iz, t)) return;
      if (tx < tz) {
        t = tx;
        tx += tdx;
        ix += stepX;
      } else {
        t = tz;
        tz += tdz;
        iz += stepZ;
      }
      if (t > tMax || t > bestHit.t) return;
    }
  }

  let rox = 0, roy = 0, roz = 0, rdx = 0, rdy = 0, rdz = 0, rMax = 0, rMask = 0;
  const visitBuildingCell = (ix, iz) => {
    const list = buildingCells.get(cellKey(ix, iz));
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c._rayStamp === stamp) continue;
      c._rayStamp = stamp;
      rayCollider(c, rox, roy, roz, rdx, rdy, rdz, Math.min(rMax, bestHit.t));
    }
    return false;
  };

  const visitDynamicCell = (ix, iz) => {
    if (ix < 0 || iz < 0 || ix >= DYN_N || iz >= DYN_N) return false;
    for (let e = dynHead[iz * DYN_N + ix]; e !== -1; e = dynNext[e]) {
      const obj = dynItem[e];
      if (obj._rs === stamp) continue;
      obj._rs = stamp;
      if (ignored(obj)) continue;
      const tMax = Math.min(rMax, bestHit.t);
      if (obj.type === 'ped') {
        if (!(rMask & MASK.PEDS)) continue;
        const p = obj.record;
        if (obj.alive) rayCylinder(obj.x, obj.z, obj.y, obj.y + obj.height, obj.radius, tMax, 'ped', obj, 'flesh');
        else rayCylinder(obj.x + Math.sin(p.deathYaw) * 0.55, obj.z + Math.cos(p.deathYaw) * 0.55, obj.y, obj.y + 0.4, 0.75, tMax, 'ped', obj, 'flesh');
      } else if (obj.type === 'traffic') {
        if (!(rMask & MASK.VEHICLES)) continue;
        rayBox(obj.x, obj.y + 0.12, obj.z, obj.heading, obj.halfW, obj.halfL, obj.height - 0.12, tMax, obj);
      } else if (obj.type === 'world') {
        if (!(rMask & MASK.VEHICLES)) continue;
        const e2 = obj.entity;
        const base = obj.mode === 'helicopter' ? e2.position.y - 0.1 : e2.position.y + 0.12;
        rayBox(e2.position.x, base, e2.position.z, e2.heading, obj.halfW, obj.halfL, obj.height, tMax, obj);
      } else if (obj.type === 'player') {
        if (!(rMask & MASK.PLAYER)) continue;
        rayCylinder(obj.x, obj.z, obj.y, obj.y + obj.height, obj.radius, tMax, 'player', obj, 'flesh');
      }
    }
    return false;
  };

  function rayCylinder(cx, cz, y0, y1, radius, tMax, kind, target, material) {
    const px = rox - cx, pz = roz - cz;
    const a = rdx * rdx + rdz * rdz;
    let t0 = -Infinity, t1 = Infinity;
    if (a < 1e-12) {
      if (px * px + pz * pz > radius * radius) return;
    } else {
      const b = px * rdx + pz * rdz;
      const c = px * px + pz * pz - radius * radius;
      const disc = b * b - a * c;
      if (disc < 0) return;
      const s = Math.sqrt(disc);
      t0 = (-b - s) / a;
      t1 = (-b + s) / a;
    }
    let ty0 = -Infinity, ty1 = Infinity;
    if (Math.abs(rdy) < 1e-9) {
      if (roy < y0 || roy > y1) return;
    } else {
      const u = (y0 - roy) / rdy, v = (y1 - roy) / rdy;
      ty0 = Math.min(u, v);
      ty1 = Math.max(u, v);
    }
    const enter = Math.max(t0, ty0, 0);
    if (enter > Math.min(t1, ty1, tMax)) return;
    if (enter === ty0 && ty0 > t0) record(enter, kind, 0, rdy < 0 ? 1 : -1, 0, target, material);
    else {
      const hx = rox + rdx * enter - cx, hz = roz + rdz * enter - cz;
      const l = Math.hypot(hx, hz) || 1;
      record(enter, kind, hx / l, 0, hz / l, target, material);
    }
  }

  // A vehicle's box in its own frame: x to its left (cos h, -sin h), z forwards (sin h, cos h)
  function rayBox(cx, y0, cz, heading, hw, hl, height, tMax, target) {
    const s = Math.sin(heading), c = Math.cos(heading);
    const px = rox - cx, pz = roz - cz;
    const lx = px * c - pz * s, lz = px * s + pz * c;
    const ldx = rdx * c - rdz * s, ldz = rdx * s + rdz * c;
    const ly = roy - y0 - height * 0.5, hh = height * 0.5;
    let t0 = 0, t1 = tMax, axis = -1, sign = 0;
    // three slabs: across (x), up (y), along (z)
    for (let k = 0; k < 3; k++) {
      const o = k === 0 ? lx : k === 1 ? ly : lz;
      const d = k === 0 ? ldx : k === 1 ? rdy : ldz;
      const h = k === 0 ? hw : k === 1 ? hh : hl;
      if (Math.abs(d) < 1e-9) {
        if (Math.abs(o) > h) return;
        continue;
      }
      const a = (-h - o) / d, b = (h - o) / d;
      const near = a < b ? a : b;
      if (near > t0) {
        t0 = near;
        axis = k === 1 ? 1 : k === 0 ? 0 : 2;
        sign = d > 0 ? -1 : 1;
      }
      const far = a < b ? b : a;
      if (far < t1) t1 = far;
      if (t0 > t1) return;
    }
    let nx = 0, ny = 0, nz = 0;
    if (axis === 0) { nx = sign * c; nz = -sign * s; }
    else if (axis === 2) { nx = sign * s; nz = sign * c; }
    else if (axis === 1) ny = sign;
    else { nx = -rdx; ny = -rdy; nz = -rdz; }
    // glass: the upper body
    const yHit = roy + rdy * t0 - y0;
    record(t0, 'vehicle', nx, ny, nz, target, yHit > height * 0.62 && axis !== 1 ? 'glass' : 'metal');
  }

  // The ground (and bridge decks, and the harbour's surface) by a march that steps further the higher the ray is
  function rayTerrain(tMax) {
    let t = 0;
    let x = rox, y = roy, z = roz;
    let ground = Math.max(terrainHeight(x, z), WATER_Y);
    if (y < ground - 0.05) return;
    let prevT = 0;
    for (let guard = 0; guard < 600 && t < tMax; guard++) {
      const gap = y - ground;
      const step = Math.min(14, Math.max(0.35, gap / (Math.max(0, -rdy) + 1.15)));
      prevT = t;
      t = Math.min(tMax, t + step);
      x = rox + rdx * t;
      y = roy + rdy * t;
      z = roz + rdz * t;
      const deck = deckHeight(x, z, roy + rdy * prevT - 2.5);
      // going up under a bridge or a viaduct: the deck's underside (1.2 m under its surface) stops the ray
      if (rdy > 0 && (rMask & MASK.TERRAIN)) {
        const under = deckHeight(x, z, Infinity) - 1.2;
        const y0 = roy + rdy * prevT;
        if (y0 < under && y >= under && terrainHeight(x, z) < under) {
          const tc = Math.max(prevT, Math.min(t, (under - roy) / rdy));
          record(tc, 'terrain', 0, -1, 0, null, 'concrete');
          return;
        }
      }
      ground = Math.max(terrainHeight(x, z), WATER_Y, deck);
      if (y <= ground) {
        // refine between prevT and t
        let lo = prevT, hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = rox + rdx * mid, mz = roz + rdz * mid, my = roy + rdy * mid;
          if (my <= Math.max(terrainHeight(mx, mz), WATER_Y, deck)) hi = mid;
          else lo = mid;
        }
        const hx = rox + rdx * hi, hz = roz + rdz * hi;
        const th = terrainHeight(hx, hz);
        const onDeck = deck > th && deck > WATER_Y && roy + rdy * hi <= deck + 0.05;
        if (!onDeck && th < WATER_Y) {
          if (rMask & MASK.WATER) record(hi, 'water', 0, 1, 0, null, 'water');
          return;
        }
        if (!(rMask & MASK.TERRAIN)) return;
        if (onDeck) record(hi, 'terrain', 0, 1, 0, null, 'concrete');
        else {
          terrainNormal(hx, hz, tmpNormal);
          const block = blockAt(hx, hz);
          record(hi, 'terrain', tmpNormal.x, tmpNormal.y, tmpNormal.z, null, block && block.park > 0.5 ? 'dirt' : 'concrete');
        }
        return;
      }
    }
  }

  /**
   * The first thing along a ray: origin & dir are { x, y, z } (dir need not be unit length), maxDist in metres.
   * opts.mask: MASK bits (default all); opts.ignore / opts.ignore2: objects to pass through (a ped or car view, a
   * world vehicle, 'player' view via world.playerView). Returns the shared hit record (copy what you keep) or null.
   */
  function raycast(origin, dir, maxDist = 250, opts = null) {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 1e-9)) return null;
    rox = origin.x; roy = origin.y; roz = origin.z;
    rdx = dir.x / len; rdy = dir.y / len; rdz = dir.z / len;
    rMax = maxDist;
    rMask = opts?.mask ?? MASK.ALL;
    rayIgnore = opts?.ignore ?? null;
    rayIgnore2 = opts?.ignore2 ?? null;
    bestHit.t = Infinity;
    bestHit.kind = null;
    stamp++;
    if (rMask & MASK.BUILDINGS) walkCells(rox, roz, rdx, rdz, rMax, BUILDING_CELL, 0, 0, visitBuildingCell);
    if (rMask & (MASK.VEHICLES | MASK.PEDS | MASK.PLAYER)) {
      // start inside the dynamic grid (clip the ray to its square)
      let tIn = 0;
      const gx1 = dynX0 + DYN_N * DYN_CELL, gz1 = dynZ0 + DYN_N * DYN_CELL;
      if (rox < dynX0 || rox >= gx1 || roz < dynZ0 || roz >= gz1) {
        let a0 = 0, a1 = rMax;
        for (let k = 0; k < 2; k++) {
          const o = k ? roz : rox, d = k ? rdz : rdx, lo = k ? dynZ0 : dynX0, hi = k ? gz1 : gx1;
          if (Math.abs(d) < 1e-12) {
            if (o < lo || o >= hi) a0 = Infinity;
          } else {
            const p = (lo - o) / d, q = (hi - o) / d;
            a0 = Math.max(a0, Math.min(p, q));
            a1 = Math.min(a1, Math.max(p, q));
          }
        }
        tIn = a0 <= a1 ? a0 + 1e-4 : Infinity;
      }
      if (tIn < Math.min(rMax, bestHit.t)) {
        const sx = rox + rdx * tIn, sz = roz + rdz * tIn;
        walkCells(sx, sz, rdx, rdz, rMax - tIn, DYN_CELL, dynX0, dynZ0, visitDynamicCell);
      }
    }
    if (rMask & (MASK.TERRAIN | MASK.WATER)) rayTerrain(Math.min(rMax, bestHit.t));
    if (!bestHit.kind) return null;
    hit.kind = bestHit.kind;
    hit.distance = bestHit.t;
    hit.x = rox + rdx * bestHit.t;
    hit.y = roy + rdy * bestHit.t;
    hit.z = roz + rdz * bestHit.t;
    const nl = Math.hypot(bestHit.nx, bestHit.ny, bestHit.nz) || 1;
    hit.nx = bestHit.nx / nl;
    hit.ny = bestHit.ny / nl;
    hit.nz = bestHit.nz / nl;
    hit.target = bestHit.target;
    hit.id = bestHit.target && bestHit.target.id !== undefined ? bestHit.target.id : -1;
    hit.material = bestHit.material;
    return hit;
  }

  const losDir = { x: 0, y: 0, z: 0 };
  /** Nothing solid (buildings & ground by default) between a and b? */
  function lineOfSight(a, b, opts = null) {
    losDir.x = b.x - a.x;
    losDir.y = b.y - a.y;
    losDir.z = b.z - a.z;
    const d = Math.hypot(losDir.x, losDir.y, losDir.z);
    if (d < 1e-6) return true;
    const mask = opts?.mask ?? MASK.STATIC;
    return !raycast(a, losDir, d - 0.05, { mask, ignore: opts?.ignore, ignore2: opts?.ignore2 });
  }

  /** How far from pivot towards to is clear of buildings (0..1), for the camera */
  function clearance(pivot, to) {
    losDir.x = to.x - pivot.x;
    losDir.y = to.y - pivot.y;
    losDir.z = to.z - pivot.z;
    const d = Math.hypot(losDir.x, losDir.y, losDir.z);
    if (d < 1e-4) return 1;
    const h = raycast(pivot, losDir, d + 0.3, { mask: MASK.BUILDINGS });
    return h ? Math.max(0, (h.distance - 0.3) / d) : 1;
  }

  // =================================================================================================================
  // QUERIES
  // =================================================================================================================
  /** Pedestrians (alive unless includeDead) within r of (x, z), into out (cleared first) */
  function nearbyPeds(x, z, r, out = [], includeDead = false) {
    out.length = 0;
    const r2 = r * r;
    for (let i = 0; i < pedViews.length; i++) {
      const v = pedViews[i];
      if (!v.active || (!v.alive && !includeDead)) continue;
      const dx = v.x - x, dz = v.z - z;
      if (dx * dx + dz * dz <= r2) out.push(v);
    }
    return out;
  }

  /** Traffic vehicles on the road within r of (x, z), into out */
  function nearbyCars(x, z, r, out = []) {
    out.length = 0;
    const r2 = r * r;
    for (let i = 0; i < carViews.length; i++) {
      const v = carViews[i];
      if (!v.active) continue;
      const dx = v.x - x, dz = v.z - z;
      if (dx * dx + dz * dz <= r2) out.push(v);
    }
    return out;
  }

  /** Living people within r of (x, z) who could see something happen there (a cheap count, no sight lines) */
  function witnesses(x, z, r = 30) {
    let n = 0;
    const r2 = r * r;
    for (let i = 0; i < pedViews.length; i++) {
      const v = pedViews[i];
      if (!v.active || !v.alive) continue;
      const dx = v.x - x, dz = v.z - z;
      if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
  }

  /** Height to stand on at (x, z): kerbs, bridge decks no more than a step above yRef */
  const groundHeight = (x, z, yRef = Infinity) => controllerManager.getGroundHeight(x, z, 'person', yRef);

  /** On the roadway (land not on a kerbed block)? */
  const isOnRoad = (x, z) => isLand(x, z) && !blockAt(x, z);

  // Road graph nodes & lane edges in 64 m cells (for spawning near a point)
  const ROAD_CELL = 64;
  const nodeCells = new Map();
  const edgeCells = new Map();
  for (const n of network.nodes) {
    const k = cellKey(Math.floor(n.x / ROAD_CELL), Math.floor(n.z / ROAD_CELL));
    let list = nodeCells.get(k);
    if (!list) nodeCells.set(k, (list = []));
    list.push(n);
  }
  for (const e of network.edges) {
    if (!(e.len > 0) || !e.lanes?.length) continue;
    const mx = e.sx + e.dx * e.len * 0.5, mz = e.sz + e.dz * e.len * 0.5;
    const k = cellKey(Math.floor(mx / ROAD_CELL), Math.floor(mz / ROAD_CELL));
    let list = edgeCells.get(k);
    if (!list) edgeCells.set(k, (list = []));
    list.push(e);
  }

  /** The nearest road-graph intersection to (x, z) within maxDist: { x, z, signal, node } or null */
  function nearestRoadNode(x, z, maxDist = 400) {
    let best = null, bestD = maxDist * maxDist;
    const reach = Math.ceil(maxDist / ROAD_CELL);
    const cx = Math.floor(x / ROAD_CELL), cz = Math.floor(z / ROAD_CELL);
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iz = cz - reach; iz <= cz + reach; iz++) {
        const list = nodeCells.get(cellKey(ix, iz));
        if (!list) continue;
        for (const n of list) {
          const d = (n.x - x) ** 2 + (n.z - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    return best ? { x: best.x, z: best.z, signal: !!best.signal, node: best } : null;
  }

  const candidates = [];
  /**
   * A random point on a traffic lane between rMin and rMax from (x, z), heading along the lane:
   * { x, y, z, heading, edge, lane } (into out if given) or null. For spawning cars, pickups and police.
   */
  function randomRoadPoint(x, z, rMin = 30, rMax = 200, out = null) {
    candidates.length = 0;
    const reach = Math.ceil(rMax / ROAD_CELL) + 1;
    const cx = Math.floor(x / ROAD_CELL), cz = Math.floor(z / ROAD_CELL);
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iz = cz - reach; iz <= cz + reach; iz++) {
        const list = edgeCells.get(cellKey(ix, iz));
        if (list) for (const e of list) candidates.push(e);
      }
    }
    for (let attempt = 0; attempt < 24 && candidates.length; attempt++) {
      const e = candidates[Math.floor(Math.random() * candidates.length)];
      const lane = Math.floor(Math.random() * e.lanes.length);
      const s = Math.random() * e.len;
      const px = e.sx + e.dx * s + e.rx * e.lanes[lane];
      const pz = e.sz + e.dz * s + e.rz * e.lanes[lane];
      const d = Math.hypot(px - x, pz - z);
      if (d < rMin || d > rMax) continue;
      const o = out || {};
      o.x = px;
      o.z = pz;
      o.y = e.deck ? controllerManager.getGroundHeight(px, pz, 'car', Infinity, 1) : terrainHeight(px, pz);
      o.heading = Math.atan2(e.dx, e.dz);
      o.edge = e;
      o.lane = lane;
      return o;
    }
    return null;
  }

  // =================================================================================================================
  // COMMANDS: people
  // =================================================================================================================
  const pedEvent = { ped: null, amount: 0, health: 0, kind: '', source: null, byPlayer: false, x: 0, y: 0, z: 0, dirX: 0, dirZ: 0, witnesses: 0 };

  function emitPed(type, view, amount, opts) {
    pedEvent.ped = view;
    pedEvent.amount = amount;
    pedEvent.health = Math.max(0, view.record.hp);
    pedEvent.kind = opts?.kind || 'unknown';
    pedEvent.source = opts?.source ?? null;
    pedEvent.byPlayer = opts?.byPlayer ?? opts?.source === 'player';
    pedEvent.x = view.record.x;
    pedEvent.y = view.y;
    pedEvent.z = view.record.z;
    pedEvent.dirX = opts?.dirX || 0;
    pedEvent.dirZ = opts?.dirZ || 0;
    pedEvent.witnesses = witnesses(view.record.x, view.record.z, 30) - (type === 'ped:killed' ? 0 : 1);
    game.emit(type, pedEvent);
  }

  /**
   * Hurts a pedestrian by id. opts: { source ('player' | object), byPlayer, kind ('melee' | 'vehicle'), dirX, dirZ
   * (the blow's direction) }. Emits ped:hit, and ped:killed when they go down for good (knocked out: they lie there
   * and are cleared away later). Returns 'killed', 'hurt' or null.
   */
  function hurtPed(id, amount, opts = null) {
    const view = pedViews[id];
    if (!view || !view.record.placed || view.record.dead) return null;
    const result = peds.hurt(id, amount, opts?.dirX || 0, opts?.dirZ || 0);
    if (!result) return null;
    view.alive = !view.record.dead;
    emitPed('ped:hit', view, amount, opts);
    if (result === 'killed') {
      emitPed('ped:killed', view, amount, opts);
      panic(view.record.x, view.record.z, 22, { duration: 10 });
    }
    return result;
  }

  function killPed(id, opts = null) {
    const view = pedViews[id];
    if (!view || !view.record.placed || view.record.dead) return false;
    return hurtPed(id, view.record.hp + 1, opts) === 'killed';
  }

  /** People within radius run (and some cower) for about opts.duration s; opts.cower: share that cower first */
  function panic(x, z, radius = 25, opts = null) {
    peds.panic(x, z, radius, opts?.duration ?? 8, opts?.cower ?? 0.25);
  }

  /** A pedestrian thrown out at (x, z), running away from (fromX, fromZ): its id or -1 */
  function spawnFleeingPed(x, z, fromX, fromZ, seconds = 6) {
    return peds.spawnFree(x, z, fromX, fromZ, seconds);
  }

  // =================================================================================================================
  // COMMANDS: traffic
  // =================================================================================================================
  const car = (id) => (typeof id === 'object' && id ? id.record || id : carViews[id]?.record);

  /** Damages a traffic vehicle (smoke, then wrecked: see game/vehicles.js). opts: { source, kind, byPlayer, x, y, z } */
  function damageCar(id, amount, opts = null) {
    const r = car(id);
    if (!r || !game.vehicles) return;
    game.vehicles.damageTraffic(r, amount, opts);
  }

  /** The driver brakes as hard as it can for `seconds` */
  function stopCar(id, seconds = 3) {
    const r = car(id);
    if (r?.edge) traffic.game.stop(r, seconds);
  }

  /** Drivers within radius panic: those heading away floor it, the others brake (seconds: how long) */
  function scareDrivers(x, z, radius = 40, seconds = 4) {
    const r2 = radius * radius;
    for (let i = 0; i < carViews.length; i++) {
      const v = carViews[i];
      if (!v.active) continue;
      const dx = v.x - x, dz = v.z - z;
      if (dx * dx + dz * dz > r2) continue;
      const away = dx * Math.sin(v.heading) + dz * Math.cos(v.heading) > 0;
      traffic.game.scare(v.record, seconds * (0.8 + Math.random() * 0.4), away);
    }
  }

  /** Takes a traffic vehicle off the road (traffic puts it back somewhere out of sight later) */
  function removeCar(id) {
    const r = car(id);
    if (!r?.edge || r.bus) return false;
    traffic.game.detach(r);
    traffic.game.release(r);
    return true;
  }

  return {
    MASK,
    peds: pedViews,
    cars: carViews,
    playerView,
    raycast,
    lineOfSight,
    clearance,
    nearbyPeds,
    nearbyCars,
    witnesses,
    groundHeight,
    isOnRoad,
    nearestRoadNode,
    randomRoadPoint,
    hurtPed,
    killPed,
    panic,
    spawnFleeingPed,
    damageCar,
    stopCar,
    scareDrivers,
    removeCar,
    /** @internal the game refreshes the views and the dynamic cells first thing each frame */
    update(dt) {
      refreshViews(dt);
      rebuildDynamic();
    },
    get clock() {
      return traffic.game.clock;
    }
  };
}

export { createWorld, MASK as RAY_MASK };
