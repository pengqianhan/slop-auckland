import { signalPhase, walkSignal } from './city-config.js';

const MOTOR_RANGE = 180;
const SIREN_RANGE = 220;
const PEOPLE_RANGE = 45;
const SIGNAL_RANGE = 35;
const unit = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
// the game's vehicle kinds to the engine voices, and how rough a damaged engine runs
const ENGINE_KIND = { taxi: 'sedan', sedan: 'sedan', minivan: 'sedan', suv: 'suv', pickup: 'suv', van: 'suv' };
const DAMAGE = { smoking: 0.45, burning: 1 };
const seedAt = (index) => ((Math.imul(index + 1, 2654435761) >>> 0) / 4294967296);

function driveLoad(keys, speed, cyclist) {
  // Match the controller's forward priority, and distinguish propulsion from braking.
  if (cyclist && speed > 0 && unit(+keys.up) > 0) return 0;
  const throttle = unit(+keys.forward) || -unit(+keys.backward) * (cyclist && speed <= 0 ? 0.6 : 1);
  if ((cyclist && throttle <= 0) || speed * throttle < 0) return 0;
  return Math.abs(throttle);
}

function helicopterVerticalSpeed(entity) {
  const speed = Number.isFinite(entity.verticalSpeed) ? entity.verticalSpeed : 0;
  // The controller clamps altitude without clearing its stored vertical velocity.
  return ((entity.altitude ?? entity.position.y) <= 0.25 && speed < 0) || (entity.position.y >= 520 && speed > 0) ? 0 : speed;
}

function helicopterLoad(entity, keys, verticalSpeed) {
  const forward = unit(+keys.forward) || -unit(+keys.backward);
  const collective = unit(+keys.up) || -unit(+keys.down);
  const grounded = (entity.altitude ?? entity.position.y) <= 0.35 && verticalSpeed <= 0.03;
  return unit((grounded ? 0.12 : 0.45)
    + 0.28 * Math.max(collective, 0) - 0.16 * Math.max(-collective, 0)
    + 0.15 * unit(verticalSpeed / 16) - 0.08 * unit(-verticalSpeed / 16)
    + 0.1 * Math.abs(forward) + 0.12 * unit(Math.abs(entity.speed) / 52));
}

function roadLoad(speed, acceleration, maxAcceleration) {
  // Constant speed still needs power against rolling resistance and air drag.
  return unit(acceleration / maxAcceleration + unit(speed / 2) * (0.12 + 0.28 * unit(speed / 30) ** 2));
}

function writeMotor(item, id, kind, x, y, z, speed, load, heading, player, seed, blocked, gain, range, verticalSpeed = 0, damage = 0) {
  item.id = id;
  item.damage = damage;
  item.kind = kind;
  item.x = x;
  item.y = y;
  item.z = z;
  item.speed = Number.isFinite(speed) ? Math.abs(speed) : 0;
  item.load = unit(load);
  item.verticalSpeed = Number.isFinite(verticalSpeed) ? verticalSpeed : 0;
  item.heading = heading;
  item.player = player;
  item.seed = seed;
  item.blocked = blocked;
  item.gain = gain;
  item.range = range;
}

// Bounded insertion keeps only nearby candidates. Records and the public array are reused across collections.
class NearestSources {
  constructor(limit) {
    this.pool = Array.from({ length: limit }, () => ({}));
    this.items = [];
    this.scores = new Float64Array(limit);
  }

  take(score) {
    let i = this.items.length;
    let item;
    if (i < this.pool.length) item = this.pool[i];
    else {
      if (score >= this.scores[i - 1]) return null;
      item = this.items[--i];
    }
    while (i > 0 && score < this.scores[i - 1]) {
      this.items[i] = this.items[i - 1];
      this.scores[i] = this.scores[i - 1];
      i--;
    }
    this.items[i] = item;
    this.scores[i] = score;
    return item;
  }
}

// Read at audio's control rate (10 Hz), after simulation updates. Snapshots remain valid until the next collect().
// IDs are the simulation objects, independent of pooled record order, so voices survive ranking changes/recycling.
class CityAudioSources {
  constructor({ controllerManager, trafficSystem, highwayTraffic, streetDetails }) {
    this.controllers = controllerManager;
    // (read afresh every collect: the game swaps the car the player drives into controllerManager.entities.car)
    this.players = [];
    this.cars = trafficSystem.cars;
    this.buses = trafficSystem.buses;
    this.peds = trafficSystem.peds;
    this.highwayCars = highwayTraffic.cars;
    this.signalSites = streetDetails.audioSignals;
    this.motors = new NearestSources(10);
    this.sirens = new NearestSources(4);
    // The game's world vehicles (js/game/vehicles.js list(), a live array) and which traffic police cars run their
    // sirens: both set by game/audio.js. AI-driven or rolling world cars get engines; ones with .siren wail
    this.worldVehicles = null;
    this.sirenPolicy = null; // (traffic record) => bool; null: every police car on the road (the sandbox)
    this.people = new NearestSources(6);
    this.signals = new NearestSources(2);
    this.snapshot = {
      motors: this.motors.items, sirens: this.sirens.items,
      people: this.people.items, signals: this.signals.items, traffic: 0, motion: 0
    };
  }

