import { streetArrival, ISLAND_BOUNDS, shoreDistance } from '../city-config.js';
import { PEDESTRIAN_DIVE_DURATION } from '../pedestrians.js';

// The player: one person, on foot or in a vehicle (game/vehicles.js). Health and armour, sprint stamina, money,
// knock-downs, falls, drowning, death and arrest; respawn at the nearest hospital (or police station) after a fade.
// Every frame it turns the game's input into the controllers' on-foot control (personControl) and the camera's aim.

const MAX_HEALTH = 100;
const MAX_ARMOR = 100;
const STAMINA = { max: 100, drain: 17, regen: 22, delay: 0.8, recover: 30 };
const HOSPITAL_FEE = 100; // (at most: a new player with NZ$150 must not be wiped out by one bad crossing)
const BAIL_MAX = 500; // the arrest's fee: a tenth of the cash, at most this (and the police keep the bat)
const CAR_HIT = 6.5; // damage per m/s of closing speed over 2.5 m/s: a 50 km/h hit takes about three quarters of full health
const DEATH_POSE = 1.0; // seconds into the dive: lying face down
const RESPAWN = { slowMo: 1.6, fadeAt: 3.2, fade: 0.7, hold: 0.35 };

// Where the player wakes up: Auckland City Hospital (Grafton) and two medical centres in town; when arrested, the
// police stations (Auckland Central's on College Hill, the Cook St base, Newmarket's)
const HOSPITALS = [
  { name: 'Auckland City Hospital', x: 640, z: 1300 },
  { name: 'Quay Park Medical Centre', x: 1097, z: -102 },
  { name: 'Victoria Park Medical Suites', x: -567, z: 45 }
];
const POLICE_STATIONS = [
  { name: 'Auckland Central Police Station', x: -1072, z: -66 },
  { name: 'Auckland Central Police Base', x: -50, z: 291 },
  { name: 'Newmarket Police Station', x: 1535, z: 2523 }
];

