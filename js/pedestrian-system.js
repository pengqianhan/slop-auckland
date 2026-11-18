import { blockAt } from './city-config.js';
import { terrainHeight } from './terrain.js';
import { createPedestrianRoutes } from './pedestrian-routes.js';
import { PersonCrowd, PersonRig, PEDESTRIAN_DIVE_DURATION } from './pedestrians.js';

// Local pedestrian population: connected walks, curb queues, conversations and player avoidance.
// Traffic supplies crossing permissions and view checks; this system owns the crowd and its animation.
const NUM_PEDS = 340;
const PED_RADIUS = 320;
const NEAR_RADIUS = 350;
const PED_SPAWN_DISTANCE = 150;
const PED_AVOID_INTERVAL = 0.12;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// The game (js/game/world.js): hit points, how long the dead lie before they are taken away (out of sight), running
// away from danger, and cowering (the crouch of the evasive dive's get-up, held: seconds into PEDESTRIAN_DIVE_DURATION)
const PED_HP = 100;
const CORPSE_TIME = 30;
const FLEE_SPEED = 4.4;
const COWER_POSE = 1.86;
const DEATH_POSE = 1.0; // lying face down
const FREE_RUN_SPEED = 5.2;

function createPedestrianSystem(network, { player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView }) {
  let clock = 0;
  let focusX = 0, focusZ = 140;
  let hasView = false;
  let pedRange = 0;
  let pedCursor = 0;

  for (const n of network.nodes) {
    n.walkers = []; // pedestrians on its crosswalks
    n.curb = []; // pedestrians at or approaching its curbs
  }

  // One instanced draw per level of detail; every pedestrian has a PersonRig that plants its footsteps on the
  // sidewalk (no sliding), with their own build, height, sex, hair, clothes and gait
  const pedCrowd = new PersonCrowd(NUM_PEDS);
  const hash = (i, salt) => {
    const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const peds = [];
  for (let i = 0; i < NUM_PEDS; i++) {
    const female = hash(i, 1) < 0.48;
    const hairRoll = hash(i, 2);
    peds.push({
      placed: false,
      crossesStreets: i % 6 === 0, // some start near crossings; everyone can use them along their route
      x: 0,
      z: 0,
      ax: 0, // track: start, direction, length; position along it and walking direction
      az: 0,
      ux: 0,
      uz: 1,
      len: 1,
      t: 0,
      dir: 1,
      node: null, // the intersection of its crosswalk, which side of it, where along it
      side: 0,
      coord: 0,
      line: 0, // its line over the crosswalk, off the centre line
      waiting: false,
      walkDelay: 0.2 + hash(i, 8) * 1.3,
      walkAt: -1,
      speed: 1.22 + (i % 5) * 0.1 + hash(i, 3) * 0.08, // preferred walking speed
      v: 0, // current speed, easing up to it and down to stops
      pause: 0,
      route: null,
      nextRoute: null,
      nextLeg: 0,
      goalX: 0,
      goalZ: 0,
      goalTime: 0,
      restTime: 0,
      socialTime: 0,
      conversation: null,
      avoidUntil: 0,
      avoidCheck: 0,
      avoidSpeed: 0,
      avoidT: 0,
      resumeDir: 0,
      dodge: 0,
      dodgeTarget: 0,
      diveStart: -Infinity,
      diveHeading: 0,
      diveT: 0,
      // the game: health, death, fleeing & cowering, and free running off the walking tracks (a driver thrown out)
      id: i,
      hp: PED_HP,
      dead: false,
      deathTime: 0,
      deathYaw: 0,
      fleeUntil: 0,
      fleeSpeed: FLEE_SPEED + hash(i, 9) * 1.2,
      fleeX: 0,
      fleeZ: 0,
      cowerStart: 0,
      cowerUntil: 0,
      free: false,
      // a free person the game steers (js/game/combat.js: armed enemies, cops on foot): the velocity it wants and
      // where it faces; never taken back by the crowd
      puppet: false,
      puppetVX: 0,
      puppetVZ: 0,
      puppetYaw: 0,
      freeUntil: 0,
      freeVX: 0,
      freeVZ: 0,
      freeSince: 0,
      rig: new PersonRig({
        seed: i * 1.6180339 + 0.13,
        female,
        scale: (female ? 0.91 : 0.97) + hash(i, 4) * 0.1,
        girth: 0.9 + hash(i, 5) * 0.24,
        hair: female ? (hairRoll < 0.68 ? 1 : 0.3 + hairRoll * 0.25) : hairRoll < 0.08 ? 1 : hairRoll * 0.35,
        armSwing: 0.75 + hash(i, 6) * 0.5,
        stride: 0.94 + hash(i, 7) * 0.12
      })
    });
  }

  const KERB = 1.6; // how far along a crosswalk track pedestrians wait to cross (the curb is 2 m along)
  const pedRoutes = createPedestrianRoutes(network, blockAt);
  const track = { ax: 0, az: 0, ux: 0, uz: 1, len: 1, node: null, side: 0, line: 0, route: null };

  function sidewalkTrack(e) {
    const choices = pedRoutes.along(e);
    if (!choices.length) return false;
    const route = choices[Math.floor(Math.random() * choices.length)];
    Object.assign(track, route, { route });
    return true;
  }

  function crosswalkTrack(n) {
    const choices = pedRoutes.across(n);
    if (!choices.length) return false;
    const route = choices[Math.floor(Math.random() * choices.length)];
    Object.assign(track, route, { route });
    return true;
  }

  // Who is at (or just past) the curbs of each intersection's crosswalks, for whoever comes up behind to queue
  const QUEUE_GAP = 0.62; // m from one person standing in a queue to the next
  const curbNodes = [];
  const curbProgress = (p) => (p.dir > 0 ? p.t : p.len - p.t); // m along its way over (the curb it waits at is KERB)
  function nextCrossingLeg(p) {
    const route = p.nextRoute;
    if (!route) return null;
    for (let i = p.nextLeg; i < route.length; i++) {
      if (route[i].track.node) return route[i];
    }
    return null;
  }
  function atCurb(p) {
    const crossing = p.node ? null : nextCrossingLeg(p);
    const n = p.node || crossing?.track.node;
    if (!n || (p.node && curbProgress(p) > KERB + 0.5) || p._curbNode === n) return;
    if (!n.curb.length) curbNodes.push(n);
    n.curb.push(p);
    p._curbNode = n;
  }
  function gatherCurbs() {
    for (const n of curbNodes) {
      for (let i = 0; i < n.curb.length; i++) n.curb[i]._curbNode = null;
      n.curb.length = 0;
    }
    curbNodes.length = 0;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (p.placed && !p.dead && !p.free) atCurb(p);
    }
  }

  // Try crosswalks first for crossing pedestrians, then fall back to sidewalks if no suitable crossing fits.
  function spawnPed(p, rMin, rMax, protectView) {
    const rMinSq = rMin * rMin, rMaxSq = rMax * rMax, gapSq = QUEUE_GAP * QUEUE_GAP;
    for (let attempt = 0; attempt < 10; attempt++) {
      const crosswalk = p.crossesStreets && nearSignals.length > 0 && attempt < 5;
      const ok = crosswalk
        ? crosswalkTrack(nearSignals[Math.floor(Math.random() * nearSignals.length)])
        : nearEdges.length > 0 && sidewalkTrack(nearEdges[Math.floor(Math.random() * nearEdges.length)]);
      if (!ok) continue;
      const along = (focusX - track.ax) * track.ux + (focusZ - track.az) * track.uz;
      const minT = Math.max(0, along - rMax), maxT = Math.min(track.len, along + rMax);
      if (minT > maxT) continue;
      const t = crosswalk ? (Math.random() < 0.5 ? Math.random() * KERB : track.len - Math.random() * KERB) : minT + Math.random() * (maxT - minT);
      const x = track.ax + track.ux * t;
      const z = track.az + track.uz * t;
      const dx = x - focusX, dz = z - focusZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < rMinSq || d2 > rMaxSq || (protectView && nearView(x, z, 2, PED_SPAWN_DISTANCE))) continue;
      if (player.active && (x - player.x) * (x - player.x) + (z - player.z) * (z - player.z) < 100) continue;
      if (crosswalk) {
        let crowded = false;
        const curb = track.node.curb;
        for (let i = 0; i < curb.length; i++) {
          const q = curb[i];
          if ((q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < gapSq) { crowded = true; break; }
        }
        if (crowded) continue;
      }
      if (p.conversation) endConversation(p.conversation);
      Object.assign(p, track);
      p.t = t;
      p.dir = t < track.len * 0.5 ? 1 : -1;
      p.x = x;
      p.z = z;
      p.v = crosswalk ? 0 : p.speed;
      p.pause = 0;
      p.waiting = false;
      p.walkAt = -1;
      p.avoidUntil = 0;
      p.resumeDir = 0;
      p.dodge = p.dodgeTarget = 0;
      p.diveStart = -Infinity;
      p.avoidCheck = clock + Math.random() * PED_AVOID_INTERVAL;
      p.nextRoute = null;
      p.nextLeg = 0;
      p.goalTime = 0;
      p.restTime = clock + 25 + Math.random() * 45;
      p.socialTime = clock + 5 + Math.random() * 15;
      p._curbNode = null;
      p.hp = PED_HP;
      p.dead = p.free = p.puppet = false;
      p.fleeUntil = p.cowerUntil = 0;
      p.rig.aimWeight = 0; // (an armed enemy's arms, put down)
      p.rig.setOutfit(null); // (and a uniform, taken off)
      p.rig.placed = false; // stands afresh where it now is
      p.placed = true;
      if (crosswalk) atCurb(p);
      return true;
    }
    return false;
  }

  // Continue through validated sidewalk corners. Crossing tracks retain their curb queues and right of way;
  // only a dead end needs a turnaround. Goals guide local choices without a city-wide path search.
  const PED_ACCEL = 1.3; // m/s^2 setting off
  const PED_BRAKE = 1.6; // m/s^2 easing to a stop
  const TURN_TIME = 0.85; // s turning round at the end of the track
  const PED_ESCAPE_SPEED = 5;
  const PED_ESCAPE_ACCEL = 9;
  const PED_ESCAPE_BRAKE = 6;
  const PED_LOOKAHEAD = 1.5;
  const PED_DIVE_DISTANCE = 1.9;
  const PED_DODGE_SPEED = PED_DIVE_DISTANCE / 0.5;

  // Limit an escape to the current validated track, respecting curbs and people in either direction.
  // Only threatened pedestrians do this local scan, at most once every 120 ms.
  function escapeRoom(p, dir) {
    let room = dir > 0 ? p.len - p.t : p.t;
    const s = dir > 0 ? p.t : p.len - p.t;
    if (p.node && s <= KERB + 1e-6 && !mayCross(p)) room = Math.min(room, Math.max(0, KERB - s));
    for (const q of peds) {
      if (q === p || !q.placed) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const forward = (dx * p.ux + dz * p.uz) * dir;
      if (forward <= 0 || forward > Math.min(room + QUEUE_GAP, 6)) continue;
      const side = dx * p.uz - dz * p.ux;
      if (Math.abs(side) < QUEUE_GAP) room = Math.min(room, Math.max(0, forward - Math.sqrt(QUEUE_GAP * QUEUE_GAP - side * side)));
    }
    return room;
  }

  // Sweep the pedestrian against the player's oriented footprint. Short linear segments account for braking,
  // acceleration and track ends without missing fast vehicles between samples or allocating temporary vectors.
  function playerContactTime(p, speed, room, emergency = true, dodgeTarget = p.dodgeTarget, diving = false) {
    const dir = speed < 0 ? -1 : speed > 0 ? 1 : p.dir;
    let v = diving ? speed : dir === p.dir ? p.v * p.dir : 0;
    let moved = 0;
    let side = p.dodge;
    const dx = p.x - player.x, dz = p.z - player.z;
    let x = dx * player.fz - dz * player.fx, z = dx * player.fx + dz * player.fz;
    const ux = p.ux * player.fz - p.uz * player.fx, uz = p.ux * player.fx + p.uz * player.fz;
    const vx = player.vx * player.fz - player.vz * player.fx, vz = player.vx * player.fx + player.vz * player.fz;
    const sideways = dodgeTarget !== p.dodge;
    const diveX = Math.abs(sideways ? uz : ux), diveZ = Math.abs(sideways ? ux : uz);
    // A prone pedestrian is longer than a standing one; project that body into the car's frame too.
    const halfW = player.halfW + (diving ? diveX + 0.4 * diveZ : 0.45);
    const halfL = player.halfL + (diving ? diveZ + 0.4 * diveX : 0.45);
    const acceleration = emergency ? PED_ESCAPE_ACCEL : PED_ACCEL;
    const braking = emergency ? PED_ESCAPE_BRAKE : 2 * PED_BRAKE;
    const step = 0.25;
    for (let time = 0; time < PED_LOOKAHEAD; time += step) {
      const rate = Math.abs(speed) > Math.abs(v) ? acceleration : braking;
      const nextV = diving ? speed : v + clamp(speed - v, -rate * step, rate * step);
      const distance = Math.min(room - moved, Math.abs((v + nextV) * 0.5 * step));
      moved += distance;
      const sideStep = clamp(dodgeTarget - side, -(diving || dodgeTarget ? PED_DODGE_SPEED : 1.8) * step, (diving || dodgeTarget ? PED_DODGE_SPEED : 1.8) * step);
      side += sideStep;
      const sx = ux * dir * distance + uz * sideStep - vx * step;
      const sz = uz * dir * distance - ux * sideStep - vz * step;
      let enter = 0, exit = 1;
      for (let axis = 0; axis < 2; axis++) {
        const pos = axis ? z : x, delta = axis ? sz : sx;
        const extent = axis ? halfL : halfW;
        if (Math.abs(delta) < 1e-6) {
          if (Math.abs(pos) > extent) { exit = -1; break; }
        } else {
          const a = (-extent - pos) / delta, b = (extent - pos) / delta;
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (enter <= exit) return time + enter * step;
      x += sx; z += sz; v = nextV;
    }
    return Infinity;
  }

  function turnPed(p, dir) {
    p.walkAt = -1;
    p.dir = dir;
    p.v = 0;
    p.nextRoute = null;
    p.nextLeg = 0;
    p.waiting = false;
  }

  function dodgeClear(p, offset, diving = false) {
    // Reserve space for the outstretched body as well as its centre when landing.
    const end = offset + (diving ? Math.sign(offset - p.dodge) * 0.9 : 0);
    if (!pedRoutes.canDodge(p, end)) return false;
    const dx = p.uz * (end - p.dodge), dz = -p.ux * (end - p.dodge);
    const lengthSq = dx * dx + dz * dz;
    for (const q of peds) {
      if (q === p || !q.placed) continue;
      const t = clamp(((q.x - p.x) * dx + (q.z - p.z) * dz) / lengthSq, 0, 1);
      if ((p.x + dx * t - q.x) ** 2 + (p.z + dz * t - q.z) ** 2 < QUEUE_GAP ** 2) return false;
    }
    return true;
  }

  function avoidPlayer(p) {
    // Commit to the landing and get-up; steering or walking during this pose would slide across the ground.
    if (clock - p.diveStart < PEDESTRIAN_DIVE_DURATION) return;
    // Stay off the walking line until the approaching vehicle has passed; returning is swept too.
    if (p.dodgeTarget && clock >= p.avoidUntil) {
      if ((!p.dodge || dodgeClear(p, 0)) && (!pedRange || playerContactTime(p, 0, 0, true, 0) === Infinity)) p.dodgeTarget = 0;
      else p.avoidUntil = clock + 0.6;
    }
    // A retreat is temporary: once clear, turn back toward the original destination instead of walking into
    // the people behind. Corner transitions below discard this old direction along with the escape boundary.
    if (p.resumeDir && (clock >= p.avoidUntil || !pedRange)) {
      if (p.dir !== p.resumeDir) {
        turnPed(p, p.resumeDir);
        p.pause = TURN_TIME;
      }
      p.resumeDir = 0;
      p.avoidCheck = 0;
    }
    if (!pedRange) { if (!p.dodgeTarget) p.avoidUntil = 0; return; }
    const dx = p.x - player.x, dz = p.z - player.z;
    if (dx * dx + dz * dz > pedRange * pedRange || clock < p.avoidCheck) return;
    p.avoidCheck = clock + PED_AVOID_INTERVAL;
    const ahead = p.dir > 0 ? p.len - p.t : p.t;
    const dodging = p.dodge !== 0 || p.dodgeTarget !== 0;
    const normalSpeed = dodging || p.pause > 0 || p.conversation || p.waiting ? 0 : p.speed;
    const normalRoom = p.node && curbProgress(p) <= KERB + 1e-6 && !mayCross(p) ? Math.max(0, KERB - curbProgress(p)) : ahead;
    const avoiding = clock < p.avoidUntil;
    const escapeAhead = Math.max(0, Math.min(ahead, (p.avoidT - p.t) * p.dir));
    const contact = playerContactTime(p, p.dir * normalSpeed, normalRoom, false);
    if (contact === Infinity
      && (!avoiding || playerContactTime(p, p.dir * p.avoidSpeed, escapeAhead) === Infinity)) return;

    const forward = escapeRoom(p, p.dir);
    const stop = playerContactTime(p, 0, forward);
    const inRoad = p.node && p.t > 2 && p.t < p.len - 2;
    let dir = p.dir, speed = 0, room = forward, best = stop, dodgeTarget = p.dodgeTarget;
    if (!dodging && ((inRoad && player.vx * player.vx + player.vz * player.vz > 1) || stop !== Infinity)) {
      speed = PED_ESCAPE_SPEED;
      best = playerContactTime(p, dir * speed, forward);
      // Corner connectors need their pending route; only full sidewalk/crosswalk tracks can turn around.
      if (p.node || p.route?.edge) {
        const back = escapeRoom(p, -dir);
        const retreat = playerContactTime(p, -dir * speed, back);
        if (retreat > best + (avoiding ? 0.2 : 0)
          || (!avoiding && retreat === Infinity && inRoad && ahead > p.len * 0.5)) {
          dir = -dir; room = back; best = retreat;
        }
      }
      if (stop > best) { dir = p.dir; speed = 0; room = forward; best = stop; }
    }
    if (!inRoad && player.vx * player.vx + player.vz * player.vz > 4 && best !== Infinity) {
      for (const offset of [p.dodge - PED_DIVE_DISTANCE, p.dodge + PED_DIVE_DISTANCE]) {
        if (!dodgeClear(p, offset, true)) continue;
        const escape = playerContactTime(p, 0, 0, true, offset, true);
        if (escape > best + 0.1) {
          best = escape; dodgeTarget = offset; dir = p.dir; speed = 0; room = 0;
        }
      }
    }
    const sideDive = Math.abs(dodgeTarget - p.dodgeTarget) > 0.5;
    const diveT = p.t + dir * PED_DIVE_DISTANCE;
    const flatLanding = !p.node || (Math.abs(diveT - 2) > 1 && Math.abs(diveT - (p.len - 2)) > 1);
    // In a crosswalk, dive along the checked escape route when the car is close. Include the prone body in
    // the room check and predict the stop at the landing, rather than assuming they keep running afterwards.
    const forwardDive = !dodging && !sideDive && contact < 1 && speed > 0 && room >= PED_DIVE_DISTANCE + 0.9 && flatLanding
      && player.vx * player.vx + player.vz * player.vz > 4
      && playerContactTime(p, dir * PED_DODGE_SPEED, PED_DIVE_DISTANCE, true, dodgeTarget, true) === Infinity;
    if (sideDive || forwardDive) {
      p.diveStart = clock;
      p.diveT = forwardDive ? diveT : p.t;
      const side = Math.sign(dodgeTarget - p.dodge);
      p.diveHeading = forwardDive ? Math.atan2(p.ux * dir, p.uz * dir) : Math.atan2(p.uz * side, -p.ux * side);
      speed = 0;
    }
    p.dodgeTarget = dodgeTarget;
    if (p.conversation) endConversation(p.conversation);
    if (!p.resumeDir) p.resumeDir = p.dir;
    if (dir !== p.dir) turnPed(p, dir);
    p.pause = 0;
    p.avoidSpeed = speed;
    p.avoidT = p.t + dir * room;
    p.avoidUntil = Math.max(clock + 0.6, p.diveStart + PEDESTRIAN_DIVE_DURATION);
    p.restTime = Math.max(p.restTime, clock + 5);
    p.socialTime = Math.max(p.socialTime, clock + 5);
  }

  const walkedNodes = [];
  function walk(p, dt) {
    const avoiding = clock < p.avoidUntil;
    const diving = clock - p.diveStart < PEDESTRIAN_DIVE_DURATION;
    const dodging = p.dodge !== 0 || p.dodgeTarget !== 0;
    const fleeing = clock < p.fleeUntil;
    const cowering = clock < p.cowerUntil + 0.65; // (and getting up again, see renderPed)
    const brake = avoiding || fleeing ? PED_ESCAPE_BRAKE : PED_BRAKE;
    if (p.pause > 0) p.pause = Math.max(0, p.pause - dt);
    if (fleeing) p.pause = 0;
    const ahead = p.dir > 0 ? p.len - p.t : p.t;
    const gdx = p.x - p.goalX, gdz = p.z - p.goalZ;
    if (clock >= p.goalTime || gdx * gdx + gdz * gdz < 625) {
      const destination = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      p.goalX = destination ? destination.sx + destination.dx * destination.len * 0.5 : p.x;
      p.goalZ = destination ? destination.sz + destination.dz * destination.len * 0.5 : p.z;
      p.goalTime = clock + 120 + Math.random() * 180;
    }
    if (!p.nextRoute && p.route && ahead < 4) {
      p.nextRoute = pedRoutes.next(p.route, p.dir, p.goalX, p.goalZ);
      p.nextLeg = 0;
      if (!p.node && p.nextRoute) atCurb(p);
    }
    if (!fleeing && !p.node && p.route?.edge && p.t > 6 && p.t < p.len - 6 && clock >= p.restTime) {
      p.pause = 1.5 + Math.random() * 3;
      p.restTime = clock + 35 + Math.random() * 55;
    }
    let vMax = avoiding ? p.avoidSpeed : fleeing ? p.fleeSpeed : p.pause > 0 || p.conversation ? 0 : p.speed;
    if (dodging || diving || cowering) p.v = vMax = 0;
    if (!p.nextRoute) vMax = Math.min(vMax, Math.sqrt(2 * brake * ahead));
    let room = Infinity;
    if (!p.node && p.nextRoute) {
      // A queue can reach back onto the sidewalk. Keep clear before entering its track, including short corner
      // segments; actual separation matters where the approach meets the crossing at an angle.
      const crossing = nextCrossingLeg(p);
      if (crossing) {
        const entranceX = crossing.track.ax + (crossing.dir < 0 ? crossing.track.ux * crossing.track.len : 0);
        const entranceZ = crossing.track.az + (crossing.dir < 0 ? crossing.track.uz * crossing.track.len : 0);
        let leader = null, nearestSq = Infinity;
        for (const q of crossing.track.node.curb) {
          const next = q.node ? null : nextCrossingLeg(q);
          const queued = q.node ? q : next?.track;
          if (!queued || queued.node !== crossing.track.node || queued.side !== crossing.track.side || (q.node ? q.dir : next.dir) !== crossing.dir || Math.abs(queued.line - crossing.track.line) > 0.55) continue;
          const edx = q.x - entranceX, edz = q.z - entranceZ;
          const distSq = edx * edx + edz * edz;
          if (!q.node && distSq < nearestSq) { leader = q; nearestSq = distSq; }
          if (q === p) continue;
          const dx = q.x - p.x, dz = q.z - p.z;
          const forward = (dx * p.ux + dz * p.uz) * p.dir;
          const lateral2 = Math.max(0, dx * dx + dz * dz - forward * forward);
          if (forward >= 0 && lateral2 < QUEUE_GAP * QUEUE_GAP) {
            room = Math.min(room, Math.max(0, forward - Math.sqrt(QUEUE_GAP * QUEUE_GAP - lateral2)));
          }
        }
        if (leader && leader !== p) {
          // The closest arrival merges first. Keep other approaches outside its remaining walking lines,
          // so perpendicular queues cannot trap each other at the entrance after WALK turns green.
          const yieldToLine = (line) => {
            const side = (p.x - line.ax) * line.uz - (p.z - line.az) * line.ux;
            const toward = (p.ux * line.uz - p.uz * line.ux) * p.dir;
            if (side * toward < 0) room = Math.min(room, Math.max(0, (Math.abs(side) - QUEUE_GAP - 0.01) / Math.abs(toward)));
          };
          yieldToLine(leader);
          for (let i = leader.nextLeg; i < leader.nextRoute.length; i++) {
            yieldToLine(leader.nextRoute[i].track);
            if (leader.nextRoute[i].track.node) break;
          }
        }
      }
    }
    let canCross = true;
    if (p.node) {
      // room to walk before standing: up to the curb unless p may cross, and up to the back of whoever is ahead
      const s = curbProgress(p);
      if (s <= KERB + 1e-6) {
        const walk = walkOn(p.side, p.node);
        if (!walk) p.walkAt = -1;
        else if (p.walkAt < 0) p.walkAt = clock + p.walkDelay;
        // React to WALK independently of the queue or vehicles still clearing the crossing (running from danger,
        // only the traffic on the crosswalk matters)
        canCross = fleeing ? mayCross(p) : walk && (avoiding || clock >= p.walkAt) && mayCross(p);
      }
      room = s <= KERB + 1e-6 && !canCross ? Math.max(0, KERB - s) : Infinity;
      for (const q of p.node.curb) {
        if (q === p || q.node !== p.node || q.side !== p.side || q.dir !== p.dir || Math.abs(q.line - p.line) > 0.55) continue;
        const gap = curbProgress(q) - s;
        if (gap > 0) room = Math.min(room, Math.max(0, gap - QUEUE_GAP));
      }
    }
    if (avoiding) room = Math.min(room, Math.max(0, (p.avoidT - p.t) * p.dir));
    vMax = Math.min(vMax, Math.sqrt(2 * brake * room));
    p.v += clamp(vMax - p.v, -(avoiding ? brake : 2 * brake) * dt, (avoiding || fleeing ? PED_ESCAPE_ACCEL : PED_ACCEL) * dt);
    const movement = diving ? Math.min(Math.abs(p.diveT - p.t), PED_DODGE_SPEED * dt) : Math.min(p.v * dt, room);
    if (p.v * dt > room) p.v = 0;
    let t = p.t + p.dir * movement;
    const reachesCurb = !!p.node && curbProgress(p) <= KERB + 1e-6 && (p.dir > 0 ? t : p.len - t) >= KERB - 1e-6;
    p.waiting = !diving && reachesCurb && !canCross;
    if (p.waiting) {
      t = p.dir > 0 ? Math.min(t, KERB) : Math.max(t, p.len - KERB);
      p.v = 0;
    }
    if (!dodging && !diving && (p.dir > 0 ? t >= p.len : t <= 0)) {
      t = p.dir > 0 ? p.len : 0;
      if (p.nextRoute) {
        p.avoidUntil = 0;
        p.resumeDir = 0;
        p.avoidCheck = 0;
        const leg = p.nextRoute[p.nextLeg++];
        Object.assign(p, leg.track);
        p.route = leg.track;
        p.walkAt = -1;
        p.dir = leg.dir;
        t = p.dir > 0 ? 0 : p.len;
        p.t = t;
        if (p.node) atCurb(p); // later arrivals this frame must see the newly occupied entrance
        if (p.nextLeg === p.nextRoute.length) p.nextRoute = null;
      } else if (!avoiding) {
        p.dir = -p.dir;
        p.walkAt = -1;
        p.v = 0;
        p.pause = fleeing ? 0 : TURN_TIME;
      }
    }
    p.t = t;
    const dodgeStep = (diving || p.dodgeTarget ? PED_DODGE_SPEED : 1.8) * dt;
    p.dodge += clamp(p.dodgeTarget - p.dodge, -dodgeStep, dodgeStep);
    p.x = p.ax + p.ux * t + p.uz * p.dodge;
    p.z = p.az + p.uz * t - p.ux * p.dodge;
    if (p.node && ((t > KERB && t < p.len - KERB) || (p.waiting && walkOn(p.side, p.node)))) {
      // where along the crosswalk: on the road's lateral axis at a junction of centreline streets (side 4+)
      p.coord = p.side >= 4 ? p.x * p.clx + p.z * p.clz : p.side >= 2 ? p.x : p.z;
      if (!p.node.walkers.length) walkedNodes.push(p.node);
      p.node.walkers.push(p);
    }
  }

  function endConversation(conversation) {
    conversation.a.conversation = null;
    conversation.a.socialTime = clock + 30 + Math.random() * 60;
    conversation.b.conversation = null;
    conversation.b.socialTime = clock + 30 + Math.random() * 60;
    conversation.remaining = 0;
  }

  const meetingCells = new Map();
  const usedMeetingCells = [];
  const meetingCellPool = [];
  const meetingKey = (ix, iz) => ((ix + 16384) << 15) | ((iz + 16384) & 0x7fff);
  let nextMeeting = 0;
  function meet(dt) {
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const conversation = p.conversation;
      if (!conversation || conversation.a !== p) continue;
      conversation.remaining -= dt;
      if (conversation.remaining <= 0) endConversation(conversation);
    }
    if (clock < nextMeeting) return;
    nextMeeting = clock + 1;
    for (let i = 0; i < usedMeetingCells.length; i++) {
      const list = usedMeetingCells[i];
      list.length = 0;
      meetingCellPool.push(list);
    }
    usedMeetingCells.length = 0;
    meetingCells.clear();
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (!p.placed || p.dead || p.free || p.node || !p.route?.edge || p.conversation || clock < p.socialTime
        || clock < p.fleeUntil || p.t < 6 || p.t > p.len - 6) continue;
      const ix = Math.floor(p.x * 0.5), iz = Math.floor(p.z * 0.5);
      let partner = null;
      for (let dx = -1; dx <= 1 && !partner; dx++) {
        for (let dz = -1; dz <= 1 && !partner; dz++) {
          const list = meetingCells.get(meetingKey(ix + dx, iz + dz));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const q = list[k];
            if (q.conversation || p.route.block !== q.route.block) continue;
            const mdx = p.x - q.x, mdz = p.z - q.z;
            const distSq = mdx * mdx + mdz * mdz;
            if (distSq < 0.5625 || distSq > 4 || Math.random() > 0.15) continue;
            partner = q;
            break;
          }
        }
      }
      if (partner) {
        p.conversation = partner.conversation = { a: p, b: partner, remaining: 6 + Math.random() * 6 };
        p.v = partner.v = 0;
      } else {
        const key = meetingKey(ix, iz);
        let list = meetingCells.get(key);
        if (!list) {
          list = meetingCellPool.pop() || [];
          meetingCells.set(key, list);
          usedMeetingCells.push(list);
        }
        list.push(p);
      }
    }
  }

  // Walking surface around a pedestrian: sidewalks are 0.22 m above the road, and crosswalk tracks start and end
  // with 2 m of sidewalk (the rig steps down and up the curbs)
  const SIDEWALK_Y = 0.22;
  const CROSSWALK_Y = 0.012;
  function pedGround(p, x, z) {
    const ground = terrainHeight(x, z);
    if (p.free) return blockAt(x, z) ? ground + SIDEWALK_Y : ground; // (off the tracks: the road or a kerbed block)
    if (!p.node) return ground + SIDEWALK_Y;
    const t = (x - p.ax) * p.ux + (z - p.az) * p.uz;
    return ground + (t > 2 && t < p.len - 2 ? CROSSWALK_Y : SIDEWALK_Y);
  }

  // Visible people (and hidden ones within footstep/turn range) advance their gait; only those the camera may see
  // solve their bone transforms and are drawn, the far ones with the light LOD. Walkers also begin turning towards
  // the next leg of their route over its last metre so the body rounds corners instead of swinging about on the spot.
  function renderPed(p, dt) {
    // (tested at the ground's height there: at y = 1 the people on Ponsonby's ridge or K Road, ~50 m up, fell below
    // the view and vanished in front of the camera)
    const draw = !hasView || visible(p.x, p.z, 7, terrainHeight(p.x, p.z) + 1);
    const diveTime = clock - p.diveStart;
    const diving = diveTime < PEDESTRIAN_DIVE_DURATION;
    const dx = p.x - focusX, dz = p.z - focusZ;
    const distSq = dx * dx + dz * dz;
    // The game's poses, through the evasive dive's keyframes: falling dead and lying face down; cowering (crouching
    // down from standing, held, then rising); a free runner facing where it runs (a puppet where the game faces it);
    // a free runner knocked flat (knock) through the dive's fall & get-up
    const knocked = p.free && !p.dead && diving;
    const posed = p.dead ? Math.min(clock - p.deathTime, DEATH_POSE)
      : knocked ? diveTime
        : clock < p.cowerUntil ? 2.2 - Math.min(2.2 - COWER_POSE, (clock - p.cowerStart) * 1.3)
          : clock - p.cowerUntil < 0.65 ? COWER_POSE + (clock - p.cowerUntil) : -1;
    if (posed >= 0 || p.free) {
      if (!draw && distSq > 2500) {
        p.rig.placed = false;
        return;
      }
      const heading = p.dead ? p.deathYaw : knocked ? p.diveHeading : posed >= 0 ? Math.atan2(p.x - p.fleeX, p.z - p.fleeZ)
        : p.puppet ? p.puppetYaw : Math.atan2(p.freeVX, p.freeVZ);
      p.rig.update(dt, p.x, p.z, heading, pedGround, p, 0, draw, posed);
      if (draw) pedCrowd.add(p.rig, Math.sqrt(distSq));
      return;
    }
    if (!draw && !diving && distSq > 2500) {
      p.rig.placed = false;
      return;
    }
    const partner = p.conversation && (p.conversation.a === p ? p.conversation.b : p.conversation.a);
    const sideStep = p.dodgeTarget - p.dodge;
    let fx = p.ux * p.dir, fz = p.uz * p.dir;
    const ahead = p.dir > 0 ? p.len - p.t : p.t, leg = p.nextRoute?.[p.nextLeg];
    if (leg && ahead < 1 && p.v >= 0.3) {
      const nx = leg.track.ux * leg.dir, nz = leg.track.uz * leg.dir;
      if (fx * nx + fz * nz >= -0.9) {
        const w = 0.5 * (1 - ahead);
        fx += (nx - fx) * w;
        fz += (nz - fz) * w;
      }
    }
    const heading = diving ? p.diveHeading : partner ? Math.atan2(partner.x - p.x, partner.z - p.z)
      : Math.abs(sideStep) > 0.01 ? Math.atan2(p.uz * Math.sign(sideStep), -p.ux * Math.sign(sideStep))
      : Math.atan2(fx, fz);
    p.rig.update(dt, p.x, p.z, heading, pedGround, p, 0, draw, diving ? diveTime : -1);
    if (!draw) return;
    pedCrowd.add(p.rig, Math.sqrt(distSq));
  }

  function update(dt, elapsed, x, z, jump, view, activeMode) {
    clock = elapsed;
    focusX = x;
    focusZ = z;
    hasView = view;
    pedRange = player.active && (activeMode === 'car' || activeMode === 'cyclist' || activeMode === 'scooter') && player.entity.position.y > -1
      ? Math.sqrt(player.vx * player.vx + player.vz * player.vz) * PED_LOOKAHEAD + player.halfL + 6 : 0;

    for (const n of walkedNodes) n.walkers.length = 0;
    walkedNodes.length = 0;
    let pedBudget = jump ? NUM_PEDS : 6;
    const keepRadius = jump ? NEAR_RADIUS : PED_RADIUS;
    const keepRadiusSq = keepRadius * keepRadius;
    for (let scanned = 0; scanned < NUM_PEDS && pedBudget > 0; scanned++) {
      const p = peds[pedCursor];
      pedCursor = (pedCursor + 1) % NUM_PEDS;
      if (p.puppet) continue; // (the game's: it takes them back itself)
      if (p.placed) {
        const dx = p.x - focusX, dz = p.z - focusZ;
        if (dx * dx + dz * dz <= keepRadiusSq) continue;
      }
      pedBudget--;
      spawnPed(p, jump ? 0 : 60, jump ? NEAR_RADIUS : 280, !jump);
    }
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (p.placed && !p.dead && !p.free && clock >= p.cowerUntil) avoidPlayer(p);
    }
    meet(dt);
    gatherCurbs();
    pedCrowd.begin();
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (!p.placed) continue;
      if (p.dead) {
        // the dead lie a while, and are taken away once nobody sees them (spawning puts them back on the streets)
        if (clock - p.deathTime > CORPSE_TIME && !nearView(p.x, p.z, 2, 150)) {
          p.placed = false;
          continue;
        }
      } else if (p.puppet) {
        runPuppet(p, dt);
      } else if (p.free) {
        if (!runFree(p, dt)) continue;
      } else {
        walk(p, dt);
      }
      renderPed(p, dt);
    }
    pedCrowd.end();
  }

  // ===================================================================================================================
  // THE GAME (js/game/world.js): hurting, killing and frightening people; drivers thrown out of their cars
  // ===================================================================================================================
  let freeCollide = null; // (pos, radius) => moved: keeps free runners out of buildings (the controllers' colliders)
  const freePos = { x: 0, y: 0, z: 0 };

  /** Everyone placed and alive within `radius` of (x, z) runs away from it for about `duration` s; some cower first */
  function panic(x, z, radius = 25, duration = 8, cowerShare = 0.25) {
    const r2 = radius * radius;
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (!p.placed || p.dead) continue;
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      scare(p, x, z, duration * (0.8 + Math.random() * 0.5), d2 < r2 * 0.3 && Math.random() < cowerShare);
    }
  }

  function scare(p, x, z, duration, cower) {
    const until = clock + duration;
    p.fleeX = x;
    p.fleeZ = z;
    if (p.free) {
      p.freeUntil = Math.max(p.freeUntil, until);
      return;
    }
    if (p.conversation) endConversation(p.conversation);
    if (cower && clock >= p.cowerUntil) {
      p.cowerStart = clock;
      p.cowerUntil = clock + 1.8 + Math.random() * 2.4;
    }
    const fresh = clock >= p.fleeUntil;
    p.fleeUntil = Math.max(p.fleeUntil, until + (cower ? 2.5 : 0));
    // run along the track away from the danger, and from corner to corner towards a goal well beyond it
    const dist = Math.hypot(p.x - x, p.z - z) || 1;
    p.goalX = p.x + ((p.x - x) / dist) * 300;
    p.goalZ = p.z + ((p.z - z) / dist) * 300;
    p.goalTime = p.fleeUntil;
    const away = (p.x - x) * p.ux + (p.z - z) * p.uz;
    const dir = away >= 0 ? 1 : -1;
    if (fresh && dir !== p.dir && (p.node || p.route?.edge)) turnPed(p, dir);
    p.pause = 0;
    p.waiting = false;
    p.restTime = Math.max(p.restTime, p.fleeUntil + 10);
    p.socialTime = Math.max(p.socialTime, p.fleeUntil + 20);
  }

  /** Takes hit points; returns 'killed', 'hurt' or null (already dead / not placed). dir: the blow's direction */
  function hurt(i, amount, dirX = 0, dirZ = 0) {
    const p = peds[i];
    if (!p || !p.placed || p.dead) return null;
    p.hp -= amount;
    if (p.hp <= 0) {
      kill(i, dirX, dirZ);
      return 'killed';
    }
    scare(p, p.x - dirX * 4, p.z - dirZ * 4, 10, false);
    return 'hurt';
  }

  /** Falls over (along the blow) and lies there */
  function kill(i, dirX = 0, dirZ = 0) {
    const p = peds[i];
    if (!p || !p.placed || p.dead) return false;
    if (p.conversation) endConversation(p.conversation);
    p.hp = 0;
    p.dead = true;
    p.puppet = false; // (the game's armed people fall like anyone, and are taken away like anyone)
    p.deathTime = clock;
    p.deathYaw = dirX || dirZ ? Math.atan2(dirX, dirZ) : p.rig.yaw;
    p.v = 0;
    p.fleeUntil = p.cowerUntil = 0;
    p.dodge = p.dodgeTarget = 0;
    p.diveStart = -Infinity;
    return true;
  }

  /**
   * Someone running off the walking tracks from (x, z), away from (fromX, fromZ): a driver thrown out of a car.
   * Takes a pedestrian nobody is looking at (or the farthest) and returns its index, or -1.
   */
  function spawnFree(x, z, fromX, fromZ, seconds = 6) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (p.free) continue;
      const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      const score = !p.placed ? 1e12 : p.dead ? -1 : d2 + (nearView(p.x, p.z, 2, 150) ? 0 : 1e9);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return -1;
    const p = peds[best];
    if (p.conversation) endConversation(p.conversation);
    let ax = x - fromX, az = z - fromZ;
    const len = Math.hypot(ax, az) || 1;
    ax /= len;
    az /= len;
    Object.assign(p, { placed: true, free: true, puppet: false, dead: false, hp: PED_HP, node: null, route: null, nextRoute: null, nextLeg: 0 });
    p.rig.aimWeight = 0;
    p.rig.setOutfit(null);
    p.x = x;
    p.z = z;
    p.v = 0;
    p.freeVX = ax * 0.5;
    p.freeVZ = az * 0.5;
    p.freeSince = clock;
    p.freeUntil = clock + seconds;
    p.fleeX = fromX;
    p.fleeZ = fromZ;
    p.fleeUntil = p.cowerUntil = 0;
    p.avoidUntil = 0;
    p.dodge = p.dodgeTarget = 0;
    p.diveStart = -Infinity;
    p.pause = 0;
    p.waiting = false;
    p._curbNode = null;
    p.rig.placed = false;
    return best;
  }

  // Free runners sprint away while frightened, then walk on, until out of sight far enough to be taken back; false
  // once taken back
  function runFree(p, dt) {
    if (clock - p.diveStart < PEDESTRIAN_DIVE_DURATION) return true; // (knocked flat: down, then up again)
    const running = clock < p.freeUntil;
    let ax = p.x - p.fleeX, az = p.z - p.fleeZ;
    const len = Math.hypot(ax, az) || 1;
    // (keeps running the way it went once well clear, rather than turning about the danger)
    const steer = len < 25 ? 1 : 0.15;
    const vx0 = p.freeVX, vz0 = p.freeVZ;
    const sp0 = Math.hypot(vx0, vz0) || 1;
    let dx = vx0 / sp0 + (ax / len - vx0 / sp0) * steer;
    let dz = vz0 / sp0 + (az / len - vz0 / sp0) * steer;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const target = running ? FREE_RUN_SPEED : 1.4;
    const speed = sp0 + clamp(target - sp0, -PED_ESCAPE_BRAKE * dt, PED_ESCAPE_ACCEL * dt);
    p.freeVX = dx * speed;
    p.freeVZ = dz * speed;
    freePos.x = p.x + p.freeVX * dt;
    freePos.z = p.z + p.freeVZ * dt;
    freePos.y = terrainHeight(freePos.x, freePos.z);
    if (freeCollide && freeCollide(freePos, 0.35)) {
      // slid along a wall: keep the speed along it
      const mx = (freePos.x - p.x) / dt, mz = (freePos.z - p.z) / dt;
      const ml = Math.hypot(mx, mz);
      if (ml > 0.2) {
        p.freeVX = (mx / ml) * speed;
        p.freeVZ = (mz / ml) * speed;
      }
    }
    p.x = freePos.x;
    p.z = freePos.z;
    const dfx = p.x - focusX, dfz = p.z - focusZ;
    if (!running && clock - p.freeSince > 4 && (dfx * dfx + dfz * dfz > 3600 || clock - p.freeSince > 40) && !nearView(p.x, p.z, 2, 150)) {
      p.free = false;
      p.placed = false;
      return false;
    }
    return true;
  }

  // A puppet (the game's armed people) walks or runs at the velocity the game asks for, eased like a person
  // speeding up and stopping, kept out of buildings; knocked flat it lies still until it is up again
  function runPuppet(p, dt) {
    const down = clock - p.diveStart < PEDESTRIAN_DIVE_DURATION;
    const k = 1 - Math.exp(-9 * dt);
    p.freeVX += ((down ? 0 : p.puppetVX) - p.freeVX) * k;
    p.freeVZ += ((down ? 0 : p.puppetVZ) - p.freeVZ) * k;
    freePos.x = p.x + p.freeVX * dt;
    freePos.z = p.z + p.freeVZ * dt;
    freePos.y = terrainHeight(freePos.x, freePos.z);
    if (freeCollide) freeCollide(freePos, 0.35);
    p.x = freePos.x;
    p.z = freePos.z;
  }

  /**
   * The game steers a free person (from spawnFree) from now on (on) or lets it go as an ordinary free runner, who
   * walks off and is taken back once out of sight (off)
   */
  function setPuppet(i, on) {
    const p = peds[i];
    if (!p || !p.placed || p.dead) return false;
    p.puppet = !!on;
    p.free = true;
    p.puppetVX = p.puppetVZ = 0;
    p.puppetYaw = p.rig.yaw;
    if (!on) {
      p.freeSince = clock;
      p.freeUntil = 0;
      p.fleeX = p.x - Math.sin(p.rig.yaw);
      p.fleeZ = p.z - Math.cos(p.rig.yaw);
      p.rig.aimWeight = 0;
    }
    return true;
  }

  /** Knocked flat along (dirX, dirZ) (a punch, a bat, a blast): the evasive dive's fall, a moment down, the get-up */
  function knock(i, dirX = 0, dirZ = 1) {
    const p = peds[i];
    if (!p || !p.placed || p.dead || clock - p.diveStart < PEDESTRIAN_DIVE_DURATION) return false;
    if (p.conversation) endConversation(p.conversation);
    p.diveStart = clock;
    p.diveT = p.t;
    p.diveHeading = dirX || dirZ ? Math.atan2(dirX, dirZ) : p.rig.yaw;
    p.dodgeTarget = p.dodge;
    p.v = 0;
    p.cowerUntil = 0;
    return true;
  }

  /** Dresses a person: setOutfit(id, 'police') puts a free person (spawnFree) in police uniform; null, their own
   * clothes (put back by themselves when the person is taken back into the crowd). Also `peds[id].outfit = ...` */
  function setOutfit(i, outfit = null) {
    const p = peds[i];
    if (!p) return false;
    p.rig.setOutfit(outfit);
    return true;
  }
  for (const p of peds) {
    Object.defineProperty(p, 'outfit', {
      get() {
        return this.rig.outfit;
      },
      set(v) {
        this.rig.setOutfit(v);
      },
      enumerable: true
    });
  }

  return {
    peds,
    meshes: pedCrowd.meshes,
    update,
    panic,
    hurt,
    kill,
    spawnFree,
    setPuppet,
    setOutfit,
    knock,
    setFreeCollider: (fn) => {
      freeCollide = typeof fn === 'function' ? fn : null;
    }
  };
}

export { createPedestrianSystem };
