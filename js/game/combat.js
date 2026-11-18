import { PEDESTRIAN_DIVE_DURATION } from '../pedestrians.js';

// The thugs: mission enemies (gangs, guards) and the police on foot (game/police.js spawns and removes those), free
// people the game steers (pedestrian-system "puppets") with a small brain. Nobody here carries a gun: a thug has a
// cricket bat or bare fists (game/weapons.js coerces anything else to the bat), the police nothing at all. On guard
// they stand at their post; they spot the player by sight lines within a view cone (or get hurt, or a mate does),
// close in and swing (the wind-up shows); lose the player and they search the last place seen, then go back (running
// into a wall on the way, they slide along it for a moment: there is no navigation mesh). At most
// MAX_ATTACKERS of them close in at a time (attack tokens): the rest circle at arm's length and wait their turn, so a
// crowd of them is a scuffle, not a pile-on.
// game.combat = {
//   spawnEnemy({ x, z, heading, weaponId = 'bat' ('bat' | 'fist'; anything else becomes the bat), health = 100,
//     accuracy = 0.35 (0..1: how quickly they swing again), aggroRange = 35 (m), faction = 'gang', hostile = true,
//     chase = false, pace = 'walk' | 'run' (how they go back to their post: a runner makes for it), runSpeed (m/s
//     flat out; default 4.2), preferRange }) -> enemy | null
//   enemies() -> live array of enemies (read only)   count   factionOfPed(pedId) -> faction | null
//   clear(faction?) removes them (all, or one faction's)   maxAttackers (attack tokens, default 2)
// }
// enemy = { id, pedId, faction, weaponId, alive, x, y, z, heading, health, state ('idle' | 'engage' | 'search' |
//   'return' | 'dead'), seesPlayer, hostile (swings at the player when close), chase (runs at the player to within
//   ~1.4 m: the police's arrests), pace, accuracy, aggroRange, view (the world.peds view), remove() (walks off if seen,
//   else vanishes), goto(x, z) (its post), setHostile(on), alert(x, z) (search there) }
// Events: enemy:killed { enemy, byPlayer } (knocked out), enemy:alerted { enemy }. Same-faction people are never hit by
// each other's blows (weapons.fireAt); the brain only ever targets the player. Knocked flat (a bat does it), they do
// nothing until they are up again.

const MAX_ATTACKERS = 2;
const SIGHT_INTERVAL = 0.2;
const VIEW_COS = Math.cos(1.75); // (about 100 degrees either side of where they face)
const CALL_FOR_HELP = 28;
const SPEED = { walk: 1.45, strafe: 1.5, advance: 2.4, run: 4.2 };
const CLOSE = 4.5; // m: inside this a thug without a token circles instead of closing in
const CIRCLE = 3.4; // m it keeps while circling

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

