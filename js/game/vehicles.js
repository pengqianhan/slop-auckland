import * as THREE from 'three/webgpu';
import { vehicleContact, sweptVehicleContact, resolveVehicleContact } from '../vehicle-physics.js';
import { terrainHeight } from '../terrain.js';
import { AKL_LANDMARKS, ISLAND_BOUNDS, LL, SPAWN, blockAt, nearestRoads, shoreDistance, LANDINGS, landingAt, landingGround } from '../city-config.js';
import { createSailboatEntity, stepSailboat, poseSailboat } from '../sailboat.js';
import { createScooterEntity, SCOOTER } from '../scooter.js';

// The vehicle layer: every vehicle the player can get into is a "world vehicle". The hero taxi, bicycle and
// helicopter are the controllers' own entities (their own meshes); any other car is a traffic car record taken off
// traffic's books (carjacked, adopted, or one of traffic's reserve cars spawned by a mission) and drawn through
// traffic's instanced bodies at the pose of a lightweight physics entity (a "proxy": the controllers' car model, no
// geometry of its own). The player drives whichever it is in through controllers.js (setEntity swaps it in as the
// car); the vehicle stays where it was left, parked and solid (traffic treats it as an obstacle), rolls on if left
// moving, and can be driven by game AI (setControls). Crashes (and a cricket bat) wear its health down: smoke, heavy
// smoke, and at nothing left the engine dies — a wreck: stalled, battered, smoking hard for a while, undrivable (no
// fire, no explosion; this is a caper). Traffic cars take damage the same way while they drive; one that is wrecked is
// abandoned by its driver and becomes a world vehicle.
// Sailboats (mode 'boat') are moored at the wharves: the player steps aboard from the quay, sails off (controllers.js
// 'boat', js/sailboat.js), and steps ashore wherever she can be brought alongside — a wharf in the city, or the
// seawall at Devonport (city-config.js LANDINGS). Left at a quay she is tied up; she takes no damage.

const KINDS = {
  taxi: { mode: 'car', label: 'Taxi', halfW: 0.86, halfL: 2.18, height: 1.55, mass: 1600, chase: 1, lift: 0 },
  sedan: { mode: 'car', label: 'Sedan', police: 'Police Car', halfW: 0.86, halfL: 2.18, height: 1.45, mass: 1600, chase: 1, lift: 0 },
  suv: { mode: 'car', label: 'SUV', police: 'Police SUV', halfW: 0.92, halfL: 2.22, height: 1.78, mass: 2100, chase: 1.05, lift: 0.18 },
  minivan: { mode: 'car', label: 'Minivan', halfW: 0.92, halfL: 2.52, height: 1.8, mass: 2000, chase: 1.08, lift: 0.18 },
  pickup: { mode: 'car', label: 'Ute', halfW: 0.96, halfL: 2.78, height: 1.85, mass: 2400, chase: 1.12, lift: 0.22 },
  van: { mode: 'car', label: 'Van', halfW: 0.95, halfL: 2.88, height: 2.45, mass: 2700, chase: 1.2, lift: 0.55 },
  bicycle: { mode: 'cyclist', label: 'Bicycle', halfW: 0.32, halfL: 0.9, height: 1.15, mass: 20 },
  scooter: { mode: 'scooter', label: 'E-Scooter', ...SCOOTER },
  helicopter: { mode: 'helicopter', label: 'Helicopter', halfW: 1.25, halfL: 4.3, height: 3.1, mass: 3000 },
  sailboat: { mode: 'boat', label: 'Sailboat', halfW: 1.35, halfL: 4.6, height: 13, mass: 3200 }
};
const CAR_KINDS = ['taxi', 'sedan', 'suv', 'minivan', 'pickup', 'van'];
// Health thresholds (out of 100): light smoke, heavy smoke, wrecked (the engine dies)
const HEALTH = { smoke: 45, heavy: 25, wreck: 0 };
const WRECK_SMOKE = 40; // s a wreck keeps smoking
const PLAYER_CRASH_SHARE = 0.6; // of the collision damage the player's own car takes
const WORLD_CAP = 12; // world vehicles kept besides the hero ones; the oldest unseen, far-off ones go first
const ENTER_REACH = 2.3; // m from a vehicle's body to get in
const JACK_REACH = 2.1;
const JACK_TOP_SPEED = 11;
const WRECK_DARKEN = 0.55; // a wreck's paint: battered and grimy (put back when it is removed)
// The hero helicopter's home: the open paving of Aotea Square, by the Town Hall (lon, lat)
const HELIPAD = LL(174.76330, -36.85250);
// The sailboats' berths: three side by side off the east side of Queens Wharf, by the Ferry Building, sterns to the
// quay and bows out into the open water between the wharves (each with a clear run out, and across the usual
// north-easterly: she gathers way at once), and one off the seawall at Devonport
const BERTHS = [
  { x: 553.0, z: -704.3, heading: 1.25 },
  { x: 556.3, z: -714.5, heading: 1.25 },
  { x: 559.0, z: -724.3, heading: 1.25 },
  ...LANDINGS.map((l) => l.berth)
];
const BOAT_REACH = 13; // m from the quay to a boat's side (people keep a few metres back from the edge)
const BOAT_ASHORE = 20; // m from a boat to the ground she can be left from
const SCOOTER_LANDMARKS = ['skytower', 'ferry', 'britomart', 'viaduct', 'wynyard', 'aotea', 'albertpark', 'university', 'kroad', 'victoriapark', 'arena'];
const SCOOTER_RETURN_TIME = 180;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