function createPlayer(game, { controllerManager, cameraSystem, fx }) {
  const cm = controllerManager;
  const person = cm.entities.person;
  const ctl = cm.personControl;

  const damageEvent = { amount: 0, armorDamage: 0, health: 0, armor: 0, source: null, kind: '', dirX: 0, dirZ: 0 };
  let knockLeft = 0;
  let deathTime = 0;
  let deathKind = 'died'; // 'died' | 'busted'
  let respawnStage = 0;
  let staminaWait = 0;
  let exhausted = false;
  let crouch = false;
  let aimEase = 0;

  const player = {
    health: MAX_HEALTH,
    maxHealth: MAX_HEALTH,
    armor: 0,
    maxArmor: MAX_ARMOR,
    stamina: STAMINA.max,
    money: 500,
    alive: true,
    invulnerable: false,
    vehicle: null, // the world vehicle the player is in (set by game/vehicles.js)
    lastDamage: null, // { source, kind, at }
    entity: person,
    hospitals: HOSPITALS,
    policeStations: POLICE_STATIONS,

    /** Where the player is: the vehicle's position when in one */
    get position() {
      return cm.getActiveEntity().position;
    },
    get onFoot() {
      return !player.vehicle;
    },
    get dead() {
      return !player.alive;
    },
    get sprinting() {
      return ctl.sprint && Math.hypot(person.velX || 0, person.velZ || 0) > 3;
    },
    get aiming() {
      return ctl.aiming;
    },
    get crouching() {
      return ctl.crouch;
    },
    get knockedDown() {
      return knockLeft > 0;
    },

    /**
     * Takes damage (armour absorbs two thirds of most kinds). opts: { source ('police' | 'traffic' | object ...),
     * kind ('melee' | 'fall' | 'vehicle' | 'crash' | 'drown'), dirX, dirZ (the
     * direction the blow travels) }. Emits player:damaged; dies at 0. Returns the health lost.
     */
    damage(amount, opts = null) {
      if (!player.alive || player.invulnerable || !(amount > 0) || game.state === 'cutscene') return 0;
      const kind = opts?.kind || 'unknown';
      let armorDamage = 0;
      if (player.armor > 0 && kind !== 'fall' && kind !== 'drown') {
        armorDamage = Math.min(player.armor, amount * 0.66);
        player.armor -= armorDamage;
      }
      const lost = Math.min(player.health, amount - armorDamage);
      player.health -= lost;
      player.lastDamage = { source: opts?.source ?? null, kind, at: game.time };
      damageEvent.amount = lost;
      damageEvent.armorDamage = armorDamage;
      damageEvent.health = player.health;
      damageEvent.armor = player.armor;
      damageEvent.source = opts?.source ?? null;
      damageEvent.kind = kind;
      damageEvent.dirX = opts?.dirX || 0;
      damageEvent.dirZ = opts?.dirZ || 0;
      game.emit('player:damaged', damageEvent);
      if (player.health <= 0) player.kill(kind, opts?.source ?? null);
      return lost;
    },

    heal(amount) {
      if (!player.alive) return;
      const before = player.health;
      player.health = Math.min(player.maxHealth, player.health + amount);
      if (player.health !== before) game.emit('player:healed', { amount: player.health - before, health: player.health, armor: player.armor });
    },

    addArmor(amount) {
      if (!player.alive) return;
      player.armor = Math.min(player.maxArmor, player.armor + amount);
      game.emit('player:healed', { amount: 0, health: player.health, armor: player.armor });
    },

    /** Money changes go through here (missions, pickups, fees): emits money:changed */
    addMoney(delta, reason = '') {
      const before = player.money;
      player.money = Math.max(0, Math.round(player.money + delta));
      if (player.money !== before) game.emit('money:changed', { money: player.money, delta: player.money - before, reason });
      return player.money - before;
    },

    /** Knocked off the feet (hit by a car, a bat, a tackle, a bail-out): the dive's fall & get-up, along (dirX, dirZ) */
    knockDown(dirX = 0, dirZ = 1, seconds = PEDESTRIAN_DIVE_DURATION) {
      if (!player.alive || player.vehicle) return;
      knockLeft = Math.max(knockLeft, Math.min(seconds, PEDESTRIAN_DIVE_DURATION));
      person.poseDive = 0;
      if (dirX || dirZ) person.heading = Math.atan2(dirX, dirZ);
      person.velX = dirX * 4;
      person.velZ = dirZ * 4;
      game.emit('player:knockdown', { dirX, dirZ });
    },

    /** Hit by a vehicle at closing speed (m/s), pushed along n (from the vehicle to the player) */
    hitByVehicle(speed, nx, nz, by) {
      if (!player.alive || player.vehicle || speed < 2.5) return;
      if (knockLeft > 0 && speed < 8) return;
      player.damage((speed - 2.5) * CAR_HIT, { kind: 'vehicle', source: by?.worldVehicle || by, dirX: nx, dirZ: nz });
      if (player.alive && speed > 4) player.knockDown(nx, nz);
    },

    /** Down and out now (the hospital follows): cause 'melee' | 'vehicle' | 'crash' | 'fall' | 'drown' | ... */
    kill(cause = 'unknown', source = null) {
      if (!player.alive) return;
      player.alive = false;
      player.health = 0;
      deathKind = 'died';
      beginDeath(cause, source);
    },

    /** Arrested (game/police calls this): respawn at the nearest police station */
    bust(source = 'police') {
      if (!player.alive) return;
      player.alive = false;
      deathKind = 'busted';
      beginDeath('busted', source);
    },

    /** Back on the feet at (x, z) facing heading, full health (the respawn uses it; missions & cheats may too) */
    respawnAt(x, z, heading = 0) {
      if (player.vehicle) game.vehicles?.exit({ eject: true });
      player.alive = true;
      player.health = player.maxHealth;
      player.stamina = STAMINA.max;
      knockLeft = 0;
      person.poseDive = -1;
      person.overWater = false;
      person.hidden = false;
      cm.setMode('person');
      cm.teleportActiveTo(x, z, heading);
      person.velX = person.velZ = 0;
      cameraSystem.resetForTeleport();
      cameraSystem.lookAlong(heading);
      game.emit('player:mode', { mode: 'person', vehicle: null });
    },

    /** The nearest of a list of { x, z } places to the player */
    nearest(places) {
      const p = player.position;
      let best = places[0], bestD = Infinity;
      for (const place of places) {
        const d = Math.hypot(place.x - p.x, place.z - p.z);
        if (d < bestD) {
          bestD = d;
          best = place;
        }
      }
      return best;
    },

    /** Roughly the right hand when aiming (weapons can use the rig's bones instead), into out */
    getMuzzle(out) {
      const p = person.position;
      const h = person.heading;
      const s = Math.sin(h), c = Math.cos(h);
      out.x = p.x + s * 0.62 - c * 0.12;
      out.y = p.y + 1.42 - Math.sin(cameraSystem.lookPitch) * 0.3;
      out.z = p.z + c * 0.62 + s * 0.12;
      return out;
    }
  };

  // Death: slow motion, the fall, a banner; a fade to black and back up at the hospital (or the police station)
  function beginDeath(cause, source) {
    deathTime = game.realTime;
    respawnStage = 0;
    knockLeft = 0;
    person.poseDive = 0;
    ctl.enabled = false;
    ctl.aiming = ctl.sprint = false;
    game.setState('dead');
    game.slowMo(0.3, RESPAWN.slowMo);
    const p = player.position;
    const payload = { cause, source, x: p.x, y: p.y, z: p.z, busted: deathKind === 'busted' };
    game.emit(deathKind === 'busted' ? 'player:busted' : 'player:died', payload);
    game.ui?.banner(deathKind === 'busted' ? 'ARRESTED' : 'HOSPITALISED', deathKind === 'busted' ? 'Taken to the station' : 'Taken to hospital');
  }

  function updateDeath(realDt) {
    const t = game.realTime - deathTime;
    if (person.poseDive >= 0) person.poseDive = Math.min(DEATH_POSE, person.poseDive + realDt * 0.9);
    // the camera drifts round the body
    if (!player.vehicle) cameraSystem.addLook(realDt * 0.12, 0);
    if (respawnStage === 0 && t > RESPAWN.fadeAt) {
      respawnStage = 1;
      game.ui?.fade(1, RESPAWN.fade);
    } else if (respawnStage === 1 && t > RESPAWN.fadeAt + RESPAWN.fade + RESPAWN.hold) {
      respawnStage = 2;
      respawn();
      game.ui?.fade(0, 0.9);
      game.ui?.banner(null);
    }
  }

  function respawn() {
    const busted = deathKind === 'busted';
    const place = player.nearest(busted ? POLICE_STATIONS : HOSPITALS);
    // the street outside: the road's lane nearest the building, stepped back onto the footpath towards it
    const arrival = streetArrival(place.x, place.z, null, 160);
    const dx = place.x - arrival.x, dz = place.z - arrival.z;
    const d = Math.hypot(dx, dz) || 1;
    const x = arrival.x + (dx / d) * Math.min(6, d * 0.5);
    const z = arrival.z + (dz / d) * Math.min(6, d * 0.5);
    player.respawnAt(x, z, Math.atan2(-dx, -dz));
    const fee = busted ? Math.min(BAIL_MAX, Math.round(player.money * 0.1)) : Math.min(player.money, HOSPITAL_FEE);
    player.addMoney(-fee, busted ? 'busted' : 'hospital');
    if (busted) player.armor = 0;
    game.setState('playing');
    game.emit('player:respawned', { at: busted ? 'police' : 'hospital', place: place.name, x, z, cost: fee });
  }

  // Each frame: input -> the controllers' on-foot control & the camera; stamina; falls; drowning; knock-downs; death
  function update(dt, elapsed, realDt) {
    const input = game.input;
    const playing = game.state === 'playing';
    if (!player.alive) {
      updateDeath(realDt);
      ctl.enabled = false;
      cameraSystem.aiming = false;
      return;
    }
    const onFoot = !player.vehicle;
    const free = playing && knockLeft <= 0 && !game.vehicles?.busy;
    ctl.enabled = free;
    // the camera's yaw: the free look's on foot, else wherever the camera faces
    ctl.yaw = cameraSystem.freeLookActive()
      ? cameraSystem.lookYaw
      : Math.atan2(cameraSystem.currentLookAt.x - cameraSystem.currentPos.x, cameraSystem.currentLookAt.z - cameraSystem.currentPos.z);
    ctl.aiming = free && onFoot && input.down('aim');
    if (input.pressed('crouch') && onFoot) crouch = !crouch;
    if (!onFoot || ctl.aiming) crouch = false;
    ctl.crouch = crouch && free;
    // sprint stamina: drains while sprinting, recovers after a pause; run dry and it waits for a breath
    const moving = Math.hypot(person.velX || 0, person.velZ || 0) > 2.5;
    const wantsSprint = free && onFoot && !ctl.aiming && !ctl.crouch && input.down('sprint');
    if (exhausted && player.stamina >= STAMINA.recover) exhausted = false;
    ctl.sprint = wantsSprint && !exhausted && player.stamina > 0;
    if (dt > 0) {
      if (ctl.sprint && moving) {
        player.stamina = Math.max(0, player.stamina - STAMINA.drain * dt);
        staminaWait = STAMINA.delay;
        if (player.stamina <= 0) exhausted = true;
      } else if ((staminaWait -= dt) <= 0) {
        player.stamina = Math.min(STAMINA.max, player.stamina + STAMINA.regen * dt);
      }
    }
    cameraSystem.aiming = ctl.aiming;
    cameraSystem.fovBias += ((ctl.sprint && moving ? 5 : 0) - cameraSystem.fovBias) * (1 - Math.exp(-realDt * 4));
    // the arms come up to aim along the camera
    aimEase += ((ctl.aiming ? 1 : 0) - aimEase) * (1 - Math.exp(-realDt * 12));
    person.rig.aimWeight = aimEase < 0.002 ? 0 : aimEase;
    {
      const c = person.rig.crouch + ((ctl.crouch ? 1 : 0) - person.rig.crouch) * (1 - Math.exp(-realDt * 10));
      person.rig.crouch = c < 0.002 ? 0 : c;
    }
    person.rig.aimYaw = ctl.yaw;
    person.rig.aimPitch = cameraSystem.freeLookActive() ? cameraSystem.lookPitch - 0.08 : 0;

    if (onFoot && dt > 0) {
      // knocked down: the dive plays out (fall, lie, get up)
      if (knockLeft > 0) {
        knockLeft -= dt;
        person.poseDive = Math.min(PEDESTRIAN_DIVE_DURATION, (person.poseDive >= 0 ? person.poseDive : 0) + dt);
        if (knockLeft <= 0 || person.poseDive >= PEDESTRIAN_DIVE_DURATION) {
          knockLeft = 0;
          person.poseDive = -1;
        }
      }
      // falls
      if (person.landingSpeed > 0) {
        const v = person.landingSpeed;
        person.landingSpeed = 0;
        if (v > 10) {
          player.damage((v - 10) * 8.5, { kind: 'fall' });
          if (player.alive && v > 13) player.knockDown(Math.sin(person.heading), Math.cos(person.heading), 2.4);
        }
      }
      // into the harbour (out of a helicopter): a splash, and that's that
      if (person.overWater && person.position.y < ISLAND_BOUNDS.waterLevel + 0.2 && shoreDistance(person.position.x, person.position.z) < 0) {
        fx?.impact('water', person.position.x, ISLAND_BOUNDS.waterLevel, person.position.z, 0, 1, 0);
        fx?.smoke(person.position.x, ISLAND_BOUNDS.waterLevel, person.position.z, { count: 8, size: 0.8, life: 1.2, color: 0xf2f6f8, alpha: 0.6, rise: 2.5 });
        player.kill('drown');
      }
    }
  }

  // Save: where the player is (on foot, next to whatever they were in), their health, armour and money
  game.save.register('player', {
    get: () => {
      // (out sailing: where they stepped aboard, so that a reload finds them ashore)
      const at = (player.vehicle?.mode === 'boat' && game.vehicles?.lastShore) || person.position;
      return {
        x: at.x, y: at.y, z: at.z, heading: person.heading,
        health: player.alive ? player.health : player.maxHealth, armor: player.armor, money: player.money
      };
    },
    set: (data) => {
      if (!data || ![data.x, data.z].every(Number.isFinite)) return;
      cm.setMode('person');
      cm.teleportActiveTo(data.x, data.z, Number.isFinite(data.heading) ? data.heading : 0, Number.isFinite(data.y) ? data.y : null);
      if (Number.isFinite(data.health)) player.health = Math.max(1, Math.min(MAX_HEALTH, data.health));
      if (Number.isFinite(data.armor)) player.armor = Math.max(0, Math.min(MAX_ARMOR, data.armor));
      if (Number.isFinite(data.money)) player.money = Math.max(0, Math.round(data.money));
    }
  });

  return { player, update };
}

export { createPlayer, HOSPITALS, POLICE_STATIONS };