function registerCombat(game, { DEFS, setHold, poseMelee, coerceWeapon }) {
  const world = game.world;
  const traffic = game.engine.trafficSystem;
  const peds = traffic.pedestrians;
  const enemies = [];
  const byPed = new Map();
  let nextId = 1;
  let tokens = 0;

  const losOpts = { mask: world.MASK.STATIC };
  const eye = { x: 0, y: 0, z: 0 };
  const target = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 0 };

  class Enemy {
    constructor(pedId, opts) {
      this.id = nextId++;
      this.pedId = pedId;
      this.record = peds.peds[pedId];
      this.view = world.peds[pedId];
      this.faction = opts.faction ?? 'gang';
      this.weaponId = coerceWeapon(opts.weaponId ?? 'bat');
      this.accuracy = clamp(opts.accuracy ?? 0.35, 0, 1);
      this.aggroRange = opts.aggroRange ?? 35;
      this.hostile = opts.hostile ?? true;
      this.chase = opts.chase ?? false;
      this.pace = opts.pace === 'run' ? 'run' : 'walk';
      this.runSpeed = Number.isFinite(opts.runSpeed) ? opts.runSpeed : SPEED.run;
      this.preferRange = opts.preferRange ?? 1.2;
      this.alive = true;
      this.removed = false;
      this.state = 'idle';
      this.alerted = false;
      this.x = opts.x;
      this.y = 0;
      this.z = opts.z;
      this.heading = opts.heading ?? 0;
      this.guardX = opts.x;
      this.guardZ = opts.z;
      this.guardYaw = this.heading;
      this.seesPlayer = false;
      this.sightTime = 0;
      this.lastX = opts.x;
      this.lastZ = opts.z;
      this.lastSeenAt = -Infinity;
      this.searchUntil = 0;
      this.nextLook = Math.random() * SIGHT_INTERVAL;
      this.hasToken = false;
      this.circle = Math.random() < 0.5 ? 1 : -1;
      this.circleLeft = 0;
      this.cool = rand(0.2, 0.8);
      this.swingT = -1;
      this.swingYaw = 0;
      this.wantYaw = this.heading;
      // getting round things: no navigation mesh, so a person running into a wall slides along it for a moment
      this.stuckT = 0;
      this.sideT = 0;
      this.sideDir = Math.random() < 0.5 ? 1 : -1;
      this.prevX = opts.x;
      this.prevZ = opts.z;
    }

    get health() {
      return this.alive ? Math.max(0, this.record.hp) : 0;
    }

    remove() {
      removeEnemy(this);
    }

    goto(x, z) {
      this.guardX = x;
      this.guardZ = z;
      if (this.state === 'idle') this.state = 'return';
    }

    setHostile(on) {
      this.hostile = !!on;
      if (!on) releaseToken(this);
    }

    /** Heard or told about the player at (x, z): go and look (someone neither hostile nor chasing keeps going) */
    alert(x, z) {
      if (!this.alive || (!this.hostile && !this.chase)) return;
      this.lastX = x;
      this.lastZ = z;
      if (this.state !== 'engage') {
        this.state = 'search';
        this.searchUntil = game.time + 9;
      }
      raiseAlert(this);
    }
  }

  function raiseAlert(e) {
    if (e.alerted) return;
    e.alerted = true;
    game.emit('enemy:alerted', { enemy: e });
  }

  function releaseToken(e) {
    if (e.hasToken) {
      e.hasToken = false;
      tokens = Math.max(0, tokens - 1);
    }
  }

  // A spot to stand on near (x, z): there if it is clear of buildings, else the nearest clear one within 12 m (a
  // point given inside a footprint would leave the person stuck in it), else there anyway
  const spot = { x: 0, z: 0 };
  function clearSpot(x, z) {
    const cm = game.engine.controllerManager;
    spot.x = x;
    spot.z = z;
    if (cm.isClear(x, z, world.groundHeight(x, z), 0.4)) return spot;
    for (let r = 1; r <= 12; r += 1) {
      const n = Math.max(8, Math.round(r * 5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const cx = x + Math.sin(a) * r, cz = z + Math.cos(a) * r;
        if (cm.isClear(cx, cz, world.groundHeight(cx, cz), 0.4)) {
          spot.x = cx;
          spot.z = cz;
          return spot;
        }
      }
    }
    return spot;
  }

  function spawnEnemy(opts = {}) {
    if (!Number.isFinite(+opts.x) || !Number.isFinite(+opts.z)) return null;
    clearSpot(+opts.x, +opts.z);
    const x = spot.x, z = spot.z;
    const heading = Number.isFinite(opts.heading) ? opts.heading : Math.random() * Math.PI * 2;
    const pedId = peds.spawnFree(x, z, x - Math.sin(heading), z - Math.cos(heading), 0);
    if (pedId < 0) return null;
    peds.setPuppet(pedId, true);
    const p = peds.peds[pedId];
    p.hp = Math.max(1, opts.health ?? 100);
    p.puppetYaw = heading;
    p.freeVX = p.freeVZ = 0;
    const e = new Enemy(pedId, { ...opts, x, z, heading });
    // (officers in uniform: pedestrian-system takes it off again when the person is reused)
    if (e.faction === 'police') peds.setOutfit?.(pedId, 'police');
    setHold(p.rig, DEFS[e.weaponId]);
    enemies.push(e);
    byPed.set(pedId, e);
    return e;
  }

  function drop(e) {
    releaseToken(e);
    e.alive = false;
    byPed.delete(e.pedId);
    const i = enemies.indexOf(e);
    if (i >= 0) enemies.splice(i, 1);
  }

  function removeEnemy(e) {
    if (e.removed) return;
    e.removed = true;
    const p = e.record;
    if (e.alive && p.placed && !p.dead && p.puppet) {
      p.rig.aimWeight = 0;
      // walking off if anyone could see it go; vanishing otherwise
      if (traffic.game.nearView(p.x, p.z, 2, 150)) peds.setPuppet(e.pedId, false);
      else {
        p.puppet = false;
        p.free = false;
        p.placed = false;
        p.rig.placed = false;
      }
    }
    e.state = 'dead';
    drop(e);
  }

  function knockOut(e, byPlayer) {
    if (!e.alive) return;
    e.state = 'dead';
    drop(e);
    game.emit('enemy:killed', { enemy: e, byPlayer: !!byPlayer });
  }

  // ---- events: knock-outs, wounds (they and their mates come looking) ----
  game.on('ped:killed', (ev) => {
    const e = byPed.get(ev.ped?.id);
    if (e) knockOut(e, ev.byPlayer);
  });
  game.on('ped:hit', (ev) => {
    const e = byPed.get(ev.ped?.id);
    if (!e || !e.alive || !ev.byPlayer) return;
    const pp = game.player.position;
    e.alert(pp.x, pp.z);
    for (let i = 0; i < enemies.length; i++) {
      const o = enemies[i];
      if (o !== e && o.faction === e.faction && o.hostile && Math.hypot(o.x - e.x, o.z - e.z) < CALL_FOR_HELP) o.alert(pp.x, pp.z);
    }
  });
  game.on('player:respawned', () => {
    for (const e of enemies) {
      releaseToken(e);
      e.state = 'return';
      e.sightTime = 0;
      e.alerted = false;
      e.lastSeenAt = -Infinity;
    }
  });

  // =================================================================================================================
  // THE BRAIN
  // =================================================================================================================
  // A swing when close (the player's timeline, a bit slower to recover): the windup shows, then the blow lands (or not)
  function swingAt(e, def, dist, dt) {
    e.cool -= dt;
    const m = def.melee;
    if (e.swingT >= 0) {
      e.swingT += dt;
      if (e.swingT >= m.windup && e.swingT - dt < m.windup) {
        dir.x = target.x - e.x;
        dir.y = target.y - 0.2 - (e.y + 1.3);
        dir.z = target.z - e.z;
        eye.y = e.y + 1.3;
        game.weapons?.fireAt(e, eye, dir, e.weaponId);
      }
      if (e.swingT > m.duration) {
        e.swingT = -1;
        // (a turn each: after a swing the token usually passes to someone circling)
        if (Math.random() < 0.65) {
          releaseToken(e);
          e.cool = Math.max(e.cool, rand(0.6, 1.2));
        }
      }
    } else if (e.seesPlayer && dist < 1.7 && e.cool <= 0) {
      e.swingT = 0;
      e.swingYaw = Math.atan2(target.x - e.x, target.z - e.z);
      e.cool = (60 / def.rpm) * 1.7 * (1.3 - 0.6 * e.accuracy);
    }
  }

  function think(e, dt) {
    const p = e.record;
    if (p.dead) {
      knockOut(e, false); // (down without an event: by the crowd's own hand)
      return;
    }
    if (!p.placed || !p.puppet) {
      drop(e); // taken over by someone else
      return;
    }
    const def = DEFS[e.weaponId];
    const pl = game.player;
    const playing = game.state === 'playing' && pl.alive;
    // knocked flat: lying there, then getting up (pedestrian-system holds the body still meanwhile)
    const down = world.clock - p.diveStart < PEDESTRIAN_DIVE_DURATION;
    e.x = p.x;
    e.z = p.z;
    e.y = e.view.y;
    e.heading = p.puppetYaw;
    // the player: the chest on foot (lower knocked down), the cabin in a vehicle
    const tp = pl.position;
    target.x = tp.x;
    target.y = tp.y + (pl.onFoot ? (pl.knockedDown ? 0.4 : pl.crouching ? 0.85 : 1.2) : 0.9);
    target.z = tp.z;
    const dx = target.x - p.x, dz = target.z - p.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const s = p.rig.s || 1;
    eye.x = p.x;
    eye.y = e.y + 1.6 * s;
    eye.z = p.z;

    // perception (a sight line a few times a second)
    if ((e.nextLook -= dt) <= 0) {
      e.nextLook = SIGHT_INTERVAL * rand(0.8, 1.2);
      let sees = false;
      if ((e.hostile || e.chase) && playing) {
        const alert = e.state === 'engage' || e.state === 'search';
        const range = alert ? e.aggroRange * 1.6 : e.aggroRange;
        if (dist < range) {
          const facing = (dx * Math.sin(p.puppetYaw) + dz * Math.cos(p.puppetYaw)) / dist;
          if (alert || facing > VIEW_COS || dist < 9) sees = world.lineOfSight(eye, target, losOpts);
        }
      }
      e.seesPlayer = sees;
    }
    if (!playing) e.seesPlayer = false;
    if (e.seesPlayer) {
      e.sightTime += dt;
      e.lastX = target.x;
      e.lastZ = target.z;
      e.lastSeenAt = game.time;
      if (e.state !== 'engage') {
        e.state = 'engage';
        raiseAlert(e);
      }
    } else {
      e.sightTime = Math.max(0, e.sightTime - dt * 1.5);
    }

    let vx = 0, vz = 0;
    let yaw = e.wantYaw;
    switch (e.state) {
      case 'engage': {
        if (!playing || (!e.hostile && !e.chase)) {
          e.state = 'return';
          releaseToken(e);
          break;
        }
        if (game.time - e.lastSeenAt > 1.6) {
          e.state = 'search';
          e.searchUntil = game.time + 9;
          releaseToken(e);
          break;
        }
        const ux = dx / dist, uz = dz / dist;
        yaw = Math.atan2(ux, uz);
        if (e.chase || !e.hostile) {
          // straight at the player, flat out until within arm's reach (an arrest: the police's hands on them; easing
          // off any sooner, they'd never close on someone jogging away)
          const sp = dist > 1.3 ? e.runSpeed : 0;
          vx = ux * sp;
          vz = uz * sp;
          break;
        }
        // a thug: closes in with a token, else circles at arm's length until one comes free
        if (!e.hasToken && dist < CLOSE + 2 && tokens < api.maxAttackers && e.cool <= 0.4) {
          tokens++;
          e.hasToken = true;
        } else if (e.hasToken && dist > CLOSE + 3) {
          releaseToken(e);
        }
        if (e.hasToken || dist > CLOSE) {
          const sp = dist > 6 ? e.runSpeed : dist > 1.4 ? SPEED.advance : 0;
          vx = ux * sp;
          vz = uz * sp;
        } else {
          if ((e.circleLeft -= dt) <= 0) {
            e.circleLeft = rand(1.2, 2.6);
            if (Math.random() < 0.4) e.circle = -e.circle;
          }
          const radial = clamp((dist - CIRCLE) * 1.5, -SPEED.strafe, SPEED.strafe);
          vx = uz * e.circle * SPEED.strafe + ux * radial;
          vz = -ux * e.circle * SPEED.strafe + uz * radial;
        }
        if (down) {
          e.swingT = -1; // (a swing cut short by the fall)
          releaseToken(e);
        } else swingAt(e, def, dist, dt);
        break;
      }
      case 'search': {
        const sx = e.lastX - p.x, sz = e.lastZ - p.z;
        const sd = Math.hypot(sx, sz);
        if (sd > 2) {
          vx = (sx / sd) * e.runSpeed * 0.85;
          vz = (sz / sd) * e.runSpeed * 0.85;
          yaw = Math.atan2(sx, sz);
        } else {
          yaw = e.wantYaw + dt * 1.4; // looking about
        }
        if (game.time > e.searchUntil) {
          e.state = 'return';
          e.alerted = false;
        }
        break;
      }
      case 'return': {
        const gx = e.guardX - p.x, gz = e.guardZ - p.z;
        const gd = Math.hypot(gx, gz);
        if (gd > 1.2) {
          const sp = e.pace === 'run' ? e.runSpeed : SPEED.walk;
          vx = (gx / gd) * sp;
          vz = (gz / gd) * sp;
          yaw = Math.atan2(gx, gz);
        } else {
          e.state = 'idle';
          e.alerted = false;
        }
        break;
      }
      default: {
        // on guard: at the post, looking about a little
        const gx = e.guardX - p.x, gz = e.guardZ - p.z;
        if (Math.hypot(gx, gz) > 3) e.state = 'return';
        yaw = e.guardYaw + Math.sin(game.time * 0.35 + e.id) * 0.6;
      }
    }
    if (e.state !== 'engage' && e.swingT >= 0 && e.swingT > def.melee.duration) e.swingT = -1;
    if (down) vx = vz = 0;
    // stuck against a wall (asking to move, hardly moving): off to one side along it for a moment, then try again
    const want = Math.hypot(vx, vz);
    const moved = Math.hypot(p.x - e.prevX, p.z - e.prevZ);
    e.prevX = p.x;
    e.prevZ = p.z;
    if (e.sideT > 0) {
      e.sideT -= dt;
      const c = Math.cos(1.3), s = Math.sin(1.3) * e.sideDir;
      const rx = vx * c - vz * s, rz = vx * s + vz * c;
      vx = rx;
      vz = rz;
    } else if (want > 1 && moved < want * dt * 0.25) {
      if ((e.stuckT += dt) > 0.6) {
        e.stuckT = 0;
        e.sideT = 1.2 + Math.random() * 0.8;
        e.sideDir = -e.sideDir;
      }
    } else {
      e.stuckT = Math.max(0, e.stuckT - dt);
    }
    // a little room between them
    for (let i = 0; i < enemies.length; i++) {
      const o = enemies[i];
      if (o === e) continue;
      const ox = p.x - o.x, oz = p.z - o.z;
      const od = Math.hypot(ox, oz);
      if (od < 1.3 && od > 1e-3) {
        vx += (ox / od) * (1.3 - od) * 2.5;
        vz += (oz / od) * (1.3 - od) * 2.5;
      }
    }
    p.puppetVX = vx;
    p.puppetVZ = vz;
    e.wantYaw = wrap(yaw);
    p.puppetYaw = wrap(p.puppetYaw + wrap(e.wantYaw - p.puppetYaw) * (1 - Math.exp(-dt * 9)));

    // the arms: a thug squares up when close (the bat raised); the swing poses itself
    const rig = p.rig;
    setHold(rig, def);
    if (e.swingT >= 0) {
      poseMelee(rig, def, e.swingT, e.swingYaw);
    } else {
      const guard = e.hostile && e.state === 'engage' && dist < CLOSE + 2 ? 1 : 0;
      const w = rig.aimWeight + (guard - rig.aimWeight) * (1 - Math.exp(-dt * 6));
      rig.aimWeight = w < 0.01 ? 0 : w;
      rig.aimYaw = Math.atan2(dx, dz);
      rig.aimPitch = clamp(Math.atan2(eye.y - target.y, dist), -1, 1) * 0.3;
    }
  }

  const api = {
    spawnEnemy,
    enemies: () => enemies,
    get count() {
      return enemies.length;
    },
    maxAttackers: MAX_ATTACKERS,
    factionOfPed: (pedId) => byPed.get(pedId)?.faction ?? null,
    enemyOfPed: (pedId) => byPed.get(pedId) || null,
    /** Removes every enemy (or one faction's) */
    clear(faction = null) {
      for (let i = enemies.length - 1; i >= 0; i--) {
        if (!faction || enemies[i].faction === faction) enemies[i].remove();
      }
    }
  };
  game.combat = api;

  game.addSystem({
    name: 'combat',
    order: 48,
    update(dt) {
      if (!(dt > 0)) return;
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (e) think(e, dt);
      }
    }
  });
  return api;
}

export { registerCombat };
