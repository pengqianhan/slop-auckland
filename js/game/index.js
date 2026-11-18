// =====================================================================================================================
// SLOP AUCKLAND — THE GAME LAYER (js/game). API REFERENCE (the contract other systems build on; keep it accurate)
// =====================================================================================================================
// main.js: const game = createGame({ scene, renderer, controllerManager, cameraSystem, trafficSystem, audioSystem,
//   colliders, mapSystem, sandbox }); every frame: simDt = game.simDt(dt) steps controllers/traffic, then
//   game.update(simDt, simElapsed, dt). ?debug exposes it as window.akl.game. ?sandbox keeps the old free-roam toy
//   (mode toolbar, keys 1-4/K, no player/vehicles/input layers; world & fx still exist). ?show=fx loops an FX demo.
//
// CORE (core.js) ------------------------------------------------------------------------------------------------------
//   game.on(type, fn) -> off()    game.once(type, fn)    game.off(type, fn)    game.emit(type, payload)
//     synchronous; handlers that throw are logged once and skipped. Hot-path payloads are REUSED objects: copy fields
//     you keep.
//   game.addSystem({ name, order = 50, init?(game), update?(dt, time, realDt), dispose?() })   removeSystem(name)
//     dt = simulation step (0 while paused; small in slow motion), realDt = wall clock. Order: world 5, player 10,
//     vehicles 20, (yours 50), fx 80, ui 90, autosave 95. A throwing system is logged once and keeps being called.
//   game.state 'playing' | 'paused' | 'dead' | 'cutscene'; setState(s, { letterbox }), pause(), resume(), togglePause()
//     game.letterbox: a cutscene with black bars (default); setState('cutscene', { letterbox: false }) is a "hold" —
//     a shop's menu, a race countdown, a respray — the player out of harm's way, no bars, the HUD up
//   game.time (sim s), game.realTime, game.frame; game.timeScale (user scale); game.slowMo(scale, seconds);
//   game.hitStop(seconds)
//   helpers (exported here): damp(a, b, rate, dt), dampAngle, createSpring(w, z, x) + stepSpring(spring, target, dt)
//   game.sandbox (bool); game.engine { scene, renderer, controllerManager, cameraSystem, trafficSystem, audioSystem,
//   mapSystem } for the rare system that must touch the engine (prefer world / vehicles / fx)
//
// INPUT (input.js) game.input --- actions: enterExit F/Y, fire (swing) LMB/RT, aim (focus: square up, the camera over
//   the shoulder) RMB/LT, weaponNext E,wheel/RB, weaponPrev Q,wheel/LB, weaponSlot 1-2 (fists, bat), sprint Shift/L3,
//   crouch C, interact G/B, jump Space/A, pause Esc,P/Start, phone T/D-pad right, horn B. Pad aim/fire/weapons/sprint
//   only on foot (LT/RT drive cars). Without pointer lock (an embedded view) the left button on the view still swings.
//   input.down(a)  input.pressed(a)  input.released(a)  input.slot (-1 | 0..9 this frame)  input.wheel (-1|0|1)
//   input.label(a) -> key text for the current device    input.device 'keyboard'|'gamepad'|'touch'
//   input.bind(a, codes[]) (new actions get edges too)  input.consume(a)  input.pointerLocked  input.requestPointerLock()
//   input.exitPointerLock()  input.reset()  input.blocked (a menu is up: only pause & phone reach the game)
//   Mouse look under pointer lock (click the view; Esc frees it and pauses; drag-look fallback). Hidden tab pauses.
//
// PLAYER (player.js) game.player ------------------------------------------------------------------------------------
//   health/maxHealth 100, armor/maxArmor 100, stamina 0..100, money, alive/dead, invulnerable, vehicle (WorldVehicle |
//   null), onFoot, aiming, sprinting, crouching, knockedDown, entity (the controllers' person), position (Vector3 of
//   whatever the player is in), lastDamage { source, kind, at }, hospitals[], policeStations[]
//   damage(amount, { source, kind, dirX, dirZ }) -> lost   kinds: melee fall vehicle crash drown
//   heal(n)  addArmor(n)  addMoney(delta, reason)  knockDown(dirX, dirZ, s)  hitByVehicle(speed, nx, nz, by)
//   kill(cause, source)  bust(source) -> respawn at the nearest police station  respawnAt(x, z, heading)
//   nearest(places)  getMuzzle(out) (approximate right hand)
//   Death: state 'dead', slow-mo, banner, fade, respawn at the nearest hospital, fee min(money, 100) (busted: 10%, at most 500,
//   and the police keep the bat; a hospital trip keeps it). A vehicle hit takes 6.5 health per m/s over 2.5 m/s.
//
// VEHICLES (vehicles.js) game.vehicles ------------------------------------------------------------------------------
//   WorldVehicle: { id, type: 'world', kind (taxi sedan suv minivan pickup van bicycle helicopter), mode ('car' |
//     'cyclist' | 'helicopter'), label, police, hero, health/maxHealth, state ('ok'|'smoking'|'wrecked'),
//     driver ('player'|'ai'|null), locked, persistent, hidden, x y z heading speed vx vz (synced each frame), halfW
//     halfL height mass, entity (physics: position Vector3, heading, speed...), record (traffic car drawn for it) }
//   list()  current  busy  heroes { taxi, bicycle, helicopter }  KINDS
//   nearest(x, z, maxDist, filter?)  findCandidate() -> { vehicle | record (traffic car to steal), distance, verb }
//   enter(v, { instant })  exit({ bail, eject })  toggle() (what F does)
//   spawn(kind | 'police' | 'police-suv', x, z, heading, { paint, police, persistent, locked, label, health }) -> v|null
//   adopt(carView | carId, { persistent, locked, evict }) -> v   (takes a traffic car off the road as it drives)
//   setControls(v, throttle -1..1, steer +1 left..-1 right) (AI driving; throttle null hands it back)  remove(v)
//   damage(v, amount, { source, kind ('collision' | 'melee'), byPlayer, x, y, z })  damageTraffic(record, amount, opts)
//   repair(v)  wreck(v)
//   Health: < 45 smoke, < 25 heavy smoke, <= 0 wrecked: the engine dies, the car stalls, battered and smoking, and can't
//   be driven (the player climbs out); no fire, no explosion. Bicycles never break. Hero vehicles go home mended.
//
// WORLD (world.js) game.world --- views refreshed every frame (read-only):
//   world.peds[id]: { id, type: 'ped', active, alive, x, y, z, vx, vz, heading, radius, height, health, fleeing, free }
//   world.cars[id]: { id, type: 'traffic', active (on the road), x, y, z, vx, vz, heading, speed, halfW, halfL,
//     height, kind (... | 'bus'), police, health }
//   raycast(origin, dir, maxDist = 250, { mask, ignore, ignore2 }) -> shared hit | null:
//     { kind 'building'|'terrain'|'water'|'vehicle'|'ped'|'player', distance, x y z, nx ny nz, target (collider |
//       car view | WorldVehicle | ped view | world.playerView), id, material 'concrete'|'metal'|'glass'|'flesh'|
//       'dirt'|'water' }   masks: RAY_MASK.BUILDINGS TERRAIN WATER VEHICLES PEDS PLAYER STATIC ALL (world.MASK)
//   lineOfSight(a, b, { mask = STATIC, ignore }) -> bool   clearance(pivot, to) -> 0..1
//   nearbyPeds(x, z, r, out = [], includeDead)  nearbyCars(x, z, r, out = [])  witnesses(x, z, r = 30) -> count
//   groundHeight(x, z, yRef)  isOnRoad(x, z)  nearestRoadNode(x, z, maxDist) -> { x, z, signal, node }
//   randomRoadPoint(x, z, rMin, rMax, out?) -> { x, y, z, heading, edge, lane } | null
//   hurtPed(id, amount, { source, byPlayer, kind, dirX, dirZ }) -> 'killed' (knocked out)|'hurt'|null   killPed(id, opts)
//   panic(x, z, radius, { duration, cower })  spawnFleeingPed(x, z, fromX, fromZ, seconds) -> id
//   damageCar(id | view, amount, opts)  stopCar(id, s)  scareDrivers(x, z, r, s)  removeCar(id)
//
// FX (fx.js) game.fx --- pooled & instanced, no per-frame allocation; all positions world space:
//   sparks(x,y,z, nx,ny,nz, count, speed)  smoke(x,y,z, { count, size, life, color, alpha, rise, spread, grow })
//   fire(x,y,z, { count, size, life })  impact(material, x,y,z, nx,ny,nz)
//   (fx.js also keeps explosion / muzzleFlash / tracer primitives from before: nothing in the game calls them)
//   debris(x,y,z, count, speed, colorHex, size)  decal('scorch'|'hole'|'blood', x,y,z, nx,ny,nz, size, life)
//   light(x,y,z, colorHex, intensity, distance, ttl, key?) (10 shared point lights; the oldest is taken)
//   smokeEmitter / fireEmitter / sparkEmitter(x,y,z, opts) -> emitter { set(x,y,z), rate, size, color, stop() }
//   beacon(x, z, colorHex, { y, radius, height, visible }) -> { set(x, z, y?), setColor(hex), visible, remove() }
//   grade { desaturate 0..1, vignette 0..1, damagePulse 0..1, brightness (1), tint (hex), set({...}), reset() }: the
//     post-process colour grade (assign fields every frame, no allocation): hud.js drives low health & hits, cards.js
//     WRECKED / NICKED
//
// CAMERA game.camera --- shake(trauma 0..1), kick(fovDegrees), getAim(origin?, dir?) -> { origin, dir } (crosshair
//   ray, no shake), aiming, lookAlong(yaw, pitch), addLook(dYaw, dPitch), system (the CameraSystem), camera
//
// UI (ui.js + hud/*.js + menus.js, css/game.css: "City of Steals") game.ui --- prompt(text|null, action?),
//   banner(title|null, sub, { style: 'passed'|'failed'|'wasted'|'busted'|'title', seconds }), toast(text, s),
//   fade(0..1, s), crosshair(bool: force on), objective(text|null), subtitle(who, text, s), timer(seconds|null, label),
//   help(text|null, s) ([F] / {action} show as key caps), notify({ title, text, icon: 'phone'|'cash'|'star'|... }),
//   tip(id) (a first-time tip, hud/tips.js, once per save), hudVisible(bool),
//   menu({ title, subtitle, items: [{ label, detail, price, right, disabled, onSelect(item, i, menu) }], onClose })
//   -> { close(), setItems(items), refresh(), setTitle(t, s), open }, confirm(q, text, onYes, onNo),
//   setWaypoint(x, z, label) / clearWaypoint(), openPause(tab), titleOpen, settings, root (#game-ui).
//   Renders by itself from state & events: health/armour, money, wanted + the arrest meter, fists / bat in hand, radar
//   with game.blips, GPS route (route:true blips) & game.police units, speedometer, place names, cards, title screen &
//   pause menu.
//   Emits 'ui:title' { open, newGame }, 'ui:waypoint' { x, z, set }, 'settings:changed' { key, value, settings }.
//
// WEAPONS (weapons.js, combat.js) game.weapons, game.combat --- the whole arsenal is ALLOWED_WEAPONS = ['fist', 'bat']
//   (weapons.js): no guns or explosives anywhere; enemies swing bats or fists, the police carry nothing and arrest.
//   The API is at the top of weapons.js (and combat.js for the thugs, police.js / wanted.js for the police).
//
// SAVE (save.js) game.save --- register(key, { get() -> json, set(data, meta) }), save(), load(), clear();
//   localStorage 'akl-game-save' { version, savedAt, versions, data: { key: ... } }; autosaves every 5 s + on hide.
//
// EVENTS (payload fields; * = reused object)
//   state { state, prev }                       input:action* { action, slot, device }   input:pointerlock { locked }
//   player:damaged* { amount, armorDamage, health, armor, source, kind, dirX, dirZ }
//   player:died / player:busted { cause, source, x, y, z, busted }   player:respawned { at, place, x, z, cost }
//   player:healed { amount, health, armor }   player:knockdown { dirX, dirZ }   player:mode { mode, vehicle }
//   money:changed { money, delta, reason }
//   vehicle:entered* / vehicle:jacked* { vehicle, carjacked, victim (ped id | -1), x, z, witnesses }
//   vehicle:exited* { vehicle, bailed, x, z }   vehicle:spawned { vehicle }   vehicle:removed { vehicle }
//   vehicle:hit* / vehicle:damaged* { target (WorldVehicle | car view), amount, health, state, source, kind, byPlayer,
//     x, y, z }   vehicle:state* { target, state, prev }   vehicle:wrecked* { target, x, y, z, byPlayer, source }
//   ped:hit* / ped:killed* (knocked out) { ped (view), amount, health, kind, source, byPlayer, x, y, z, dirX, dirZ,
//     witnesses }   police:tackle { x, z, level }
//   save:loaded { savedAt }   save:written { savedAt }
// =====================================================================================================================

