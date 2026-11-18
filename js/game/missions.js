import { createPickups } from './pickups.js';
import { createEconomy } from './economy.js';
import { createActivities } from './activities.js';
import { createStats } from './missions/stats.js';
import { createDriving, densify } from './missions/driver.js';
import { createMarkers } from './missions/markers.js';
import { createPlaces } from './missions/places.js';
import { createPhone } from './missions/phone.js';
import { STEPS, fmt } from './missions/steps.js';
import { STORY } from './missions/story.js';

// Missions & everything to do in the city (engineer D). registerMissions(game) sets up, and publishes:
//   game.missions  the mission framework: list(), active, start(id), fail(reason), abort(), isActive, objective,
//                  retry(), replay(id), isDone(id), gps(id), debugSkipStep(), debugPass(), debugUnlockAll()
//   game.blips     points of interest for the HUD (blips.js)        game.pickups  things to pick up (pickups.js)
//   game.stats     the numbers (missions/stats.js)                  game.economy  shops & safehouses (economy.js)
//   game.activities  taxi fares, exports, races, challenges, golden kiwis (activities.js)
//   game.phone     the phone (T / D-pad right) (missions/phone.js)
// A mission is a script (missions/story.js, activities.js): { id, title, giver, kind, start: [x, z], requires,
// reward, intro: [[who, text, s?]...], outro, setup(ctx), steps: [...] } built from the reusable steps of
// missions/steps.js. Walking (or driving slowly) into its start marker plays a short letterboxed intro (state
// 'cutscene' + subtitles), then the steps run one after the other; dying, being arrested, a protected vehicle
// destroyed or a step's own fail condition fails it. Pass, fail or abort, everything it spawned is cleaned up.
// Events: mission:available {id} mission:started {id, title, giver} mission:objective {text} mission:passed {id,
// title, reward, stats} mission:failed {id, title, reason, code} mission:timer {seconds|null, label} dialogue {who,
// text, seconds}.

const START_COLORS = { story: 0xffd23f, race: 0xc58cff, rampage: 0xff5a4a };
const REPLAY_SHARE = 0.2; // of the reward, for replaying a mission already passed
const RETRY_WINDOW = 14; // s after a failure (once back on the feet) during which interact retries it

// ---------------------------------------------------------------------------------------------------------------------
// Dialogue: phone calls & radio lines, one at a time (ui.subtitle + the 'dialogue' event)
// ---------------------------------------------------------------------------------------------------------------------
function createDialogue(game) {
  const queue = [];
  let current = null;
  let left = 0;
  const hud = () => typeof game.ui?.subtitle === 'function';
  const dialogue = {
    say(who, text, seconds) {
      const s = seconds ?? Math.min(6.5, 1.6 + text.length * 0.052);
      queue.push({ who, text, seconds: s });
    },
    clear() {
      queue.length = 0;
      if (current) {
        current = null;
        left = 0;
        if (hud()) game.ui.subtitle(null);
      }
    },
    get busy() {
      return !!current || queue.length > 0;
    },
    /** Seconds until everything queued has been said */
    get remaining() {
      let t = current ? left : 0;
      for (const q of queue) t += q.seconds;
      return t;
    },
    /** Skips to the next line */
    next() {
      left = 0;
    },
    update(realDt) {
      if (game.state === 'paused') return;
      if (current && (left -= realDt) <= 0) {
        current = null;
        if (!queue.length && hud()) game.ui.subtitle(null);
      }
      if (!current && queue.length) {
        current = queue.shift();
        left = current.seconds;
        game.emit('dialogue', current);
        if (hud()) game.ui.subtitle(current.who, current.text, current.seconds);
        else game.ui?.toast?.(`${current.who}: ${current.text}`, current.seconds);
      }
    }
  };
  return dialogue;
}

