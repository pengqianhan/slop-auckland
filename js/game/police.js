import * as THREE from 'three/webgpu';
import { uv } from 'three/tsl';
import {
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from '../helicopter.js';
import { transparentEffectMRT } from '../tsl-materials.js';
import { terrainHeight } from '../terrain.js';
import { ISLAND_BOUNDS } from '../city-config.js';
import { createWanted } from './wanted.js';

// The police: the response to the wanted level (game/wanted.js, created here). Nobody in uniform carries a gun: they
// catch people. Patrol cars and SUVs are world vehicles (game/vehicles.js) spawned out of sight on the streets around
// the player, or patrol cars already in traffic taken over; they find their way along the road graph (A* over
// traffic's intersections, driving the lane nearest the centre line, sirens on, traffic getting out of their way) and,
// close with the player in sight, steer straight for them: tailing at one star, ramming from two, boxing a slow car in
// (one across its nose, one at its tail) from three, PIT manoeuvres from four, faster with every star, with short
// "whisker" raycasts round buildings and cars and a reverse-and-retry when stuck. Officers get out when the player is on
// foot or stopped, run them down (faster at more stars), tackle a runner from two stars, and arrest them: standing
// still or knocked down beside one, or sat in a stopped car — quicker the more of them there are round the player.
// From three stars roadblocks are set across the road ahead and a helicopter circles overhead with a searchlight
// (tracking only; a car driven faster than its light can swing slips out of it). Out of the police's sight the units
// converge on where the player was heading when last seen and sweep the streets round it; new units come in round
// there too (never out of nowhere ahead of a player they have lost), and roadblocks go up only ahead of a car they can
// see. Officers on foot are game.combat's people of the police faction (never hostile: they chase and grab), else
// free-running pedestrians driven here (spawnFree).

// ---- tuning (one block) ---------------------------------------------------------------------------------------------
const POLICE = {
  maxCars: 8, // police vehicles at once (pursuit + roadblocks)
  maxOfficers: 10, // officers on foot at once
  cars: [0, 1, 2, 3, 4, 5], // pursuit vehicles per level
  suvs: [0, 0, 0, 1, 2, 3], // of which SUVs (five stars: the tactical squad's, tougher)
  crew: { car: 2, suv: 3 },
  health: { car: 150, heavy: 210 }, // vehicle health (a world vehicle's is 100: smoke under 45, stalled at 0)
  footPatrol: [0, 2, 2, 2, 2, 2], // officers sent on foot when the player is on foot (no car needed)
  firstDispatch: [0, 4.5, 2.5, 1.5, 1.2, 1], // s from reaching a level to its first new unit (one star: response time)
  dispatchEvery: 2.6, // s between two new units
  spawnMin: 95, spawnMax: 190, // m from the player, out of sight
  recycleDistance: 240, // m: a unit this far, stuck or lost, and out of sight is moved closer
  ramFrom: 2, boxFrom: 3, pitFrom: 4, tackleFrom: 2, heliFrom: 3, roadblockFrom: 3,
  roadblocks: [0, 0, 0, 1, 2, 2], roadblockEvery: 16, roadblockTime: 75,
  sight: { car: 80, foot: 60, roadblock: 70, ambient: 55, heliBeam: 13 }, // m (half when the player is "disguised")
  sightEvery: 0.25, raysPerFrame: 4,
  // driving (m/s, m/s²): chase is the pursuit speed by level (a car's top speed is 36)
  cruise: 25, chase: [0, 26, 30, 33, 35, 36], cornerSpeed: 7, cornerAngle: 0.75, brake: 6.5, wrongWay: 3,
  directRange: 60, // m: closer than this with the player in sight, steer straight for them
  deployRange: 26, // m: officers get out when the player is on foot (or stopped) this close
  regroupTime: 12, // s officers have to get back in when the player drives off (the rest stay on foot)
  tailGap: 8, // m behind at one star
  box: { slow: 9, gap: 7, range: 45 }, // boxing in: a car under `slow` m/s, a unit `gap` m off its nose / tail, within range
  whisker: { angle: 0.42, min: 8, max: 34, perSpeed: 1.1 },
  repathEvery: 0.6, pathsPerFrame: 1, maxExpand: 3000, pathEdges: 96, // A*: at most one search a frame
  stuck: { time: 1.3, reverse: 1.25, recycleAfter: 3 },
  // officers: their sprint by level (the player sprints at 7.6 for a few seconds, jogs at 4.8), the arrest: within
  // arrestRange (arrestCarRange of a car's door) for arrestTime s (plus perStar a star, plus inCar in a car), each more
  // officer within reach cutting it by `surrounded` of itself; a tackle: a running player within tackle.range of an
  // officer goes down for tackle.down s (each officer once every tackle.every s)
  footSpeed: [0, 4.6, 5.0, 5.4, 5.8, 6.2], walkSpeed: 1.5,
  arrestRange: 1.9, arrestCarRange: 3.1, arrestTime: 1.4, perStar: 0.12, inCar: 0.5, surrounded: 0.4,
  tackle: { range: 1.8, speed: 2.6, down: 1.3, every: 5, chance: [0, 0, 0.45, 0.6, 0.75, 0.9] },
  // helicopter (searchlight only): beamSpeed by level is how fast (m/s) the light can swing after a car it has lit up —
  // a car driven faster than that leaves it behind (three stars: 20, about 72 km/h)
  heli: { altitude: 48, clearRoof: 24, orbit: 32, searchOrbit: 62, speed: 30, accel: 9, spot: 7, light: 260, beamSpeed: [0, 0, 0, 20, 24, 28] }
};
const MAX_UNITS = POLICE.maxCars;
const MAX_PTS = POLICE.pathEdges * 2 + 4;
const NODE_CELL = 64;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

function registerPolice(game) {
  if (game.sandbox || !game.player || !game.vehicles || !game.world) return null;
  const world = game.world;
  const vehicles = game.vehicles;
  const fx = game.fx;
  const { trafficSystem: traffic, controllerManager: cm, cameraSystem, scene } = game.engine;
  const tg = traffic.game;
  const pedRecords = traffic.pedestrians.peds;
  const MASK = world.MASK;
  const person = cm.entities.person;

  // =================================================================================================================
  // THE ROAD GRAPH: traffic's intersections as nodes, its lane edges both ways (against a one-way street costs more)
  // =================================================================================================================
  const nodes = traffic.network.nodes;
  const edges = traffic.network.edges;
  const N = nodes.length;
  const nodeX = new Float32Array(N), nodeZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    nodeX[i] = nodes[i].x;
    nodeZ[i] = nodes[i].z;
  }
  const twin = (n, to) => n.out.some((f) => f.to === to);
  const adjStart = new Int32Array(N + 1);
  let M = 0;
  for (let i = 0; i < N; i++) {
    adjStart[i] = M;
    M += nodes[i].out.length;
    for (const e of nodes[i].in) if (!twin(nodes[i], e.from)) M++;
  }
  adjStart[N] = M;
  const adjFrom = new Int32Array(M), adjTo = new Int32Array(M), adjEdge = new Int32Array(M);
  const adjRev = new Uint8Array(M), adjCost = new Float32Array(M);
  {
    let k = 0;
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      for (const e of n.out) {
        adjFrom[k] = i;
        adjTo[k] = e.to.id;
        adjEdge[k] = e.id;
        adjRev[k] = 0;
        adjCost[k] = Math.hypot(e.to.x - n.x, e.to.z - n.z) + 4;
        k++;
      }
      for (const e of n.in) {
        if (twin(n, e.from)) continue;
        adjFrom[k] = i;
        adjTo[k] = e.from.id;
        adjEdge[k] = e.id;
        adjRev[k] = 1;
        adjCost[k] = Math.hypot(e.from.x - n.x, e.from.z - n.z) * POLICE.wrongWay + 4;
        k++;
      }
    }
  }
  // nodes in 64 m cells, for "the nodes near here"
  const nodeCells = new Map();
  const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  for (let i = 0; i < N; i++) {
    const k = cellKey(Math.floor(nodeX[i] / NODE_CELL), Math.floor(nodeZ[i] / NODE_CELL));
    let list = nodeCells.get(k);
    if (!list) nodeCells.set(k, (list = []));
    list.push(i);
  }
  const nearIdx = new Int32Array(24), nearD = new Float32Array(24);
  /** The nearest nodes to (x, z) within r, nearest first, into nearIdx / nearD (at most max): how many */
  function nearestNodes(x, z, r, max = 8) {
    let n = 0;
    const reach = Math.ceil(r / NODE_CELL);
    const cx = Math.floor(x / NODE_CELL), cz = Math.floor(z / NODE_CELL);
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iz = cz - reach; iz <= cz + reach; iz++) {
        const list = nodeCells.get(cellKey(ix, iz));
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const id = list[j];
          const d = Math.hypot(nodeX[id] - x, nodeZ[id] - z);
          if (d > r || (n === max && d >= nearD[n - 1])) continue;
          let k = n < max ? n++ : n - 1;
          while (k > 0 && nearD[k - 1] > d) {
            nearIdx[k] = nearIdx[k - 1];
            nearD[k] = nearD[k - 1];
            k--;
          }
          nearIdx[k] = id;
          nearD[k] = d;
        }
      }
    }
    return n;
  }

  // A* (allocation-free: generation stamps, a binary heap in typed arrays)
  const gScore = new Float32Array(N), viaK = new Int32Array(N), openGen = new Int32Array(N), closedGen = new Int32Array(N);
  let gen = 0;
  const heapNode = new Int32Array(M + 64), heapKey = new Float32Array(M + 64);
  let heapLen = 0;
  function heapPush(n, key) {
    let i = heapLen++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p] <= key) break;
      heapNode[i] = heapNode[p];
      heapKey[i] = heapKey[p];
      i = p;
    }
    heapNode[i] = n;
    heapKey[i] = key;
  }
  function heapPop() {
    const top = heapNode[0];
    const n = heapNode[--heapLen], key = heapKey[heapLen];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapLen) break;
      if (c + 1 < heapLen && heapKey[c + 1] < heapKey[c]) c++;
      if (heapKey[c] >= key) break;
      heapNode[i] = heapNode[c];
      heapKey[i] = heapKey[c];
      i = c;
    }
    heapNode[i] = n;
    heapKey[i] = key;
    return top;
  }
  const seedNode = new Int32Array(8), seedG = new Float32Array(8);
  const backK = new Int32Array(N);
  const pathK = new Int32Array(POLICE.pathEdges);
  let pathsThisFrame = 0;
  /** Cheapest way from the seeds to goal: adjacency entries into pathK (from the start), how many, or -1 */
  function aStar(seeds, goal) {
    gen++;
    heapLen = 0;
    const gx = nodeX[goal], gz = nodeZ[goal];
    for (let s = 0; s < seeds; s++) {
      const n = seedNode[s];
      if (openGen[n] === gen && seedG[s] >= gScore[n]) continue;
      openGen[n] = gen;
      gScore[n] = seedG[s];
      viaK[n] = -1;
      heapPush(n, seedG[s] + Math.hypot(nodeX[n] - gx, nodeZ[n] - gz));
    }
    let expanded = 0;
    let found = false;
    while (heapLen > 0) {
      const n = heapPop();
      if (closedGen[n] === gen) continue;
      closedGen[n] = gen;
      if (n === goal) {
        found = true;
        break;
      }
      if (++expanded > POLICE.maxExpand) break;
      const g0 = gScore[n];
      for (let k = adjStart[n], end = adjStart[n + 1]; k < end; k++) {
        const m = adjTo[k];
        if (closedGen[m] === gen) continue;
        const g = g0 + adjCost[k];
        if (openGen[m] === gen && g >= gScore[m]) continue;
        openGen[m] = gen;
        gScore[m] = g;
        viaK[m] = k;
        heapPush(m, g + Math.hypot(nodeX[m] - gx, nodeZ[m] - gz));
      }
    }
    if (!found) return -1;
    let count = 0;
    for (let n = goal; viaK[n] >= 0 && count < N; n = adjFrom[viaK[n]]) backK[count++] = viaK[n];
    const take = Math.min(count, POLICE.pathEdges);
    for (let i = 0; i < take; i++) pathK[i] = backK[count - 1 - i];
    return take;
  }

  // =================================================================================================================
  // THE PLAYER as the police see it, refreshed each frame
  // =================================================================================================================
  const P = { x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, fx: 0, fz: 1, inCar: false, vehicle: null, chestY: 0, still: 0, fleeT: 0 };
  function refreshPlayer(dt) {
    const pl = game.player;
    const pos = pl.position;
    const v = pl.vehicle;
    P.x = pos.x;
    P.y = pos.y;
    P.z = pos.z;
    P.vehicle = v;
    P.inCar = !!v;
    if (v) {
      P.vx = v.vx;
      P.vz = v.vz;
      P.fx = Math.sin(v.heading);
      P.fz = Math.cos(v.heading);
      P.chestY = pos.y + (v.mode === 'helicopter' ? 1.4 : 1.0);
    } else {
      P.vx = person.velX || 0;
      P.vz = person.velZ || 0;
      P.fx = Math.sin(person.heading);
      P.fz = Math.cos(person.heading);
      P.chestY = pos.y + 1.25;
    }
    P.speed = Math.hypot(P.vx, P.vz);
    P.still = P.speed < 1.2 ? P.still + dt : 0;
    P.fleeT = !v && P.speed > 3.5 ? P.fleeT + dt : Math.max(0, P.fleeT - dt);
  }
  // the pursuit speed for the level
  const chaseSpeed = () => POLICE.chase[wanted.level] || POLICE.chase[1];
  // Where the police think the player is: in their sight (or just reported), where they are and where they're going;
  // out of it, the last known position. New units, units moved up from far behind and foot patrols come in round
  // this, so a player who has lost them is not found by cars appearing out of nowhere ahead of them.
  const F = { x: 0, z: 0, vx: 0, vz: 0, speed: 0 };
  function refreshFocus() {
    const lk = wanted.lastKnown;
    if (eyes.seesPlayer || wanted.level === 0 || !(game.time - lk.at < Infinity)) {
      F.x = P.x;
      F.z = P.z;
      F.vx = P.vx;
      F.vz = P.vz;
    } else {
      F.x = lk.x;
      F.z = lk.z;
      F.vx = F.vz = 0;
    }
    F.speed = Math.hypot(F.vx, F.vz);
  }

  // =================================================================================================================
  // WANTED: what the police can see, for game/wanted.js
  // =================================================================================================================
  const eyes = {
    seesPlayer: false,
    heliUp: false,
    nearestUnit: Infinity,
    playerSpeed: 0,
    witness: (x, z, hearing) => witness(x, z, hearing),
    isCop: (pedView) => isCopPed(pedView)
  };
  const { wanted, update: updateWanted } = createWanted(game, eyes);
  game.wanted = wanted;

  // =================================================================================================================
  // UNITS: police vehicles (pursuit cars & SUVs, roadblock cars)
  // =================================================================================================================
  const units = Array.from({ length: MAX_UNITS }, (_, i) => ({
    id: i + 1, active: false, kind: 'car', v: null, state: 'idle', crew: 0, crewOut: 0, heavy: false,
    pts: new Float32Array(MAX_PTS * 2), ptsN: 0, seg: 0, goalX: 0, goalZ: 0, pathAt: -Infinity, pathFail: 0,
    tx: 0, tz: 0, searchX: 0, searchZ: 0, searchAt: 0, direct: false,
    throttle: 0, steer: 0, stuckT: 0, reverseT: 0, revSteer: 0, stuckCount: 0, stuckWindow: 0, stopT: 0, idleT: 0,
    sees: false, sightAt: 0, eyeY: 1.5, siren: false, yieldAt: 0, checkAt: 0, born: 0, regroupAt: 0,
    wC: Infinity, wL: Infinity, wR: Infinity, wSide: 0, roadblock: null, rammedAt: -Infinity,
    view: { id: i + 1, kind: 'car', x: 0, z: 0, vehicle: null, state: 'idle' }
  }));
  const officers = Array.from({ length: POLICE.maxOfficers }, (_, i) => ({
    id: 101 + i, active: false, pedId: -1, enemy: null, alertAt: 0, unit: null, state: 'idle', x: 0, y: 0, z: 0, heading: 0,
    sees: false, sightAt: 0, eyeY: 1.6, tackleAt: 0, holdX: 0, holdZ: 0, holding: false,
    wanderX: 0, wanderZ: 0, wanderAt: 0, born: 0, lostAt: 0,
    view: { id: 101 + i, kind: 'foot', x: 0, z: 0, vehicle: null, state: 'idle' }
  }));
  const roadblocks = Array.from({ length: 2 }, () => ({ active: false, x: 0, z: 0, dx: 0, dz: 1, born: 0, cars: [null, null], done: false }));

  const isCopPed = (view) => {
    if (!view) return false;
    if (game.combat?.factionOfPed?.(view.id) === 'police') return true;
    for (let i = 0; i < officers.length; i++) if (officers[i].active && officers[i].pedId === view.id) return true;
    return false;
  };

  function setSiren(u, on) {
    if (!u.v || u.siren === on) return;
    u.siren = on;
    u.v.siren = on;
    if (u.v.record) u.v.record.siren = on; // (the audio reads the drawn traffic record)
    game.emit('police:siren', { vehicle: u.v, on });
  }

  const tmpCars = [];
  const spawnPt = { x: 0, y: 0, z: 0, heading: 0, edge: null, lane: 0 };
  const losA = { x: 0, y: 0, z: 0 }, losB = { x: 0, y: 0, z: 0 };
  const losOpts = { mask: MASK.BUILDINGS, ignore: null, ignore2: null };

  // Could the camera see a car standing at (x, y, z)? (in its view and not behind a building)
  function cameraSees(x, y, z, r = 5, dist = 420) {
    if (!tg.nearView(x, z, r, dist)) return false;
    const c = cameraSystem.currentPos;
    losA.x = c.x;
    losA.y = c.y;
    losA.z = c.z;
    losB.x = x;
    losB.y = y + 1.2;
    losB.z = z;
    losOpts.mask = MASK.BUILDINGS;
    return world.lineOfSight(losA, losB, losOpts);
  }

  // Something already standing there?
  function occupied(x, z, r) {
    if (world.nearbyCars(x, z, r, tmpCars).length) return true;
    return !!vehicles.nearest(x, z, r - 2);
  }

  /**
   * A lane point minR..maxR from where the police think the player is (ahead of them when seen moving), out of the
   * camera's sight and never close to the player: spawnPt or null
   */
  function findSpawn(minR, maxR) {
    refreshFocus();
    const lead = Math.min(2.5, 60 / Math.max(1, F.speed));
    const cx = F.x + F.vx * lead, cz = F.z + F.vz * lead;
    for (let a = 0; a < 14; a++) {
      if (!world.randomRoadPoint(cx, cz, minR, maxR, spawnPt)) continue;
      const d = Math.hypot(spawnPt.x - P.x, spawnPt.z - P.z);
      if (d < minR * 0.75) continue;
      if (cameraSees(spawnPt.x, spawnPt.y, spawnPt.z)) continue;
      if (occupied(spawnPt.x, spawnPt.z, 7)) continue;
      return spawnPt;
    }
    return null;
  }

  function freeUnit() {
    for (let i = 0; i < MAX_UNITS; i++) if (!units[i].active) return units[i];
    return null;
  }

  function initUnit(u, v, kind, state) {
    u.active = true;
    u.v = v;
    u.kind = kind;
    u.state = state;
    u.heavy = kind === 'suv' && wanted.level >= 5;
    u.crew = kind === 'suv' ? POLICE.crew.suv : POLICE.crew.car;
    u.crewOut = 0;
    u.ptsN = 0;
    u.seg = 0;
    u.pathAt = -Infinity;
    u.pathFail = 0;
    u.direct = false;
    u.throttle = u.steer = 0;
    u.stuckT = u.reverseT = 0;
    u.stuckCount = 0;
    u.stuckWindow = game.time;
    u.stopT = 0;
    u.idleT = 0;
    u.sees = false;
    u.sightAt = 0;
    u.eyeY = kind === 'suv' ? 1.7 : 1.5;
    u.siren = false;
    u.yieldAt = 0;
    u.checkAt = game.time + 1;
    u.born = game.time;
    u.regroupAt = 0;
    u.roadblock = null;
    u.rammedAt = -Infinity;
    u.searchAt = 0;
    u.wC = u.wL = u.wR = Infinity;
    v.siren = false;
    if (v.record) v.record.siren = false;
    v.persistent = true;
    // (pursuit cars are built tougher than a family sedan: the tactical squad's SUVs more so)
    if (v.health >= 100) v.health = u.heavy ? POLICE.health.heavy : POLICE.health.car;
    u.view.kind = kind;
    u.view.vehicle = v;
  }

  /** A pursuit vehicle: 'car' | 'suv' at a hidden street point near the player; the unit or null */
  function spawnCar(kind) {
    const u = freeUnit();
    if (!u) return null;
    const pt = findSpawn(POLICE.spawnMin, POLICE.spawnMax);
    if (!pt) return null;
    const level = wanted.level;
    let v = vehicles.spawn(kind === 'suv' ? 'police-suv' : 'police', pt.x, pt.z, pt.heading, { persistent: true });
    if (!v) {
      kind = kind === 'suv' ? 'car' : 'suv';
      v = vehicles.spawn(kind === 'suv' ? 'police-suv' : 'police', pt.x, pt.z, pt.heading, { persistent: true });
    }
    if (!v) return null;
    placeVehicle(v, pt.x, pt.y, pt.z, pt.heading, 9);
    initUnit(u, v, kind, 'respond');
    setSiren(u, true);
    game.emit('police:dispatch', { kind, level });
    return u;
  }

  function placeVehicle(v, x, y, z, heading, speed = 0) {
    const e = v.entity;
    e.position.set(x, y, z);
    e.prevX = x;
    e.prevZ = z;
    e.heading = heading;
    e.speed = speed;
    e.vx = e.vz = e.angularVel = 0;
    v.x = x;
    v.y = y;
    v.z = z;
    v.heading = heading;
  }

  // A patrol car already in traffic near the player joins in (it was right there)
  let ambientWitness = null; // the traffic police car that last saw a crime
  let ambientWitnessAt = -Infinity;
  function convertAmbient(maxDist) {
    let best = null, bestD = maxDist;
    if (ambientWitness && game.time - ambientWitnessAt < 6 && ambientWitness.active && !ambientWitness.record.worldVehicle && ambientWitness.police) {
      best = ambientWitness;
      bestD = 0;
    }
    ambientWitness = null;
    if (!best) {
      for (let i = 0; i < ambientCount; i++) {
        const c = ambient[i];
        if (!c.active || c.record.worldVehicle || !c.police) continue;
        const d = Math.hypot(c.x - P.x, c.z - P.z);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    if (!best) return null;
    const u = freeUnit();
    if (!u) return null;
    const v = vehicles.adopt(best, { persistent: true });
    if (!v) return null;
    initUnit(u, v, v.kind === 'suv' ? 'suv' : 'car', 'respond');
    setSiren(u, true);
    game.emit('police:dispatch', { kind: u.kind, level: wanted.level });
    return u;
  }

  /** The unit lets go of its vehicle: removed (when nobody can see it go) or left where it is */
  function dropUnit(u, removeVehicle = false) {
    const v = u.v;
    if (v) {
      setSiren(u, false);
      if (v.record) v.record.siren = undefined; // (back to whatever traffic's patrol cars do)
      if (removeVehicle && v !== vehicles.current) {
        vehicles.remove(v);
      } else {
        v.persistent = false;
        if (v.driver === 'ai') vehicles.setControls(v, null);
      }
    }
    for (let i = 0; i < officers.length; i++) if (officers[i].unit === u) officers[i].unit = null;
    if (u.roadblock) {
      const rb = u.roadblock;
      if (rb.cars[0] === u) rb.cars[0] = null;
      if (rb.cars[1] === u) rb.cars[1] = null;
    }
    u.active = false;
    u.v = null;
    u.view.vehicle = null;
    u.roadblock = null;
    u.state = 'idle';
  }

  // =================================================================================================================
  // PATHS: the lane polyline from the unit to its goal
  // =================================================================================================================
  function addPt(u, x, z) {
    const n = u.ptsN;
    if (n > 0) {
      const px = u.pts[n * 2 - 2], pz = u.pts[n * 2 - 1];
      if (Math.abs(px - x) < 0.4 && Math.abs(pz - z) < 0.4) return;
    }
    if (n >= MAX_PTS) return;
    u.pts[n * 2] = x;
    u.pts[n * 2 + 1] = z;
    u.ptsN = n + 1;
  }

  function planPath(u, x, z, heading, speed, gx, gz) {
    u.pathAt = game.time;
    u.goalX = gx;
    u.goalZ = gz;
    pathsThisFrame++;
    // start from the intersections around it (those behind it cost more when it is moving)
    let count = nearestNodes(x, z, 110, 6);
    if (!count) count = nearestNodes(x, z, 320, 3);
    if (!count) {
      u.ptsN = 0;
      u.pathFail++;
      return false;
    }
    const fx = Math.sin(heading), fz = Math.cos(heading);
    for (let i = 0; i < count; i++) {
      const id = nearIdx[i];
      const d = nearD[i];
      const behind = (nodeX[id] - x) * fx + (nodeZ[id] - z) * fz < 0 && speed > 4;
      seedNode[i] = id;
      seedG[i] = behind ? d * 2 + 30 : d;
    }
    if (!nearestNodes(gx, gz, 320, 1)) {
      u.ptsN = 0;
      u.pathFail++;
      return false;
    }
    const goal = nearIdx[0];
    const goalD = nearD[0];
    const n = aStar(count, goal);
    u.ptsN = 0;
    u.seg = 0;
    if (n < 0) {
      u.pathFail++;
      return false;
    }
    u.pathFail = 0;
    addPt(u, x, z);
    for (let i = 0; i < n; i++) {
      const k = pathK[i];
      const e = edges[adjEdge[k]];
      if (!adjRev[k]) {
        const lane = e.lanes[e.lanes.length - 1];
        const ax = e.sx + e.rx * lane, az = e.sz + e.rz * lane;
        addPt(u, ax, az);
        addPt(u, ax + e.dx * e.len, az + e.dz * e.len);
      } else {
        // against a one-way street: down its middle
        addPt(u, e.sx + e.dx * e.len, e.sz + e.dz * e.len);
        addPt(u, e.sx, e.sz);
      }
    }
    if (n === 0) addPt(u, nodeX[goal], nodeZ[goal]);
    if (goalD < 40) addPt(u, gx, gz);
    return true;
  }

  // Pure pursuit along the polyline: the point `ahead` m on from the car's projection into look, the speed the
  // bends ahead allow into look.speed; returns how far off the line the car is
  const look = { x: 0, z: 0, speed: 0, end: false };
  function followPath(u, x, z, speed, ahead, cruise) {
    const pts = u.pts;
    const n = u.ptsN;
    look.end = false;
    if (n < 2) {
      look.x = u.goalX;
      look.z = u.goalZ;
      look.speed = cruise;
      look.end = true;
      return Infinity;
    }
    // the nearest point among the next few segments
    let best = Infinity, bestK = u.seg, bestT = 0;
    const last = Math.min(n - 2, u.seg + 5);
    for (let k = u.seg; k <= last; k++) {
      const ax = pts[k * 2], az = pts[k * 2 + 1];
      const sx = pts[k * 2 + 2] - ax, sz = pts[k * 2 + 3] - az;
      const len2 = sx * sx + sz * sz;
      let t = len2 > 1e-6 ? ((x - ax) * sx + (z - az) * sz) / len2 : 0;
      t = clamp(t, 0, 1);
      const qx = ax + sx * t - x, qz = az + sz * t - z;
      const d = qx * qx + qz * qz;
      if (d < best) {
        best = d;
        bestK = k;
        bestT = t * Math.sqrt(len2);
      }
    }
    u.seg = bestK;
    // the look-ahead point
    let k = bestK;
    let t = bestT;
    let remaining = ahead;
    for (;;) {
      const ax = pts[k * 2], az = pts[k * 2 + 1];
      const sx = pts[k * 2 + 2] - ax, sz = pts[k * 2 + 3] - az;
      const len = Math.hypot(sx, sz);
      if (len - t >= remaining || k >= n - 2) {
        const s = len > 1e-6 ? Math.min(len, t + remaining) / len : 0;
        look.x = ax + sx * s;
        look.z = az + sz * s;
        if (k >= n - 2 && len - t < remaining) look.end = true;
        break;
      }
      remaining -= len - t;
      t = 0;
      k++;
    }
    // the bends ahead: the speed each allows, less what braking from here can shed before it
    let allowed = cruise;
    let dist = 0;
    let px = pts[bestK * 2 + 2] - pts[bestK * 2], pz = pts[bestK * 2 + 3] - pts[bestK * 2 + 1];
    let pl = Math.hypot(px, pz) || 1;
    dist = pl - bestT;
    for (let j = bestK + 1; j <= n - 2 && dist < 90; j++) {
      const sx = pts[j * 2 + 2] - pts[j * 2], sz = pts[j * 2 + 3] - pts[j * 2 + 1];
      const sl = Math.hypot(sx, sz);
      if (sl < 0.3) continue;
      const cos = (px * sx + pz * sz) / (pl * sl);
      const angle = Math.acos(clamp(cos, -1, 1));
      if (angle > 0.12) {
        const v = cruise + (POLICE.cornerSpeed - cruise) * clamp(angle / POLICE.cornerAngle, 0, 1);
        allowed = Math.min(allowed, Math.sqrt(v * v + 2 * POLICE.brake * Math.max(0, dist - 3)));
      }
      px = sx;
      pz = sz;
      pl = sl;
      dist += sl;
    }
    look.speed = allowed;
    return Math.sqrt(best);
  }

  // =================================================================================================================
  // DRIVING
  // =================================================================================================================
  const rayO = { x: 0, y: 0, z: 0 }, rayD = { x: 0, y: 0, z: 0 };
  const rayOpts = { mask: MASK.BUILDINGS | MASK.VEHICLES, ignore: null, ignore2: null };

  // Two short rays a frame (straight ahead, and one side in turn) from the front bumper
  function whiskers(u, e, speed, aimAngle, ram) {
    const h = e.heading + aimAngle * 0.5;
    const len = clamp(POLICE.whisker.min + Math.abs(speed) * POLICE.whisker.perSpeed, POLICE.whisker.min, POLICE.whisker.max);
    const fx = Math.sin(e.heading), fz = Math.cos(e.heading);
    rayO.x = e.position.x + fx * (u.v.halfL - 0.2);
    rayO.y = e.position.y + 0.75;
    rayO.z = e.position.z + fz * (u.v.halfL - 0.2);
    rayOpts.ignore = u.v;
    rayOpts.ignore2 = ram ? P.vehicle : null;
    rayD.x = Math.sin(h);
    rayD.y = 0;
    rayD.z = Math.cos(h);
    const hc = world.raycast(rayO, rayD, len, rayOpts);
    u.wC = hc ? hc.distance : Infinity;
    u.wSide ^= 1;
    const side = u.wSide ? 1 : -1; // +1 left
    const hs = h + side * POLICE.whisker.angle;
    rayD.x = Math.sin(hs);
    rayD.z = Math.cos(hs);
    const hh = world.raycast(rayO, rayD, len * 0.8, rayOpts);
    if (side > 0) u.wL = hh ? hh.distance : Infinity;
    else u.wR = hh ? hh.distance : Infinity;
    return len;
  }

  // Steer for (tx, tz) at targetSpeed with whiskers and un-sticking: the vehicle's controls
  function drive(u, dt, tx, tz, targetSpeed, ram) {
    const v = u.v, e = v.entity;
    const x = e.position.x, z = e.position.z;
    const speed = e.speed || 0;
    const fx = Math.sin(e.heading), fz = Math.cos(e.heading);
    const dx = tx - x, dz = tz - z;
    // + to the left: the car's left is (cos h, -sin h)
    const angle = Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
    let steer = clamp(angle * 2.4, -1, 1);
    // a target well off to the side or behind: slow for the turn
    const top = chaseSpeed();
    const turnLimit = top + (6 - top) * clamp((Math.abs(angle) - 0.3) / 1.1, 0, 1);
    let want = Math.min(targetSpeed, turnLimit);
    if (u.reverseT > 0) {
      // backing out of a jam: the other lock, then a fresh path
      u.reverseT -= dt;
      vehicles.setControls(v, -0.85, u.revSteer);
      if (u.reverseT <= 0) u.pathAt = -Infinity;
      return;
    }
    if (dt > 0 && (Math.abs(speed) > 1.5 || want > 3)) {
      const len = whiskers(u, e, speed, angle, ram);
      const half = len * 0.55;
      if (u.wL < half) steer -= (1 - u.wL / half) * 0.9;
      if (u.wR < half) steer += (1 - u.wR / half) * 0.9;
      if (u.wC < len) {
        const block = 1 - u.wC / len;
        // round the obstacle on the freer side
        steer += (u.wL > u.wR ? 1 : -1) * block * 1.2;
        const stop = Math.max(0, u.wC - 4);
        want = Math.min(want, Math.sqrt(2 * POLICE.brake * stop) + 2);
      }
      steer = clamp(steer, -1, 1);
    }
    const err = want - speed;
    let throttle = err > 0 ? clamp(err / 3, 0.2, 1) : clamp(err / 4, -1, 0);
    if (want < 0.3 && Math.abs(speed) < 0.4) throttle = 0;
    // stuck: wanting to go, not going
    if (throttle > 0.3 && Math.abs(speed) < 1.0) {
      u.stuckT += dt;
      if (u.stuckT > POLICE.stuck.time) {
        u.stuckT = 0;
        u.reverseT = POLICE.stuck.reverse + Math.random() * 0.5;
        u.revSteer = steer >= 0 ? -1 : 1;
        if (game.time - u.stuckWindow > 25) {
          u.stuckWindow = game.time;
          u.stuckCount = 0;
        }
        u.stuckCount++;
      }
    } else {
      u.stuckT = Math.max(0, u.stuckT - dt * 0.5);
    }
    // backwards (the reverse of a turn) the wheel turns the other way
    if (speed < -0.5) steer = -steer;
    u.throttle = throttle;
    u.steer = steer;
    vehicles.setControls(v, throttle, steer);
  }

  // Sirens clear the road: cars ahead going the same way floor it, the others stop
  function yieldTraffic(u) {
    const e = u.v.entity;
    const fx = Math.sin(e.heading), fz = Math.cos(e.heading);
    world.nearbyCars(e.position.x, e.position.z, 42, tmpCars);
    for (let i = 0; i < tmpCars.length; i++) {
      const c = tmpCars[i];
      if (c.kind === 'bus' && c.speed > 2) continue;
      const rx = c.x - e.position.x, rz = c.z - e.position.z;
      const ahead = rx * fx + rz * fz;
      const lateral = Math.abs(rx * fz - rz * fx);
      const dot = Math.sin(c.heading) * fx + Math.cos(c.heading) * fz;
      if (ahead <= 0 || lateral > 7) continue;
      // in front going its way, or crossing in front: get going (out of the way); coming at it in its lane: stop
      if (dot > 0.5 || (dot > -0.5 && ahead < 30)) tg.scare(c.record, 2.2, true);
      else if (lateral < 3.5) tg.stop(c.record, 2.5);
    }
  }

  // Where a unit heads: the player when the police can see them, else the last known position and the streets round it
  // where the player was heading when last seen (a guess at where they went, the further the more stars)
  const lastHeading = { vx: 0, vz: 0 };
  const GUESS = [0, 2, 3, 4, 5, 6]; // s of the last seen velocity carried on
  function guessX() {
    const lk = wanted.lastKnown;
    return lk.x + lastHeading.vx * Math.min(GUESS[wanted.level] || 0, Math.max(0, game.time - lk.at));
  }
  function guessZ() {
    const lk = wanted.lastKnown;
    return lk.z + lastHeading.vz * Math.min(GUESS[wanted.level] || 0, Math.max(0, game.time - lk.at));
  }

  function chooseTarget(u, seen) {
    if (seen) {
      u.tx = P.x;
      u.tz = P.z;
      u.searchAt = 0;
      return;
    }
    const e = u.v.entity;
    const gx = guessX(), gz = guessZ();
    const dLk = Math.hypot(e.position.x - gx, e.position.z - gz);
    if (u.searchAt === 0 && dLk > 30) {
      u.tx = gx;
      u.tz = gz;
      return;
    }
    // sweep: a street corner round where they think the player went, the next once there (or after a while)
    const reached = Math.hypot(e.position.x - u.searchX, e.position.z - u.searchZ) < 18;
    if (u.searchAt === 0 || reached || game.time - u.searchAt > 22) {
      const r = 50 + 25 * wanted.level;
      const n = nearestNodes(gx + (Math.random() - 0.5) * r * 1.6, gz + (Math.random() - 0.5) * r * 1.6, r, 6);
      if (n) {
        const id = nearIdx[Math.floor(Math.random() * n)];
        u.searchX = nodeX[id];
        u.searchZ = nodeZ[id];
      } else {
        u.searchX = gx;
        u.searchZ = gz;
      }
      u.searchAt = game.time;
    }
    u.tx = u.searchX;
    u.tz = u.searchZ;
  }

  function updateUnit(u, dt) {
    const v = u.v;
    // gone, wrecked or stolen
    if (!v || v.hidden || !vehicles.list().includes(v)) {
      dropUnit(u, false);
      return;
    }
    if (v === vehicles.current) {
      dropUnit(u, false);
      return;
    }
    if (v.state === 'wrecked') {
      if (u.state !== 'roadblock' && u.state !== 'stopped' && u.crew > 0 && wanted.level > 0) deployCrew(u, true);
      dropUnit(u, false);
      return;
    }
    const e = v.entity;
    const x = e.position.x, z = e.position.z;
    const d = Math.hypot(P.x - x, P.z - z);
    const level = wanted.level;
    u.view.x = x;
    u.view.z = z;
    u.view.state = u.state;
    if (u.state === 'roadblock') {
      vehicles.setControls(v, 0, 0);
      return;
    }
    // housekeeping once a second: out of sight and far, lost or stuck: closer (or gone when standing down)
    if (game.time >= u.checkAt) {
      u.checkAt = game.time + 1;
      const unseen = !cameraSees(x, e.position.y, z, 6, 500);
      if (u.state === 'return') {
        if (unseen && (d > 90 || game.time - u.born > 120)) {
          dropUnit(u, true);
          return;
        }
      } else if (unseen && (refreshFocus(), Math.hypot(F.x - x, F.z - z)) > POLICE.recycleDistance * 0.6
        && (u.stuckCount >= POLICE.stuck.recycleAfter || u.pathFail > 2 || Math.hypot(F.x - x, F.z - z) > POLICE.recycleDistance)) {
        // (far behind, lost or stuck, and out of sight: brought up to where the police think the player is)
        const pt = findSpawn(POLICE.spawnMin, POLICE.spawnMax);
        if (pt) {
          placeVehicle(v, pt.x, pt.y, pt.z, pt.heading, 8);
          u.ptsN = 0;
          u.pathAt = -Infinity;
          u.stuckCount = 0;
          u.pathFail = 0;
          u.reverseT = 0;
        }
      }
    }
    if (u.state === 'return') {
      setSiren(u, false);
      if (u.ptsN < 2 && game.time - u.pathAt > 3 && pathsThisFrame < POLICE.pathsPerFrame) planPath(u, x, z, e.heading, e.speed, u.goalX, u.goalZ);
      if (u.ptsN >= 2) {
        followPath(u, x, z, e.speed, clamp(6 + Math.abs(e.speed) * 0.55, 7, 20), 14);
        drive(u, dt, look.x, look.z, look.end ? 0 : look.speed, false);
      } else {
        drive(u, dt, x + Math.sin(e.heading) * 10, z + Math.cos(e.heading) * 10, 0, false);
      }
      return;
    }
    if (u.state === 'stopped') {
      // parked, officers out: back in and away when the player drives off (or the crew is all down)
      updateStopped(u, d);
      return;
    }

    const seen = eyes.seesPlayer;
    chooseTarget(u, seen);
    setSiren(u, level > 0);
    if (u.siren && game.time >= u.yieldAt) {
      u.yieldAt = game.time + 0.4;
      yieldTraffic(u);
    }
    u.state = seen ? 'pursue' : 'search';
    // close and the player on foot (or stopped): stop, officers out
    const playerStopped = P.inCar && P.speed < 1.5 && P.still > 1.2;
    const deployAt = P.inCar ? POLICE.tailGap + 4 : POLICE.deployRange; // (pull up behind a stopped car first)
    if (u.sees && d < deployAt && (!P.inCar || playerStopped || P.vehicle?.mode === 'helicopter' && P.y - e.position.y < 4)) {
      u.stopT += dt;
      drive(u, dt, P.x, P.z, 0, false);
      if (Math.abs(e.speed) < 1.6 || u.stopT > 2.5) {
        deployCrew(u, false);
      }
      return;
    }
    u.stopT = 0;
    // straight for them: in sight and close
    u.direct = u.sees && d < POLICE.directRange && Math.abs(P.y - e.position.y) < 6;
    if (u.direct) {
      const ram = level >= POLICE.ramFrom && P.inCar && P.speed > 3;
      let tx = P.x, tz = P.z, want;
      // coming at them head-on: stop across their path instead (they swerve or hit a parked car, not a 70 km/h one)
      const headOn = P.inCar && P.speed > 5 && (Math.sin(e.heading) * P.fx + Math.cos(e.heading) * P.fz) < -0.5
        && (x - P.x) * P.fx + (z - P.z) * P.fz > 0;
      const cooling = game.time - u.rammedAt < (level >= POLICE.pitFrom ? 1.5 : 2.6);
      if (headOn && d < 45) {
        drive(u, dt, tx, tz, 0, false);
        return;
      }
      // boxing in (three stars on): a slow car gets a unit across its nose and one at its tail; once it stops, their
      // crews come out (above) while it is penned in
      if (level >= POLICE.boxFrom && P.inCar && P.vehicle?.mode === 'car' && P.speed < POLICE.box.slow && d < POLICE.box.range) {
        const sgn = (u.id & 1) === 1 ? 1 : -1; // (odd units take the nose, even ones the tail)
        const lead = Math.min(1.2, P.speed * 0.15);
        tx = P.x + P.fx * sgn * POLICE.box.gap + P.vx * lead;
        tz = P.z + P.fz * sgn * POLICE.box.gap + P.vz * lead;
        const dBox = Math.hypot(tx - x, tz - z);
        drive(u, dt, tx, tz, dBox < 3 ? 0 : clamp(dBox * 0.9, 3, chaseSpeed()), false);
        return;
      }
      if (ram && cooling) {
        // just rammed: drop back a little before the next one
        want = Math.max(0, P.speed - 2 + (d - 12) * 0.5);
        tx = P.x - P.fx * 10;
        tz = P.z - P.fz * 10;
      } else if (ram) {
        // lead the target by how long it takes to get there
        const closing = Math.max(6, Math.abs(e.speed));
        const lead = clamp(d / closing, 0, 1.2);
        tx += P.vx * lead;
        tz += P.vz * lead;
        want = Math.min(chaseSpeed(), P.speed + (level >= POLICE.pitFrom ? 10 : 6));
        if (level >= POLICE.pitFrom && P.speed > 8) {
          // PIT: come up beside the rear quarter, then turn in
          const along = (x - P.x) * P.fx + (z - P.z) * P.fz;
          const side = (x - P.x) * P.fz - (z - P.z) * P.fx > 0 ? 1 : -1; // which side of the player it is on
          const sx = P.fz * side, sz = -P.fx * side;
          if (along < -3) {
            tx = P.x - P.fx * 1.6 + sx * 1.6 + P.vx * 0.4;
            tz = P.z - P.fz * 1.6 + sz * 1.6 + P.vz * 0.4;
            want = P.speed + 4;
          } else {
            tx = P.x - P.fx * 1.8 - sx * 1.2 + P.vx * 0.3;
            tz = P.z - P.fz * 1.8 - sz * 1.2 + P.vz * 0.3;
            want = P.speed + 2;
          }
        }
      } else {
        // tail them (one star, or the player on foot further away)
        want = clamp((d - POLICE.tailGap) * 1.1, 0, chaseSpeed()) + (P.inCar ? P.speed * 0.9 : 0);
      }
      drive(u, dt, tx, tz, want, ram);
      return;
    }
    // along the streets
    const moved = Math.hypot(u.tx - u.goalX, u.tz - u.goalZ);
    const off = u.ptsN >= 2 ? followPath(u, x, z, e.speed, 10, POLICE.cruise) : Infinity;
    const due = game.time - u.pathAt > POLICE.repathEvery;
    if (due && pathsThisFrame < POLICE.pathsPerFrame && (u.ptsN < 2 || moved > 18 || off > 14 || look.end)) {
      planPath(u, x, z, e.heading, e.speed, u.tx, u.tz);
    }
    if (u.ptsN < 2) {
      // no path (yet): head for it directly
      drive(u, dt, u.tx, u.tz, Math.min(POLICE.cruise * 0.6, Math.max(0, Math.hypot(u.tx - x, u.tz - z) - 6)), false);
      return;
    }
    const cruise = d > 160 ? chaseSpeed() : Math.min(POLICE.cruise, chaseSpeed());
    followPath(u, x, z, e.speed, clamp(6 + Math.abs(e.speed) * 0.55, 7, 22), cruise);
    const endGap = look.end ? Math.hypot(look.x - x, look.z - z) : Infinity;
    drive(u, dt, look.x, look.z, look.end ? Math.min(look.speed, Math.max(0, endGap - 4)) : look.speed, false);
    // as close as the streets go to where they were last seen: sweep the streets round it from here, and with the
    // player on foot somewhere near (a plaza, a park, a courtyard), out and look on foot
    if (!seen && look.end && endGap < 10 && Math.abs(e.speed) < 2) {
      if (u.searchAt === 0) u.searchAt = 1;
      u.idleT += dt;
      if (!P.inCar && d < 70 && u.crew > 0 && u.idleT > 1.5 && level > 0) deployCrew(u, false);
    } else {
      u.idleT = 0;
    }
  }

  // Officers out: a pair (three from an SUV) from the doors
  function deployCrew(u, bail) {
    const v = u.v;
    if (!v || u.crew <= 0) return;
    const e = v.entity;
    const h = e.heading, s = Math.sin(h), c = Math.cos(h);
    let out = 0;
    for (let i = 0; i < u.crew; i++) {
      // doors: driver (right), passenger (left), behind them
      const lx = (i % 2 === 0 ? -1 : 1) * (v.halfW + 0.6);
      const lz = i < 2 ? 0.3 : -1.0;
      const ox = e.position.x + lx * c + lz * s;
      const oz = e.position.z - lx * s + lz * c;
      if (spawnOfficer(ox, oz, u)) out++;
    }
    u.crewOut = out;
    u.crew -= out;
    if (!bail) {
      u.state = 'stopped';
      u.view.state = 'stopped';
      u.regroupAt = 0;
      vehicles.setControls(v, null);
      setSiren(u, false);
    }
  }

  function updateStopped(u, d) {
    let alive = 0, aboard = 0;
    for (let i = 0; i < officers.length; i++) {
      const o = officers[i];
      if (!o.active || o.unit !== u) continue;
      alive++;
    }
    aboard = u.crew;
    const away = wanted.level === 0 || (P.inCar && P.speed > 6 && d > 35) || d > 70;
    if (away) {
      if (!u.regroupAt) {
        u.regroupAt = game.time;
        for (let i = 0; i < officers.length; i++) if (officers[i].active && officers[i].unit === u) officers[i].state = 'board';
      }
      if (alive === 0 || game.time - u.regroupAt > POLICE.regroupTime) {
        // whoever is not back by now stays on foot
        for (let i = 0; i < officers.length; i++) if (officers[i].active && officers[i].unit === u) officers[i].unit = null;
        if (aboard > 0) {
          u.state = wanted.level > 0 ? 'respond' : 'return';
          u.regroupAt = 0;
          u.ptsN = 0;
          u.pathAt = -Infinity;
          if (u.state === 'return') pickReturnGoal(u);
        } else {
          dropUnit(u, false); // an abandoned patrol car (the player may take it)
        }
      }
    } else {
      if (u.regroupAt) {
        // (they came back: as you were)
        u.regroupAt = 0;
        for (let i = 0; i < officers.length; i++) if (officers[i].active && officers[i].unit === u && officers[i].state === 'board') officers[i].state = 'search';
      }
      if (alive === 0 && aboard === 0) dropUnit(u, false);
    }
  }

  function pickReturnGoal(u) {
    const e = u.v.entity;
    let ax = e.position.x - P.x, az = e.position.z - P.z;
    const l = Math.hypot(ax, az) || 1;
    ax /= l;
    az /= l;
    u.goalX = e.position.x + ax * 300;
    u.goalZ = e.position.z + az * 300;
    u.ptsN = 0;
    u.pathAt = -Infinity;
  }

  // =================================================================================================================
  // OFFICERS ON FOOT
  // =================================================================================================================
  const combat = () => (game.combat && typeof game.combat.spawnEnemy === 'function' ? game.combat : null);

  function freeOfficer() {
    for (let i = 0; i < officers.length; i++) if (!officers[i].active) return officers[i];
    return null;
  }

  function spawnOfficer(x, z, unit, announce = false, post = false) {
    const o = freeOfficer();
    if (!o) return null;
    const dx = P.x - x, dz = P.z - z;
    const l = Math.hypot(dx, dz) || 1;
    const c = combat();
    let id = -1, enemy = null;
    if (c) {
      // one of game.combat's people, of the police: the footwork is theirs, the orders ours; never hostile (they
      // carry nothing and swing at nobody), they chase and grab
      enemy = c.spawnEnemy({
        x, z, heading: Math.atan2(dx, dz), weaponId: 'fist', health: 100, aggroRange: 55,
        faction: 'police', hostile: false, chase: false, pace: 'run', runSpeed: officerSpeed()
      });
      if (!enemy) return null;
      id = enemy.pedId;
      if (!post) enemy.goto(wanted.lastKnown.x, wanted.lastKnown.z);
    } else {
      // run off towards the player (spawnFree runs away from the "from" point: put it behind)
      id = world.spawnFleeingPed(x, z, x - (dx / l) * 5, z - (dz / l) * 5, 1e6);
      if (id < 0) return null;
    }
    o.active = true;
    o.pedId = id;
    o.enemy = enemy;
    o.alertAt = 0;
    o.unit = unit;
    o.state = post ? 'post' : 'approach';
    o.x = x;
    o.z = z;
    o.y = world.groundHeight(x, z);
    o.sees = false;
    o.sightAt = 0;
    o.tackleAt = game.time + 1.5;
    o.holding = false;
    o.wanderAt = 0;
    o.born = game.time;
    o.lostAt = 0;
    if (!enemy) pedRecords[id].freeUntil = tg.clock + 1e6;
    o.view.vehicle = null;
    if (announce) game.emit('police:dispatch', { kind: 'foot', level: wanted.level });
    return o;
  }
  const officerSpeed = () => POLICE.footSpeed[wanted.level] || POLICE.footSpeed[1];

  function releaseOfficer(o, vanish = false) {
    if (!o.active) return;
    const p = o.pedId >= 0 ? pedRecords[o.pedId] : null;
    if (o.enemy) {
      const en = o.enemy;
      if (vanish && en.alive && p && p.placed && !p.dead) {
        // (into the car: gone on the spot, seen or not)
        p.rig.aimWeight = 0;
        p.puppet = false;
        p.free = false;
        p.placed = false;
        p.rig.placed = false;
      }
      en.remove();
      o.enemy = null;
    } else if (p && p.free && !p.dead) {
      p.rig.aimWeight = 0;
      if (vanish) {
        p.free = false;
        p.placed = false;
        p.rig.placed = false;
      } else {
        // walks off and is taken back by the crowd once out of sight
        p.freeUntil = tg.clock;
        p.fleeX = P.x;
        p.fleeZ = P.z;
      }
    } else if (p && p.dead) {
      p.rig.aimWeight = 0;
    }
    o.active = false;
    o.pedId = -1;
    o.unit = null;
    o.state = 'idle';
  }

  /** A foot patrol: officers coming round a corner on foot (the player on foot) */
  function spawnFootPatrol(n) {
    // a footpath point 45-80 m from where the police think the player is (and not near the player), out of the
    // camera's sight
    refreshFocus();
    for (let a = 0; a < 10; a++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 45 + Math.random() * 35;
      const x = F.x + Math.cos(ang) * r, z = F.z + Math.sin(ang) * r;
      if (Math.hypot(x - P.x, z - P.z) < 40) continue;
      if (!cm.isClear(x, z, world.groundHeight(x, z), 0.5)) continue;
      if (cameraSees(x, world.groundHeight(x, z), z, 2, 300)) continue;
      let made = 0;
      for (let i = 0; i < n; i++) if (spawnOfficer(x + i * 1.2, z + i * 0.8, null, i === 0)) made++;
      return made;
    }
    return 0;
  }

  // What an officer should be doing: 'board' (back into the car), 'arrest' (in sight: after them, hands on), 'post'
  // (a roadblock's, out of sight: stay put) or 'search' (out of sight: where the player was last seen)
  function officerMode(o, seen) {
    if (o.state === 'board') return 'board';
    if (seen) return 'arrest';
    return o.unit?.state === 'roadblock' ? 'post' : 'search';
  }

  // A tackle: an officer within reach of a player running on foot brings them down (from tackleFrom stars, once every
  // few seconds each, more likely at more stars); the arrest can follow while they're down
  const tackleCall = ['Gotcha!', 'Down you go!', 'Not so fast, mate.', 'Stop resisting!'];
  function tryTackle(o, d) {
    const level = wanted.level;
    const pl = game.player;
    if (level < POLICE.tackleFrom || P.inCar || !pl.alive || pl.knockedDown || game.time < o.tackleAt) return;
    if (d > POLICE.tackle.range || P.speed < POLICE.tackle.speed) return;
    o.tackleAt = game.time + POLICE.tackle.every;
    if (Math.random() > POLICE.tackle.chance[level]) return;
    const dx = P.x - o.x, dz = P.z - o.z;
    const l = Math.hypot(dx, dz) || 1;
    pl.knockDown(dx / l, dz / l, POLICE.tackle.down);
    game.emit('police:tackle', { x: P.x, z: P.z, level });
    game.ui?.subtitle?.('Constable', tackleCall[Math.floor(Math.random() * tackleCall.length)], 1.6);
  }

  // An officer who is one of game.combat's people: orders through chase / goto / alert (never hostile)
  function updateCombatOfficer(o, dt) {
    const en = o.enemy;
    if (!en.alive || en.removed) {
      o.active = false;
      o.enemy = null;
      o.pedId = -1;
      o.unit = null;
      return;
    }
    o.x = en.x;
    o.z = en.z;
    o.y = en.y;
    const level = wanted.level;
    if (level === 0) {
      if (o.unit && o.unit.active && o.unit.state === 'stopped') o.state = 'board';
      else {
        releaseOfficer(o, false);
        return;
      }
    }
    en.runSpeed = officerSpeed();
    if (en.hostile) en.setHostile(false);
    const d = Math.hypot(P.x - o.x, P.z - o.z);
    const seen = o.sees || en.seesPlayer;
    const mode = officerMode(o, seen);
    if (mode === 'board') {
      const u = o.unit;
      if (!u || !u.active || !u.v) {
        o.state = 'search';
        return;
      }
      const e = u.v.entity;
      const bx = e.position.x - Math.cos(e.heading) * (u.v.halfW + 0.6), bz = e.position.z + Math.sin(e.heading) * (u.v.halfW + 0.6);
      const db = Math.hypot(bx - o.x, bz - o.z);
      // at the door (or nobody watching): in
      if (db < 1.8 || (db < 45 && !cameraSees(o.x, o.y, o.z, 2, 200))) {
        u.crew++;
        releaseOfficer(o, true);
        return;
      }
      en.chase = false;
      en.goto(bx, bz);
      o.state = 'board';
    } else if (mode === 'arrest') {
      en.chase = true;
      o.state = 'arrest';
      tryTackle(o, d);
    } else {
      // out of sight: to where the player was last seen (roadblock officers stay put, watching: police.js's own sight
      // rays spot the player for them)
      en.chase = mode !== 'post';
      o.state = mode;
      if (o.state === 'search' && game.time >= o.alertAt && en.state !== 'engage') {
        const lk = wanted.lastKnown;
        o.alertAt = game.time + 8;
        en.goto(lk.x + (Math.random() - 0.5) * 20, lk.z + (Math.random() - 0.5) * 20);
        en.alert(lk.x, lk.z);
      }
      // far behind and out of sight: gone (a fresh one comes if needed; roadblock officers go with their roadblock)
      if (o.state === 'search' && d > 160 && !cameraSees(o.x, o.y, o.z, 2, 200)) {
        releaseOfficer(o, true);
        return;
      }
    }
    o.view.x = o.x;
    o.view.z = o.z;
    o.view.state = o.state;
    void dt;
  }

  // An officer without game.combat: a free runner steered here
  function updateOfficer(o, dt) {
    if (o.enemy) {
      updateCombatOfficer(o, dt);
      return;
    }
    const p = pedRecords[o.pedId];
    const view = world.peds[o.pedId];
    if (!p || !p.placed || !p.free || p.dead) {
      // down (lies where they fell), or taken back by the crowd
      if (p) p.rig.aimWeight = 0;
      o.active = false;
      o.pedId = -1;
      o.unit = null;
      return;
    }
    o.x = p.x;
    o.z = p.z;
    o.y = view.y;
    const level = wanted.level;
    const dx = P.x - o.x, dz = P.z - o.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    let gx = o.x, gz = o.z; // where to go
    let speed = 0;
    let faceX = dx / d, faceZ = dz / d;
    if (level === 0) {
      // standing down: back to the car, or off
      if (o.unit && o.unit.active && o.unit.state === 'stopped') o.state = 'board';
      else {
        releaseOfficer(o, false);
        return;
      }
    }
    if (o.state === 'board') {
      const u = o.unit;
      if (!u || !u.active || !u.v) {
        o.state = 'search';
      } else {
        const e = u.v.entity;
        const bx = e.position.x - Math.cos(e.heading) * (u.v.halfW + 0.6), bz = e.position.z + Math.sin(e.heading) * (u.v.halfW + 0.6);
        const db = Math.hypot(bx - o.x, bz - o.z);
        if (db < 1.6 || Math.hypot(e.position.x - o.x, e.position.z - o.z) < u.v.halfW + 1.1) {
          u.crew++;
          releaseOfficer(o, true);
          return;
        }
        gx = bx;
        gz = bz;
        speed = officerSpeed();
        faceX = (bx - o.x) / db;
        faceZ = (bz - o.z) / db;
      }
    }
    if (o.state !== 'board') {
      const mode = officerMode(o, o.sees);
      if (o.sees) {
        o.lostAt = 0;
        o.state = mode;
      } else if (mode === 'post') {
        o.state = 'post'; // (roadblock officers keep their post)
      } else if (o.state !== 'search' && o.state !== 'approach') {
        if (!o.lostAt) o.lostAt = game.time;
        if (game.time - o.lostAt > 1.5) {
          o.state = 'search';
          o.wanderAt = 0;
        }
      }
      if (o.state === 'arrest') {
        let tx = P.x, tz = P.z, stopAt = POLICE.arrestRange * 0.7;
        if (P.inCar && P.vehicle) {
          const v = P.vehicle, h = v.heading;
          tx = P.x - Math.cos(h) * (v.halfW + 0.7);
          tz = P.z + Math.sin(h) * (v.halfW + 0.7);
          stopAt = 0.6;
        }
        const dt2 = Math.hypot(tx - o.x, tz - o.z);
        gx = tx;
        gz = tz;
        speed = dt2 > stopAt ? Math.min(officerSpeed(), dt2 * 3) : 0;
        if (dt2 > stopAt) {
          faceX = (tx - o.x) / dt2;
          faceZ = (tz - o.z) / dt2;
        }
        tryTackle(o, d);
      } else if (o.state === 'search' || o.state === 'approach') {
        // to the last known position, then about it
        const lk = wanted.lastKnown;
        if (o.state === 'approach') {
          gx = lk.x;
          gz = lk.z;
          if (Math.hypot(lk.x - o.x, lk.z - o.z) < 6) o.state = 'search';
        } else {
          if (!o.wanderAt || game.time > o.wanderAt || Math.hypot(o.wanderX - o.x, o.wanderZ - o.z) < 2) {
            o.wanderX = lk.x + (Math.random() - 0.5) * 40;
            o.wanderZ = lk.z + (Math.random() - 0.5) * 40;
            o.wanderAt = game.time + 6;
          }
          gx = o.wanderX;
          gz = o.wanderZ;
        }
        const dg = Math.hypot(gx - o.x, gz - o.z);
        speed = dg > 1.5 ? (o.state === 'approach' ? officerSpeed() : 2.6) : 0;
        if (dg > 0.5) {
          faceX = (gx - o.x) / dg;
          faceZ = (gz - o.z) / dg;
        }
        // far behind and out of sight: gone (a fresh one comes if needed)
        if (d > 160 && !cameraSees(o.x, o.y, o.z, 2, 200)) {
          releaseOfficer(o, true);
          return;
        }
      }
    }
    // steer the free runner: its velocity along (gx, gz) at `speed`; standing: held in place facing the player
    let mx = gx - o.x, mz = gz - o.z;
    const ml = Math.hypot(mx, mz);
    if (speed > 0.05 && ml > 0.2) {
      mx /= ml;
      mz /= ml;
      o.holding = false;
      p.freeVX = mx * speed;
      p.freeVZ = mz * speed;
      p.fleeX = p.x - mx * 6;
      p.fleeZ = p.z - mz * 6;
      o.heading = Math.atan2(mx, mz);
    } else {
      if (!o.holding) {
        o.holding = true;
        o.holdX = p.x;
        o.holdZ = p.z;
      }
      p.x = o.holdX;
      p.z = o.holdZ;
      p.freeVX = faceX * 0.02;
      p.freeVZ = faceZ * 0.02;
      p.fleeX = p.x - faceX * 6;
      p.fleeZ = p.z - faceZ * 6;
      o.heading = Math.atan2(faceX, faceZ);
    }
    p.freeUntil = tg.clock + 1e6;
    p.rig.aimWeight = 0;
    o.view.x = o.x;
    o.view.z = o.z;
    o.view.state = o.state;
  }

  // =================================================================================================================
  // ARRESTS
  // =================================================================================================================
  let arrestT = 0;
  let lastShout = -Infinity;
  function updateArrest(dt) {
    const level = wanted.level;
    if (level === 0 || !game.player.alive || game.state !== 'playing') {
      arrestT = 0;
      wanted.arrestProgress = 0;
      wanted.arrestOfficers = 0;
      return;
    }
    // the nearest officer, and how many are within reach (each more one quickens the arrest: surrounded)
    let near = Infinity, around = 0;
    for (let i = 0; i < officers.length; i++) {
      const o = officers[i];
      if (!o.active || o.state === 'board') continue;
      let d;
      if (P.inCar && P.vehicle) {
        const v = P.vehicle, h = v.heading;
        const doorX = P.x - Math.cos(h) * (v.halfW + 0.7), doorZ = P.z + Math.sin(h) * (v.halfW + 0.7);
        d = Math.min(Math.hypot(doorX - o.x, doorZ - o.z), Math.hypot(P.x - o.x, P.z - o.z) - v.halfW) - (POLICE.arrestCarRange - POLICE.arrestRange);
      } else {
        d = Math.hypot(P.x - o.x, P.z - o.z);
      }
      if (d < near) near = d;
      if (d < POLICE.arrestRange + 0.6) around++;
    }
    const knocked = game.player.knockedDown;
    let can;
    if (P.inCar) can = P.vehicle && P.vehicle.mode === 'car' && P.speed < 1.0 && near < POLICE.arrestRange;
    else can = near < POLICE.arrestRange && (P.speed < 1.6 || knocked);
    const time = (POLICE.arrestTime + POLICE.perStar * level + (P.inCar ? POLICE.inCar : 0)) / (1 + POLICE.surrounded * Math.max(0, Math.min(3, around) - 1));
    if (can) {
      arrestT += dt;
      if (game.time - lastShout > 6) {
        lastShout = game.time;
        game.ui?.subtitle?.('Constable', P.inCar ? 'Out of the car! Hands where I can see them!' : around > 1 ? 'Nowhere to go, mate. You\'re nicked.' : 'Stay right there, mate. You\'re under arrest.', 2.5);
      }
    } else {
      arrestT = Math.max(0, arrestT - dt * 2);
    }
    wanted.arrestProgress = clamp(arrestT / time, 0, 1);
    wanted.arrestOfficers = can ? around : 0;
    if (arrestT >= time) bust();
  }

  function bust() {
    arrestT = 0;
    wanted.arrestProgress = 0;
    if (game.player.vehicle) vehicles.exit({ eject: true });
    game.player.bust('police');
    game.weapons?.removeAll?.(); // (the bat is evidence now)
    wanted.clear('busted');
  }

  // =================================================================================================================
  // SIGHT: who of the police can see the player (round robin, a few rays a frame); crimes they witness
  // =================================================================================================================
  const AMBIENT_CAP = 12;
  const ambient = new Array(AMBIENT_CAP).fill(null);
  let ambientCount = 0;
  let ambientAt = 0;
  function refreshAmbient() {
    ambientCount = 0;
    const cars = world.cars;
    for (let i = 0; i < cars.length && ambientCount < AMBIENT_CAP; i++) {
      const c = cars[i];
      if (!c.active || !c.police || c.record.worldVehicle) continue;
      if (Math.abs(c.x - P.x) > 350 || Math.abs(c.z - P.z) > 350) continue;
      ambient[ambientCount++] = c;
    }
  }

  function los(ax, ay, az, bx, by, bz) {
    losA.x = ax;
    losA.y = ay;
    losA.z = az;
    losB.x = bx;
    losB.y = by;
    losB.z = bz;
    losOpts.mask = MASK.STATIC;
    return world.lineOfSight(losA, losB, losOpts);
  }

  let sightCursor = 0;
  let seenBefore = false;
  function updateSight() {
    const level = wanted.level;
    const scale = wanted.disguised ? 0.5 : 1;
    const now = game.time;
    let rays = 0;
    const total = MAX_UNITS + officers.length;
    for (let s = 0; s < total && rays < POLICE.raysPerFrame; s++) {
      sightCursor = (sightCursor + 1) % total;
      const o = sightCursor < MAX_UNITS ? units[sightCursor] : officers[sightCursor - MAX_UNITS];
      if (!o.active || now < o.sightAt) continue;
      o.sightAt = now + POLICE.sightEvery;
      let ox, oy, oz, range;
      if (sightCursor < MAX_UNITS) {
        if (!o.v || (o.crew <= 0 && o.state !== 'roadblock')) {
          o.sees = false;
          continue;
        }
        const e = o.v.entity;
        ox = e.position.x;
        oy = e.position.y + o.eyeY;
        oz = e.position.z;
        range = (o.state === 'roadblock' ? POLICE.sight.roadblock : POLICE.sight.car) * scale;
      } else {
        ox = o.x;
        oy = o.y + o.eyeY;
        oz = o.z;
        range = POLICE.sight.foot * scale;
      }
      const d = Math.hypot(P.x - ox, P.z - oz);
      if (d > range || level === 0) {
        o.sees = false;
        continue;
      }
      rays++;
      o.sees = los(ox, oy, oz, P.x, P.chestY, P.z);
    }
    // anyone?
    let sees = heli.active && heli.sees;
    let nearest = Infinity;
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (!u.active || !u.v) continue;
      if (u.sees) sees = true;
      if (u.state !== 'return') nearest = Math.min(nearest, Math.hypot(P.x - u.v.x, P.z - u.v.z));
    }
    for (let i = 0; i < officers.length; i++) {
      const o = officers[i];
      if (!o.active) continue;
      if (o.sees) sees = true;
      nearest = Math.min(nearest, Math.hypot(P.x - o.x, P.z - o.z));
    }
    eyes.seesPlayer = sees && level > 0 && game.player.alive;
    if (eyes.seesPlayer) {
      lastHeading.vx = P.vx;
      lastHeading.vz = P.vz;
    }
    eyes.heliUp = heli.active && heli.state !== 'leave';
    eyes.nearestUnit = nearest;
    eyes.playerSpeed = P.speed;
    if (eyes.seesPlayer && !seenBefore) game.emit('police:spotted', {});
    seenBefore = eyes.seesPlayer;
  }

  /** Did the police see (2) or hear (1) something at (x, z)? hearing: m within which a unit hears it (0: silent) */
  function witness(x, z, hearing) {
    const y = world.groundHeight(x, z) + 1.1;
    let rays = 0;
    let heard = false;
    const check = (ox, oy, oz, range) => {
      const d = Math.hypot(x - ox, z - oz);
      if (hearing && d < hearing) heard = true;
      if (d > range || rays >= 5) return false;
      rays++;
      return los(ox, oy, oz, x, y, z);
    };
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (!u.active || !u.v || (u.crew <= 0 && u.state !== 'roadblock')) continue;
      if (check(u.v.x, u.v.y + u.eyeY, u.v.z, POLICE.sight.car)) return 2;
    }
    for (let i = 0; i < officers.length; i++) {
      const o = officers[i];
      if (o.active && check(o.x, o.y + o.eyeY, o.z, POLICE.sight.foot)) return 2;
    }
    if (heli.active && check(heli.x, heli.y - 1, heli.z, 110)) return 2;
    refreshAmbient();
    for (let i = 0; i < ambientCount; i++) {
      const c = ambient[i];
      if (check(c.x, c.y + 1.4, c.z, POLICE.sight.ambient)) {
        ambientWitness = c;
        ambientWitnessAt = game.time;
        return 2;
      }
    }
    return heard ? 1 : 0;
  }

  // Speeding past a patrol car (not yet wanted)
  let speedCheckAt = 0;
  function checkSpeeding() {
    if (wanted.level > 0 || !P.inCar || P.speed < 22 || P.vehicle?.mode !== 'car' || game.time < speedCheckAt) return;
    speedCheckAt = game.time + 0.5;
    for (let i = 0; i < ambientCount; i++) {
      const c = ambient[i];
      if (Math.hypot(c.x - P.x, c.z - P.z) > 30) continue;
      if (los(c.x, c.y + 1.4, c.z, P.x, P.chestY, P.z)) {
        ambientWitness = c;
        ambientWitnessAt = game.time;
        wanted.report('speeding-past-cop', { police: true });
        return;
      }
    }
  }

  // =================================================================================================================
  // ROADBLOCKS: patrol cars parked across the road at an intersection ahead, officers behind them
  // =================================================================================================================
  let nextRoadblock = 0;
  function tryRoadblock() {
    nextRoadblock = game.time + 4; // (try again soon if nowhere fits)
    const rb = roadblocks[0].active ? roadblocks[1] : roadblocks[0];
    if (rb.active) return false;
    const dirX = P.vx / P.speed, dirZ = P.vz / P.speed;
    const count = nearestNodes(P.x + dirX * 175, P.z + dirZ * 175, 80, 16);
    for (let i = 0; i < count; i++) {
      const id = nearIdx[i];
      const nx = nodeX[id], nz = nodeZ[id];
      const rx = nx - P.x, rz = nz - P.z;
      const d = Math.hypot(rx, rz);
      if (d < 110 || d > 250 || (rx * dirX + rz * dirZ) / d < 0.8) continue;
      // the road the player is coming in on
      const n = nodes[id];
      let best = null, bestDot = 0.75;
      for (let j = 0; j < n.in.length; j++) {
        const e = n.in[j];
        const dot = e.dx * dirX + e.dz * dirZ;
        if (e.len > 16 && dot > bestDot) {
          bestDot = dot;
          best = e;
        }
      }
      if (!best) continue;
      const e = best;
      const s = e.len - 4;
      const cx = e.sx + e.dx * s, cz = e.sz + e.dz * s;
      const cy = roadY(cx, cz, e.deck);
      if (cameraSees(cx, cy, cz, 8, 320)) continue;
      // across both ways of the road (the other way's lanes mirrored)
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < e.lanes.length; j++) {
        lo = Math.min(lo, e.lanes[j]);
        hi = Math.max(hi, e.lanes[j]);
      }
      for (let j = 0; j < n.out.length; j++) {
        const f = n.out[j];
        if (f.to !== e.from) continue;
        for (let k = 0; k < f.lanes.length; k++) {
          lo = Math.min(lo, -f.lanes[k]);
          hi = Math.max(hi, -f.lanes[k]);
        }
      }
      lo -= 1.2;
      hi += 1.2;
      const width = hi - lo;
      const cars = width > 7 && totalCars() + 2 <= POLICE.maxCars ? 2 : 1;
      const heading = Math.atan2(e.dx, e.dz) + Math.PI / 2;
      let made = 0;
      for (let c = 0; c < cars; c++) {
        const off = cars === 1 ? (lo + hi) / 2 : c === 0 ? lo + width * 0.27 : hi - width * 0.27;
        const x = cx + e.rx * off, z = cz + e.rz * off;
        // clear the spot of traffic nobody can see
        world.nearbyCars(x, z, 6, tmpCars);
        for (let t = 0; t < tmpCars.length; t++) world.removeCar(tmpCars[t].id);
        const u = freeUnit();
        if (!u) break;
        const kind = wanted.level >= 4 && c === 1 ? 'suv' : 'car';
        const v = vehicles.spawn(kind === 'suv' ? 'police-suv' : 'police', x, z, heading + (c ? Math.PI : 0), { persistent: true })
          || vehicles.spawn(kind === 'suv' ? 'police' : 'police-suv', x, z, heading, { persistent: true });
        if (!v) break;
        placeVehicle(v, x, roadY(x, z, e.deck), z, heading + (c ? Math.PI : 0), 0);
        initUnit(u, v, v.kind === 'suv' ? 'suv' : 'car', 'roadblock');
        u.roadblock = rb;
        rb.cars[c] = u;
        vehicles.setControls(v, 0, 0);
        // an officer behind the car (on the far side from the player), ready to give chase on foot
        const ox = x + e.dx * 3.2, oz = z + e.dz * 3.2;
        const o = spawnOfficer(ox, oz, u, false, true);
        if (o) u.crew = Math.max(0, u.crew - 1);
        made++;
      }
      if (!made) return false;
      rb.active = true;
      rb.done = false;
      rb.x = cx;
      rb.z = cz;
      rb.dx = e.dx;
      rb.dz = e.dz;
      rb.born = game.time;
      nextRoadblock = game.time + POLICE.roadblockEvery;
      game.emit('police:dispatch', { kind: 'roadblock', level: wanted.level });
      return true;
    }
    return false;
  }

  function roadY(x, z, deck) {
    return deck ? cm.getGroundHeight(x, z, 'car', Infinity, 1) : terrainHeight(x, z);
  }

  function updateRoadblocks() {
    for (let i = 0; i < roadblocks.length; i++) {
      const rb = roadblocks[i];
      if (!rb.active) continue;
      const along = (P.x - rb.x) * rb.dx + (P.z - rb.z) * rb.dz;
      const d = Math.hypot(P.x - rb.x, P.z - rb.z);
      if (along > 40 || d > 280 || wanted.level === 0 || game.time - rb.born > POLICE.roadblockTime) rb.done = true;
      if (!rb.done) continue;
      // packed up once nobody can see it
      if (cameraSees(rb.x, terrainHeight(rb.x, rb.z), rb.z, 10, 400) && d < 400) continue;
      for (let c = 0; c < 2; c++) {
        const u = rb.cars[c];
        if (!u) continue;
        for (let j = 0; j < officers.length; j++) if (officers[j].active && officers[j].unit === u) releaseOfficer(officers[j], true);
        dropUnit(u, true);
      }
      rb.cars[0] = rb.cars[1] = null;
      rb.active = false;
    }
  }

  // =================================================================================================================
  // THE HELICOPTER: the hero helicopter's model (its geometry and material, so nothing new compiles), a searchlight
  // cone, strobes, and the searchlight's pool on the ground through the effects' light pool
  // =================================================================================================================
  const heliRoot = new THREE.Group();
  heliRoot.name = 'PoliceHelicopter';
  const heliTilt = new THREE.Group();
  heliRoot.add(heliTilt);
  const heroHeli = cm.entities.helicopter;
  const heroBody = heroHeli?.tiltPivot?.children.find((o) => o.isMesh);
  const heroMain = heroHeli?.mainRotorPivot?.children.find((o) => o.isMesh);
  const heroTail = heroHeli?.tailRotorPivot?.children.find((o) => o.isMesh);
  const heliMat = heroBody?.material || createLoftedHelicopterMaterial();
  const bodyMesh = new THREE.Mesh(heroBody?.geometry || buildHelicopterBodyGeometry(), heliMat);
  bodyMesh.castShadow = true;
  heliTilt.add(bodyMesh);
  const mainPivot = new THREE.Group();
  mainPivot.position.set(0, 2.66, -0.35);
  mainPivot.add(new THREE.Mesh(heroMain?.geometry || buildHelicopterMainRotorGeometry(), heroMain?.material || heliMat));
  heliTilt.add(mainPivot);
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0.18, 2.02, -5.62);
  tailPivot.add(new THREE.Mesh(heroTail?.geometry || buildHelicopterTailRotorGeometry(), heroTail?.material || heliMat));
  heliTilt.add(tailPivot);
  const strobeGeo = new THREE.SphereGeometry(0.11, 8, 6);
  const strobeRed = new THREE.Mesh(strobeGeo, new THREE.MeshBasicNodeMaterial({ color: 0xff2030 }));
  const strobeBlue = new THREE.Mesh(strobeGeo, new THREE.MeshBasicNodeMaterial({ color: 0x2060ff }));
  strobeRed.position.set(-0.42, 0.42, 1.7);
  strobeBlue.position.set(0.42, 0.42, 1.7);
  heliTilt.add(strobeRed, strobeBlue);
  // the beam: a unit cone, apex at the origin, pointing down -y (scaled and turned onto the spot each frame)
  const beamGeo = new THREE.ConeGeometry(1, 1, 24, 1, true);
  beamGeo.translate(0, -0.5, 0);
  const beamMat = new THREE.MeshBasicNodeMaterial({
    color: 0xfff0cc, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
  });
  beamMat.opacityNode = uv().y.mul(0.1).add(0.012);
  beamMat.mrtNode = transparentEffectMRT;
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = 'PoliceSearchlight';
  beam.castShadow = beam.receiveShadow = false;
  scene.add(heliRoot, beam);
  // (shown for the first frames so their pipelines compile behind the loading screen, then hidden until needed)
  heliRoot.position.set(0, -50, 0);
  beam.position.set(0, -50, 0);
  heliRoot.updateMatrixWorld(true);
  beam.updateMatrixWorld();

  const heli = {
    active: false, state: 'idle', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, pitch: 0, roll: 0, orbit: 0,
    beamX: 0, beamZ: 0, beamY: 0, sees: false, sightAt: 0, roofAt: 0, roof: 0, born: 0, exitX: 0, exitZ: 0,
    view: { id: 99, kind: 'heli', x: 0, y: 0, z: 0, vehicle: null, state: 'idle' }
  };
  const _down = new THREE.Vector3(0, -1, 0), _dir = new THREE.Vector3();
  const beamFrom = { x: 0, y: 0, z: 0 };
  const beamRayOpts = { mask: MASK.STATIC };
  const roofRayO = { x: 0, y: 0, z: 0 }, roofRayD = { x: 0, y: -1, z: 0 };
  const roofOpts = { mask: MASK.BUILDINGS };

  function launchHeli() {
    const ang = Math.random() * Math.PI * 2;
    heli.active = true;
    heli.state = 'track';
    heli.x = P.x + Math.cos(ang) * 380;
    heli.z = P.z + Math.sin(ang) * 380;
    heli.y = terrainHeight(heli.x, heli.z) + 110;
    heli.vx = heli.vy = heli.vz = 0;
    heli.heading = Math.atan2(P.x - heli.x, P.z - heli.z);
    heli.orbit = Math.atan2(heli.z - P.z, heli.x - P.x);
    heli.beamX = P.x;
    heli.beamZ = P.z;
    heli.beamY = terrainHeight(P.x, P.z);
    heli.sees = false;
    heli.born = game.time;
    heliRoot.visible = beam.visible = true;
    game.emit('police:dispatch', { kind: 'heli', level: wanted.level });
  }

  function updateHeli(dt, time) {
    if (!heli.active) {
      if (game.frame > 3 && (heliRoot.visible || beam.visible)) heliRoot.visible = beam.visible = false;
      return;
    }
    if (dt <= 0) return;
    const H = POLICE.heli;
    const lk = wanted.lastKnown;
    const seen = eyes.seesPlayer;
    let cx, cz;
    let tx, tz, ty;
    if (heli.state === 'leave') {
      tx = heli.exitX;
      tz = heli.exitZ;
      ty = terrainHeight(tx, tz) + 140;
      if (Math.hypot(heli.x - P.x, heli.z - P.z) > 520) {
        heli.active = false;
        heli.state = 'idle';
        heli.sees = false;
        heliRoot.visible = beam.visible = false;
        return;
      }
    } else {
      cx = seen ? P.x : guessX();
      cz = seen ? P.z : guessZ();
      heli.orbit += dt * (seen ? 0.2 : 0.14);
      const r = seen ? H.orbit : Math.min(140, H.searchOrbit + (game.time - lk.at) * 2);
      tx = cx + Math.cos(heli.orbit) * r;
      tz = cz + Math.sin(heli.orbit) * r;
      // over the roofs: what is under it, a few times a second
      if (time >= heli.roofAt) {
        heli.roofAt = time + 0.3;
        roofRayO.x = heli.x + heli.vx * 1.5;
        roofRayO.y = 420;
        roofRayO.z = heli.z + heli.vz * 1.5;
        const h = world.raycast(roofRayO, roofRayD, 420, roofOpts);
        heli.roof = h ? h.y : -Infinity;
      }
      const ground = Math.max(terrainHeight(tx, tz), ISLAND_BOUNDS.waterLevel);
      ty = Math.max(ground + H.altitude, heli.roof + H.clearRoof);
    }
    // fly there: velocity steered with a limited acceleration
    let wx = (tx - heli.x) * 0.7, wz = (tz - heli.z) * 0.7;
    const wl = Math.hypot(wx, wz);
    if (wl > H.speed) {
      wx *= H.speed / wl;
      wz *= H.speed / wl;
    }
    const wy = clamp((ty - heli.y) * 0.8, -6, 9);
    const ax = clamp(wx - heli.vx, -H.accel * dt, H.accel * dt);
    const az = clamp(wz - heli.vz, -H.accel * dt, H.accel * dt);
    heli.vx += ax;
    heli.vz += az;
    heli.vy += clamp(wy - heli.vy, -6 * dt, 6 * dt);
    heli.x += heli.vx * dt;
    heli.y += heli.vy * dt;
    heli.z += heli.vz * dt;
    // the searchlight: on the player when seen, sweeping round the last known position when not
    let bx, bz;
    if (heli.state === 'leave') {
      bx = heli.x;
      bz = heli.z;
    } else if (seen) {
      bx = P.x;
      bz = P.z;
    } else {
      // (the sweep widens the longer they have been gone, round where they guess the player went)
      const r = Math.min(110, 26 + (game.time - lk.at) * 4);
      bx = guessX() + Math.sin(time * 0.55) * r + Math.sin(time * 1.31) * r * 0.3;
      bz = guessZ() + Math.cos(time * 0.42) * r + Math.cos(time * 1.07) * r * 0.3;
    }
    const k = 1 - Math.exp(-dt * (seen ? 3.5 : 1.2));
    let mx = (bx - heli.beamX) * k, mz = (bz - heli.beamZ) * k;
    // (the light swings only so fast: a car going flat out slips out of it; one crawling along, or a runner, can't)
    const maxMove = (seen ? H.beamSpeed[wanted.level] || 20 : 40) * dt;
    const ml = Math.hypot(mx, mz);
    if (ml > maxMove) {
      mx *= maxMove / ml;
      mz *= maxMove / ml;
    }
    heli.beamX += mx;
    heli.beamZ += mz;
    heli.beamY = Math.max(terrainHeight(heli.beamX, heli.beamZ), ISLAND_BOUNDS.waterLevel);
    // the nose follows the light; the body leans into its acceleration
    const faceTo = heli.state === 'leave' ? Math.atan2(heli.vx, heli.vz) : Math.atan2(heli.beamX - heli.x, heli.beamZ - heli.z);
    heli.heading += wrap(faceTo - heli.heading) * (1 - Math.exp(-dt * 1.4));
    const s = Math.sin(heli.heading), c = Math.cos(heli.heading);
    const fwdAcc = (ax * s + az * c) / dt, sideAcc = (ax * c - az * s) / dt;
    heli.pitch += (clamp(fwdAcc * 0.03 + (heli.vx * s + heli.vz * c) * 0.006, -0.25, 0.3) - heli.pitch) * (1 - Math.exp(-dt * 3));
    heli.roll += (clamp(-sideAcc * 0.03, -0.3, 0.3) - heli.roll) * (1 - Math.exp(-dt * 3));
    // does the light find them? (and nothing in between)
    if (heli.state !== 'leave' && time >= heli.sightAt) {
      heli.sightAt = time + 0.2;
      const spot = H.spot * 1.6 * (wanted.disguised ? 0.6 : 1);
      const inLight = Math.hypot(P.x - heli.beamX, P.z - heli.beamZ) < spot || (seen && heli.sees && Math.hypot(P.x - heli.beamX, P.z - heli.beamZ) < spot * 2);
      heli.sees = inLight && los(heli.x, heli.y - 1, heli.z, P.x, P.chestY, P.z);
    }
    // pose
    heliRoot.position.set(heli.x, heli.y, heli.z);
    heliRoot.rotation.set(0, heli.heading, 0);
    heliTilt.rotation.set(heli.pitch, 0, heli.roll);
    mainPivot.rotation.y += dt * 24;
    tailPivot.rotation.x += dt * 32;
    const flash = Math.floor(time * 3) % 2 === 0;
    strobeRed.visible = flash;
    strobeBlue.visible = !flash;
    heliRoot.updateMatrixWorld(true);
    // beam from under the nose to the ground
    if (heli.state !== 'leave') {
      const ox = heli.x + s * 1.6, oy = heli.y + 0.2, oz = heli.z + c * 1.6;
      _dir.set(heli.beamX - ox, heli.beamY - oy, heli.beamZ - oz);
      let len = _dir.length();
      _dir.multiplyScalar(1 / Math.max(1e-3, len));
      // the beam stops at the first roof or wall in its way (a few times a second): a searchlight doesn't light the
      // street through a building, nor its pool sit under one
      if (!(time < heli.beamRayAt)) {
        heli.beamRayAt = time + 0.2;
        beamFrom.x = ox;
        beamFrom.y = oy;
        beamFrom.z = oz;
        const hit = world.raycast(beamFrom, _dir, len, beamRayOpts);
        heli.beamCut = hit && hit.distance < len - 0.5 ? hit.distance : -1;
      }
      let lx = heli.beamX, ly = heli.beamY, lz = heli.beamZ;
      if (heli.beamCut > 0 && heli.beamCut < len) {
        len = heli.beamCut;
        lx = ox + _dir.x * len;
        ly = oy + _dir.y * len;
        lz = oz + _dir.z * len;
      }
      beam.position.set(ox, oy, oz);
      beam.quaternion.setFromUnitVectors(_down, _dir);
      beam.scale.set(H.spot, len, H.spot);
      beam.visible = true;
      beam.updateMatrixWorld();
      fx.light(lx, ly + 5, lz, 0xfff2d8, H.light, 26, 0.25, 'police-heli-spot');
    } else {
      beam.visible = false;
    }
    heli.view.x = heli.x;
    heli.view.y = heli.y;
    heli.view.z = heli.z;
    heli.view.state = heli.sees ? 'track' : heli.state === 'leave' ? 'leave' : 'search';
  }

  // =================================================================================================================
  // DISPATCH: how many of what for the level
  // =================================================================================================================
  let nextDispatch = 0;
  let nextFoot = 0;
  let heliAt = 0;

  function totalCars() {
    let n = 0;
    for (let i = 0; i < MAX_UNITS; i++) if (units[i].active) n++;
    return n;
  }

  function dispatch() {
    const level = wanted.level;
    if (level === 0 || !game.player.alive) return;
    const now = game.time;
    let pursuit = 0, suvs = 0, all = 0;
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (!u.active) continue;
      all++;
      if (u.state === 'roadblock' || u.state === 'return') continue;
      pursuit++;
      if (u.kind === 'suv') suvs++;
    }
    let foot = 0;
    for (let i = 0; i < officers.length; i++) if (officers[i].active) foot++;
    // the patrol car that saw it happen comes at once
    if (ambientWitness && game.time - ambientWitnessAt < 6 && pursuit < POLICE.cars[level] && all < POLICE.maxCars) {
      if (convertAmbient(0)) {
        pursuit++;
        all++;
      }
    }
    if (now >= nextDispatch && pursuit < POLICE.cars[level] && all < POLICE.maxCars) {
      nextDispatch = now + POLICE.dispatchEvery;
      const kind = suvs < POLICE.suvs[level] ? 'suv' : 'car';
      // one in traffic nearby, else a fresh one out of sight
      if (!(kind === 'car' && convertAmbient(150))) spawnCar(kind);
    }
    // on foot in a plaza or a park: officers on foot too
    if (!P.inCar && now >= nextFoot && foot < POLICE.footPatrol[level]) {
      nextFoot = now + 8;
      spawnFootPatrol(POLICE.footPatrol[level] - foot);
    }
    if (level >= POLICE.heliFrom && !heli.active && now >= heliAt) launchHeli();
    if (level >= POLICE.heliFrom && heli.active && heli.state === 'leave') heli.state = 'track'; // (called back)
    if (level < POLICE.heliFrom && heli.active && heli.state !== 'leave') sendHeliAway();
    let rbs = (roadblocks[0].active ? 1 : 0) + (roadblocks[1].active ? 1 : 0);
    // (roadblocks go up ahead of a car they can see, or saw a moment ago: not across the road of one they have lost)
    if (level >= POLICE.roadblockFrom && P.inCar && P.vehicle?.mode === 'car' && P.speed > 10 && now >= nextRoadblock
      && now - wanted.lastKnown.at < 5 && rbs < POLICE.roadblocks[level] && all + 1 <= POLICE.maxCars) {
      if (tryRoadblock()) rbs++;
    }
    // too many for the level (a bribe): the extra ones go home
    if (pursuit > POLICE.cars[level]) {
      for (let i = MAX_UNITS - 1; i >= 0 && pursuit > POLICE.cars[level]; i--) {
        const u = units[i];
        if (!u.active || u.state === 'roadblock' || u.state === 'return' || u.state === 'stopped') continue;
        u.state = 'return';
        pickReturnGoal(u);
        pursuit--;
      }
    }
  }

  function sendHeliAway() {
    if (!heli.active) return;
    heli.state = 'leave';
    heli.sees = false;
    let ax = heli.x - P.x, az = heli.z - P.z;
    const l = Math.hypot(ax, az) || 1;
    heli.exitX = heli.x + (ax / l) * 900;
    heli.exitZ = heli.z + (az / l) * 900;
  }

  /** Everyone goes home: cars drive off, officers walk off (or back to their car), the helicopter leaves */
  function standDown() {
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (!u.active || u.state === 'roadblock') continue;
      if (u.state === 'stopped') continue; // (its officers come back first, see updateStopped)
      u.state = 'return';
      u.born = game.time;
      setSiren(u, false);
      pickReturnGoal(u);
    }
    for (let i = 0; i < roadblocks.length; i++) if (roadblocks[i].active) roadblocks[i].done = true;
    sendHeliAway();
    arrestT = 0;
  }

  /** Off the map at once (the player was arrested or died: they are somewhere else now) */
  function removeEveryoneUnseen() {
    for (let i = 0; i < officers.length; i++) {
      const o = officers[i];
      if (o.active) releaseOfficer(o, !cameraSees(o.x, o.y, o.z, 2, 300));
    }
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (u.active) {
        u.state = 'return';
        u.born = game.time;
        setSiren(u, false);
        pickReturnGoal(u);
      }
    }
    sendHeliAway();
  }

  game.on('wanted:changed', ({ level, prev }) => {
    if (level > 0 && prev === 0) {
      nextDispatch = game.time + POLICE.firstDispatch[level];
      nextFoot = game.time + POLICE.firstDispatch[level] + 2;
      heliAt = game.time + 5;
      nextRoadblock = game.time + 8;
      // units still heading home turn round
      for (let i = 0; i < MAX_UNITS; i++) {
        const u = units[i];
        if (u.active && u.state === 'return') {
          u.state = 'respond';
          u.ptsN = 0;
          u.pathAt = -Infinity;
        }
      }
    } else if (level > prev) {
      nextDispatch = Math.min(nextDispatch, game.time + POLICE.firstDispatch[level]);
      if (level >= POLICE.heliFrom && !heli.active) heliAt = Math.min(heliAt, game.time + 4);
    }
    if (level === 0) standDown();
  });
  game.on('player:died', removeEveryoneUnseen);
  game.on('player:busted', removeEveryoneUnseen);
  // a unit and the player's vehicle collided: a moment before the next ram
  game.on('vehicle:hit', (e) => {
    if (e.kind !== 'collision' || !P.vehicle) return;
    const src = e.source?.worldVehicle || e.source;
    for (let i = 0; i < MAX_UNITS; i++) {
      const u = units[i];
      if (u.active && u.v && ((e.target === P.vehicle && (src === u.v || e.source === u.v.entity)) || (e.target === u.v && src === 'player'))) u.rammedAt = game.time;
    }
  });
  // the player took a patrol car: it is theirs now
  game.on('vehicle:entered', (e) => {
    for (let i = 0; i < MAX_UNITS; i++) if (units[i].active && units[i].v === e.vehicle) dropUnit(units[i], false);
  });

  // =================================================================================================================
  // EVERY FRAME
  // =================================================================================================================
  let dispatchAt = 0;
  function update(dt, time) {
    if (game.state === 'cutscene') return;
    // (not a number: a frame with no step — a NaN would stick in the arrest timer for good)
    if (!(dt > 0)) {
      refreshPlayer(0);
      updateHeli(0, time);
      return;
    }
    refreshPlayer(dt);
    pathsThisFrame = 0;
    if (time >= ambientAt) {
      ambientAt = time + 0.5;
      refreshAmbient();
    }
    updateSight();
    checkSpeeding();
    for (let i = 0; i < MAX_UNITS; i++) if (units[i].active) updateUnit(units[i], dt);
    for (let i = 0; i < officers.length; i++) if (officers[i].active) updateOfficer(officers[i], dt);
    updateHeli(dt, time);
    updateRoadblocks();
    if (game.state === 'playing') updateArrest(dt);
    if (time >= dispatchAt) {
      dispatchAt = time + 0.5;
      dispatch();
    }
  }

  game.addSystem({ name: 'police', order: 44, update });
  game.addSystem({ name: 'wanted', order: 46, update: (dt) => updateWanted(dt) });

  // the units, for the HUD's radar and anyone else: [{ id, kind ('car'|'suv'|'foot'|'heli'), x, z, vehicle, state }]
  const unitList = [];
  game.police = {
    units() {
      unitList.length = 0;
      for (let i = 0; i < MAX_UNITS; i++) if (units[i].active) unitList.push(units[i].view);
      for (let i = 0; i < officers.length; i++) if (officers[i].active) unitList.push(officers[i].view);
      if (heli.active) unitList.push(heli.view);
      return unitList;
    },
    get count() {
      let n = heli.active ? 1 : 0;
      for (let i = 0; i < MAX_UNITS; i++) if (units[i].active) n++;
      for (let i = 0; i < officers.length; i++) if (officers[i].active) n++;
      return n;
    },
    /** The police helicopter (for its rotor sound): { active, x, y, z, beamX, beamZ, sees } */
    heli,
    /** Debug: a unit now ('car' | 'suv'), a roadblock, everyone home */
    spawn: (kind = 'car') => spawnCar(kind),
    roadblock: () => tryRoadblock(),
    standDown,
    TUNING: POLICE,
    _debug: { units, officers, roadblocks, eyes, P }
  };
  return game.police;
}

export { registerPolice, POLICE };
