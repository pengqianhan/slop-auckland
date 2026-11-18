// The game's core: a small synchronous event bus, the registry of game systems, the game state (playing, paused,
// dead, cutscene) and the simulation clock. main.js asks the clock how far to step the whole simulation each frame
// (game.simDt), so pausing, slow motion and hit-stop apply to traffic, people and vehicles alike.
// Everything here is fail-soft: a system or an event handler that throws is logged once and skipped from then on
// for that call, so one broken plug-in never stops the frame loop.

const STATES = ['playing', 'paused', 'dead', 'cutscene'];

/** Frame-rate independent exponential smoothing of a towards b (rate: 1/s) */
function damp(a, b, rate, dt) {
  return b + (a - b) * Math.exp(-rate * dt);
}

/** Angle a eased towards b the short way round */
function dampAngle(a, b, rate, dt) {
  let d = b - a;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return a + d * (1 - Math.exp(-rate * dt));
}

/**
 * A damped spring solved in closed form (exact for any dt, so it never explodes on a long frame): x position,
 * v velocity, w natural angular frequency (rad/s), z damping ratio (1 critically damped, < 1 bouncy).
 */
function createSpring(w = 12, z = 1, x = 0) {
  return { x, v: 0, w, z };
}

function stepSpring(s, target, dt) {
  const w = s.w;
  const z = s.z;
  const x0 = s.x - target;
  const v0 = s.v;
  if (Math.abs(z - 1) < 1e-4) {
    const e = Math.exp(-w * dt);
    const c = v0 + w * x0;
    s.x = target + (x0 + c * dt) * e;
    s.v = (v0 - w * c * dt) * e;
  } else if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * dt);
    const cos = Math.cos(wd * dt);
    const sin = Math.sin(wd * dt);
    const b = (v0 + z * w * x0) / wd;
    s.x = target + e * (x0 * cos + b * sin);
    s.v = e * (v0 * cos - (z * w * b + x0 * wd) * sin);
  } else {
    const r = Math.sqrt(z * z - 1);
    const r1 = -w * (z - r);
    const r2 = -w * (z + r);
    const c2 = (v0 - r1 * x0) / (r2 - r1);
    const c1 = x0 - c2;
    const e1 = Math.exp(r1 * dt);
    const e2 = Math.exp(r2 * dt);
    s.x = target + c1 * e1 + c2 * e2;
    s.v = r1 * c1 * e1 + r2 * c2 * e2;
  }
  return s.x;
}

const SYSTEM_ORDER = { early: 10, default: 50, late: 90 };

class Game {
  constructor({ sandbox = false } = {}) {
    this.sandbox = sandbox;
    this.state = 'playing';
    this.letterbox = false; // a cutscene with black bars (see setState)
    this.time = 0; // simulation seconds (stops while paused, slows in slow motion)
    this.realTime = 0; // wall-clock seconds since the game started
    this.frame = 0;
    this._handlers = new Map(); // type -> array of handlers (copied on write, so emit can iterate safely)
    this._systems = [];
    this._systemsByName = new Map();
    this._failed = new WeakSet(); // systems & handlers already reported as throwing
    // time scale: user scale (cheats, cutscenes) x effect scale (slow motion / hit-stop, timed in real seconds)
    this.timeScale = 1;
    this._effectScale = 1;
    this._effectLeft = 0;
    this._effectEase = 0;
    this._lastSimDt = 0;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Event bus (synchronous). Handlers run in subscription order; payloads on hot paths are reused objects, so copy
  // whatever you keep. on() returns an unsubscribe function.
  // ---------------------------------------------------------------------------------------------------------------
  on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    const list = this._handlers.get(type);
    this._handlers.set(type, list ? [...list, fn] : [fn]);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return;
    const next = list.filter((h) => h !== fn);
    if (next.length) this._handlers.set(type, next);
    else this._handlers.delete(type);
  }