  distanceSq(x, y, z) {
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const dz = z - this.listener.z;
    return dx * dx + dy * dy + dz * dz;
  }

  motor(id, kind, x, y, z, speed, load, heading, police, player, seed, blocked, gain = 1, range = kind === 'helicopter' ? 500 : 160, verticalSpeed = 0, damage = 0) {
    const d2 = this.distanceSq(x, y, z);
    if (!Number.isFinite(d2)) return;
    if (police && d2 <= SIREN_RANGE * SIREN_RANGE) {
      const siren = this.sirens.take(d2);
      if (siren) writeMotor(siren, id, 'siren', x, y, z, speed, load, heading, player, seed, blocked, 1, 200);
    }
    const reach = kind === 'helicopter' ? range : MOTOR_RANGE;
    if (d2 > reach * reach) return;
    const item = this.motors.take(player ? -1 : d2);
    if (!item) return;
    writeMotor(item, id, kind, x, y, z, speed, load, heading, player, seed, blocked, gain, range, verticalSpeed, damage);
  }

  person(id, x, y, z, speed, grounded, rig, player = false, priority = player) {
    const d2 = this.distanceSq(x, y, z);
    if (!Number.isFinite(d2) || d2 > PEOPLE_RANGE * PEOPLE_RANGE) return;
    const item = this.people.take(priority ? -1 : d2);
    if (!item) return;
    item.id = id;
    item.x = x;
    item.y = y;
    item.z = z;
    item.speed = Number.isFinite(speed) ? Math.abs(speed) : 0;
    item.grounded = grounded;
    item.seed = rig.seed;
    item.phase = rig.phase;
    item.player = player;
    item.conversation = player ? null : id.conversation || null;
    const left = rig.feet[0], right = rig.feet[1];
    item.leftX = left.px; item.leftY = left.py; item.leftZ = left.pz;
    item.rightX = right.px; item.rightY = right.py; item.rightZ = right.pz;
  }

