import * as THREE from 'three/webgpu';
import { PERSON_BONES } from '../pedestrians.js';
import { registerCombat } from './combat.js';

// Weapons: City of Steals is a caper, not a war. The whole arsenal is ALLOWED_WEAPONS — bare fists and a cricket bat —
// for the player and for anyone else (mission thugs swing them too; the police carry nothing and arrest people). Every
// way a weapon can come in (give, equip, a save, a shop, a pickup, a mission's enemy) goes through allowedWeapon(), so
// nothing else can turn up: an id that is not on the list is refused (the player) or swapped for the bat (an enemy).
// A swing is a short lunge towards whoever is in reach, a hit cone, a knock-down, a moment's hit-stop; the bat is
// slower, hits harder and dents cars. The bat is a small low-poly model built here at start-up (one instanced draw),
// held in the right hand of the player's and the thugs' rigs (PersonRig's aim pose raises the arms and swings them).
//
// game.weapons = {
//   defs { id: def } (fist, bat)   order (ids by slot)   current (def)   currentId   enabled (false: no swinging;
//   missions, menus)   has(id)   owned() -> ids (cached array, read only)   give(id) (the bat: anything not allowed is
//   refused, false)   remove(id)   removeAll() (keeps the fists)   equip(id)   giveAll() (debug: the bat)
//   ammo(id) -> { mag: 0, reserve: 0 } | null (melee needs none)   addAmmo() -> 0
//   fireAt(attacker, origin, dir, weaponId) -> reused { hit, kind, x, y, z, target, killed } | null: an NPC's blow
//     landing (combat.js's thugs); killed: the person it hit was knocked out
//   published each frame for the HUD: aiming (squared up with the focus button), crosshair (show the dot)
// }
// Slots (number keys): 1 fists, 2 bat; Q / E / the wheel switch between them (on foot).
// Events: weapon:switch { weaponId, prevId }, weapon:pickup { weaponId }, melee:swing* { x, y, z, hit, weaponId },
//   combat:hitmarker* { kind: 'hit' | 'kill' (a knock-out) | 'vehicle', killed, x, y, z } (the player's blows).
// game.combat (the thugs): see combat.js.

const ALLOWED_WEAPONS = Object.freeze(['fist', 'bat']);
const allowedWeapon = (id) => ALLOWED_WEAPONS.includes(id);
/** An NPC's weapon: an allowed one as asked, anything else the bat (old mission scripts, saves, typos) */
const coerceWeapon = (id) => (allowedWeapon(id) ? id : 'bat');

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lerp = (a, b, t) => a + (b - a) * t;

const ORDER = ALLOWED_WEAPONS;
const SLOT_IDS = { 1: 'fist', 2: 'bat' };

// The two. Contract fields (id, name, slot, kind, damage, rpm, range, price) first, then the feel: melee (windup &
// duration s, reach m, cone: cos of the half-angle it hits in, lunge m/s, car: damage to a vehicle, knock: chance of a
// knock-down, hitStop s, shake), hold (aim pose: reach, support, left; pitch: how the hanging hand holds it; aimPitch:
// tilt when squared up, the bat raised), model.
const DEFS = {
  fist: {
    id: 'fist', name: 'Fists', slot: 1, kind: 'melee', damage: 12, rpm: 150, magSize: 0, range: 1.8, auto: false, price: 0,
    melee: { windup: 0.1, duration: 0.4, reach: 1.75, cone: 0.45, lunge: 2.6, car: 1.5, knock: 0.3, hitStop: 0.05, shake: 0.12 },
    hold: { reach: 0.26, support: 0.04, left: 0.85, pitch: 0, aimPitch: 0 }, model: null
  },
  bat: {
    id: 'bat', name: 'Cricket Bat', slot: 2, kind: 'melee', damage: 36, rpm: 88, magSize: 0, range: 2.4, auto: false, price: 60,
    melee: { windup: 0.22, duration: 0.66, reach: 2.35, cone: 0.3, lunge: 3.2, car: 7, knock: 1, hitStop: 0.085, shake: 0.22 },
    hold: { reach: 0.32, support: -0.09, left: 1, pitch: 1.05, aimPitch: -1.05 }, model: 'bat'
  }
};
for (const id of Object.keys(DEFS)) if (!allowedWeapon(id)) throw new Error(`weapons: ${id} is not an allowed weapon`);

