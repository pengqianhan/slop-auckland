// The mission steps: reusable objectives a mission script is built from. Each type is { enter, update, exit, skip }
// over (ctx, s, st): the running mission (missions.js), the step as written in the script, and the step's own
// scratch state. update returns true when the objective is met, a string to fail the mission with that reason, or
// nothing to keep going. skip (the debug "skip step") puts the world in the state the step leaves behind (the player
// at the place, in the car, the targets down...), so the steps after it run as they would in play.
//
// Common fields of every step: text (the objective line; a string or (ctx) => string), say ([[who, text, s?], ...]
// lines on the phone / radio as it starts), timer (s: starts a mission clock shown on the HUD, failing at 0),
// timerLabel, stopTimer (clears the clock as the step starts), wanted (stars set as it starts), onEnter(ctx, st),
// onDone(ctx, st). A step can also be written inline as { enter, update, exit, skip } functions of (ctx, st).
//
// Positions in scripts: [x, z], { x, z }, a ref name (a vehicle / target the mission spawned) or (ctx) => { x, z }.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const fmt = (s) => {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const COL = { dest: 0xffd23f, enemy: 0xff4a4a, friend: 0x5ec8ff, race: 0xc58cff, next: 0x8a6cff };

/** What the player is in, as a step's `mode` asks: 'any', 'foot', 'vehicle' (any car), 'helicopter', or a ref name */
function modeOk(ctx, mode) {
  const v = ctx.game.player.vehicle;
  if (!mode || mode === 'any') return true;
  if (mode === 'foot') return !v;
  if (mode === 'vehicle') return !!v && v.mode === 'car';
  if (mode === 'helicopter') return !!v && v.mode === 'helicopter';
  return !!v && v === ctx.refs[mode];
}

/**
 * For steps that need the player in a particular vehicle (mode = ref name): while they're out of it, the objective
 * becomes "Get back in the X" with a blip on it; too long or too far away and the mission fails. Returns true while
 * the player is in it (the step can do its work), false while away, or a fail reason.
 */
function vehicleGuard(ctx, s, st, dt) {
  const ref = s.vehicle || (s.mode && !['any', 'foot', 'vehicle', 'helicopter'].includes(s.mode) ? s.mode : null);
  if (!ref) return true;
  const v = ctx.refs[ref];
  if (!v || v.hidden || v.state === 'wrecked') {
    st._code = 'destroyed';
    return v && !v.hidden ? `The ${s.vehicleLabel || v.label.toLowerCase()} is wrecked.` : `The ${s.vehicleLabel || 'vehicle'} is gone.`;
  }
  const inIt = ctx.game.player.vehicle === v;
  if (inIt) {
    if (st._away) {
      st._away = false;
      st._awayT = 0;
      st._backBlip?.remove();
      st._backBlip = null;
      ctx.objective(st._text);
      if (st.blip) st.blip.visible = true;
      if (st.beacon) st.beacon.visible = true;
    }
    return true;
  }
  if (!st._away) {
    st._away = true;
    st._awayT = 0;
    st._backBlip = ctx.blip({ target: v, kind: 'objective', label: v.label, route: true });
    ctx.objective(`Get back in the ${s.vehicleLabel || v.label.toLowerCase()}.`);
    if (st.blip) st.blip.visible = false;
    if (st.beacon) st.beacon.visible = false;
  }
  st._awayT += dt;
  const d = ctx.dist(v.x, v.z);
  if (st._awayT > (s.abandonTime ?? 75) || d > (s.abandonDist ?? 320)) {
    st._code = 'abandoned';
    return `You abandoned the ${s.vehicleLabel || v.label.toLowerCase()}.`;
  }
  return false;
}

function guardExit(st) {
  st._backBlip?.remove();
  st._backBlip = null;
}