  emit(type, payload) {
    const list = this._handlers.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload, type);
      } catch (error) {
        if (!this._failed.has(list[i])) {
          this._failed.add(list[i]);
          console.error(`[game] handler for "${type}" threw (reported once):`, error);
        }
      }
    }
  }

  hasListeners(type) {
    return this._handlers.has(type);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Systems: { name, order?, init?(game), update?(dt, elapsed, realDt), dispose?() }. dt is the simulation step:
  // 0 while paused (systems that only simulate can return early), small in slow motion. order: lower runs first
  // (built-ins: world 5, player 10, vehicles 20, others 50 by default, fx 80, ui 90).
  // ---------------------------------------------------------------------------------------------------------------
  addSystem(system) {
    if (!system || !system.name) throw new Error('game.addSystem: a system needs a name');
    if (this._systemsByName.has(system.name)) this.removeSystem(system.name);
    system.order ??= SYSTEM_ORDER.default;
    this._systems.push(system);
    this._systems.sort((a, b) => a.order - b.order);
    this._systemsByName.set(system.name, system);
    if (typeof system.init === 'function') {
      try {
        system.init(this);
      } catch (error) {
        console.error(`[game] system "${system.name}" failed to initialise:`, error);
      }
    }
    return system;
  }

  removeSystem(name) {
    const system = this._systemsByName.get(name);
    if (!system) return;
    this._systemsByName.delete(name);
    this._systems = this._systems.filter((s) => s !== system);
    try {
      system.dispose?.();
    } catch (error) {
      console.error(`[game] system "${name}" failed to dispose:`, error);
    }
  }

  getSystem(name) {
    return this._systemsByName.get(name) || null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * opts.letterbox (cutscene only, default true): false for a "hold" that is not a scene — a shop's menu, a respray —
   * where the world goes on, the player is out of harm's way and the controls are the menu's, but no black bars
   */
  setState(state, opts = null) {
    if (!STATES.includes(state)) return;
    const letterbox = state === 'cutscene' && opts?.letterbox !== false;
    if (state === this.state) {
      // (a hold turning into a scene, or back: only the bars change)
      if (state === 'cutscene' && letterbox !== this.letterbox) {
        this.letterbox = letterbox;
        this.emit('state', { state, prev: state, letterbox });
      }
      return;
    }
    const prev = this.state;
    this.state = state;
    this.letterbox = letterbox;
    this.emit('state', { state, prev, letterbox });
  }

  get paused() {
    return this.state === 'paused';
  }

  get playing() {
    return this.state === 'playing';
  }

  pause() {
    if (this.state === 'playing') {
      this._resumeState = 'playing';
      this.setState('paused');
    }
  }

  resume() {
    if (this.state === 'paused') this.setState(this._resumeState || 'playing');
  }
  togglePause() {
    if (this.state === 'paused') this.resume();
    else this.pause();
  }

  /** Slow motion: the simulation runs at `scale` for `seconds` of real time, easing back over the last 0.25 s */
  slowMo(scale = 0.3, seconds = 1) {
    this._effectScale = Math.max(0.01, Math.min(1, scale));
    this._effectLeft = Math.max(this._effectLeft, seconds);
    this._effectEase = Math.min(0.25, seconds * 0.5);
  }

  /** Hit-stop: an almost frozen moment (a few frames) for weight on big hits */
  hitStop(seconds = 0.06) {
    this.slowMo(0.04, seconds);
    this._effectEase = 0;
  }

  /** Called once per frame by main.js: how far to step the simulation for a wall-clock dt (0 while paused) */
  simDt(dt) {
    this.realTime += dt;
    let scale = this.timeScale;
    if (this._effectLeft > 0) {
      this._effectLeft = Math.max(0, this._effectLeft - dt);
      const ease = this._effectEase > 0 ? Math.min(1, this._effectLeft / this._effectEase) : 1;
      scale *= this._effectLeft > 0 ? 1 + (this._effectScale - 1) * ease : 1;
    }
    const step = this.state === 'paused' ? 0 : dt * scale;
    this._lastSimDt = step;
    return step;
  }

  get effectiveTimeScale() {
    return this.state === 'paused' ? 0 : this.timeScale * (this._effectLeft > 0 ? this._effectScale : 1);
  }

  /** Runs every system; main.js calls it after the controllers, camera and traffic have updated */
  update(dt, elapsed, realDt) {
    this.frame++;
    if (dt > 0) this.time += dt;
    this.input?.begin?.();
    const systems = this._systems;
    for (let i = 0; i < systems.length; i++) {
      const system = systems[i];
      if (!system.update) continue;
      try {
        system.update(dt, this.time, realDt);
      } catch (error) {
        if (!this._failed.has(system)) {
          this._failed.add(system);
          console.error(`[game] system "${system.name}" threw in update (reported once, keeps running):`, error);
        }
      }
    }
    // (input edges last one frame: every system above saw the same presses)
    this.input?.end?.();
  }
}

export { Game, STATES, SYSTEM_ORDER, damp, dampAngle, createSpring, stepSpring };