const NPC_PLAYER_DAMAGE = 0.3; // a thug's blow hurts the player this share of its damage (a gang of them stays fair)
const NPC_KNOCKDOWN = { chance: 0.25, grace: 3 }; // a thug's bat may floor the player, not again within grace s of it

// The right forearm's grip point in the rig's bind pose: the elbow, then a forearm and a palm down the arm hanging
// 0.14 rad out (pedestrians.js: ARM_BIND_ABDUCTION; the IK reaches FOREARM + 0.07 from the elbow)
const FOREARM_R = PERSON_BONES.FOREARM_R;
const ARM_SIN = Math.sin(0.14), ARM_COS = Math.cos(0.14);
const GRIP_LEN = 0.325;
// A model's frame (+Z along the blade, +Y up) in the forearm bone's frame (+Z the body's front, +Y up the forearm)
const HAND_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(ARM_COS, -ARM_SIN, 0), new THREE.Vector3(ARM_SIN, ARM_COS, 0), new THREE.Vector3(0, 0, 1)));

// =====================================================================================================================
// MODELS: low-poly, vertex coloured, merged into one geometry each
// =====================================================================================================================
const COL = { willow: 0xd9c08c, cane: 0xbfa572, rubber: 0x232326 };
const ALONG_Z = Math.PI / 2; // a cylinder (axis +Y) turned to lie along +Z

function box(w, h, l, x, y, z, c, rx = 0, ry = 0, rz = 0) {
  return { g: new THREE.BoxGeometry(w, h, l), x, y, z, c, rx, ry, rz };
}
function cyl(r, l, x, y, z, c, segs = 8, rTop = r, rx = ALONG_Z) {
  return { g: new THREE.CylinderGeometry(rTop, r, l, segs), x, y, z, c, rx, ry: 0, rz: 0 };
}