import { Game, damp, dampAngle, createSpring, stepSpring } from './core.js';
import { SaveStore } from './save.js';
import { createInput } from './input.js';
import { createUI } from './ui.js';
import { createWorld, RAY_MASK } from './world.js';
import { createFx } from './fx.js';
import { createPlayer } from './player.js';
import { createVehicles } from './vehicles.js';
// ---- SYSTEMS (weapons, police, missions, HUD...): one import here, one register line below -------------------------
import { registerWeapons } from './weapons.js';
import { registerPolice } from './police.js';
import { registerMissions } from './missions.js';
import { registerAudio } from './audio.js';
// (the HUD needs no line here: it is game.ui, js/game/ui.js, created by createGame)
// --------------------------------------------------------------------------------------------------------------------

function createGame({ scene, renderer, controllerManager, cameraSystem, trafficSystem, audioSystem = null, colliders = [], mapSystem = null, sandbox = false }) {
  const game = new Game({ sandbox });
  // the engine, for systems that genuinely need it (prefer game.world / game.vehicles)
  game.engine = { scene, renderer, controllerManager, cameraSystem, trafficSystem, audioSystem, mapSystem };
  game.save = new SaveStore(game, { enabled: !sandbox });
  game.fx = createFx(scene);
  game.world = createWorld(game, { controllerManager, trafficSystem, colliders, cameraSystem });
  game.camera = {
    system: cameraSystem,
    get camera() {
      return cameraSystem.camera;
    },
    get aiming() {
      return cameraSystem.aiming;
    },
    shake: (trauma) => cameraSystem.shake(trauma),
    kick: (degrees) => cameraSystem.kick(degrees),
    getAim: (origin, dir) => cameraSystem.getAim(origin, dir),
    lookAlong: (yaw, pitch) => cameraSystem.lookAlong(yaw, pitch),
    addLook: (dYaw, dPitch) => cameraSystem.addLook(dYaw, dPitch)
  };
  game.addSystem({ name: 'world', order: 5, update: (dt) => game.world.update(dt) });
  game.addSystem({ name: 'fx', order: 80, update: (dt) => game.fx.update(dt, cameraSystem.camera) });

  if (sandbox) return game;

  // ---- the game proper --------------------------------------------------------------------------------------------
  controllerManager.gameMode = true;
  cameraSystem.freeLook = true;
  cameraSystem.collide = game.world.clearance;
  game.input = createInput(game, { canvas: renderer.domElement, cameraSystem, controllerManager, getMapOpen: () => !!mapSystem?.isFullMapOpen });
  game.ui = createUI(game);
  game.input.buildTouch(game.ui.root);
  const player = createPlayer(game, { controllerManager, cameraSystem, fx: game.fx });
  game.player = player.player;
  game.vehicles = createVehicles(game, { controllerManager, trafficSystem, cameraSystem, world: game.world, fx: game.fx });
  game.addSystem({ name: 'player', order: 10, update: player.update });
  game.addSystem({ name: 'vehicles', order: 20, update: (dt) => game.vehicles.update(dt) });
  game.addSystem({ name: 'ui', order: 90, update: (dt, time, realDt) => game.ui.update(dt, time, realDt) });

  // the one player starts on foot, on the footpath at the taxi's kerbside, looking down Queen Street past it
  const taxi = controllerManager.entities.car;
  const th = taxi.heading;
  controllerManager.setMode('person');
  const startX = taxi.position.x + Math.cos(th) * 3.1 - Math.sin(th) * 1.2;
  const startZ = taxi.position.z - Math.sin(th) * 3.1 - Math.cos(th) * 1.2;
  const startY = controllerManager.getGroundHeight(startX, startZ, 'person', Infinity, 1);
  const me = controllerManager.entities.person;
  if (controllerManager.isClear(startX, startZ, startY, 0.45)) {
    me.position.set(startX, startY, startZ);
    me.prevX = startX;
    me.prevZ = startZ;
    me.heading = th;
    me.rig.placed = false;
  } else {
    controllerManager.teleportActiveTo(startX, startZ, th);
  }
  cameraSystem.lookAlong(th);

  // ---- SYSTEMS: register here (one line each) ---------------------------------------------------------------------
  registerWeapons(game);
  registerPolice(game);
  registerMissions(game);
  registerAudio(game);
  // (HUD: game.ui, see above)
  // ---------------------------------------------------------------------------------------------------------------

  game.save.load();
  let nextSave = 5;
  game.addSystem({
    name: 'autosave',
    order: 95,
    update: (dt, time, realDt) => {
      if ((nextSave -= realDt) > 0 || game.state !== 'playing') return;
      nextSave = 5;
      game.save.save();
    }
  });
  window.addEventListener('pagehide', () => game.save.save());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing') game.save.save();
  });

  if (new URLSearchParams(location.search).get('show') === 'fx') addFxShow(game);
  if (new URLSearchParams(location.search).has('range')) addRange(game);
  return game;
}