/** A target marker: blip (with GPS route) and beacon at p, both tracked by the mission */
function markTarget(ctx, st, p, s, kind = 'objective', color = COL.dest) {
  st.blip = ctx.blip({ x: p.x, z: p.z, kind: s.blipKind || kind, label: s.label || '', route: s.route !== false });
  if (s.beacon !== false) st.beacon = ctx.beacon(p.x, p.z, s.color ?? color, { radius: Math.min(8, s.radius ?? 4), height: s.beaconHeight ?? 34, y: s.y });
}

function unmark(st) {
  st.blip?.remove();
  st.beacon?.remove();
  st.blip = st.beacon = null;
}

const STEPS = {
  // ---------------------------------------------------------------------------------------------------------------
  // Go somewhere (on foot, in a car, in a particular car, in the helicopter); optionally stop there, land, or stay a
  // few seconds. Delivering a car undamaged is this with mode: '<ref>' and minHealth.
  //   { type: 'goto', at, radius = 4, mode, stop, land, hold, minHealth, label }
  // ---------------------------------------------------------------------------------------------------------------
  goto: {
    enter(ctx, s, st) {
      st.p = ctx.at(s.at);
      st.hold = 0;
      markTarget(ctx, st, st.p, s);
    },
    update(ctx, s, st, dt) {
      const g = vehicleGuard(ctx, s, st, dt);
      if (g !== true) return g || undefined;
      const player = ctx.game.player;
      const v = player.vehicle;
      if (s.minHealth != null && v && v.health < s.minHealth) {
        st._code = 'damaged';
        return `The ${v.label.toLowerCase()} is too damaged to be worth anything.`;
      }
      if (!modeOk(ctx, s.mode)) {
        if (s.modeHint && !st.hinted) {
          st.hinted = true;
          ctx.hint(s.modeHint);
        }
        return;
      }
      const p = player.position;
      const r = s.radius ?? 4;
      const dx = p.x - st.p.x, dz = p.z - st.p.z;
      if (dx * dx + dz * dz > r * r) {
        st.hold = 0;
        return;
      }
      if (s.stop && v && Math.abs(v.speed) > 2.5) {
        ctx.hint('Stop the vehicle.');
        return;
      }
      if (s.land) {
        if (!v || v.mode !== 'helicopter') return;
        // (the helicopter knows its height over whatever is under it; the summit is outside the street ground)
        const above = Number.isFinite(v.entity.altitude) ? v.entity.altitude - 0.25 : p.y - ctx.places.ground(p.x, p.z);
        if (above > 2.2 || Math.abs(v.speed) > 3) {
          ctx.hint('Set it down gently.');
          return;
        }
      }
      st.hold += dt;
      if (s.hold && st.hold < s.hold) {
        ctx.hint(s.holdText || `Wait… ${Math.ceil(s.hold - st.hold)}`);
        return;
      }
      return true;
    },
    exit(ctx, s, st) {
      unmark(st);
      guardExit(st);
    },
    skip(ctx, s, st) {
      const p = st.p || ctx.at(s.at);
      ctx.teleportPlayer(p.x, p.z, s.land ? 0.5 : null);
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Get into a vehicle the mission spawned (ref), or into any vehicle of a kind (steal: 'police' | kind), stored as
  // refs[as]. { type: 'enter', ref } | { type: 'steal', kind, as, police }
  // ---------------------------------------------------------------------------------------------------------------
  enter: {
    enter(ctx, s, st) {
      const v = ctx.refs[s.ref];
      if (v) st.blip = ctx.blip({ target: v, kind: 'objective', label: s.label || v.label, route: s.route !== false });
    },
    update(ctx, s, st) {
      const v = ctx.refs[s.ref];
      if (!v || v.hidden) return `The ${s.vehicleLabel || 'car'} is gone.`;
      if (v.state === 'wrecked') return `The ${s.vehicleLabel || v.label.toLowerCase()} is wrecked.`;
      return ctx.game.player.vehicle === v;
    },
    exit(ctx, s, st) {
      unmark(st);
    },
    skip(ctx, s) {
      const v = ctx.refs[s.ref];
      if (v) ctx.putPlayerIn(v);
    }
  },
  steal: {
    update(ctx, s) {
      const v = ctx.game.player.vehicle;
      if (!v || v.state === 'wrecked') return;
      const kindOk = s.kind === 'police' ? v.police : s.kind === 'any' ? v.mode === 'car' : v.kind === s.kind && (s.police == null || v.police === !!s.police);
      if (!kindOk || v.hero) return;
      ctx.adopt(s.as || 'stolen', v);
      return true;
    },
    skip(ctx, s) {
      const p = ctx.game.player.position;
      const kind = s.kind === 'police' ? 'police' : s.kind === 'any' ? 'sedan' : s.kind;
      const at = ctx.places.road(p.x, p.z);
      const v = ctx.spawnVehicle(s.as || 'stolen', kind, at.x, at.z, at.heading, {});
      if (v) ctx.putPlayerIn(v);
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Wanted level: { type: 'wanted', level } (instant). Lose the cops: { type: 'loseCops', fallback = 25 } — done at
  // zero stars; without a police system, "lie low" for `fallback` seconds instead.
  // ---------------------------------------------------------------------------------------------------------------
  wanted: {
    enter(ctx, s) {
      ctx.setWanted(s.level);
    },
    update() {
      return true;
    }
  },
  loseCops: {
    enter(ctx, s, st) {
      st.left = s.fallback ?? 25;
      st.hasPolice = !!ctx.game.wanted;
      if (!st.hasPolice) ctx.objective(`Lie low for ${Math.round(st.left)} seconds.`);
    },
    update(ctx, s, st, dt) {
      const g = vehicleGuard(ctx, s, st, dt);
      if (typeof g === 'string') return g;
      const w = ctx.game.wanted;
      if (w) return !(w.level > 0);
      st.left -= dt;
      ctx.hint(`Lying low… ${Math.ceil(Math.max(0, st.left))}`);
      return st.left <= 0;
    },
    exit(ctx, s, st) {
      guardExit(st);
    },
    skip(ctx) {
      ctx.game.wanted?.clear?.('debug');
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Wreck vehicles (rammed or battered until the engine dies): { type: 'destroy', refs: ['van1', ...], health (counts
  // as done at or below; default: wrecked) }
  // ---------------------------------------------------------------------------------------------------------------
  destroy: {
    enter(ctx, s, st) {
      st.blips = new Map();
      for (const name of s.refs) {
        const v = ctx.refs[name];
        if (!v) continue;
        // (the job's own targets: wrecking one is the job, not a crime the police hear about by itself)
        v.crimeFree = true;
        st.blips.set(name, ctx.blip({ target: v, kind: 'enemy', label: s.label || v.label }));
      }
    },
    update(ctx, s, st) {
      let left = 0;
      for (const name of s.refs) {
        const v = ctx.refs[name];
        const down = !v || v.hidden || v.state === 'wrecked' || (s.health != null && v.health <= s.health);
        if (down) {
          const b = st.blips.get(name);
          if (b) {
            b.remove();
            st.blips.delete(name);
          }
        } else left++;
      }
      if (s.refs.length > 1 && left !== st.left) {
        st.left = left;
        if (left > 0) ctx.objective(`${typeof s.text === 'function' ? s.text(ctx) : s.text || 'Wreck the targets.'} (${s.refs.length - left}/${s.refs.length})`);
      }
      if (left === 0) return true;
      // a target driving somewhere (a convoy): getting there is getting away
      if (s.escapeRef) {
        const v = ctx.refs[s.escapeRef];
        const d = v && ctx.driverOf(v);
        if (d && d.done && v.state !== 'wrecked') return s.escapeText || 'They got away.';
      }
      return false;
    },
    exit(ctx, s, st) {
      for (const b of st.blips.values()) b.remove();
    },
    skip(ctx, s) {
      for (const name of s.refs) {
        const v = ctx.refs[name];
        if (v && v.state !== 'wrecked' && !v.hidden) ctx.game.vehicles.wreck(v);
      }
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Knock out targets the mission spawned with ctx.target() (down and out cold): { type: 'eliminate', refs: ['g1', ...] }
  // ---------------------------------------------------------------------------------------------------------------
  eliminate: {
    enter(ctx, s, st) {
      st.blips = new Map();
      for (const name of s.refs) {
        const t = ctx.refs[name];
        if (t) st.blips.set(name, ctx.blip({ target: t, kind: 'enemy', label: s.label || 'Target' }));
      }
    },
    update(ctx, s, st) {
      let left = 0;
      for (const name of s.refs) {
        const t = ctx.refs[name];
        if (!t || !t.alive) {
          const b = st.blips.get(name);
          if (b) {
            b.remove();
            st.blips.delete(name);
          }
        } else left++;
      }
      if (left !== st.left) {
        st.left = left;
        if (left > 0 && s.refs.length > 1) ctx.objective(`${typeof s.text === 'function' ? s.text(ctx) : s.text || 'Knock out the targets.'} (${s.refs.length - left}/${s.refs.length})`);
      }
      if (left === 0) return true;
      // a target making for somewhere (escape: { x, z, radius, text }): getting there is getting away
      if (s.escape) {
        for (const name of s.refs) {
          const t = ctx.refs[name];
          if (t && t.alive && Math.hypot(t.x - s.escape.x, t.z - s.escape.z) < (s.escape.radius ?? 20)) {
            st._code = 'escaped';
            return s.escape.text || 'They got away.';
          }
        }
      }
      return false;
    },
    exit(ctx, s, st) {
      for (const b of st.blips.values()) b.remove();
    },
    skip(ctx, s) {
      for (const name of s.refs) ctx.refs[name]?.kill?.();
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Tail a vehicle without being seen: it drives its route (to, or points); closer than `near` for spotTime s and
  // it's spotted, further than `far` for loseTime s and it's lost.
  //   { type: 'tail', ref, to: [x, z] | points, speed = 11, near = 14, far = 110, spotTime = 3, loseTime = 9 }
  // ---------------------------------------------------------------------------------------------------------------
  tail: {
    enter(ctx, s, st) {
      const v = ctx.refs[s.ref];
      st.spot = 0;
      st.lost = 0;
      if (!v) return;
      const pts = s.points ? (typeof s.points === 'function' ? s.points(ctx) : s.points) : ctx.routeTo(v, ctx.at(s.to));
      st.driver = ctx.drive(v, { points: pts, speed: s.speed ?? 11 });
      st.blip = ctx.blip({ target: v, kind: 'enemy', label: s.label || v.label });
    },
    update(ctx, s, st, dt) {
      const v = ctx.refs[s.ref];
      if (!v || v.hidden || v.state === 'wrecked') return s.wreckedText || 'The target got wrecked. That\'s one way to end a stakeout.';
      if (!st.driver) return true;
      if (st.driver.done) return true;
      const d = ctx.dist(v.x, v.z);
      const near = s.near ?? 14, far = s.far ?? 110;
      if (d < near) {
        st.spot += dt;
        ctx.hint(`Too close! Back off. ${'▮'.repeat(Math.ceil((st.spot / (s.spotTime ?? 3)) * 5))}`);
        if (st.spot > (s.spotTime ?? 3)) {
          st._code = 'spotted';
          return s.spottedText || 'You were spotted.';
        }
      } else {
        st.spot = Math.max(0, st.spot - dt * 0.5);
      }
      if (d > far) {
        st.lost += dt;
        ctx.hint(`You're losing them! ${Math.ceil((s.loseTime ?? 9) - st.lost)}`);
        if (st.lost > (s.loseTime ?? 9)) {
          st._code = 'lost';
          return s.lostText || 'You lost them.';
        }
      } else {
        st.lost = 0;
      }
    },
    exit(ctx, s, st) {
      st.blip?.remove();
      if (st.driver && !st.driver.done) st.driver.stop(true);
    },
    skip(ctx, s, st) {
      const v = ctx.refs[s.ref];
      const P = st.driver?.points;
      if (v && P) ctx.moveVehicle(v, P[P.length - 2], P[P.length - 1], Math.atan2(P[P.length - 2] - P[P.length - 4], P[P.length - 1] - P[P.length - 3]));
      if (st.driver) {
        st.driver.done = true;
        st.driver.stop(true);
      }
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Collect items lying about: { type: 'collect', items: [[x, z], ...], kind = 'package', label, inVehicle = true }
  // ---------------------------------------------------------------------------------------------------------------
  collect: {
    enter(ctx, s, st) {
      st.left = 0;
      st.items = [];
      const items = typeof s.items === 'function' ? s.items(ctx) : s.items;
      for (const it of items) {
        const p = ctx.at(it);
        const item = { p, got: false, pickup: null, blip: null };
        item.pickup = ctx.pickup(s.kind || 'package', p.x, p.z, {
          inVehicle: s.inVehicle ?? true,
          label: s.label,
          onCollect: () => {
            item.got = true;
            item.blip?.remove();
            ctx.game.emit('mission:item', { id: ctx.def.id, kind: s.kind || 'package' });
          }
        });
        item.blip = ctx.blip({ x: p.x, z: p.z, kind: 'pickup', label: s.label || 'Package', route: false });
        st.items.push(item);
        st.left++;
      }
      // the GPS leads to the nearest one still lying there
      st.route = ctx.blip({ x: st.items[0]?.p.x ?? 0, z: st.items[0]?.p.z ?? 0, kind: 'objective', label: s.label || 'Package', route: true });
    },
    update(ctx, s, st) {
      let left = 0, best = null, bd = Infinity;
      for (const it of st.items) {
        if (it.got) continue;
        left++;
        const d = ctx.dist(it.p.x, it.p.z);
        if (d < bd) {
          bd = d;
          best = it;
        }
      }
      if (best) st.route.set(best.p.x, best.p.z);
      if (left !== st.left) {
        st.left = left;
        if (left > 0) ctx.objective(`${typeof s.text === 'function' ? s.text(ctx) : s.text || 'Collect the packages.'} (${st.items.length - left}/${st.items.length})`);
      }
      return left === 0;
    },
    exit(ctx, s, st) {
      for (const it of st.items) {
        it.blip?.remove();
        if (!it.got) ctx.game.pickups.remove(it.pickup);
      }
      st.route?.remove();
    },
    skip(ctx, s, st) {
      for (const it of st.items) {
        it.got = true;
        ctx.game.pickups.remove(it.pickup);
      }
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Checkpoint race: { type: 'race', points: [[x, z], ...] | (ctx) => [...], radius = 10, rivals: ['r1', ...]
  //   (vehicles the mission spawned; they drive `path` or a road route through the points), rivalSpeed, mustWin,
  //   medals: [gold, silver, bronze] s (finishing slower than bronze fails), countdown = 3, mode }
  // st.time is the race time; ctx.result.place / .time / .medal are set on finishing.
  // ---------------------------------------------------------------------------------------------------------------
  race: {
    enter(ctx, s, st) {
      st.points = (typeof s.points === 'function' ? s.points(ctx) : s.points).map((p) => ctx.at(p));
      st.i = 0;
      st.time = 0;
      st.count = s.countdown ?? 3;
      st.started = st.count <= 0;
      st.rivals = [];
      if (!st.started) ctx.freeze(true);
      // the grid: rivals lined up beside and just behind the player wherever they stopped (not 14 m behind, in the
      // same lane, to ram them off the line at GO)
      const pv = ctx.game.player.vehicle;
      if (pv && s.grid !== false) {
        const fs = Math.sin(pv.heading), fc = Math.cos(pv.heading);
        const slots = [[3.6, -1.5], [3.6, -10], [0, -11], [-3.6, -10]]; // [left, forward] m
        let k = 0;
        for (const name of s.rivals || []) {
          const v = ctx.refs[name];
          if (!v || k >= slots.length) continue;
          const [l, f] = slots[k++];
          ctx.moveVehicle(v, pv.x + fc * l + fs * f, pv.z - fs * l + fc * f, pv.heading);
        }
      }
      const path = s.path ? (typeof s.path === 'function' ? s.path(ctx) : s.path) : null;
      for (const name of s.rivals || []) {
        const v = ctx.refs[name];
        if (!v) continue;
        const pts = path || ctx.routeThrough(v, st.points);
        st.rivals.push({ v, pts, driver: null, done: false });
      }
      st.cpBeacon = null;
      st.nextBeacon = null;
      st.blip = null;
      st.nextBlip = null;
      showCheckpoint(ctx, s, st);
      if (!st.started) ctx.flash(String(Math.ceil(st.count)));
    },
    update(ctx, s, st, dt) {
      if (!st.started) {
        const before = Math.ceil(st.count);
        st.count -= dt;
        const after = Math.ceil(st.count);
        if (after !== before) ctx.flash(after > 0 ? String(after) : 'GO!');
        if (st.count <= 0) {
          st.started = true;
          ctx.freeze(false);
          for (const r of st.rivals) {
            r.driver = ctx.drive(r.v, {
              points: r.pts, speed: s.rivalSpeed ?? 27, barge: true,
              onArrive: () => {
                r.done = true;
              }
            });
          }
        }
        return;
      }
      const g = vehicleGuard(ctx, s, st, dt);
      if (typeof g === 'string') return g;
      st.time += dt;
      if (!modeOk(ctx, s.mode || 'vehicle')) {
        if (!st.hinted) {
          st.hinted = true;
          ctx.hint('Get in a car!');
        }
      } else {
        const p = ctx.game.player.position;
        const cp = st.points[st.i];
        const r = s.radius ?? 10;
        if ((p.x - cp.x) ** 2 + (p.z - cp.z) ** 2 < r * r && Math.abs(p.y - ctx.places.ground(cp.x, cp.z)) < 12) {
          st.i++;
          ctx.game.emit('race:checkpoint', { index: st.i, count: st.points.length, time: st.time });
          ctx.game.audio?.play?.('ui-select');
          if (st.i >= st.points.length) return finishRace(ctx, s, st);
          showCheckpoint(ctx, s, st);
        }
      }
      // rivals finishing first
      if (s.mustWin && st.rivals.some((r) => r.done)) {
        st._code = 'lost';
        return s.lostText || 'You were beaten to the line.';
      }
      if ((s.medals && st.time > s.medals[2] + 0.05) || (s.timeLimit && st.time > s.timeLimit)) {
        st._code = 'timeout';
        return s.medals ? 'Too slow — out of time.' : 'Out of time.';
      }
      ctx.timer(s.medals ? s.medals[2] - st.time : s.timeLimit ? s.timeLimit - st.time : st.time, s.medals ? 'Bronze' : s.timeLimit ? 'Time' : 'Race');
      // rubber band: each rival measured against the player along its own line (metres to go), eased off when far
      // ahead and pushed when behind, so a race stays a race whoever is winning
      if (st.rivals.length) rubberBand(ctx, s, st);
      // position: rivals ahead of the player (by metres to go on their own line; by checkpoints if that's unknown)
      if (st.rivals.length) {
        const mine = st.i / st.points.length;
        let ahead = 0;
        for (const r of st.rivals) if (r.done || (r.driver && (Number.isFinite(r.playerLeft) ? r.driver.remaining < r.playerLeft - 4 : r.driver.progress > mine + 0.02))) ahead++;
        const place = ahead + 1;
        if (place !== st.place) {
          st.place = place;
          ctx.objective(`${s.text || 'Win the race.'} Checkpoint ${st.i + 1}/${st.points.length} · ${ordinal(place)}`);
        }
      }
    },
    exit(ctx, s, st) {
      ctx.freeze(false);
      st.cpBeacon?.remove();
      st.nextBeacon?.remove();
      st.blip?.remove();
      st.nextBlip?.remove();
      ctx.timer(null);
      for (const r of st.rivals) r.driver?.stop(true);
      guardExit(st);
    },
    skip(ctx, s, st) {
      st.skipped = true;
      ctx.freeze(false);
      ctx.result.place = 1;
      ctx.result.time = s.medals ? s.medals[0] - 1 : 60;
      ctx.result.medal = s.medals ? 'gold' : null;
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Survive: stay alive (and out of handcuffs) for `seconds`, with `wanted` stars if given: { type: 'survive', seconds }
  // ---------------------------------------------------------------------------------------------------------------
  survive: {
    enter(ctx, s, st) {
      st.left = s.seconds ?? 60;
    },
    update(ctx, s, st, dt) {
      const g = vehicleGuard(ctx, s, st, dt);
      if (typeof g === 'string') return g;
      st.left -= dt;
      ctx.timer(st.left, s.timerLabel || 'Survive');
      if (s.keepWanted && ctx.game.wanted && ctx.game.wanted.level < s.keepWanted) ctx.setWanted(s.keepWanted);
      return st.left <= 0;
    },
    exit(ctx, s, st) {
      ctx.timer(null);
      guardExit(st);
    },
    skip() {}
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Chase and ram: the target flees (barging through traffic) until its health is down to `until` (or it is
  // wrecked); left further than `far` for loseTime s, it gets away.
  //   { type: 'chase', ref, until = 25, speed = 24, far = 170, loseTime = 10 }
  // ---------------------------------------------------------------------------------------------------------------
  chase: {
    enter(ctx, s, st) {
      const v = ctx.refs[s.ref];
      st.lost = 0;
      if (!v) return;
      st.blip = ctx.blip({ target: v, kind: 'enemy', label: s.label || v.label });
      flee(ctx, s, st, v);
    },
    update(ctx, s, st, dt) {
      const v = ctx.refs[s.ref];
      if (!v || v.hidden) return 'The target got away.';
      if (v.state === 'wrecked' || v.health <= (s.until ?? 25)) return true;
      if (!st.driver || st.driver.done || st.driver.stopped) flee(ctx, s, st, v);
      const d = ctx.dist(v.x, v.z);
      if (d > (s.far ?? 170)) {
        st.lost += dt;
        ctx.hint(`They're getting away! ${Math.ceil((s.loseTime ?? 10) - st.lost)}`);
        if (st.lost > (s.loseTime ?? 10)) {
          st._code = 'lost';
          return s.lostText || 'The target got away.';
        }
      } else st.lost = 0;
      // the health bar of the target
      const pct = clamp((v.health - (s.until ?? 25)) / (100 - (s.until ?? 25)), 0, 1);
      const bars = Math.ceil(pct * 10);
      if (bars !== st.bars) {
        st.bars = bars;
        ctx.objective(`${typeof s.text === 'function' ? s.text(ctx) : s.text || 'Ram the target off the road.'} ${'█'.repeat(bars)}${'░'.repeat(10 - bars)}`);
      }
    },
    exit(ctx, s, st) {
      st.blip?.remove();
      st.driver?.stop(true);
    },
    skip(ctx, s) {
      const v = ctx.refs[s.ref];
      if (v) {
        v.health = Math.min(v.health, (s.until ?? 25) - 1);
        ctx.game.vehicles.setControls(v, null);
      }
    }
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Wait a few seconds (a phone call plays out): { type: 'wait', seconds }
  // ---------------------------------------------------------------------------------------------------------------
  wait: {
    enter(ctx, s, st) {
      st.left = s.seconds ?? 3;
    },
    update(ctx, s, st, dt) {
      st.left -= dt;
      return st.left <= 0;
    },
    skip() {}
  },

  // An instant step that runs a function: { type: 'do', run(ctx) }
  do: {
    enter(ctx, s) {
      s.run?.(ctx);
    },
    update() {
      return true;
    },
    skip() {}
  }
};

// The race's rubber band: where the player is along each rival's polyline (the nearest vertex, searched near the last
// one), how far ahead or behind the rival is, and its speed set from that: up to RUBBER.slow slower a long way ahead,
// up to RUBBER.fast faster behind
const RUBBER = { range: 220, slow: 0.72, fast: 1.18 };
function rubberBand(ctx, s, st) {
  const p = ctx.game.player.position;
  const base = s.rivalSpeed ?? 27;
  for (const r of st.rivals) {
    const d = r.driver;
    if (!d || d.done || d.stopped || !d.lengths) continue;
    const P = r.pts;
    const n = P.length / 2;
    let best = r.pIdx ?? 0, bd = Infinity;
    const from = Math.max(0, (r.pIdx ?? 0) - 12), to = Math.min(n - 1, (r.pIdx ?? 0) + 40);
    for (let i = from; i <= to; i++) {
      const dd = (P[i * 2] - p.x) ** 2 + (P[i * 2 + 1] - p.z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    // (off the line by more than a block: keep the last estimate rather than jump to a far part of it)
    if (bd < 90 * 90 || r.pIdx == null) r.pIdx = best;
    r.playerLeft = d.lengths[r.pIdx] ?? Infinity;
    const lead = r.playerLeft - d.remaining; // > 0: the rival is ahead by that many metres
    const k = clamp(lead / RUBBER.range, -1, 1);
    d.setSpeed(base * (k > 0 ? 1 - (1 - RUBBER.slow) * k : 1 - (RUBBER.fast - 1) * k));
  }
}

function ordinal(n) {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

function showCheckpoint(ctx, s, st) {
  st.cpBeacon?.remove();
  st.nextBeacon?.remove();
  st.blip?.remove();
  st.nextBlip?.remove();
  const cp = st.points[st.i];
  const last = st.i === st.points.length - 1;
  st.cpBeacon = ctx.beacon(cp.x, cp.z, last ? 0xffffff : COL.race, { radius: s.radius ?? 10, height: 40 });
  st.blip = ctx.blip({ x: cp.x, z: cp.z, kind: 'race', label: last ? 'Finish' : `Checkpoint ${st.i + 1}`, route: true });
  const next = st.points[st.i + 1];
  if (next) {
    st.nextBeacon = ctx.beacon(next.x, next.z, COL.next, { radius: (s.radius ?? 10) * 0.6, height: 18 });
    st.nextBlip = ctx.blip({ x: next.x, z: next.z, kind: 'race', label: 'Next', route: false, short: true });
  }
  ctx.objective(`${s.text || 'Race!'} Checkpoint ${st.i + 1}/${st.points.length}${st.place ? ` · ${ordinal(st.place)}` : ''}`);
}

function finishRace(ctx, s, st) {
  const ahead = st.rivals.filter((r) => r.done).length;
  ctx.result.place = ahead + 1;
  ctx.result.time = st.time;
  if (s.medals) ctx.result.medal = st.time <= s.medals[0] ? 'gold' : st.time <= s.medals[1] ? 'silver' : 'bronze';
  if (s.mustWin && ahead > 0) return s.lostText || 'You were beaten to the line.';
  return true;
}

function flee(ctx, s, st, v) {
  st.driver?.stop(false);
  const p = ctx.game.player.position;
  // somewhere well away from the player, ahead of the target if possible
  let best = null;
  for (let k = 0; k < 6; k++) {
    const q = ctx.game.world.randomRoadPoint(v.x, v.z, 350, 800);
    if (!q) continue;
    const away = (q.x - v.x) * (v.x - p.x) + (q.z - v.z) * (v.z - p.z);
    if (!best || away > best.away) best = { x: q.x, z: q.z, away };
  }
  const pts = best ? ctx.routeTo(v, best) : null;
  // (a getaway car barges through anything, the player's car included: cut in front of it and it shoves past)
  st.driver = pts ? ctx.drive(v, { points: pts, speed: s.speed ?? 24, barge: true, ram: true }) : null;
}

export { STEPS, fmt, modeOk, vehicleGuard, ordinal };