function buildModel(parts) {
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  for (const part of parts) {
    const g = part.g.index ? part.g.toNonIndexed() : part.g;
    q.setFromEuler(e.set(part.rx, part.ry, part.rz));
    g.applyMatrix4(m.compose(v.set(part.x, part.y, part.z), q, one));
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    c.setHex(part.c);
    for (let i = 0; i < p.length; i++) {
      pos.push(p[i]);
      nor.push(n[i]);
    }
    for (let i = 0; i < p.length / 3; i++) col.push(c.r, c.g, c.b);
    g.dispose();
    part.g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

// Origin at the palm (the grip), +Z along the blade, +Y up; metres
const MODELS = {
  bat: { cap: 8, parts: () => [
    cyl(0.017, 0.3, 0, 0, 0.05, COL.rubber, 8),
    cyl(0.013, 0.08, 0, 0, 0.23, COL.cane, 8),
    box(0.108, 0.034, 0.56, 0, 0, 0.53, COL.willow),
    box(0.05, 0.022, 0.46, 0, -0.022, 0.52, COL.willow)
  ] }
};

// =====================================================================================================================

function registerWeapons(game) {
  const world = game.world;
  const fx = game.fx;
  const MASK = world.MASK;
  const { scene, controllerManager: cm, cameraSystem, trafficSystem } = game.engine;
  const person = cm.entities.person;
  const ctl = cm.personControl;
  const peds = trafficSystem.pedestrians; // knock (melee), setPuppet / spawnFree (combat.js)

  // ---- models: one instanced mesh each, a shared vertex-coloured material; all drawn once (zero-scaled) until the
  // first update, so main.js compiles them behind the loading screen
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 });
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const draws = {};
  const drawList = [];
  for (const [id, model] of Object.entries(MODELS)) {
    const mesh = new THREE.InstancedMesh(buildModel(model.parts()), material, model.cap);
    mesh.name = `weapon-${id}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.setMatrixAt(0, zero);
    mesh.count = 1;
    scene.add(mesh);
    mesh.updateMatrixWorld(true);
    draws[id] = { mesh, n: 0, cap: model.cap };
    drawList.push(draws[id]);
  }
  const _mat = new THREE.Matrix4();
  const _one = new THREE.Vector3(1, 1, 1);
  function draw(modelId, pos, quat) {
    const d = draws[modelId];
    if (!d || d.n >= d.cap) return;
    d.mesh.setMatrixAt(d.n++, _mat.compose(pos, quat, _one));
  }
  function drawBegin() {
    for (let i = 0; i < drawList.length; i++) drawList[i].n = 0;
  }
  function drawEnd() {
    for (let i = 0; i < drawList.length; i++) {
      const d = drawList[i];
      d.mesh.count = d.n;
      d.mesh.visible = d.n > 0;
      if (d.n > 0) d.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // =================================================================================================================
  // HELD WEAPONS: the right hand's grip from a rig's pose; the hanging hand's frame blended into the aim
  // =================================================================================================================
  const _qBone = new THREE.Quaternion();
  const _qAim = new THREE.Quaternion();
  const _qTmp = new THREE.Quaternion();
  const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
  const _gv = new THREE.Vector3();
  const _xAxis = new THREE.Vector3(1, 0, 0);

  /**
   * The right hand's grip (pos) and the weapon's orientation (quat) for a rig; false when it has no pose. raised:
   * the hold's squared-up tilt applies (a bat held up; not mid-swing)
   */
  function holdFrame(rig, def, aimWeight, aimYaw, aimPitch, pos, quat, raised = true) {
    if (!rig.placed) return false;
    const a = rig.pose;
    const o = FOREARM_R * 8;
    const s = a[o + 7];
    if (!(s > 0)) return false;
    _qBone.set(a[o], a[o + 1], a[o + 2], a[o + 3]);
    const b = rig.bind[FOREARM_R];
    _gv.set(b.x - ARM_SIN * GRIP_LEN, b.y - ARM_COS * GRIP_LEN, b.z).multiplyScalar(s).applyQuaternion(_qBone);
    pos.set(_gv.x + a[o + 4], _gv.y + a[o + 5], _gv.z + a[o + 6]);
    quat.copy(_qBone).multiply(HAND_Q);
    const hold = def.hold;
    if (hold?.pitch) quat.multiply(_qTmp.setFromAxisAngle(_xAxis, hold.pitch));
    if (aimWeight > 0.001) {
      _qAim.setFromEuler(_eul.set(aimPitch + (raised ? hold?.aimPitch || 0 : 0), aimYaw, 0, 'YXZ'));
      quat.slerp(_qAim, Math.min(1, aimWeight * 1.15));
    }
    return true;
  }

  /** Sets a rig's aim pose shape for a weapon (combat.js does the same for the thugs) */
  function setHold(rig, def) {
    const h = def?.hold;
    rig.aimReach = h ? h.reach : 0.5;
    rig.aimSupport = h ? h.support : -0.12;
    rig.aimLeft = h ? h.left : 1;
  }

  /** Draws def's model at a grip frame */
  function drawHeld(def, pos, quat) {
    if (def.model) draw(def.model, pos, quat);
  }

  // =================================================================================================================
  // THE PLAYER'S PAIR
  // =================================================================================================================
  const owned = new Set(['fist']);
  const ownedList = [];
  let ownedDirty = true;
  let currentId = 'fist';
  let cooldown = 0;
  let switchLeft = 0;
  let fireBuffer = 0;
  let hipHold = 0;
  let heldOk = false;
  const swing = { active: false, t: 0, hit: false, def: null, yaw: 0 };

  const has = (id) => id === 'fist' || owned.has(id);

  const switchEvent = { weaponId: '', prevId: '' };
  function equip(id, quick = false) {
    if (!allowedWeapon(id) || !has(id) || id === currentId) return false;
    const prev = currentId;
    currentId = id;
    switchLeft = quick ? 0.12 : 0.3;
    swing.active = false;
    fireBuffer = 0;
    switchEvent.weaponId = id;
    switchEvent.prevId = prev;
    game.emit('weapon:switch', switchEvent);
    return true;
  }

  function cycle(dir) {
    const start = ORDER.indexOf(currentId);
    for (let k = 1; k <= ORDER.length; k++) {
      const id = ORDER[(start + dir * k + ORDER.length * 2) % ORDER.length];
      if (has(id)) return equip(id);
    }
    return false;
  }

  // =================================================================================================================
  // MELEE: a swing with a short lunge, a hit cone, knock-downs, a moment's hit-stop on contact
  // =================================================================================================================
  const makeHit = () => ({ kind: null, distance: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, target: null, id: -1, material: '' });
  const hitA = makeHit();
  function copyHit(src, dst) {
    if (!src) {
      dst.kind = null;
      return null;
    }
    dst.kind = src.kind;
    dst.distance = src.distance;
    dst.x = src.x;
    dst.y = src.y;
    dst.z = src.z;
    dst.nx = src.nx;
    dst.ny = src.ny;
    dst.nz = src.nz;
    dst.target = src.target;
    dst.id = src.id;
    dst.material = src.material;
    return dst;
  }

  const rayOpts = { mask: MASK.ALL, ignore: null, ignore2: null };
  function cast(origin, dir, maxDist, ignore, ignore2, mask = MASK.ALL) {
    rayOpts.mask = mask;
    rayOpts.ignore = ignore;
    rayOpts.ignore2 = ignore2;
    return world.raycast(origin, dir, maxDist, rayOpts);
  }

  const hurtOpts = { source: null, byPlayer: false, kind: 'melee', dirX: 0, dirZ: 0 };
  const carOpts = { source: null, kind: 'melee', byPlayer: false, x: 0, y: 0, z: 0 };
  const playerOpts = { source: null, kind: 'melee', dirX: 0, dirZ: 0 };
  const markerEvent = { kind: 'hit', killed: false, x: 0, y: 0, z: 0 };

  function hitmarker(kind, killed, x, y, z) {
    markerEvent.kind = kind;
    markerEvent.killed = killed;
    markerEvent.x = x;
    markerEvent.y = y;
    markerEvent.z = z;
    game.emit('combat:hitmarker', markerEvent);
  }

  /** Who is a ped on the attacker's side (the same faction's thugs): their blows pass them */
  const allyOf = (attacker, view) => !!(attacker && attacker.faction && game.combat?.factionOfPed(view.id) === attacker.faction);

  // A scuffle frightens people round about (throttled)
  let lastPanicAt = -Infinity, lastPanicX = 0, lastPanicZ = 0;
  const PANIC_OPTS = { duration: 7, cower: 0.3 };
  function fightNoise(x, z) {
    const t = game.time;
    if (t - lastPanicAt > 0.35 || Math.hypot(x - lastPanicX, z - lastPanicZ) > 18) {
      lastPanicAt = t;
      lastPanicX = x;
      lastPanicZ = z;
      world.panic(x, z, 16, PANIC_OPTS);
    }
  }

  const nearPeds = [];
  const swingEvent = { x: 0, y: 0, z: 0, hit: false, weaponId: '' };
  const _from = { x: 0, y: 0, z: 0 };
  const _dir = { x: 0, y: 0, z: 0 };

  function meleeTarget(def, x, z, yaw, range) {
    const m = def.melee;
    const fx0 = Math.sin(yaw), fz0 = Math.cos(yaw);
    world.nearbyPeds(x, z, range + 0.5, nearPeds);
    let best = null, bestD = Infinity;
    for (let i = 0; i < nearPeds.length; i++) {
      const v = nearPeds[i];
      const dx = v.x - x, dz = v.z - z;
      const d = Math.hypot(dx, dz);
      if (d > range + v.radius || Math.abs(v.y - person.position.y) > 1.3) continue;
      if (d > 0.3 && (dx * fx0 + dz * fz0) / d < m.cone) continue;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  function startSwing(def) {
    const yaw = ctl.yaw;
    swing.active = true;
    swing.t = 0;
    swing.hit = false;
    swing.def = def;
    swing.yaw = yaw;
    hipHold = Math.max(hipHold, def.melee.duration);
    // a short lunge, towards someone in reach if there is one
    const target = meleeTarget(def, person.position.x, person.position.z, yaw, 3.6);
    let lx = Math.sin(yaw), lz = Math.cos(yaw);
    if (target) {
      const dx = target.x - person.position.x, dz = target.z - person.position.z;
      const d = Math.hypot(dx, dz) || 1;
      lx = dx / d;
      lz = dz / d;
      swing.yaw = Math.atan2(lx, lz);
    }
    person.velX = (person.velX || 0) + lx * def.melee.lunge;
    person.velZ = (person.velZ || 0) + lz * def.melee.lunge;
  }

  function meleeHit(def) {
    const m = def.melee;
    const px = person.position.x, py = person.position.y, pz = person.position.z;
    const yaw = swing.yaw;
    const fx0 = Math.sin(yaw), fz0 = Math.cos(yaw);
    let hit = false, killed = false, hx = px + fx0 * m.reach * 0.8, hy = py + 1.2, hz = pz + fz0 * m.reach * 0.8;
    const v = meleeTarget(def, px, pz, yaw, m.reach);
    if (v) {
      const dx = v.x - px, dz = v.z - pz;
      const d = Math.hypot(dx, dz) || 1;
      hurtOpts.source = 'player';
      hurtOpts.byPlayer = true;
      hurtOpts.kind = 'melee';
      hurtOpts.dirX = dx / d;
      hurtOpts.dirZ = dz / d;
      const result = world.hurtPed(v.id, def.damage * rand(0.9, 1.15), hurtOpts);
      killed = result === 'killed';
      if (result === 'hurt' && Math.random() < m.knock) peds.knock?.(v.id, dx / d, dz / d);
      hx = v.x - (dx / d) * 0.25;
      hz = v.z - (dz / d) * 0.25;
      hy = v.y + v.height * 0.75;
      fx.impact('flesh', hx, hy, hz, -dx / d, 0, -dz / d);
      hit = true;
      hitmarker(killed ? 'kill' : 'hit', killed, hx, hy, hz);
    } else {
      // a car (dents it; the bat more) or a wall (a thud, no damage)
      _from.x = px;
      _from.y = py + 1.15;
      _from.z = pz;
      _dir.x = fx0;
      _dir.y = -0.15;
      _dir.z = fz0;
      const h = copyHit(cast(_from, _dir, m.reach + 0.4, world.playerView, null, MASK.VEHICLES | MASK.BUILDINGS), hitA);
      if (h) {
        hx = h.x; hy = h.y; hz = h.z;
        hit = true;
        if (h.kind === 'vehicle' && h.target) {
          fx.sparks(h.x, h.y, h.z, h.nx, h.ny, h.nz, def.id === 'bat' ? 8 : 3, 5, 0.6);
          carOpts.source = 'player';
          carOpts.kind = 'melee';
          carOpts.byPlayer = true;
          carOpts.x = h.x;
          carOpts.y = h.y;
          carOpts.z = h.z;
          if (h.target.type === 'world') game.vehicles?.damage(h.target, m.car, carOpts);
          else world.damageCar(h.target, m.car, carOpts);
          hitmarker('vehicle', false, h.x, h.y, h.z);
        } else {
          fx.impact('concrete', h.x, h.y, h.z, h.nx, h.ny, h.nz);
        }
      }
    }
    if (hit) {
      game.hitStop(m.hitStop);
      game.camera.shake(m.shake);
      if (def.id === 'bat') game.camera.kick(1.2);
      fightNoise(px, pz);
    }
    swingEvent.x = hx;
    swingEvent.y = hy;
    swingEvent.z = hz;
    swingEvent.hit = hit;
    swingEvent.weaponId = def.id;
    game.emit('melee:swing', swingEvent);
  }

  // The swing's arms through the rig's aim pose, t s into it, aimed along yaw: a punch shoots the grip out; a bat
  // sweeps from the right to the left (the thugs' swings too: combat.js)
  function poseMelee(rig, def, t, yaw) {
    const m = def.melee;
    rig.aimWeight = 1;
    if (def.id === 'bat') {
      const strike = 0.13;
      let off, pitch;
      if (t < m.windup) {
        const k = t / m.windup;
        off = lerp(0, -1.5, k);
        pitch = lerp(0, -0.55, k);
      } else if (t < m.windup + strike) {
        const k = (t - m.windup) / strike;
        off = lerp(-1.5, 1.15, k * k * (3 - 2 * k));
        pitch = lerp(-0.55, 0.2, k);
      } else {
        const k = clamp((t - m.windup - strike) / (m.duration - m.windup - strike), 0, 1);
        off = lerp(1.15, 0.2, k);
        pitch = lerp(0.2, 0, k);
      }
      rig.aimYaw = yaw + off;
      rig.aimPitch = pitch;
      rig.aimReach = 0.42;
      rig.aimSupport = -0.09;
      rig.aimLeft = 1;
    } else {
      let reach;
      if (t < m.windup) reach = lerp(0.24, 0.18, t / m.windup);
      else if (t < m.windup + 0.07) reach = lerp(0.18, 0.64, (t - m.windup) / 0.07);
      else reach = lerp(0.64, 0.28, clamp((t - m.windup - 0.07) / (m.duration - m.windup - 0.07), 0, 1));
      rig.aimYaw = yaw + 0.12;
      rig.aimPitch = 0.08;
      rig.aimReach = reach;
      rig.aimSupport = 0.02;
      rig.aimLeft = 0.5;
    }
  }

  // =================================================================================================================
  // NPC BLOWS: a thug's swing landing (combat.js times the swing; this decides what it meets)
  // =================================================================================================================
  const blowResult = { hit: false, kind: null, x: 0, y: 0, z: 0, target: null, killed: false };
  let lastFloored = -Infinity;
  const _nOrigin = { x: 0, y: 0, z: 0 };

  /**
   * fireAt(attacker, origin {x,y,z}, dir {x,y,z}, weaponId) — one blow by anyone but the player, along dir from
   * origin over the weapon's reach: the player (NPC_PLAYER_DAMAGE of the damage; a bat may knock them down), a person
   * (not one of the attacker's faction), a car or a wall. attacker: an enemy handle (game.combat) or any object; its
   * ped view (attacker.view) is not hit. Returns a reused { hit, kind, x, y, z, target, killed }.
   */
  function fireAt(attacker, origin, dir, weaponId = 'fist', opts = null) {
    const def = DEFS[coerceWeapon(weaponId)];
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    if (!(dl > 1e-9) || !origin || attacker === 'player' || attacker === game.player) return null;
    const dx0 = dir.x / dl, dz0 = dir.z / dl;
    const hl = Math.hypot(dx0, dz0) || 1;
    const ignore = attacker?.view || (attacker?.type === 'ped' ? attacker : null);
    const ignore2 = attacker?.vehicle || null;
    blowResult.hit = false;
    blowResult.kind = null;
    blowResult.target = null;
    blowResult.killed = false;
    _nOrigin.x = origin.x;
    _nOrigin.y = origin.y;
    _nOrigin.z = origin.z;
    const h = copyHit(cast(_nOrigin, dir, def.range, ignore, ignore2, MASK.PLAYER | MASK.PEDS | MASK.VEHICLES | MASK.BUILDINGS), hitA);
    if (!h) return blowResult;
    blowResult.hit = true;
    blowResult.kind = h.kind;
    blowResult.x = h.x; blowResult.y = h.y; blowResult.z = h.z;
    blowResult.target = h.target;
    if (h.kind === 'player') {
      playerOpts.source = attacker;
      playerOpts.kind = 'melee';
      playerOpts.dirX = dx0 / hl;
      playerOpts.dirZ = dz0 / hl;
      game.player.damage(def.damage * NPC_PLAYER_DAMAGE * (opts?.damage ?? 1), playerOpts);
      // (floored now and then, but never kept down: a gang taking turns can't pin the player to the ground)
      if (def.id === 'bat' && game.player.alive && !game.player.knockedDown && game.time - lastFloored > NPC_KNOCKDOWN.grace
        && Math.random() < NPC_KNOCKDOWN.chance) {
        lastFloored = game.time;
        game.player.knockDown(dx0 / hl, dz0 / hl, 1.6);
      }
      fx.impact('flesh', h.x, h.y, h.z, h.nx, h.ny, h.nz);
    } else if (h.kind === 'ped' && h.target?.alive && !allyOf(attacker, h.target)) {
      hurtOpts.source = attacker;
      hurtOpts.byPlayer = false;
      hurtOpts.kind = 'melee';
      hurtOpts.dirX = dx0 / hl;
      hurtOpts.dirZ = dz0 / hl;
      blowResult.killed = world.hurtPed(h.target.id, def.damage, hurtOpts) === 'killed';
    } else if (h.kind === 'vehicle' && h.target && def.id === 'bat') {
      carOpts.source = attacker;
      carOpts.kind = 'melee';
      carOpts.byPlayer = false;
      carOpts.x = h.x;
      carOpts.y = h.y;
      carOpts.z = h.z;
      if (h.target.type === 'world') game.vehicles?.damage(h.target, def.melee.car * 0.5, carOpts);
      else world.damageCar(h.target, def.melee.car * 0.5, carOpts);
      fx.sparks(h.x, h.y, h.z, h.nx, h.ny, h.nz, 5, 4, 0.5);
    }
    return blowResult;
  }

  // =================================================================================================================
  // THE PLAYER, EACH FRAME
  // =================================================================================================================
  const handPos = new THREE.Vector3();
  const handQuat = new THREE.Quaternion();

  function footUpdate(def, canAct, dt, realDt) {
    const rig = person.rig;
    if (swing.active && dt > 0) {
      swing.t += dt;
      if (!swing.hit && swing.t >= def.melee.windup) {
        swing.hit = true;
        meleeHit(def);
      }
      if (swing.t >= def.melee.duration) swing.active = false;
    } else if (!swing.active && canAct && switchLeft <= 0 && fireBuffer > 0 && cooldown <= 0) {
      fireBuffer = 0;
      cooldown = 60 / def.rpm;
      startSwing(def);
    }
    // mid-swing the body turns to the camera's direction (the arms do the rest)
    if (canAct && (hipHold > 0 || swing.active)) ctl.aiming = true;
    setHold(rig, def);
    if (swing.active) poseMelee(rig, swing.def, swing.t, swing.yaw);
    void realDt;
  }

  function updatePlayer(dt, realDt) {
    const input = game.input;
    const pl = game.player;
    const playing = game.state === 'playing';
    const onFoot = pl.onFoot;
    const free = playing && pl.alive && !game.vehicles?.busy && !pl.knockedDown;
    const canAct = free && api.enabled && onFoot;
    if (free && onFoot) {
      if (input.slot >= 0) {
        const id = SLOT_IDS[input.slot];
        if (id && has(id)) equip(id);
      }
      if (input.pressed('weaponNext')) cycle(1);
      else if (input.pressed('weaponPrev')) cycle(-1);
    }
    if (input.pressed('fire') && canAct) fireBuffer = 0.25;
    if (dt > 0) {
      cooldown = Math.max(0, cooldown - dt);
      switchLeft -= dt;
      fireBuffer -= dt;
      hipHold -= dt;
    }
    const def = DEFS[currentId];
    // the hand's frame (the bat drawn in it)
    heldOk = false;
    if (onFoot && !person.hidden) {
      const rig = person.rig;
      heldOk = holdFrame(rig, def, rig.aimWeight, rig.aimYaw, rig.aimPitch, handPos, handQuat, !swing.active);
      // a pose left behind (a teleport): not drawn this frame
      if (heldOk && Math.hypot(handPos.x - person.position.x, handPos.z - person.position.z) > 1.6) heldOk = false;
    }
    if (onFoot) footUpdate(def, canAct, dt, realDt);
    else swing.active = false;
    if (!playing || !pl.alive) {
      swing.active = false;
      hipHold = 0;
    }
    // published state: the dot shows while squared up (the focus button) on foot
    api.aiming = onFoot && cameraSystem.aiming;
    api.crosshair = canAct && cameraSystem.aiming;
  }

  // ---- drawing: the player's bat, the thugs' ----
  const npcPos = new THREE.Vector3();
  const npcQuat = new THREE.Quaternion();
  function drawPlayer() {
    if (!game.player.onFoot || !heldOk || person.hidden) return;
    drawHeld(DEFS[currentId], handPos, handQuat);
  }

  function drawArmed() {
    const list = game.combat?.enemies();
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const p = e.record;
      if (!e.alive || !p || !p.placed || p.dead) continue;
      const def = DEFS[e.weaponId];
      if (!def || !def.model) continue;
      const rig = p.rig;
      if (!holdFrame(rig, def, rig.aimWeight, rig.aimYaw, rig.aimPitch, npcPos, npcQuat, !(e.swingT >= 0))) continue;
      // a pose not updated lately (out of view) is left where it was: skip it
      if (Math.hypot(npcPos.x - p.x, npcPos.z - p.z) > 1.6) continue;
      drawHeld(def, npcPos, npcQuat);
    }
  }

  // =================================================================================================================
  // EVENTS, SAVE, THE API
  // =================================================================================================================
  game.on('player:died', () => {
    swing.active = false;
  });

  const pickupEvent = { weaponId: '', ammo: 0 };
  const NO_AMMO = Object.freeze({ mag: 0, reserve: 0 });
  const api = {
    defs: DEFS,
    order: ORDER,
    allowed: ALLOWED_WEAPONS,
    enabled: true,
    // published each frame (for the HUD): aiming (squared up on foot), crosshair (show the dot)
    aiming: false,
    crosshair: false,
    get current() {
      return DEFS[currentId] || null;
    },
    get currentId() {
      return currentId;
    },
    /** Melee needs no ammunition: { 0, 0 } for an owned weapon, null otherwise */
    ammo: (id = currentId) => (has(id) ? NO_AMMO : null),
    has,
    /** Owned ids in slot order (a cached array, rebuilt when the pair changes: read only) */
    owned() {
      if (ownedDirty) {
        ownedList.length = 0;
        for (const id of ORDER) if (has(id)) ownedList.push(id);
        ownedDirty = false;
      }
      return ownedList;
    },
    /** Gives an allowed weapon (the bat) and takes it in hand from the fists; anything else is refused (false) */
    give(id) {
      if (!allowedWeapon(id) || id === 'fist') return false;
      const fresh = !owned.has(id);
      owned.add(id);
      ownedDirty = true;
      pickupEvent.weaponId = id;
      pickupEvent.ammo = 0;
      game.emit('weapon:pickup', pickupEvent);
      if (fresh && currentId === 'fist' && game.player.onFoot) equip(id);
      return true;
    },
    /** (melee needs no ammunition) */
    addAmmo: () => 0,
    remove(id) {
      if (id === 'fist' || !owned.has(id)) return false;
      owned.delete(id);
      ownedDirty = true;
      if (currentId === id) dropToFists(id);
      return true;
    },
    removeAll() {
      const prev = currentId;
      owned.clear();
      owned.add('fist');
      ownedDirty = true;
      if (prev !== 'fist') dropToFists(prev);
    },
    equip: (id) => equip(id),
    fireAt,
    /** Debug: the bat */
    giveAll() {
      for (const id of ORDER) if (id !== 'fist') api.give(id);
      return api.owned();
    },
    /** @internal combat.js: shape a rig's aim pose for a weapon */
    setHold,
    /** @internal the hold of a weapon (combat.js) */
    holdOf: (id) => DEFS[id]?.hold || null
  };
  function dropToFists(prev) {
    currentId = 'fist';
    swing.active = false;
    switchEvent.weaponId = 'fist';
    switchEvent.prevId = prev;
    game.emit('weapon:switch', switchEvent);
  }

  // Saved as { current, owned: { id: [0, 0] } } (the shape older saves have, ammunition and all): only what is allowed
  // comes back — a save from when there were guns loads with the guns gone and the fists (or the bat) in hand
  game.save.register('weapons', {
    get: () => {
      const list = {};
      for (const id of owned) list[id] = [0, 0];
      return { current: currentId, owned: list };
    },
    set: (data) => {
      if (!data || typeof data.owned !== 'object' || !data.owned) return;
      owned.clear();
      owned.add('fist');
      ownedDirty = true;
      for (const id of Object.keys(data.owned)) if (allowedWeapon(id)) owned.add(id);
      currentId = allowedWeapon(data.current) && has(data.current) ? data.current : 'fist';
    }
  });

  game.weapons = api;
  // the thugs (mission enemies; the police on foot, who carry nothing): game.combat
  registerCombat(game, { DEFS, setHold, poseMelee, coerceWeapon });

  game.addSystem({
    name: 'weapons',
    order: 50,
    update(dt, time, realDt) {
      drawBegin();
      updatePlayer(dt, realDt);
      drawPlayer();
      drawArmed();
      drawEnd();
    }
  });
  return api;
}

export { registerWeapons, DEFS as WEAPON_DEFS, ORDER as WEAPON_ORDER, ALLOWED_WEAPONS, allowedWeapon, coerceWeapon };