// ?range: practice in the nets. The cricket bat in hand and a handful of thugs with bats and fists around the player;
// a new wave a few seconds after the last one is knocked out.
function addRange(game) {
  let wait = 1.5, armed = false, wave = 0;
  game.addSystem({
    name: 'range',
    order: 95,
    update: (dt) => {
      if (game.state !== 'playing' || !game.player?.onFoot || !game.weapons || !game.combat) return;
      if (!armed) {
        armed = true;
        game.weapons.give?.('bat');
        game.weapons.equip?.('bat');
        game.player.addArmor?.(100);
      }
      if (game.combat.enemies().some((e) => e.alive && e.faction === 'range')) return;
      if ((wait -= dt) > 0) return;
      wait = 4;
      wave++;
      const p = game.player.position;
      const n = Math.min(3 + wave, 7);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + wave;
        const r = 16 + (i % 3) * 5;
        game.combat.spawnEnemy({
          x: p.x + Math.sin(a) * r, z: p.z + Math.cos(a) * r, heading: a + Math.PI,
          weaponId: i % 3 === 2 ? 'fist' : 'bat', health: 80, accuracy: 0.2, faction: 'range', aggroRange: 45
        });
      }
      game.ui?.notify?.({ title: 'Practice', text: `Wave ${wave}: ${n} thugs. Left button swings; right button squares you up.` });
    }
  });
}