function createVehicles(game, { controllerManager, trafficSystem, cameraSystem, world, fx }) {
  const cm = controllerManager;
  const traffic = trafficSystem;
  const person = cm.entities.person;
  const vehicles = [];
  const obstacles = [];
  let nextId = 1;
  let current = null; // the vehicle the player is in
  let action = null; // getting in (walking to the door, carjacking) or stopping to get out
  let lastPrompt = null;

  // =================================================================================================================
  // RECORDS & ENTITIES
  // =================================================================================================================
  // A physics entity for a car drawn through traffic's instances: the fields controllers.simulateCar and the cameras
  // read (the chassis, wheels and lamp state are bare objects: the record shows them)
  function createProxy(kind, x, y, z, heading) {
    const k = KINDS[kind];
    const mesh = new THREE.Object3D();
    const chassisPivot = new THREE.Object3D();
    mesh.add(chassisPivot);
    const wheels = [true, true, false, false].map((isFront) => ({ steerPivot: new THREE.Object3D(), tire: new THREE.Object3D(), isFront }));
    return {
      type: 'car', label: k.label, mesh, chassisPivot, carState: { value: new THREE.Vector4() }, headLights: [], wheels,
      position: new THREE.Vector3(x, y, z), prevX: x, prevZ: z, heading, speed: 0, vx: 0, vz: 0, angularVel: 0,
      pitchVel: 0, rollVel: 0, heaveY: 0, heaveVel: 0, lastCollisionSpark: null, steerAngle: 0, wheelSpin: 0,
      groundPitch: 0, groundRoll: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96 + k.lift, 0), chaseDistance: 6.9 * k.chase, chaseHeight: 2.12 * k.chase,
      halfW: k.halfW, halfL: k.halfL, mass: k.mass, engineOff: true, proxy: true
    };
  }

  function makeVehicle(kind, entity, record, opts = {}) {
    const k = KINDS[kind];
    const police = !!opts.police;
    const v = {
      id: nextId++, type: 'world', kind, mode: k.mode,
      label: opts.label || (police && k.police) || k.label,
      police, hero: !!opts.hero, entity, record: record || null, hidden: false,
      health: 100, maxHealth: 100, state: 'ok', wreckSmokeUntil: 0,
      driver: null, lastDriver: null, lastDriverAt: -Infinity, controls: { throttle: 0, steer: 0 },
      locked: !!opts.locked, persistent: !!opts.persistent, lastUsed: game.time, createdAt: game.time,
      halfW: k.halfW, halfL: k.halfL, height: k.height, mass: k.mass,
      x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading, speed: 0, vx: 0, vz: 0,
      smoke: null, home: opts.home || null, respawnPending: false,
      trafficId: record?.view ? record.view.id : -1, awake: true, lastHitBy: null, lastHitByPlayer: false,
      restore: record ? { paint: record.paint.slice(), style: record.style, isPolice: record.isPolice } : null,
      _hitAt: -Infinity, _hitSpeed: 0, _rs: 0
    };
    entity.worldVehicle = v;
    entity.halfW = k.halfW;
    entity.halfL = k.halfL;
    entity.mass = k.mass;
    entity.engineOff = true;
    if (record) {
      record.worldVehicle = v;
      record.shown = true;
      record.lightsOff = true;
    }
    vehicles.push(v);
    return v;
  }

  // =================================================================================================================
  // THE HERO VEHICLES: the taxi the player starts beside, the bicycle behind it, the helicopter on Aotea Square
  // =================================================================================================================
  const taxiEntity = cm.entities.car;
  const bikeEntity = cm.entities.cyclist;
  const heliEntity = cm.entities.helicopter;
  const heroTaxi = makeVehicle('taxi', taxiEntity, null, { hero: true, persistent: true, home: { x: taxiEntity.position.x, z: taxiEntity.position.z, heading: taxiEntity.heading } });
  const heroBike = makeVehicle('bicycle', bikeEntity, null, { hero: true, persistent: true, home: { x: bikeEntity.position.x, z: bikeEntity.position.z, heading: bikeEntity.heading } });
  bikeEntity.riderless = true;
  // the rider is the player: same build, clothes and hair (the appearance is the pose buffer's last vec4)
  {
    const from = person.rig, to = bikeEntity.riderRig;
    Object.assign(to, { seed: from.seed, s: from.s, female: from.female, girth: from.girth, bind: from.bind });
    const n = from.pose.length;
    to.pose.set(from.pose.subarray(n - 4), n - 4);
  }
  // the helicopter stands on the ground with its rotors still
  const padY = Math.max(terrainHeight(HELIPAD.x, HELIPAD.z), ISLAND_BOUNDS.waterLevel) + 0.25;
  heliEntity.position.set(HELIPAD.x, padY, HELIPAD.z);
  heliEntity.heading = Math.PI * 0.85;
  heliEntity.rotorSpeed = 0;
  heliEntity.verticalSpeed = heliEntity.speed = 0;
  const heroHeli = makeVehicle('helicopter', heliEntity, null, { hero: true, persistent: true, home: { x: HELIPAD.x, z: HELIPAD.z, heading: heliEntity.heading } });
  // the sailboats at their berths, sails furled (the first is the controllers' own)
  const heroBoats = BERTHS.map((b, i) => {
    const e = i === 0 ? cm.entities.boat : createSailboatEntity({ paint: i, x: b.x, z: b.z, heading: b.heading });
    if (i > 0) cm.scene.add(e.mesh);
    e.position.set(b.x, ISLAND_BOUNDS.waterLevel, b.z);
    e.heading = b.heading;
    e.moored = true;
    e.sailsUp = false;
    const v = makeVehicle('sailboat', e, null, { hero: true, persistent: true, home: { x: b.x, z: b.z, heading: b.heading } });
    v.invulnerable = true;
    return v;
  });
  const scooterSites = [
    { x: SPAWN.x + 16 * Math.sin(SPAWN.heading) + 7 * Math.cos(SPAWN.heading),
      z: SPAWN.z + 16 * Math.cos(SPAWN.heading) - 7 * Math.sin(SPAWN.heading) },
    ...AKL_LANDMARKS.filter((landmark) => SCOOTER_LANDMARKS.includes(landmark.id))
  ];
  const scooters = [];
  for (const site of scooterSites) {
    const home = scooterParking(site);
    if (!home) continue;
    const e = createScooterEntity(home.x, home.y, home.z, home.heading);
    cm.scene.add(e.mesh);
    cm.rideGround(e, SCOOTER.axle, 0, 1);
    syncScooterMesh(e);
    const v = makeVehicle('scooter', e, null, { hero: true, persistent: true, home });
    v.invulnerable = true;
    v.awake = false;
    v.blip = game.blips.add({ kind: 'scooter', label: v.label, target: v, short: true });
    scooters.push(v);
  }
  let lastShore = null; // where the player stepped aboard from (the save keeps them ashore)
  // (the kiwi belongs to the sandbox)
  cm.entities.kiwi.mesh.visible = false;
  for (const v of [heroTaxi, heroBike, heroHeli]) v.awake = false;

  // =================================================================================================================
  // QUERIES
  // =================================================================================================================
  const list = () => vehicles;

  // Distance from (x, z) to the body's footprint (0 inside)
  function bodyDistance(x, z, cx, cz, heading, hw, hl) {
    const dx = x - cx, dz = z - cz;
    const s = Math.sin(heading), c = Math.cos(heading);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const qx = Math.max(0, Math.abs(lx) - hw), qz = Math.max(0, Math.abs(lz) - hl);
    return Math.hypot(qx, qz);
  }

  /** The nearest world vehicle within maxDist of (x, z) (by its body), passing filter(v) if given */
  function nearest(x, z, maxDist = 10, filter = null) {
    let best = null, bestD = maxDist;
    for (const v of vehicles) {
      if (v.hidden || (filter && !filter(v))) continue;
      const e = v.entity;
      const d = bodyDistance(x, z, e.position.x, e.position.z, e.heading, v.halfW, v.halfL);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  function scooterParking(site) {
    let best = null, bestDistance = Infinity;
    for (const n of nearestRoads(site.x, site.z, 150)) {
      if (n.road.closed || n.road.bridge) continue;
      for (const along of [0, 8, -8, 16, -16, 24, -24, 32, -32]) {
        for (const side of [-1, 1]) {
          // Look for the actual kerb rather than assuming the mapped road runs down its centre.
          const edge = Math.max(2, n.road.w / 2 - 1.5);
          for (let offset = edge; offset <= edge + 5; offset += 0.75) {
            const x = n.x + n.dx * along + n.dz * side * offset;
            const z = n.z + n.dz * along - n.dx * side * offset;
            const distance = Math.hypot(x - site.x, z - site.z);
            if (distance >= bestDistance) continue;
            const block = blockAt(x, z);
            if (!block || block.median || block.kind === 3 || shoreDistance(x, z) < 10) continue;
            // Both wheels and the space to step off on the kerb side should be on the footpath.
            if (blockAt(x + n.dx * SCOOTER.axle, z + n.dz * SCOOTER.axle) !== block ||
                blockAt(x - n.dx * SCOOTER.axle, z - n.dz * SCOOTER.axle) !== block ||
                blockAt(x + n.dz * side * 0.7, z - n.dx * side * 0.7) !== block) continue;
            const y = cm.getGroundHeight(x, z, 'scooter', Infinity, 1);
            if (!cm.isClear(x, z, y, 1.25) || nearest(x, z, 3)) continue;
            best = { x, y, z, heading: Math.atan2(-side * n.dx, -side * n.dz) };
            bestDistance = distance;
            break;
          }
        }
      }
    }
    return best;
  }

  function syncScooterMesh(e) {
    e.mesh.position.copy(e.position);
    e.mesh.rotation.set(e.groundPitch, e.heading, 0, 'YXZ');
    e.mesh.updateMatrixWorld();
  }

  // What F would get the player into: a world vehicle, or a traffic car to steal
  const candidate = { vehicle: null, record: null, distance: Infinity, verb: '' };
  function findCandidate() {
    candidate.vehicle = candidate.record = null;
    candidate.distance = Infinity;
    const p = person.position;
    for (const v of vehicles) {
      const boat = v.mode === 'boat';
      if (v.hidden || v.locked || v.state === 'wrecked' || v.driver === 'ai' || Math.abs(v.entity.position.y - p.y) > (v.mode === 'helicopter' ? 3 : boat ? 6 : 2)) continue;
      const e = v.entity;
      if (boat && Math.abs(e.speed) > 2) continue;
      const d = bodyDistance(p.x, p.z, e.position.x, e.position.z, e.heading, v.halfW, v.halfL);
      if (d < (boat ? BOAT_REACH : ENTER_REACH) && d < candidate.distance && (!boat || canStepAboard(v, d))) {
        candidate.vehicle = v;
        candidate.distance = d;
      }
    }
    const cars = world.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active || c.kind === 'bus' || c.speed > JACK_TOP_SPEED || Math.abs(c.y - p.y) > 2) continue;
      if (Math.abs(c.x - p.x) > 8 || Math.abs(c.z - p.z) > 8) continue;
      const d = bodyDistance(p.x, p.z, c.x, c.z, c.heading, c.halfW, c.halfL);
      if (d < JACK_REACH && d < candidate.distance) {
        candidate.vehicle = null;
        candidate.record = c.record;
        candidate.distance = d;
      }
    }
    const v = candidate.vehicle;
    candidate.verb = candidate.record ? 'Steal' : !v ? '' : v.mode === 'cyclist' || v.mode === 'scooter' ? 'Ride'
      : v.mode === 'helicopter' ? 'Fly' : v.mode === 'boat' ? 'Sail' : 'Enter';
    return candidate;
  }

  // A boat within reach of the quay: nothing but water between her and the player (not a boat seen across a wharf)
  function canStepAboard(v, d) {
    const p = person.position, e = v.entity;
    const dx = e.position.x - p.x, dz = e.position.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    // from the player towards her: land, then water up to her side (land again after water: a wharf in between)
    let wet = false;
    for (let t = 1; t < len - v.halfW; t += 1.5) {
      const x = p.x + (dx / len) * t, z = p.z + (dz / len) * t;
      const land = landingAt(x, z) ? landingGround(x, z, 0) : shoreDistance(x, z) > 0;
      if (!land) wet = true;
      else if (wet) return false;
    }
    void d;
    return true;
  }

  // Ground to step ashore onto from a boat: the nearest clear spot on a wharf or the shore (or on a landing's land)
  const ashore = { x: 0, y: 0, z: 0 };
  function findAshore(e) {
    let best = null, bd = Infinity;
    for (let r = 3; r <= BOAT_ASHORE; r += 1.5) {
      const n = Math.max(12, Math.round(r * 2.5));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = e.position.x + Math.sin(a) * r, z = e.position.z + Math.cos(a) * r;
        const landing = landingAt(x, z);
        if (landing ? !landingGround(x, z, 1.5) : shoreDistance(x, z) < 8.3 || x < ISLAND_BOUNDS.minX + 3 || x > ISLAND_BOUNDS.maxX - 3 || z < ISLAND_BOUNDS.minZ + 3 || z > ISLAND_BOUNDS.maxZ - 3) continue;
        const y = world.groundHeight(x, z, 60);
        if (!cm.isClear(x, z, y, 0.45)) continue;
        if (r < bd) {
          bd = r;
          best = ashore;
          ashore.x = x; ashore.y = y; ashore.z = z;
        }
      }
      if (best) return best;
    }
    return null;
  }

  // =================================================================================================================
  // GETTING IN & OUT
  // =================================================================================================================
  // The driver's door: New Zealand cars are right-hand drive (local -x is the right side); a bicycle from its side,
  // the helicopter by its right-hand cabin door
  function doorPoint(kind, x, z, heading, hw, out) {
    const twoWheels = kind === 'bicycle' || kind === 'scooter';
    const lx = twoWheels ? -0.65 : kind === 'helicopter' ? -1.65 : -(hw + 0.55);
    const lz = twoWheels ? 0 : kind === 'helicopter' ? 0.9 : 0.3;
    const s = Math.sin(heading), c = Math.cos(heading);
    out.x = x + lx * c + lz * s;
    out.z = z - lx * s + lz * c;
    return out;
  }

  const door = { x: 0, z: 0 };
  const enterEvent = { vehicle: null, carjacked: false, victim: -1, x: 0, z: 0, witnesses: 0 };

  /** Get the player into vehicle v (walking to its door first unless instant) */
  function enter(v, { instant = false } = {}) {
    if (!v || current || v.state === 'wrecked' || v.hidden || !game.player?.alive) return false;
    if (instant) return board(v, false, -1);
    action = { type: 'enter', vehicle: v, record: null, t: 0 };
    return true;
  }

  function startJack(record) {
    traffic.game.stop(record, 6);
    action = { type: 'jack', vehicle: null, record, t: 0 };
  }

  function board(v, carjacked, victim) {
    action = null;
    person.hidden = true;
    person.velX = person.velZ = person.speed = 0;
    if (v.mode === 'car') {
      if (cm.entities.car !== v.entity && cm.entities.car === taxiEntity) setTaxiLights(false);
      cm.setEntity('car', v.entity);
    }
    if (v.mode === 'scooter') cm.setEntity('scooter', v.entity);
    if (v.mode === 'boat') {
      lastShore = { x: person.position.x, y: person.position.y, z: person.position.z };
      cm.setEntity('boat', v.entity);
      v.entity.moored = false;
      v.entity.sailsUp = true;
    }
    cm.resetInput();
    cm.setMode(v.mode);
    v.driver = 'player';
    v.lastDriver = 'player';
    v.lastDriverAt = game.time;
    v.entity.engineOff = false;
    v.awake = true;
    v.lastUsed = game.time;
    if (v.record) v.record.lightsOff = false;
    if (v.mode === 'cyclist') v.entity.riderless = false;
    current = v;
    if (game.player) game.player.vehicle = v;
    enterEvent.vehicle = v;
    enterEvent.carjacked = carjacked;
    enterEvent.victim = victim;
    enterEvent.x = v.entity.position.x;
    enterEvent.z = v.entity.position.z;
    enterEvent.witnesses = world.witnesses(enterEvent.x, enterEvent.z, 30);
    game.emit('vehicle:entered', enterEvent);
    if (carjacked) game.emit('vehicle:jacked', enterEvent);
    game.emit('player:mode', { mode: v.mode, vehicle: v });
    return true;
  }

  function setTaxiLights(on) {
    for (const spot of taxiEntity.headLights || []) if (!on) spot.intensity = 0;
  }

  // Where the player can step out: the driver's side first, then the other side, behind, in front
  const stepOff = (hw, hl) => [[-0.75, 0], [0.75, 0], [0, -(hl + 0.5)], [0, hl + 0.5]];
  const EXITS = {
    car: (hw, hl) => [[-(hw + 0.6), 0.35], [hw + 0.6, 0.35], [-(hw + 0.6), -1.2], [hw + 0.6, -1.2], [0, -(hl + 0.8)], [0, hl + 0.8]],
    cyclist: stepOff,
    scooter: stepOff,
    helicopter: () => [[-1.8, 0.9], [1.8, 0.9], [-1.8, -1.5], [1.8, -1.5], [0, 3.4]],
    boat: () => [[-2.2, 0], [2.2, 0], [0, -5.4]]
  };

  function clearForPerson(x, z, y, airborne) {
    if (!airborne && shoreDistance(x, z) < 1.5) return false;
    if (!cm.isClear(x, z, y, 0.42)) return false;
    for (const o of vehicles) {
      if (o.hidden || o === current) continue;
      const e = o.entity;
      if (Math.abs(e.position.y - y) > 2.5) continue;
      if (bodyDistance(x, z, e.position.x, e.position.z, e.heading, o.halfW, o.halfL) < 0.45) return false;
    }
    const cars = world.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active || Math.abs(c.x - x) > 8 || Math.abs(c.z - z) > 8) continue;
      if (bodyDistance(x, z, c.x, c.z, c.heading, c.halfW, c.halfL) < 0.45) return false;
    }
    return true;
  }

  const exitEvent = { vehicle: null, bailed: false, x: 0, z: 0 };
  /** Get out (bail: at speed, thrown out with a knock-down) */
  function exit({ bail = false, eject = false } = {}) {
    const v = current;
    if (!v) return false;
    action = null;
    const e = v.entity;
    const h = e.heading;
    const s = Math.sin(h), c = Math.cos(h);
    const airborne = v.mode === 'helicopter' && e.position.y - Math.max(terrainHeight(e.position.x, e.position.z), ISLAND_BOUNDS.waterLevel) > 2;
    const offsets = EXITS[v.mode](v.halfW, v.halfL);
    let px = NaN, pz = NaN, py = 0;
    // off a boat: onto the quay (she's tied up there, sails furled)
    const shore = v.mode === 'boat' ? findAshore(e) : null;
    if (shore) {
      px = shore.x; pz = shore.z; py = shore.y;
      e.moored = true;
      e.speed = 0;
    }
    if (v.mode === 'boat') e.sailsUp = false;
    for (const [lx, lz] of shore ? [] : offsets) {
      const x = e.position.x + lx * c + lz * s;
      const z = e.position.z - lx * s + lz * c;
      const y = airborne ? e.position.y + 0.3 : world.groundHeight(x, z, e.position.y + 1);
      if (clearForPerson(x, z, y, airborne) || eject) {
        px = x; pz = z; py = y;
        break;
      }
    }
    if (!Number.isFinite(px)) {
      // boxed in: out of the door anyway (the controllers push the person out of walls)
      px = e.position.x + offsets[0][0] * c + offsets[0][1] * s;
      pz = e.position.z - offsets[0][0] * s + offsets[0][1] * c;
      py = airborne ? e.position.y + 0.3 : world.groundHeight(px, pz, e.position.y + 1);
    }
    current = null;
    if (game.player) game.player.vehicle = null;
    v.driver = null;
    v.lastUsed = game.time;
    v.lastDriverAt = game.time;
    v.entity.engineOff = true;
    v.awake = true;
    if (v.record) v.record.lightsOff = true;
    if (v.mode === 'cyclist') e.riderless = true;
    if (v.mode === 'car' && e === taxiEntity) setTaxiLights(false);
    e.carState && (e.carState.value.x = e.carState.value.w = 0);
    if (v.mode === 'boat') lastShore = null;

    person.position.set(px, py, pz);
    person.prevX = px;
    person.prevZ = pz;
    person.heading = h;
    person.velX = bail ? Math.sin(h) * (e.speed || 0) * 0.35 : 0;
    person.velZ = bail ? Math.cos(h) * (e.speed || 0) * 0.35 : 0;
    person.speed = person.verticalVel = 0;
    person.jumping = false;
    person.jumpPrep = 0;
    person.landingSpeed = 0;
    person.hidden = false;
    person.rig.placed = false;
    // over the harbour: the person falls into it (and does not get pushed ashore on the way down)
    person.overWater = airborne && shoreDistance(px, pz) < 0;
    cm.resetInput();
    cm.setMode('person');
    exitEvent.vehicle = v;
    exitEvent.bailed = bail;
    exitEvent.x = px;
    exitEvent.z = pz;
    game.emit('vehicle:exited', exitEvent);
    game.emit('player:mode', { mode: 'person', vehicle: null });
    if (bail && game.player) {
      const speed = Math.abs(e.speed || 0);
      game.player.damage(Math.max(0, speed - 8) * 2.2, { kind: 'fall', source: v });
      if (game.player.alive) game.player.knockDown(Math.sin(h), Math.cos(h), 2.2);
    }
    return true;
  }

  // Press F: out if in, in if near something
  function toggle() {
    if (current) {
      const speed = Math.abs(current.entity.speed || 0);
      if (current.mode === 'helicopter') return exit();
      if (current.mode === 'cyclist') return exit({ bail: speed > 5 });
      if (current.mode === 'boat') {
        if (speed > 4.5) return notice('Slow her down first (hold S / LT to brake), then step ashore.'), false;
        if (!findAshore(current.entity)) return notice('Bring her alongside a wharf or the shore to step off.'), false;
        return exit();
      }
      if (speed < 2.5) return exit();
      if (speed < 14) {
        action = { type: 'stop', t: 0 };
        return true;
      }
      return exit({ bail: true });
    }
    if (action) return false;
    const cand = findCandidate();
    if (cand.vehicle) return enter(cand.vehicle, { instant: cand.vehicle.mode === 'boat' });
    if (cand.record) {
      startJack(cand.record);
      return true;
    }
    return false;
  }

  function updateAction(dt) {
    if (!action) return;
    action.t += dt;
    if (action.type === 'stop') {
      const e = current?.entity;
      if (!e) {
        action = null;
        return;
      }
      // a firm stop (about 0.9 g), then out
      e.speed = Math.sign(e.speed) * Math.max(0, Math.abs(e.speed) - 9 * dt);
      const k = Math.exp(-6 * dt);
      if (e.vx) e.vx *= k;
      if (e.vz) e.vz *= k;
      if (e.carState) e.carState.value.x = 1;
      if (Math.abs(e.speed) < 1.2 || action.t > 4) exit();
      return;
    }
    // walking (running) to the door
    let x, z, heading, hw;
    if (action.type === 'jack') {
      const r = action.record;
      if (!r.edge || r.detached) {
        action = null;
        return;
      }
      traffic.game.stop(r, 2);
      x = r.x;
      z = r.z;
      heading = r.yaw + r.yawOffset;
      hw = r.halfWidth;
      doorPoint(r.bodyType, x, z, heading, hw, door);
    } else {
      const e = action.vehicle.entity;
      x = e.position.x;
      z = e.position.z;
      heading = e.heading;
      hw = action.vehicle.halfW;
      doorPoint(action.vehicle.kind, x, z, heading, hw, door);
    }
    const p = person.position;
    const dx = door.x - p.x, dz = door.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 9 || action.t > 4) {
      action = null;
      return;
    }
    const step = Math.min(d, 6 * dt);
    if (d > 1e-3) {
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      person.heading = Math.atan2(dx, dz);
    }
    person.velX = person.velZ = 0;
    const arrived = d < 0.35 || action.t > 1.2;
    if (action.type === 'enter') {
      if (arrived) board(action.vehicle, false, -1);
      return;
    }
    // carjack: once the car has (nearly) stopped, open the door, throw the driver out, take the seat
    const r = action.record;
    if (arrived && r.speed < 1.4) {
      const fromX = p.x, fromZ = p.z;
      traffic.game.detach(r);
      const victim = world.spawnFleeingPed(door.x + Math.cos(heading) * -0.4, door.z - Math.sin(heading) * -0.4, x, z, 7);
      const entity = createProxy(r.bodyType, r.x, r.gy, r.z, heading);
      const v = makeVehicle(r.bodyType, entity, r, { police: r.isPolice });
      world.panic(fromX, fromZ, 18, { duration: 6, cower: 0.15 });
      board(v, true, victim);
    }
  }

  // =================================================================================================================
  // SPAWNING, ADOPTING, REMOVING
  // =================================================================================================================
  /**
   * A new world vehicle: kind 'taxi' | 'sedan' | 'suv' | 'minivan' | 'pickup' | 'van' | 'police' | 'police-suv'.
   * opts: paint (hex), police, persistent (never despawned), locked (the player cannot get in), label, health.
   * Returns the vehicle or null (no reserve car left of that kind).
   */
  function spawn(kind, x, z, heading = 0, opts = {}) {
    let police = !!opts.police;
    if (kind === 'police') { kind = 'sedan'; police = true; }
    else if (kind === 'police-suv') { kind = 'suv'; police = true; }
    if (!CAR_KINDS.includes(kind)) return null;
    let r = traffic.game.acquire(kind, police);
    if (!r) {
      // none in reserve: borrow a traffic car of that kind nobody is looking at
      for (const c of world.cars) {
        const rec = c.record;
        if (!c.active || rec.bodyType !== kind || !!rec.isPolice !== police) continue;
        if (traffic.game.nearView(c.x, c.z, 4, 260)) continue;
        traffic.game.detach(rec);
        r = rec;
        break;
      }
    }
    if (!r) return null;
    const y = world.groundHeight(x, z);
    r.x = r.prevX = x;
    r.z = r.prevZ = z;
    r.gy = y;
    r.yaw = heading;
    r.yawOffset = r.gp = r.gr = r.pitch = r.roll = r.steer = 0;
    const entity = createProxy(kind, x, y, z, heading);
    const v = makeVehicle(kind, entity, r, { police, persistent: opts.persistent, locked: opts.locked, label: opts.label });
    if (opts.paint != null) {
      const col = new THREE.Color(opts.paint);
      r.paint[0] = Math.fround(col.r);
      r.paint[1] = Math.fround(col.g);
      r.paint[2] = Math.fround(col.b);
    }
    if (opts.health != null) v.health = opts.health;
    v.awake = false;
    game.emit('vehicle:spawned', { vehicle: v });
    return v;
  }

  /** Takes a traffic car (CarView or id) off the road as a world vehicle, as it drives (no driver unless setControls) */
  function adopt(carOrId, opts = {}) {
    const view = typeof carOrId === 'object' ? carOrId : world.cars[carOrId];
    const r = view?.record;
    if (!r || !r.edge || r.bus) return null;
    const heading = r.yaw + r.yawOffset;
    const speed = r.speed;
    traffic.game.detach(r);
    const entity = createProxy(r.bodyType, r.x, r.gy, r.z, heading);
    entity.speed = speed;
    const v = makeVehicle(r.bodyType, entity, r, { police: r.isPolice, persistent: opts.persistent, locked: opts.locked });
    v.health = r.health ?? 100;
    if (opts.evict) world.spawnFleeingPed(doorPoint(r.bodyType, r.x, r.z, heading, r.halfWidth, door).x, door.z, r.x, r.z, 6);
    return v;
  }

  /** Removes a world vehicle (hero ones go home instead) */
  function remove(v) {
    if (!v || v === current) return false;
    if (v.hero) {
      sendHome(v);
      return true;
    }
    stopEffects(v);
    if (v.record) {
      const r = v.record;
      if (v.restore) {
        r.paint[0] = v.restore.paint[0];
        r.paint[1] = v.restore.paint[1];
        r.paint[2] = v.restore.paint[2];
        r.style = v.restore.style;
        r.isPolice = v.restore.isPolice;
      }
      r.worldVehicle = null;
      traffic.game.release(r);
    }
    v.hidden = true;
    const i = vehicles.indexOf(v);
    if (i >= 0) vehicles.splice(i, 1);
    if (cm.entities.car === v.entity) cm.setEntity('car', taxiEntity);
    game.emit('vehicle:removed', { vehicle: v });
    return true;
  }

  /** AI driving for world vehicles (police, missions): throttle -1..1, steer +1 left .. -1 right; null hands it back */
  function setControls(v, throttle, steer = 0) {
    if (!v || v === current) return;
    if (throttle === null) {
      v.driver = null;
      v.entity.engineOff = true;
      if (v.record) v.record.lightsOff = true;
      return;
    }
    v.driver = 'ai';
    v.controls.throttle = clamp(throttle, -1, 1);
    v.controls.steer = clamp(steer, -1, 1);
    v.entity.engineOff = false;
    v.awake = true;
    if (v.record) v.record.lightsOff = false;
  }

  function sendHome(v) {
    stopEffects(v);
    const e = v.entity;
    const h = v.home;
    const y = v.mode === 'helicopter' ? padY : v.mode === 'boat' ? ISLAND_BOUNDS.waterLevel
      : v.mode === 'scooter' ? h.y : world.groundHeight(h.x, h.z);
    e.position.set(h.x, y, h.z);
    e.heading = h.heading;
    e.speed = e.vx = e.vz = e.angularVel = 0;
    if (v.mode === 'boat') {
      e.moored = true;
      e.sailsUp = false;
      e.sailShow = 0;
      poseSailboat(e, 0.016, game.time);
    }
    if (v.mode === 'helicopter') {
      e.verticalSpeed = 0;
      e.rotorSpeed = 0;
    }
    if (v.mode === 'scooter') {
      e.leanAngle = e.leanPivot.rotation.z = e.steerPivot.rotation.y = 0;
      cm.rideGround(e, SCOOTER.axle, 0, 1);
      syncScooterMesh(e);
    }
    e.prevX = h.x;
    e.prevZ = h.z;
    v.health = 100;
    v.state = 'ok';
    v.hidden = false;
    v.respawnPending = false;
    v.awake = v.mode === 'boat';
    e.mesh.visible = true;
  }

  // =================================================================================================================
  // DAMAGE
  // =================================================================================================================
  const dmgEvent = { target: null, amount: 0, health: 0, state: '', source: null, kind: '', byPlayer: false, x: 0, y: 0, z: 0 };
  const stateEvent = { target: null, state: '', prev: '' };

  function emitDamage(type, target, amount, health, state, opts, x, y, z) {
    dmgEvent.target = target;
    dmgEvent.amount = amount;
    dmgEvent.health = health;
    dmgEvent.state = state;
    dmgEvent.source = opts?.source ?? null;
    dmgEvent.kind = opts?.kind || 'unknown';
    dmgEvent.byPlayer = opts?.byPlayer ?? opts?.source === 'player';
    dmgEvent.x = opts?.x ?? x;
    dmgEvent.y = opts?.y ?? y;
    dmgEvent.z = opts?.z ?? z;
    game.emit(type, dmgEvent);
  }

  /** Damages a world vehicle. opts: { source, kind ('collision' | 'melee'), byPlayer, x, y, z } */
  function damage(v, amount, opts = null) {
    if (!v || v.hidden || !(amount > 0) || v.state === 'wrecked') return;
    const p = v.entity.position;
    emitDamage('vehicle:hit', v, amount, v.health, v.state, opts, p.x, p.y + 0.8, p.z);
    if (v.mode === 'cyclist' || v.mode === 'boat' || v.invulnerable) return; // (a bicycle or a boat takes knocks, not damage)
    v.health -= amount;
    v.lastHitBy = opts?.source ?? null;
    v.lastHitByPlayer = opts?.byPlayer ?? opts?.source === 'player';
    v.awake = true;
    const next = v.health <= HEALTH.wreck ? 'wrecked' : v.health <= HEALTH.smoke ? 'smoking' : v.state;
    emitDamage('vehicle:damaged', v, amount, v.health, next, opts, p.x, p.y + 0.8, p.z);
    refreshState(v);
  }

  function setState(v, state) {
    if (v.state === state) return;
    stateEvent.prev = v.state;
    v.state = state;
    stateEvent.target = v;
    stateEvent.state = state;
    game.emit('vehicle:state', stateEvent);
  }

  function refreshState(v) {
    if (v.state === 'wrecked') return;
    if (v.health <= HEALTH.wreck) wreckVehicle(v);
    else if (v.health <= HEALTH.smoke) setState(v, 'smoking');
  }

  // The engine bay (front of a car, the helicopter's turbines) for the smoke
  const bay = { x: 0, y: 0, z: 0 };
  function engineBay(x, y, z, heading, kind, hl, out) {
    const ahead = kind === 'helicopter' ? -0.6 : hl * 0.62;
    out.x = x + Math.sin(heading) * ahead;
    out.y = y + (kind === 'helicopter' ? 2.4 : 0.95);
    out.z = z + Math.cos(heading) * ahead;
    return out;
  }

  function updateEffects(v) {
    const e = v.entity;
    engineBay(e.position.x, e.position.y, e.position.z, e.heading, v.kind, v.halfL, bay);
    if (v.state === 'smoking' || (v.state === 'wrecked' && game.time < v.wreckSmokeUntil)) {
      if (!v.smoke) v.smoke = fx.smokeEmitter(bay.x, bay.y, bay.z);
      const wreck = v.state === 'wrecked';
      const heavy = wreck || v.health <= HEALTH.heavy;
      // (a wreck pours it out at first, then dies down)
      const fade = wreck ? Math.max(0.25, Math.min(1, (v.wreckSmokeUntil - game.time) / (WRECK_SMOKE * 0.6))) : 1;
      v.smoke.rate = wreck ? 14 * fade : heavy ? 11 : 4;
      v.smoke.color = wreck ? 0x2a2928 : heavy ? 0x3a3a3a : 0x8a8a8a;
      v.smoke.alpha = heavy ? 0.6 : 0.4;
      v.smoke.size = wreck ? 1.4 : heavy ? 1.2 : 0.8;
      v.smoke.set(bay.x, bay.y, bay.z);
    } else if (v.smoke) {
      v.smoke.stop();
      v.smoke = null;
    }
  }

  function stopEffects(v) {
    if (v.smoke) v.smoke.stop();
    v.smoke = null;
  }

  // Wrecked: the engine dies with a bang of the bonnet and a cloud of steam and smoke; the car stalls where it is,
  // battered, its lamps out, and can't be driven again (it is cleared away later; a hero vehicle goes home)
  const wreckedEvent = { target: null, x: 0, y: 0, z: 0, byPlayer: false, source: null };
  const WRECK_PUFF = { count: 14, size: 1.5, life: 2.6, color: 0x5a5856, alpha: 0.55, rise: 1.2, spread: 0.9, grow: 2.5 };
  const notice = (text) => (typeof game.ui?.help === 'function' ? game.ui.help(text, 3.5) : game.ui?.toast?.(text, 3));
  function wreckVehicle(v) {
    if (v.state === 'wrecked') return;
    const e = v.entity;
    setState(v, 'wrecked');
    v.health = Math.min(v.health, 0);
    v.wreckSmokeUntil = game.time + WRECK_SMOKE;
    v.awake = true;
    e.engineOff = true;
    if (v.driver === 'ai') v.driver = null;
    engineBay(e.position.x, e.position.y, e.position.z, e.heading, v.kind, v.halfL, bay);
    fx.smoke(bay.x, bay.y, bay.z, WRECK_PUFF);
    fx.sparks(bay.x, bay.y, bay.z, 0, 1, 0, 10, 3.5, 0.5);
    if (v.record) {
      for (let k = 0; k < 3; k++) v.record.paint[k] *= WRECK_DARKEN;
      v.record.lightsOff = true;
    }
    // the player inside climbs out (thrown out if it is still going fast)
    if (v === current) {
      e.speed = (e.speed || 0) * 0.35;
      const fast = Math.abs(e.speed) > 9;
      exit({ bail: fast && v.mode !== 'helicopter' });
      notice(v.mode === 'helicopter' ? 'That\'s the chopper cooked.' : 'Engine\'s cooked. Find another ride.');
    }
    // a hero vehicle is fetched home and mended once nobody's looking
    if (v.hero) v.respawnPending = true;
    wreckedEvent.target = v;
    wreckedEvent.x = e.position.x;
    wreckedEvent.y = e.position.y;
    wreckedEvent.z = e.position.z;
    wreckedEvent.byPlayer = v.lastHitByPlayer;
    wreckedEvent.source = v.lastHitBy;
    game.emit('vehicle:wrecked', wreckedEvent);
  }

  // Traffic cars take damage as they drive: smoke from the bonnet; wrecked, the driver gets out and walks off and the
  // car becomes a (wrecked) world vehicle
  const smokingTraffic = [];
  function damageTraffic(r, amount, opts = null) {
    if (!(amount > 0) || r.bus) return;
    if (r.worldVehicle) {
      damage(r.worldVehicle, amount, opts);
      return;
    }
    if (!r.edge) return;
    const view = r.view;
    emitDamage('vehicle:hit', view, amount, r.health ?? 100, '', opts, r.x, r.gy + 0.8, r.z);
    r.health = (r.health ?? 100) - amount;
    emitDamage('vehicle:damaged', view, amount, r.health, r.health <= HEALTH.wreck ? 'wrecked' : r.health <= HEALTH.smoke ? 'smoking' : 'ok', opts, r.x, r.gy + 0.8, r.z);
    if (r.health <= HEALTH.wreck) {
      // the driver gets out and legs it; the car rolls to a stop, dead
      const heading = r.yaw + r.yawOffset;
      doorPoint(r.bodyType, r.x, r.z, heading, r.halfWidth, door);
      world.spawnFleeingPed(door.x, door.z, r.x, r.z, 8);
      const v = adopt(view);
      if (v) {
        v.health = r.health;
        v.lastHitBy = opts?.source ?? null;
        v.lastHitByPlayer = opts?.byPlayer ?? opts?.source === 'player';
        refreshState(v);
      }
      return;
    }
    if (r.health <= HEALTH.smoke && !smokingTraffic.some((t) => t.record === r)) {
      smokingTraffic.push({ record: r, emitter: fx.smokeEmitter(r.x, r.gy + 1, r.z) });
    }
  }

  function updateSmokingTraffic() {
    for (let i = smokingTraffic.length - 1; i >= 0; i--) {
      const t = smokingTraffic[i];
      const r = t.record;
      if (!r.edge || r.worldVehicle || (r.health ?? 100) > HEALTH.smoke) {
        t.emitter.stop();
        smokingTraffic.splice(i, 1);
        continue;
      }
      engineBay(r.x, r.gy, r.z, r.yaw + r.yawOffset, r.bodyType, r.halfL ?? 2.2, bay);
      const heavy = r.health <= HEALTH.heavy;
      t.emitter.set(bay.x, bay.y, bay.z);
      t.emitter.rate = heavy ? 10 : 4;
      t.emitter.color = heavy ? 0x353535 : 0x8a8a8a;
      t.emitter.size = heavy ? 1.1 : 0.8;
    }
  }

  // Collisions reported by the controllers (buildings, the ground, the world vehicles' own contacts) and traffic
  function vehicleOf(obj) {
    if (!obj) return null;
    if (obj.worldVehicle) return obj.worldVehicle;
    return null;
  }

  function collisionDamage(obj, other, speed, kind, x, y, z) {
    const target = vehicleOf(obj) || (obj.edge !== undefined && obj.view ? obj : null);
    if (!target) return;
    // a helicopter on the ground with "descend" still held keeps its sink rate, and would hit the ground again every
    // frame: the touchdown takes it (the hit below), then it rests
    if (kind === 'ground' && target.mode === 'helicopter' && obj.verticalSpeed < 0) obj.verticalSpeed = 0;
    const now = game.time;
    if (now - (target._hitAt ?? -Infinity) < 0.25 && speed < (target._hitSpeed || 0) * 1.6) return;
    target._hitAt = now;
    target._hitSpeed = speed;
    const myMass = target.mass ?? 1600;
    const otherMass = kind === 'building' ? myMass : other?.mass ?? other?.worldVehicle?.mass ?? 1600;
    let amount = Math.max(0, speed - 4) * 2.2 * (kind === 'building' ? 1 : clamp((2 * otherMass) / (myMass + otherMass), 0.3, 1.8));
    // (a helicopter set down with "descend" held all the way meets the ground at its full 16 m/s sink: a firm landing
    // for a player, not a write-off; only a real drop does damage)
    if (kind === 'ground') amount = target.mode === 'helicopter' ? Math.max(0, speed - 13) * 8 : Math.max(0, speed - 5) * 9;
    // (a helicopter settling beside a roof edge is pushed off it every frame at its sink rate: a scrape, not a crash;
    // flown into a wall at speed it still hurts)
    else if (kind === 'building' && target.mode === 'helicopter') amount = Math.max(0, speed - 10) * 2.2;
    // (the player's own ride is a little tougher: a chase through traffic should take a few big hits, not three)
    else if (target === current) amount *= PLAYER_CRASH_SHARE;
    if (amount <= 0) return;
    const otherV = vehicleOf(other);
    const byPlayer = !!current && (otherV === current || other === current?.entity);
    const opts = { source: byPlayer ? 'player' : other, kind: 'collision', byPlayer, x, y, z };
    if (target.type === 'world') damage(target, amount, opts);
    else damageTraffic(target, amount, opts);
    // the player feels a big one
    if (target === current && game.player) {
      if (current.mode === 'car') game.player.damage(Math.max(0, speed - 13) * 2.2, { kind: 'crash', source: other });
      else if ((current.mode === 'cyclist' || current.mode === 'scooter') && speed > 7) {
        game.player.damage((speed - 5) * 5, { kind: 'crash', source: other });
        exit({ bail: true });
      }
    }
  }

  function onCollision(event) {
    const { a, b, kind, speed } = event;
    if (kind === 'pedestrian') {
      if (a === person && game.player) game.player.hitByVehicle(speed, event.nx, event.nz, b);
      return;
    }
    collisionDamage(a, b, speed, kind, event.x, event.y, event.z);
    if (kind === 'vehicle') collisionDamage(b, a, speed, kind, event.x, event.y, event.z);
  }
  const offControllers = cm.addCollisionListener(onCollision);
  const offTraffic = traffic.addCollisionListener(onCollision);

  // =================================================================================================================
  // SIMULATION of the vehicles nobody (or game AI) drives
  // =================================================================================================================
  const bodyA = {}, bodyB = {}, contact = {};
  function readBody(v, body) {
    const e = v.entity;
    body.x = e.position.x;
    body.z = e.position.z;
    body.prevX = e.prevX ?? e.position.x;
    body.prevZ = e.prevZ ?? e.position.z;
    body.sin = Math.sin(e.heading);
    body.cos = Math.cos(e.heading);
    body.halfW = v.halfW;
    body.halfL = v.halfL;
    body.mass = v.mass;
    body.vx = body.sin * (e.speed || 0) + (e.vx || 0);
    body.vz = body.cos * (e.speed || 0) + (e.vz || 0);
    body.angularVel = e.angularVel || 0;
  }
  function writeBody(v, body) {
    const e = v.entity;
    e.speed = body.vx * body.sin + body.vz * body.cos;
    if (v.mode === 'car') {
      e.vx = body.vx - body.sin * e.speed;
      e.vz = body.vz - body.cos * e.speed;
      e.angularVel = body.angularVel;
    }
    v.awake = true;
  }

  // World vehicles against each other (the player's car into a parked one, a rolling one into another)
  function collideVehicles() {
    for (let i = 0; i < vehicles.length; i++) {
      const a = vehicles[i];
      if (a.hidden) continue;
      const ea = a.entity;
      const movingA = a.driver || a.awake;
      for (let j = i + 1; j < vehicles.length; j++) {
        const b = vehicles[j];
        if (b.hidden || (!movingA && !(b.driver || b.awake))) continue;
        const eb = b.entity;
        if (Math.abs(ea.position.y - eb.position.y) > 2.5) continue;
        const reach = a.halfL + b.halfL + 1;
        if (Math.abs(ea.position.x - eb.position.x) > reach || Math.abs(ea.position.z - eb.position.z) > reach) continue;
        readBody(a, bodyA);
        readBody(b, bodyB);
        if (!sweptVehicleContact(bodyA, bodyB, contact) && !vehicleContact(bodyA, bodyB, contact)) continue;
        const speed = resolveVehicleContact(bodyA, bodyB, contact);
        const share = bodyB.mass / (bodyA.mass + bodyB.mass);
        ea.position.x = contact.ax + contact.nx * contact.depth * share;
        ea.position.z = contact.az + contact.nz * contact.depth * share;
        eb.position.x = contact.bx - contact.nx * contact.depth * (1 - share);
        eb.position.z = contact.bz - contact.nz * contact.depth * (1 - share);
        if (speed <= 0) continue;
        writeBody(a, bodyA);
        writeBody(b, bodyB);
        cm.reportCollision(ea, eb, 'vehicle', contact.x, Math.max(ea.position.y, eb.position.y) + 0.6, contact.z, contact.nx, 0, contact.nz, speed);
      }
    }
  }

  // The player on foot against world vehicles: pushed out of their bodies, and hit by the moving ones
  function collidePerson() {
    if (current || person.hidden) return;
    const p = person.position;
    for (const v of vehicles) {
      if (v.hidden || v.mode === 'boat') continue;
      const e = v.entity;
      if (Math.abs(e.position.y - p.y) > (v.mode === 'helicopter' ? 3.2 : 1.8)) continue;
      const dx = p.x - e.position.x, dz = p.z - e.position.z;
      if (Math.abs(dx) > v.halfL + 1 || Math.abs(dz) > v.halfL + 1) continue;
      const s = Math.sin(e.heading), c = Math.cos(e.heading);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const r = 0.36;
      const qx = clamp(lx, -v.halfW, v.halfW), qz = clamp(lz, -v.halfL, v.halfL);
      let ox = lx - qx, oz = lz - qz;
      let d = Math.hypot(ox, oz);
      if (d >= r) continue;
      let depth;
      if (d > 1e-6) {
        ox /= d;
        oz /= d;
        depth = r - d;
      } else if (v.halfW - Math.abs(lx) < v.halfL - Math.abs(lz)) {
        ox = lx < 0 ? -1 : 1;
        oz = 0;
        depth = v.halfW - Math.abs(lx) + r;
      } else {
        ox = 0;
        oz = lz < 0 ? -1 : 1;
        depth = v.halfL - Math.abs(lz) + r;
      }
      // back to world: x = lx * c + lz * s, z = -lx * s + lz * c
      const nx = ox * c + oz * s, nz = -ox * s + oz * c;
      p.x += nx * depth;
      p.z += nz * depth;
      const vvx = s * (e.speed || 0) + (e.vx || 0), vvz = c * (e.speed || 0) + (e.vz || 0);
      const closing = (vvx - (person.velX || 0)) * nx + (vvz - (person.velZ || 0)) * nz;
      const into = (person.velX || 0) * nx + (person.velZ || 0) * nz;
      if (into < 0) {
        person.velX -= into * nx;
        person.velZ -= into * nz;
      }
      if (closing > 2.5 && game.player) game.player.hitByVehicle(closing, nx, nz, v);
    }
  }

  // People in the way of a moving world vehicle (the player's car above all) are run down; with game AI at the wheel
  // (the police, a job's drivers) the driver swerves at the last moment and they dive clear, unhurt
  const pedHitOpts = { source: null, byPlayer: false, kind: 'vehicle', dirX: 0, dirZ: 0 };
  const crowd = traffic.pedestrians;
  function runOver(v) {
    const e = v.entity;
    const speed = Math.abs(e.speed || 0);
    if (speed < 3 || v.mode === 'helicopter' && e.position.y - terrainHeight(e.position.x, e.position.z) > 1.5) return;
    const s = Math.sin(e.heading), c = Math.cos(e.heading);
    const peds = world.peds;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (!p.active || !p.alive) continue;
      const dx = p.x - e.position.x, dz = p.z - e.position.z;
      if (Math.abs(dx) > v.halfL + 1 || Math.abs(dz) > v.halfL + 1 || Math.abs(p.y - e.position.y) > 2) continue;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) > v.halfW + 0.3 || Math.abs(lz) > v.halfL + 0.3) continue;
      if (v.driver === 'ai') {
        const side = lx < 0 ? -1 : 1; // (out to the side they are on: the car's right is (cos h, -sin h))
        crowd.knock?.(p.id, c * side, -s * side);
        continue;
      }
      const byPlayer = v.driver === 'player' || (v.lastDriver === 'player' && game.time - v.lastDriverAt < 5);
      pedHitOpts.source = byPlayer ? 'player' : v;
      pedHitOpts.byPlayer = byPlayer;
      pedHitOpts.dirX = Math.sign(e.speed) * s;
      pedHitOpts.dirZ = Math.sign(e.speed) * c;
      if (speed > 7) world.killPed(p.id, pedHitOpts);
      else world.hurtPed(p.id, (speed - 2.5) * 22, pedHitOpts);
    }
  }

  function simulate(v, dt) {
    const e = v.entity;
    e.prevX = e.position.x;
    e.prevZ = e.position.z;
    if (v.mode === 'car') {
      if (v.driver === 'ai' && v.state !== 'wrecked') {
        cm.simulateCar(e, dt, v.controls.throttle, v.controls.steer);
      } else {
        cm.simulateCar(e, dt, 0, 0);
        // parking brake: a car left rolling stops within a few seconds
        const brake = (v.state === 'wrecked' ? 6 : 2.6) * dt;
        e.speed = Math.sign(e.speed) * Math.max(0, Math.abs(e.speed) - brake);
      }
      if (e.carState) e.carState.value.x = e.carState.value.w = 0;
      if (v.driver !== 'ai' && Math.abs(e.speed) < 0.04 && Math.hypot(e.vx, e.vz) < 0.04 && Math.abs(e.angularVel) < 0.02
        && Math.abs(e.pitchVel) < 0.02 && Math.abs(e.rollVel) < 0.02 && Math.abs(e.heaveVel) < 0.02) {
        e.speed = e.vx = e.vz = e.angularVel = 0;
        v.awake = false;
      }
      // a hero taxi not in the controllers' hands moves its own mesh
      if (e === taxiEntity && cm.entities.car !== taxiEntity) {
        e.mesh.position.copy(e.position);
        e.mesh.rotation.set(e.groundPitch || 0, e.heading, e.groundRoll || 0, 'YXZ');
        e.chassisPivot.position.y = e.heaveY;
      }
    } else if (v.mode === 'helicopter') {
      // unpiloted: the rotors run down and it sinks, faster and faster; a hard landing is a crash
      e.rotorSpeed = Math.max(0, (e.rotorSpeed ?? 0) - dt * 0.3);
      const floor = Math.max(terrainHeight(e.position.x, e.position.z), ISLAND_BOUNDS.waterLevel) + 0.25;
      const lift = 9.8 * Math.min(1, (e.rotorSpeed ?? 0) * 1.05) ** 2;
      e.verticalSpeed = (e.verticalSpeed || 0) + (lift - 9.8) * dt;
      e.speed *= Math.exp(-dt * 0.6);
      e.position.x += Math.sin(e.heading) * e.speed * dt;
      e.position.z += Math.cos(e.heading) * e.speed * dt;
      e.position.y += e.verticalSpeed * dt;
      if (e.position.y <= floor) {
        const impact = -e.verticalSpeed;
        e.position.y = floor;
        e.verticalSpeed = 0;
        e.speed *= 0.3;
        if (impact > 1) cm.reportCollision(e, GROUND, 'ground', e.position.x, floor, e.position.z, 0, 1, 0, impact);
      }
      cm.resolveHorizontalCollision(e.position, 4.5, null, e);
      e.tiltPivot.rotation.x *= Math.exp(-dt * 2);
      e.tiltPivot.rotation.z *= Math.exp(-dt * 2);
      e.tiltPivot.position.y = 0;
      if (e.position.y <= floor + 0.01 && Math.abs(e.speed) < 0.05 && e.rotorSpeed <= 0) v.awake = false;
    } else if (v.mode === 'boat') {
      // tied up: she rides the swell where she was left; cast off (left at sea), she drifts, slowing, downwind
      if (e.moored) {
        e.speed = 0;
        e.turnRate = 0;
        e.power = 0;
        poseSailboat(e, dt, game.time);
      } else {
        stepSailboat(e, 0, 0, dt, game.time);
      }
    } else if (v.mode === 'scooter') {
      cm.simulateScooter(e, dt);
      if (e.speed === 0 && Math.abs(e.leanAngle) < 0.01 && Math.abs(e.steerPivot.rotation.y) < 0.01) {
        e.leanAngle = e.leanPivot.rotation.z = e.steerPivot.rotation.y = 0;
        v.awake = false;
      }
    } else if (v.mode === 'cyclist') {
      e.speed *= Math.exp(-dt * 2.5);
      e.position.x += Math.sin(e.heading) * e.speed * dt;
      e.position.z += Math.cos(e.heading) * e.speed * dt;
      cm.resolveHorizontalCollision(e.position, 0.65, null, e);
      e.position.y = cm.getGroundHeight(e.position.x, e.position.z, 'cyclist', e.position.y);
      e.leanAngle *= Math.exp(-dt * 6);
      e.leanPivot.rotation.z = e.leanAngle;
      if (Math.abs(e.speed) < 0.05) {
        e.speed = 0;
        v.awake = false;
      }
    }
  }
  const GROUND = { type: 'ground' };

  // =================================================================================================================
  // EVERY FRAME
  // =================================================================================================================
  function syncRecords() {
    for (const v of vehicles) {
      const r = v.record;
      if (!r) continue;
      const e = v.entity;
      r.prevX = r.x;
      r.prevZ = r.z;
      r.x = e.position.x;
      r.z = e.position.z;
      r.gy = e.position.y + (e.heaveY || 0);
      r.yaw = e.heading;
      r.yawOffset = 0;
      r.gp = e.groundPitch || 0;
      r.gr = e.groundRoll || 0;
      r.pitch = e.chassisPivot.rotation.x;
      r.roll = e.chassisPivot.rotation.z;
      r.steer = e.steerAngle || 0;
      r.speed = Math.abs(e.speed || 0);
      r.acc = e.carState && e.carState.value.x > 0.5 ? -3 : 0;
      r.blink = 0;
      r.shown = !v.hidden;
      r.lightsOff = v.state === 'wrecked' || !v.driver;
    }
  }
  traffic.game.setRenderHook(syncRecords);
  traffic.game.setObstacles(obstacles);

  function refreshObstacles() {
    obstacles.length = 0;
    for (const v of vehicles) if (!v.hidden && v !== current) obstacles.push(v.entity);
  }

  function despawn() {
    const p = cm.getActiveEntity().position;
    let count = 0;
    let oldest = null;
    for (const v of vehicles) {
      if (v.hero || v.persistent) continue;
      count++;
      if (v === current || v.driver) continue;
      const e = v.entity;
      const far = Math.hypot(e.position.x - p.x, e.position.z - p.z) > 140 && !traffic.game.nearView(e.position.x, e.position.z, v.halfL + 2, 400);
      if (!far) continue;
      // wrecks and long-abandoned cars go anyway after a while
      if ((v.state === 'wrecked' && game.time - v.lastUsed > 90) || game.time - v.lastUsed > 600) {
        remove(v);
        return;
      }
      if (!oldest || v.lastUsed < oldest.lastUsed) oldest = v;
    }
    if (count > WORLD_CAP && oldest) remove(oldest);
  }

  function updateHeroes() {
    const p = cm.getActiveEntity().position;
    // a sailboat left somewhere else for a few minutes, out of sight, goes back to her berth (unless it's taken)
    for (const v of heroBoats) {
      if (v === current) continue;
      const e = v.entity, h = v.home;
      if (Math.hypot(e.position.x - h.x, e.position.z - h.z) < 6 || game.time - v.lastUsed < 180) continue;
      if (Math.hypot(e.position.x - p.x, e.position.z - p.z) < 500 || Math.hypot(h.x - p.x, h.z - p.z) < 500) continue;
      if (heroBoats.some((o) => o !== v && Math.hypot(o.entity.position.x - h.x, o.entity.position.z - h.z) < 10)) continue;
      sendHome(v);
    }
    for (const v of scooters) {
      if (v.driver || v.awake || action?.vehicle === v || game.time - v.lastUsed < SCOOTER_RETURN_TIME) continue;
      const e = v.entity, h = v.home;
      if (Math.hypot(e.position.x - h.x, e.position.z - h.z) < 4) continue;
      if (Math.hypot(e.position.x - p.x, e.position.z - p.z) < 120 || Math.hypot(h.x - p.x, h.z - p.z) < 120) continue;
      if (traffic.game.nearView(e.position.x, e.position.z, 2, 300) || traffic.game.nearView(h.x, h.z, 2, 300)) continue;
      if (nearest(h.x, h.z, 2) || !clearForPerson(h.x, h.z, h.y, false)) continue;
      sendHome(v);
    }
    for (const v of [heroTaxi, heroBike, heroHeli]) {
      if (!v.respawnPending) continue;
      const h = v.home;
      // (neither where it's going nor where the wreck stands in view: it doesn't vanish under the player's nose)
      if (Math.hypot(h.x - p.x, h.z - p.z) > 120 && !traffic.game.nearView(h.x, h.z, 6, 400) && !traffic.game.nearView(v.x, v.z, 6, 400)) sendHome(v);
    }
  }

  function promptText() {
    if (current || action || !game.player?.alive || game.state !== 'playing') return null;
    const cand = findCandidate();
    if (!cand.vehicle && !cand.record) return null;
    const label = cand.vehicle ? cand.vehicle.label : KINDS[cand.record.bodyType]?.[cand.record.isPolice ? 'police' : 'label'] || 'Car';
    return `${game.input.label('enterExit')} — ${cand.verb} ${label}`;
  }

  function update(dt) {
    if (game.state === 'playing' && game.input.pressed('enterExit') && game.player?.alive) toggle();
    if (dt > 0) {
      updateAction(dt);
      for (const v of vehicles) {
        if (v.hidden || v === current) continue;
        if (v.driver === 'ai' || v.awake || v.mode === 'boat') simulate(v, dt);
      }
      collideVehicles();
      collidePerson();
      for (const v of vehicles) {
        if (v.hidden) continue;
        if ((v === current || v.awake || v.driver) && v.mode !== 'cyclist' && v.mode !== 'scooter' && v.mode !== 'boat') runOver(v);
        if (v.state !== 'ok') updateEffects(v);
      }
      updateSmokingTraffic();
    }
    // the helicopter's rotors spin up under the player, and the person rides along (hidden) in whatever it is in
    if (current) {
      const e = current.entity;
      if (current.mode === 'helicopter') e.rotorSpeed = Math.min(1, (e.rotorSpeed ?? 0) + dt * 0.5);
      person.position.copy(e.position);
      person.heading = e.heading;
    }
    // the sync fields everyone may read
    for (const v of vehicles) {
      const e = v.entity;
      if (v.mode === 'scooter' && (v === current || v.awake || v.x !== e.position.x || v.z !== e.position.z || v.speed !== e.speed)) syncScooterMesh(e);
      if (v.blip) v.blip.visible = !v.driver && !v.hidden;
      v.x = e.position.x;
      v.y = e.position.y;
      v.z = e.position.z;
      v.heading = e.heading;
      v.speed = e.speed || 0;
      v.vx = Math.sin(e.heading) * v.speed + (e.vx || 0);
      v.vz = Math.cos(e.heading) * v.speed + (e.vz || 0);
      if (v.mode !== 'car' || v.hero) e.mesh.visible = !v.hidden;
    }
    refreshObstacles();
    if (game.frame % 30 === 0) {
      despawn();
      updateHeroes();
    }
    const text = promptText();
    if (text !== lastPrompt) {
      lastPrompt = text;
      game.ui?.prompt(text);
    }
  }

  // =================================================================================================================
  // SAVE: the hero vehicles where they were left
  // =================================================================================================================
  game.save.register('vehicles', {
    get: () => ({
      heroes: [heroTaxi, heroBike, heroHeli].map((v) => ({
        kind: v.kind, x: v.entity.position.x, y: v.entity.position.y, z: v.entity.position.z, heading: v.entity.heading,
        health: v.state === 'wrecked' ? 100 : Math.max(HEALTH.smoke + 1, v.health)
      })),
      boats: heroBoats.map((v) => ({ x: v.entity.position.x, z: v.entity.position.z, heading: v.entity.heading, moored: !!v.entity.moored || v === current }))
    }),
    set: (data) => {
      for (const h of data?.heroes || []) {
        const v = [heroTaxi, heroBike, heroHeli].find((m) => m.kind === h.kind);
        if (!v || ![h.x, h.y, h.z, h.heading].every(Number.isFinite)) continue;
        const e = v.entity;
        e.position.set(h.x, v.mode === 'helicopter' ? Math.max(h.y, terrainHeight(h.x, h.z) + 0.25) : world.groundHeight(h.x, h.z, h.y + 1), h.z);
        e.prevX = h.x;
        e.prevZ = h.z;
        e.heading = h.heading;
        e.mesh.position.copy(e.position);
        e.mesh.rotation.set(0, e.heading, 0, 'YXZ');
        if (Number.isFinite(h.health)) v.health = h.health;
        v.awake = v.mode === 'helicopter'; // (one left in the air settles to the ground)
      }
      (data?.boats || []).forEach((b, i) => {
        const v = heroBoats[i];
        if (!v || ![b.x, b.z, b.heading].every(Number.isFinite)) return;
        const e = v.entity;
        // (one left at or near her berth is tied up at it, as the berths are now)
        const h = v.home;
        const atBerth = Math.hypot(b.x - h.x, b.z - h.z) < 30;
        const x = atBerth ? h.x : b.x, z = atBerth ? h.z : b.z;
        e.position.set(x, ISLAND_BOUNDS.waterLevel, z);
        e.prevX = x;
        e.prevZ = z;
        e.heading = atBerth ? h.heading : b.heading;
        e.speed = 0;
        e.moored = true; // (whoever left her at sea comes back to find her tied up there)
        e.sailsUp = false;
        e.sailShow = 0;
        v.lastUsed = game.time;
        poseSailboat(e, 0.016, game.time);
      });
    }
  });

  return {
    KINDS,
    list,
    nearest,
    findCandidate,
    enter,
    exit,
    toggle,
    spawn,
    adopt,
    remove,
    damage,
    damageTraffic,
    repair: (v) => {
      if (!v || v.state === 'wrecked') return;
      v.health = v.maxHealth;
      setState(v, 'ok');
      stopEffects(v);
    },
    wreck: wreckVehicle,
    setControls,
    get current() {
      return current;
    },
    get busy() {
      return !!action;
    },
    heroes: { taxi: heroTaxi, bicycle: heroBike, helicopter: heroHeli, boats: heroBoats, scooters },
    /** Where the player stepped aboard the boat they are sailing (null ashore): the save keeps them on land */
    get lastShore() {
      return lastShore;
    },
    update,
    dispose() {
      offControllers();
      offTraffic();
      traffic.game.setRenderHook(null);
      traffic.game.setObstacles([]);
    }
  };
}

export { createVehicles, KINDS as VEHICLE_KINDS };