// ---------------------------------------------------------------------------------------------------------------------
// The mission runner
// ---------------------------------------------------------------------------------------------------------------------
function createMissionRunner(game, { places, markers, driving, dialogue }) {
  const defs = new Map();
  const order = [];
  const done = new Map(); // id -> times passed
  const best = {}; // id -> { time, medal, place }
  let run = null; // the running mission
  let lastFailed = null; // { id, playingFor } for the retry offer
  let gpsBlip = null;
  const later = []; // [realTime, fn]
  const hud = () => typeof game.ui?.subtitle === 'function';

  // ---- registry ----
  function register(def) {
    def.kind ??= 'story';
    def.requires ??= [];
    def.reward ??= 0;
    defs.set(def.id, def);
    order.push(def);
    if (def.start) {
      const p = resolve(def.start);
      def.startAt = p;
      def.marker = markers.add({
        x: p.x, z: p.z, radius: def.kind === 'story' ? 2 : 3.2, color: START_COLORS[def.kind] ?? 0xffd23f,
        kind: def.kind === 'story' ? 'mission' : def.kind === 'race' ? 'race' : 'mission', label: def.title,
        short: def.kind !== 'story', when: def.when || 'any', maxSpeed: 5,
        enabled: () => !run && available(def) && (def.repeatable || !done.has(def.id)) && (!def.enabled || def.enabled()),
        onEnter: () => tryStart(def.id)
      });
    }
    return def;
  }

  let unlockAll = false; // (debug: every job open, nothing marked passed)
  const available = (def) => (unlockAll || def.requires.every((id) => done.has(id))) && (!def.available || def.available());
  const isDone = (id) => done.has(id);

  // A position as written in a script: [x, z] | { x, z } | { kerb | lane | road | open | raw: [x, z] } | a ref |
  // (ctx) => any of those
  function resolve(p, ctx = null) {
    if (typeof p === 'function') p = p(ctx);
    if (typeof p === 'string') {
      const r = ctx?.refs[p];
      return r ? { x: r.x, z: r.z, heading: r.heading ?? 0 } : { x: 0, z: 0, heading: 0 };
    }
    if (Array.isArray(p)) return { x: p[0], z: p[1], heading: p[2] ?? 0 };
    if (!p) return { x: 0, z: 0, heading: 0 };
    if (p.kerb) return places.kerb(p.kerb[0], p.kerb[1]);
    if (p.lane) return places.kerbLane(p.lane[0], p.lane[1], 160, p.face ? { x: p.face[0], z: p.face[1] } : null);
    if (p.road) return places.road(p.road[0], p.road[1], p.face ? { x: p.face[0], z: p.face[1] } : null);
    if (p.open) {
      const c = places.findClear(p.open[0], p.open[1], p.within ?? 30, p.clearance ?? 0.6);
      return { x: c.x, z: c.z, heading: p.heading ?? 0 };
    }
    if (p.raw) return { x: p.raw[0], z: p.raw[1], heading: p.heading ?? 0 };
    return { x: p.x, z: p.z, heading: p.heading ?? 0 };
  }

  // ---- the running mission's context (what steps and scripts use) ----
  function makeContext(def, opts) {
    const disposers = [];
    const vehicles = []; // [v, keep]
    const targets = [];
    const drivers = new Map();
    const protectedRefs = new Map();
    let clock = null; // { left, label }
    let lastTimer = '';
    let hintText = null, hintAt = -Infinity;
    let frozen = false;
    const track = (fn) => {
      disposers.push(fn);
      return fn;
    };
    const ctx = {
      game, def, places, refs: {}, result: {}, replay: !!opts.replay, t: 0, stepT: 0, vars: {},
      at: (p) => resolve(p, ctx),
      dist(x, z) {
        const p = game.player.position;
        return Math.hypot(p.x - x, p.z - z);
      },
      say(who, text, seconds) {
        dialogue.say(who, text, seconds);
      },
      objective(text) {
        if (run && run.ctx === ctx) run.objective = text || null;
        game.ui?.objective?.(text || null);
        game.emit('mission:objective', { text: text || null });
        if (text && !hud()) game.ui?.toast?.(text, 4);
      },
      hint(text) {
        const now = game.realTime;
        if (text === hintText && now - hintAt < 1.2) return;
        hintText = text;
        hintAt = now;
        if (typeof game.ui?.help === 'function') game.ui.help(text, 1.6);
        else game.ui?.toast?.(text, 1.4);
      },
      flash(text) {
        if (hud()) game.ui.banner(text, '', { style: 'title', seconds: 0.9 });
        else game.ui?.toast?.(text, 0.9);
      },
      /** The HUD clock (a countdown or a race time); null hides it. Dirty-checked by the second. */
      timer(seconds, label = '') {
        const key = seconds == null ? '' : `${Math.ceil(Math.max(0, seconds))}|${label}`;
        if (key === lastTimer) return;
        lastTimer = key;
        const s = seconds == null ? null : Math.max(0, Math.ceil(seconds));
        game.ui?.timer?.(s, label);
        game.emit('mission:timer', { seconds: s, label });
        if (!hud() && s != null && s % 5 === 0) game.ui?.toast?.(`${label} ${fmt(s)}`, 1);
      },
      setClock(seconds, label = 'Time') {
        clock = { left: seconds, label };
      },
      clearClock() {
        clock = null;
        ctx.timer(null);
      },
      get clock() {
        return clock;
      },
      blip(o) {
        const b = game.blips.add(o);
        track(() => b.remove());
        return b;
      },
      beacon(x, z, color, o) {
        const b = game.fx.beacon(x, z, color, o);
        let gone = false;
        const handle = {
          get visible() {
            return b.visible;
          },
          set visible(v) {
            if (!gone) b.visible = v;
          },
          set: (nx, nz, ny) => !gone && b.set(nx, nz, ny),
          remove() {
            if (gone) return;
            gone = true;
            b.remove();
          }
        };
        track(() => handle.remove());
        return handle;
      },
      pickup(kind, x, z, o) {
        const p = game.pickups.spawn(kind, x, z, { persistent: true, ...o });
        if (p) track(() => game.pickups.remove(p));
        return p;
      },
      on(type, fn) {
        return track(game.on(type, fn));
      },
      track,
      /** A vehicle for the mission (removed when it ends unless the player is in it). at: a position as for resolve */
      spawnVehicle(name, kind, x, z, heading = 0, o = {}) {
        const v = game.vehicles.spawn(kind, x, z, heading, { persistent: true, locked: o.locked, paint: o.paint, label: o.label, health: o.health });
        if (!v) return null;
        if (o.invulnerable) v.invulnerable = true;
        vehicles.push([v, !!o.keep]);
        if (name) ctx.refs[name] = v;
        return v;
      },
      spawnAt(name, kind, at, o = {}) {
        const p = resolve(at, ctx);
        return ctx.spawnVehicle(name, kind, p.x, p.z, o.heading ?? p.heading ?? 0, o);
      },
      /** Takes a vehicle the player found into the mission (keep: left in the world when it ends) */
      adopt(name, v, keep = true) {
        ctx.refs[name] = v;
        if (!vehicles.some((e) => e[0] === v)) vehicles.push([v, keep]);
        return v;
      },
      /** Fails the mission if the vehicle is destroyed (text: the reason) */
      protect(name, text) {
        protectedRefs.set(name, text);
      },
      unprotect(name) {
        protectedRefs.delete(name);
      },
      moveVehicle(v, x, z, heading) {
        const e = v.entity;
        const y = v.mode === 'helicopter' ? e.position.y : places.ground(x, z);
        e.position.set(x, y, z);
        e.prevX = x;
        e.prevZ = z;
        if (Number.isFinite(heading)) e.heading = heading;
        e.speed = e.vx = e.vz = e.angularVel = 0;
        v.awake = true;
      },
      teleportPlayer(x, z, heading = null) {
        const cm = game.engine.controllerManager;
        const h = Number.isFinite(heading) ? heading : cm.getActiveEntity().heading;
        cm.teleportActiveTo(x, z, h);
        game.engine.cameraSystem.resetForTeleport?.();
      },
      putPlayerIn(v) {
        if (game.player.vehicle === v) return;
        if (game.player.vehicle) game.vehicles.exit({ eject: true });
        v.locked = false;
        game.vehicles.enter(v, { instant: true });
      },
      setWanted(level) {
        const w = game.wanted;
        if (!w) return;
        if (level > 0) w.set?.(level);
        else w.clear?.('mission');
      },
      drive(v, o) {
        const d = driving.drive(v, o);
        if (d) {
          drivers.set(v, d);
          track(() => d.stop(true));
        }
        return d;
      },
      driverOf: (v) => drivers.get(v) || null,
      routeTo(v, p) {
        return driving.route(v.x, v.z, p.x, p.z, v.heading) || densify([v.x, v.z, p.x, p.z], 12);
      },
      routeThrough(v, points) {
        const stops = [[v.x, v.z], ...points.map((p) => [p.x, p.z])];
        return driving.routeVia(stops, v.heading);
      },
      route: (ax, az, bx, bz) => driving.route(ax, az, bx, bz),
      /** Stops the player (and only the player) for a moment: a countdown */
      freeze(on) {
        if (on === frozen) return;
        frozen = on;
        // (a hold, not a scene: no black bars over a race's countdown)
        if (on && game.state === 'playing') game.setState('cutscene', { letterbox: false });
        else if (!on && game.state === 'cutscene') game.setState('playing');
      },
      /** An enemy (a thug with a bat or fists if the combat system can make one, else a stand-in on foot) */
      target(name, x, z, o = {}) {
        const t = makeTarget(game, x, z, o);
        targets.push(t);
        if (name) ctx.refs[name] = t;
        return t;
      },
      /** Gives the player an allowed weapon (the bat); anything else is refused (false) */
      giveWeapon(id) {
        const w = game.weapons;
        if (!w || !w.defs?.[id]) return false;
        if (!w.has?.(id)) w.give(id);
        return true;
      },
      /** Peds stepping out of a vehicle and walking off (a passenger dropped, a driver bailing) */
      passengersOut(v, n = 1, run = 3) {
        for (let i = 0; i < n; i++) {
          const s = Math.sin(v.heading), c = Math.cos(v.heading);
          const side = i % 2 ? -1 : 1;
          game.world.spawnFleeingPed(v.x + c * side * (v.halfW + 0.7), v.z - s * side * (v.halfW + 0.7), v.x, v.z, run);
        }
      },
      fail: (reason, code) => fail(reason, code),
      pass: () => pass(),
      // (internal)
      // (every frame, the intro included: stand-in targets must be kept from wandering off meanwhile)
      _tick(dt) {
        for (const t of targets) t.update?.(dt);
      },
      _update(dt) {
        ctx.t += dt;
        for (const [name, text] of protectedRefs) {
          const v = ctx.refs[name];
          if (v && (v.state === 'wrecked' || v.hidden)) return fail(text || `The ${v.label.toLowerCase()} is wrecked.`, 'destroyed');
        }
        if (clock) {
          clock.left -= dt;
          ctx.timer(clock.left, clock.label);
          if (clock.left <= 0) return fail('Out of time.', 'timeout');
        }
        return null;
      },
      _dispose(passed) {
        if (frozen) ctx.freeze(false);
        for (let i = disposers.length - 1; i >= 0; i--) {
          try {
            disposers[i]();
          } catch (e) {
            console.warn('[missions] cleanup', e);
          }
        }
        disposers.length = 0;
        for (const t of targets) t.remove?.();
        const current = game.vehicles.current;
        for (const [v, keep] of vehicles) {
          if (v.driver === 'ai') game.vehicles.setControls(v, null);
          v.invulnerable = false;
          if (v.hero) continue;
          if (v._claimed) {
            // (left where it was delivered, locked, and tidied away by the world later)
            v.locked = true;
            v.persistent = false;
            continue;
          }
          if (v === current || keep) {
            // the player keeps the car they're in (it becomes an ordinary vehicle)
            v.persistent = false;
            v.locked = false;
            continue;
          }
          game.vehicles.remove(v);
        }
        if (clock || lastTimer) ctx.timer(null);
        clock = null;
        if (hintText && typeof game.ui?.help === 'function') game.ui.help(null);
        void passed;
      }
    };
    return ctx;
  }

  // ---- lifecycle ----
  function tryStart(id) {
    const def = defs.get(id);
    if (!def || run) return false;
    if (game.wanted?.level > 0) {
      markers.notice('Lose the cops before taking on a job.', 3);
      return false;
    }
    return start(id);
  }

  function start(id, opts = {}) {
    const def = defs.get(id);
    if (!def || run || !game.player?.alive) return false;
    if (game.state !== 'playing' && game.state !== 'cutscene') return false;
    game.activities?.interrupt?.();
    dialogue.clear();
    lastFailed = null;
    markers.ambient = null;
    clearGps();
    const ctx = makeContext(def, { replay: opts.replay ?? done.has(id) });
    run = { def, ctx, phase: 'intro', stepIndex: -1, step: null, type: null, st: null, introLeft: 0, objective: null, startedAt: game.time };
    markers.refresh();
    game.stats.add('missionAttempts');
    game.emit('mission:started', { id: def.id, title: def.title, giver: def.giver || '' });
    if (hud()) game.ui.banner(def.title, def.giver || '', { style: 'title', seconds: 3 });
    else game.ui?.toast?.(def.title, 3);
    try {
      def.setup?.(ctx);
    } catch (e) {
      console.error(`[missions] ${id} setup`, e);
    }
    if (!run) return false; // (setup failed it)
    const intro = def.intro || [];
    if (intro.length && !opts.skipIntro) {
      for (const [who, text, s] of intro) dialogue.say(who, text, s);
      run.introLeft = dialogue.remaining + 0.3;
      game.setState('cutscene');
    } else {
      run.introLeft = 0;
    }
    run.introTotal = run.introLeft;
    return true;
  }

  function endIntro() {
    if (!run || run.phase !== 'intro') return;
    run.phase = 'steps';
    if (game.state === 'cutscene') game.setState('playing');
    beginStep(0);
  }

  function beginStep(i) {
    if (!run) return;
    const steps = run.def.steps;
    if (i >= steps.length) {
      pass();
      return;
    }
    const s = steps[i];
    const type = typeof s.update === 'function' ? { enter: s.enter && ((c, _s, st) => s.enter(c, st)), update: (c, _s, st, dt) => s.update(c, st, dt), exit: s.exit && ((c, _s, st) => s.exit(c, st)), skip: s.skip && ((c, _s, st) => s.skip(c, st)) } : STEPS[s.type];
    if (!type) {
      console.warn(`[missions] unknown step type "${s.type}" in ${run.def.id}`);
      beginStep(i + 1);
      return;
    }
    run.stepIndex = i;
    run.step = s;
    run.type = type;
    run.st = {};
    run.ctx.stepT = 0;
    const ctx = run.ctx;
    if (s.stopTimer) ctx.clearClock();
    if (s.timer) ctx.setClock(s.timer, s.timerLabel || 'Time');
    if (s.wanted != null) ctx.setWanted(s.wanted);
    for (const line of s.say || []) dialogue.say(line[0], line[1], line[2]);
    const text = typeof s.text === 'function' ? s.text(ctx) : s.text;
    run.st._text = text || run.objective;
    if (text) ctx.objective(text);
    try {
      s.onEnter?.(ctx, run.st);
      type.enter?.(ctx, s, run.st);
    } catch (e) {
      console.error(`[missions] ${run.def.id} step ${i} enter`, e);
    }
  }

  function finishStep() {
    if (!run) return;
    const { step, type, st, ctx, stepIndex } = run;
    try {
      type.exit?.(ctx, step, st);
      step.onDone?.(ctx, st);
    } catch (e) {
      console.error(`[missions] ${run?.def.id} step ${stepIndex} exit`, e);
    }
    if (run && run.ctx === ctx && run.stepIndex === stepIndex) beginStep(stepIndex + 1);
  }

  function teardown(passed) {
    const r = run;
    run = null;
    if (!r) return;
    try {
      if (r.phase === 'steps' && r.type) r.type.exit?.(r.ctx, r.step, r.st);
    } catch (e) {
      console.warn('[missions] step exit on teardown', e);
    }
    r.ctx._dispose(passed);
    // (the mission's own scene ends with it; a shop's hold is the shop's to let go of)
    if (game.state === 'cutscene' && (game.letterbox || !game.economy?.menuOpen)) game.setState('playing');
    game.ui?.objective?.(null);
    game.emit('mission:objective', { text: null });
    markers.refresh();
    return r;
  }

  function pass() {
    if (!run) return;
    const r = run;
    const def = r.def;
    const first = !done.has(def.id);
    const reward = Math.round(first ? def.reward : def.reward * REPLAY_SHARE);
    const result = { ...r.ctx.result, time: r.ctx.result.time ?? game.time - r.startedAt, replay: !first };
    // vehicles the giver keeps (a repossessed ute): the player gets out and it's locked
    for (const name of def.claim || []) {
      const v = r.ctx.refs[name];
      if (!v) continue;
      if (game.player.vehicle === v) game.vehicles.exit();
      v._claimed = true;
    }
    teardown(true);
    done.set(def.id, (done.get(def.id) || 0) + 1);
    if (def.kind === 'story' && first) game.stats.add('missionsPassed');
    try {
      def.onPass?.(result, first);
    } catch (e) {
      console.error(`[missions] ${def.id} onPass`, e);
    }
    const extra = typeof def.bonus === 'function' ? def.bonus(result, first) || 0 : 0;
    const total = reward + extra;
    if (total > 0) game.player.addMoney(total, 'mission');
    game.emit('mission:passed', { id: def.id, title: def.title, reward: total, stats: result });
    if (!hud()) game.ui?.banner?.('MISSION PASSED', total > 0 ? `$${total.toLocaleString('en-NZ')}` : def.title);
    if (!hud()) setTimeout(() => game.ui?.banner?.(null), 3500);
    for (const [who, text, s] of (typeof def.outro === 'function' ? def.outro(result, first) : def.outro) || []) dialogue.say(who, text, s);
    // newly available missions: a call from their giver (the HUD shows the notification), and the GPS to the first
    let next = null;
    for (const d of order) {
      if (d.kind !== 'story' || done.has(d.id) || !available(d) || d.announced) continue;
      if (!d.requires.includes(def.id)) continue;
      d.announced = true;
      game.emit('mission:available', { id: d.id });
      for (const [who, text, s] of d.call || []) dialogue.say(who, text, s);
      next ??= d;
    }
    if (next?.startAt) later.push([game.realTime + 4, () => !run && setGps(next.startAt.x, next.startAt.z, next.title)]);
    markers.refresh();
    game.save.save();
  }

  function fail(reason = 'Mission failed.', code = 'other') {
    if (!run) return;
    const def = run.def;
    teardown(false);
    dialogue.clear();
    game.stats.add('missionsFailed');
    game.emit('mission:failed', { id: def.id, title: def.title, reason, code });
    if (code !== 'aborted') {
      lastFailed = { id: def.id, playingFor: 0 };
      if (!hud()) {
        game.ui?.banner?.('MISSION FAILED', reason);
        setTimeout(() => game.ui?.banner?.(null), 3500);
      }
    }
  }

  function retry() {
    const f = lastFailed;
    if (!f || run) return false;
    if (game.wanted?.level > 0) {
      markers.notice('Lose the cops before taking on a job.', 3);
      return false;
    }
    lastFailed = null;
    const def = defs.get(f.id);
    if (!def) return false;
    travel(def.startAt.x, def.startAt.z, () => start(def.id, { skipIntro: true }));
    return true;
  }

  /** Fades out, puts the player at (x, z) (in the car if in one), fades back in, then calls done */
  function travel(x, z, done) {
    game.ui?.fade?.(1, 0.35);
    const at = places.kerb(x, z);
    later.push([game.realTime + 0.45, () => {
      const v = game.player.vehicle;
      const cm = game.engine.controllerManager;
      if (v && v.mode === 'car') {
        const r = places.road(x, z);
        cm.teleportActiveTo(r.x, r.z, r.heading);
      } else {
        if (v) game.vehicles.exit({ eject: true });
        cm.teleportActiveTo(at.x, at.z, at.heading);
      }
      game.engine.cameraSystem.resetForTeleport?.();
      game.ui?.fade?.(0, 0.6);
      done?.();
    }]);
  }

  function clearGps() {
    gpsBlip?.remove();
    gpsBlip = null;
  }

  function setGps(x, z, label = 'Waypoint') {
    clearGps();
    gpsBlip = game.blips.add({ x, z, kind: 'destination', label, route: true });
    return gpsBlip;
  }

  // ---- every frame ----
  function update(dt, realDt) {
    for (let i = later.length - 1; i >= 0; i--) {
      if (game.realTime >= later[i][0]) {
        const fn = later[i][1];
        later.splice(i, 1);
        fn();
      }
    }
    if (gpsBlip) {
      const p = game.player.position;
      if (Math.hypot(p.x - gpsBlip.x, p.z - gpsBlip.z) < 12) clearGps();
    }
    if (!run) {
      // the retry offer
      if (lastFailed && game.state === 'playing' && game.player.alive) {
        lastFailed.playingFor += realDt;
        if (lastFailed.playingFor > RETRY_WINDOW) {
          // (no retry taken: the GPS leads back to the job's start instead)
          const def = defs.get(lastFailed.id);
          if (def?.startAt && def.kind === 'story' && !gpsBlip) setGps(def.startAt.x, def.startAt.z, def.title);
          lastFailed = null;
          markers.ambient = null;
        } else {
          markers.ambient = `${game.input.label('interact')} — Retry ${defs.get(lastFailed.id)?.title || 'the mission'}`;
          if (game.input.pressed('interact') && !markers.list.some((m) => m.inside && m.prompt)) {
            markers.ambient = null;
            retry();
          }
        }
      } else if (!lastFailed && markers.ambient) {
        markers.ambient = null;
      }
      return;
    }
    run.ctx._tick(dt);
    if (run.phase === 'intro') {
      run.introLeft -= realDt;
      const skip = run.introLeft < run.introTotal - 0.6 && (game.input.pressed('jump') || game.input.pressed('enterExit') || game.input.pressed('interact'));
      if (skip) dialogue.clear();
      if (run.introLeft <= 0 || skip) endIntro();
      return;
    }
    if (!(dt > 0)) return;
    const ctx = run.ctx;
    ctx.stepT += dt;
    ctx._update(dt);
    if (!run || run.ctx !== ctx) return;
    let r;
    try {
      r = run.type.update(ctx, run.step, run.st, dt);
    } catch (e) {
      console.error(`[missions] ${run.def.id} step ${run.stepIndex} update`, e);
      r = undefined;
    }
    if (!run || run.ctx !== ctx) return;
    if (typeof r === 'string') fail(r, run.st?._code || run.step.failCode || 'other');
    else if (r === true) finishStep();
  }

  // a death or an arrest ends the job
  game.on('player:died', () => run && fail('You were hospitalised.', 'died'));
  game.on('player:busted', () => run && fail('You were arrested.', 'busted'));

  const api = {
    defs,
    register,
    resolve,
    list() {
      return order.map((d) => ({
        id: d.id, title: d.title, giver: d.giver || '', x: d.startAt?.x ?? 0, z: d.startAt?.z ?? 0,
        available: available(d), done: done.has(d.id), kind: d.kind, blurb: d.blurb || '', reward: d.reward, best: best[d.id] || null
      }));
    },
    get active() {
      if (!run) return null;
      return { id: run.def.id, title: run.def.title, giver: run.def.giver || '', kind: run.def.kind, step: run.stepIndex, objective: run.objective, phase: run.phase, refs: run.ctx.refs };
    },
    get isActive() {
      return !!run;
    },
    get objective() {
      return run ? run.objective : null;
    },
    start(id, opts) {
      return start(id, opts);
    },
    fail(reason) {
      fail(reason || 'Mission failed.', 'other');
    },
    abort() {
      if (!run) return;
      fail('Aborted.', 'aborted');
    },
    retry,
    /** Replays a passed mission from its start (teleporting there) */
    replay(id) {
      const def = defs.get(id);
      if (!def || run) return false;
      // (as walking into its marker: not with the police on you)
      if (game.wanted?.level > 0) {
        markers.notice('Lose the cops before taking on a job.', 3);
        return false;
      }
      travel(def.startAt.x, def.startAt.z, () => start(id, { replay: true }));
      return true;
    },
    isDone,
    timesPassed: (id) => done.get(id) || 0,
    best,
    travel,
    /** Points the GPS at a mission's start (or any x, z) */
    gps(idOrX, z) {
      if (typeof idOrX === 'string') {
        const def = defs.get(idOrX);
        return def?.startAt ? setGps(def.startAt.x, def.startAt.z, def.title) : null;
      }
      return setGps(idOrX, z);
    },
    clearGps,
    // ---- debug ----
    debugSkipStep() {
      if (!run) return false;
      if (run.phase === 'intro') {
        dialogue.clear();
        endIntro();
        return true;
      }
      const { type, step, st, ctx } = run;
      try {
        type.skip?.(ctx, step, st);
      } catch (e) {
        console.warn('[missions] skip', e);
      }
      if (run && run.ctx === ctx) finishStep();
      return true;
    },
    debugPass() {
      if (!run) return false;
      if (run.phase === 'intro') endIntro();
      pass();
      return true;
    },
    debugUnlockAll() {
      unlockAll = true;
      markers.refresh();
    },
    /** @internal */
    update,
    get run() {
      return run;
    },
    toJSON() {
      return { done: Object.fromEntries(done), best, announced: order.filter((d) => d.announced).map((d) => d.id) };
    },
    load(data) {
      if (!data || typeof data !== 'object') return;
      done.clear();
      for (const [id, n] of Object.entries(data.done || {})) if (defs.has(id)) done.set(id, n | 0);
      Object.assign(best, data.best || {});
      for (const id of data.announced || []) {
        const d = defs.get(id);
        if (d) d.announced = true;
      }
      markers.refresh();
    }
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mission targets: thugs from the combat system when it can make them (a cricket bat or fists: combat.js swaps any
// other weapon for the bat), else a stand-in (a free pedestrian kept milling about its post)
// ---------------------------------------------------------------------------------------------------------------------
function makeTarget(game, x, z, o) {
  const combat = game.combat;
  if (combat && typeof combat.spawnEnemy === 'function') {
    try {
      const e = combat.spawnEnemy({
        x, z, heading: o.heading ?? Math.random() * Math.PI * 2, weaponId: o.weapon ?? 'bat', health: o.health ?? 100,
        accuracy: o.accuracy ?? 0.3, aggroRange: o.aggroRange ?? 30, faction: o.faction ?? 'gull', hostile: o.hostile ?? true,
        pace: o.pace, runSpeed: o.runSpeed
      });
      if (e) return wrapEnemy(game, e);
    } catch (err) {
      console.warn('[missions] combat.spawnEnemy failed; using an unarmed stand-in', err);
    }
  }
  return standIn(game, x, z, o);
}

function wrapEnemy(game, e) {
  const pedOf = () => {
    const id = typeof e === 'number' ? e : e.pedId ?? e.ped?.id ?? (Number.isInteger(e.id) ? e.id : -1);
    return id >= 0 ? game.world.peds[id] : null;
  };
  return {
    armed: true,
    enemy: e,
    get alive() {
      if (typeof e === 'object') {
        if (e.alive !== undefined) return !!e.alive;
        if (e.dead !== undefined) return !e.dead;
        if (e.health !== undefined) return e.health > 0;
      }
      const v = pedOf();
      return v ? v.alive && v.active : false;
    },
    get x() {
      return e.x ?? e.position?.x ?? pedOf()?.x ?? 0;
    },
    get z() {
      return e.z ?? e.position?.z ?? pedOf()?.z ?? 0;
    },
    kill() {
      if (typeof e.kill === 'function') e.kill();
      else if (typeof game.combat?.killEnemy === 'function') game.combat.killEnemy(e);
      else {
        const v = pedOf();
        if (v) game.world.killPed(v.id, { source: 'player', byPlayer: true });
      }
    },
    remove() {
      if (typeof game.combat?.removeEnemy === 'function') game.combat.removeEnemy(e);
      else if (typeof e.remove === 'function') e.remove();
      else if (typeof e.despawn === 'function') e.despawn();
    }
  };
}

function standIn(game, x, z, o) {
  // The crowd only keeps people within ~320 m of the player (further ones are re-used elsewhere), so the stand-in is
  // "at its post" in the abstract until the player comes near: then a free pedestrian takes the part, ambles about
  // the post, and is replaced the same way if the crowd takes it back while the player is away. Out cold is out.
  const peds = game.engine.trafficSystem.pedestrians.peds;
  const EMBODY = 200; // m from the player
  let id = -1, rec = null, dead = false, removed = false;
  let wanderX = x, wanderZ = z, nextWander = 0;
  const radius = o.radius ?? 8;
  const embodied = () => rec && rec.placed && rec.free && !rec.dead;
  const t = {
    armed: false,
    get pedId() {
      return id;
    },
    get alive() {
      if (dead || removed) return false;
      if (rec && rec.dead) {
        dead = true;
        return false;
      }
      return true;
    },
    get x() {
      return embodied() ? rec.x : x;
    },
    get z() {
      return embodied() ? rec.z : z;
    },
    update(dt) {
      if (!t.alive) return;
      const p = game.player.position;
      if (!embodied()) {
        rec = null;
        if (Math.hypot(p.x - x, p.z - z) > EMBODY) return;
        id = game.world.spawnFleeingPed(x, z, x + 0.05, z, 0.01);
        rec = id >= 0 ? peds[id] : null;
        if (!rec) return;
      }
      const clock = game.world.clock;
      rec.freeSince = clock; // (never taken back while the mission needs it)
      if (clock < rec.freeUntil) return; // running from something: let it
      // amble about the post: towards a wander point near it, a new one now and then
      if ((nextWander -= dt) <= 0 || Math.hypot(rec.x - wanderX, rec.z - wanderZ) < 1) {
        nextWander = 3 + Math.random() * 4;
        const a = Math.random() * Math.PI * 2, r = Math.random() * radius;
        wanderX = x + Math.cos(a) * r;
        wanderZ = z + Math.sin(a) * r;
      }
      const dx = wanderX - rec.x, dz = wanderZ - rec.z;
      const d = Math.hypot(dx, dz) || 1;
      // the free runner walks away from its flee point: put that just behind it
      rec.fleeX = rec.x - (dx / d) * 2;
      rec.fleeZ = rec.z - (dz / d) * 2;
    },
    kill() {
      if (!t.alive) return;
      if (embodied()) game.world.killPed(id, { source: 'player', byPlayer: true, kind: 'melee' });
      dead = true;
    },
    remove() {
      // left to walk off and be taken back by the crowd as usual
      if (embodied()) rec.freeSince = game.world.clock - 30;
      removed = true;
    }
  };
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------
// registerMissions: everything engineer D publishes
// ---------------------------------------------------------------------------------------------------------------------
function registerMissions(game) {
  if (game.sandbox) return;
  const places = createPlaces(game);
  game.pickups = createPickups(game);
  game.stats = createStats(game);
  const markers = createMarkers(game);
  const driving = createDriving(game);
  const dialogue = createDialogue(game);
  const runner = createMissionRunner(game, { places, markers, driving, dialogue });
  game.missions = runner;
  // (for scripts & debugging: road routes, AI drivers, valid ground, the world markers)
  runner.driving = driving;
  runner.places = places;
  runner.markers = markers;
  const shared = { places, markers, driving, dialogue, missions: runner, densify };
  game.dialogue = dialogue;
  for (const def of STORY) runner.register(def);
  game.economy = createEconomy(game, shared);
  game.activities = createActivities(game, shared);
  game.phone = createPhone(game, shared);

  // completion: story 40, golden kiwis 15, races 9, challenges 9, exports 8, taxi 10, safehouses 9
  game.stats.setProgress(() => {
    let p = 0;
    const story = STORY.length;
    p += (STORY.filter((d) => runner.isDone(d.id)).length / story) * 40;
    p += (Math.min(30, game.stats.get('collectibles')) / 30) * 15;
    p += game.activities?.progress?.() ?? 0;
    p += (Math.min(3, game.stats.get('safehouses')) / 3) * 9;
    return Math.min(100, p);
  });

  game.save.register('missions', {
    get: () => runner.toJSON(),
    set: (data) => runner.load(data)
  });
  game.save.register('stats', {
    get: () => game.stats.toJSON(),
    set: (data) => game.stats.load(data)
  });

  // a new game: once the title screen lets go, Aunty Mere rings about the first job (and the GPS points to her)
  game.on('ui:title', (e) => {
    if (e?.open !== false || runner.isActive) return;
    if (!e.newGame || runner.isDone(STORY[0].id)) {
      // carrying on: the GPS to the next story job, if there is one
      const next = runner.list().find((m) => m.kind === 'story' && m.available && !m.done);
      if (next) setTimeout(() => !runner.isActive && runner.gps(next.id), 1500);
      return;
    }
    setTimeout(() => {
      if (runner.isActive || runner.isDone(STORY[0].id)) return;
      game.ui?.notify?.({ title: 'Aunty Mere', text: 'Incoming call', icon: 'phone' });
      dialogue.say('Aunty Mere', 'Taxi! It\'s Mere. You\'re behind on that cab again. Come see me on Queen Street, by the pie shop.');
      dialogue.say('Aunty Mere', 'Don\'t make me come find you. I know where you park.');
      runner.gps(STORY[0].id);
    }, 2500);
  });

  game.addSystem({
    name: 'missions',
    order: 55,
    update(dt, time, realDt) {
      dialogue.update(realDt);
      driving.update(dt);
      runner.update(dt, realDt);
      game.economy.update(dt, realDt);
      game.activities.update(dt, realDt);
      game.phone.update(dt, realDt);
      markers.update(dt, realDt);
      game.pickups.update(dt, realDt);
      game.stats.update(dt, realDt);
      game.blips.update();
    }
  });
  return runner;
}

export { registerMissions, createDialogue };