  // World vehicles drawn through traffic's instances (proxies): police and mission cars under AI control, cars left
  // rolling. The ones the controllers own (the hero taxi, bicycle, helicopter, and the car the player is in) are above.
  gameVehicles(list) {
    const car = this.controllers.entities.car;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const e = v.entity;
      if (v.hidden || !e || !e.proxy || e === car || v.state === 'wrecked') continue;
      const speed = Math.abs(v.speed || 0);
      const ai = v.driver === 'ai';
      const siren = v.siren === true;
      if (!ai && !siren && speed < 0.3) continue; // parked: engine off
      const throttle = ai ? Math.max(0, (v.controls?.throttle || 0) * Math.sign(v.speed || 1)) : 0;
      this.motor(e, ENGINE_KIND[v.kind] || 'sedan', v.x, v.y + 0.7, v.z, ai ? speed : speed * 0.5, ai ? Math.max(throttle, roadLoad(speed, 0, 3) * 0.5) : 0,
        v.heading, siren, false, seedAt(5000 + v.id), false, ai ? 0.85 : 0.45, 160, 0, DAMAGE[v.state] || 0);
    }
  }

  streetVehicles(vehicles, elapsed, seedOffset) {
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.edge) continue;
      const d2 = this.distanceSq(v.x, 0.7, v.z);
      const range = v.isPolice ? SIREN_RANGE : MOTOR_RANGE;
      if (!Number.isFinite(d2) || d2 > range * range) continue;
      if (d2 <= MOTOR_RANGE * MOTOR_RANGE) {
        this.snapshot.traffic += (1 - d2 / (MOTOR_RANGE * MOTOR_RANGE)) * (0.2 + 0.8 * unit(v.speed / 12));
      }
      const green = !v.edge.to.signal || signalPhase(elapsed, v.edge.axisIndex === 0) === 'green';
      const blocked = v.wait > 2 && v.speed < 0.5 && v.gap < 8 && v.leaderSpeed < 0.5 && green && !v.conn && !v.yielding;
      const siren = !!v.isPolice && (!this.sirenPolicy || this.sirenPolicy(v));
      this.motor(v, v.bus ? 'bus' : v.engine, v.x, 0.7, v.z,
        v.speed, roadLoad(v.speed, v.acc, v.driver.a), v.yaw + v.yawOffset, siren, false, seedAt(seedOffset + i), blocked);
    }
  }

  collect(listenerPosition, elapsed) {
    this.listener = listenerPosition;
    this.motors.items.length = this.sirens.items.length = this.people.items.length = this.signals.items.length = 0;
    this.snapshot.traffic = 0;
    const active = this.controllers.getActiveEntity();
    const keys = this.controllers.keys;
    this.snapshot.motion = active.type === 'person' ? active.rig.speed
      : Math.hypot(active.speed, active.type === 'helicopter' ? helicopterVerticalSpeed(active) : 0);

    const players = this.players;
    players.length = 0;
    for (const key in this.controllers.entities) players.push(this.controllers.entities[key]);
    for (let i = 0; i < players.length; i++) {
      const entity = players[i];
      if (entity.mesh.visible === false) continue;
      // (the game's parked vehicles have their engines off)
      if (entity.engineOff && entity !== active) continue;
      const { x, y, z } = entity.position;
      const player = entity === active;
      if (entity.type === 'person') {
        const ground = this.controllers.getGroundHeight(x, z, 'person');
        const grounded = y <= ground + 0.03 && Math.abs(entity.verticalVel) < 0.1;
        this.person(entity, x, y, z, entity.rig.speed, grounded, entity.rig, true, player);
      } else {
        // Inactive bicycles stop updating and are silent, even if their stored speed is left over from riding.
        if (!player && entity.type === 'cyclist') continue;
        if (entity.type === 'kiwi' || entity.type === 'boat') continue; // (no engine: it flies, or sails, in silence)
        const kind = entity.type === 'car' ? 'sedan' : entity.type;
        const helicopter = kind === 'helicopter';
        const verticalSpeed = player && helicopter ? helicopterVerticalSpeed(entity) : 0;
        const load = player ? helicopter ? helicopterLoad(entity, keys, verticalSpeed) : driveLoad(keys, entity.speed, kind === 'cyclist' || kind === 'scooter') : 0;
        const gain = player ? 1 : helicopter ? 0.22 : 0.5;
        const range = helicopter ? (player ? 500 : 200) : 160;
        this.motor(entity, kind, x, y + (helicopter ? 2.66 : 0.7), z, player ? entity.speed : 0, load, entity.heading,
          false, player, seedAt(i), false, gain, range, verticalSpeed, DAMAGE[entity.worldVehicle?.state] || 0);
      }
    }
    if (this.worldVehicles) this.gameVehicles(this.worldVehicles);

    this.streetVehicles(this.cars, elapsed, 100);
    this.streetVehicles(this.buses, elapsed, 1000);
    for (let i = 0; i < this.highwayCars.length; i++) {
      const car = this.highwayCars[i];
      // Lane ends sink into the road and the Battery tunnel is underground; neither should sound above ground.
      if (!car.placed) continue; // (not yet on the road, or in the tunnel)
      const d2 = this.distanceSq(car.x, car.y + 0.7, car.z);
      if (!Number.isFinite(d2) || d2 > MOTOR_RANGE * MOTOR_RANGE) continue;
      this.snapshot.traffic += (1 - d2 / (MOTOR_RANGE * MOTOR_RANGE)) * (0.2 + 0.8 * unit(car.v / 12));
      this.motor(car, car.engine, car.x, car.y + 0.7, car.z,
        car.v, roadLoad(car.v, car.acc, 1.6), car.yaw, false, false, seedAt(2000 + i), car.v < 0.5);
    }
    this.snapshot.traffic = unit(this.snapshot.traffic / 16);

    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      if (!ped.placed) continue;
      const t = (ped.x - ped.ax) * ped.ux + (ped.z - ped.az) * ped.uz;
      const y = ped.node && t > 2 && t < ped.len - 2 ? 0.012 : 0.22;
      this.person(ped, ped.x, y, ped.z, ped.v, true, ped.rig);
    }
    for (let i = 0; i < this.signalSites.length; i++) {
      const site = this.signalSites[i];
      const d2 = this.distanceSq(site.x, site.y, site.z);
      if (!Number.isFinite(d2) || d2 > SIGNAL_RANGE * SIGNAL_RANGE) continue;
      const item = this.signals.take(d2);
      if (!item) continue;
      item.id = site;
      item.x = site.x;
      item.y = site.y;
      item.z = site.z;
      item.walk = walkSignal(elapsed, site.isAvenue);
      item.seed = seedAt(10000 + i);
    }
    return this.snapshot;
  }
}

export { CityAudioSources };