// ?show=fx: every few seconds, a round of every effect 12 m ahead of the player
function addFxShow(game) {
  let next = 2;
  let beacon = null;
  game.addSystem({
    name: 'fx-show',
    order: 60,
    update: (dt, time, realDt) => {
      if ((next -= realDt) > 0) return;
      next = 4;
      const p = game.player.position;
      const h = game.engine.controllerManager.getActiveEntity().heading;
      const x = p.x + Math.sin(h) * 12, z = p.z + Math.cos(h) * 12;
      const y = game.world.groundHeight(x, z);
      if (!beacon) beacon = game.fx.beacon(x + 4, z, 0xffc02a);
      else beacon.set(x + 4, z);
      game.fx.impact('metal', x - 3, y + 1, z, -Math.sin(h), 0, -Math.cos(h));
      game.fx.impact('concrete', x + 2, y + 0.05, z - 2, 0, 1, 0);
      game.fx.impact('flesh', x - 2, y + 1, z + 2, 0, 0, 1);
      game.fx.smoke(x + 3, y, z + 3, { count: 10, size: 1.2 });
      game.fx.fire(x - 3, y, z - 3, { count: 12 });
      game.fx.sparks(x, y + 1, z + 3, 0, 1, 0, 24, 10);
      game.fx.debris(x + 1, y + 0.5, z - 1, 8, 4, 0x6a6a6a, 0.2);
    }
  });
}

export { createGame, damp, dampAngle, createSpring, stepSpring, RAY_MASK };
