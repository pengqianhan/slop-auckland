import { createSfxBank, SFX_RECIPES, mulberry, hash } from './audio-sfx.js';
import { createMusicKit, createStation, Scheduler, STATIONS, POLICE_BAND } from './audio-music.js';
import { createMotorVoice } from '../audio-synthesis.js';
import { createRadio, createRadioChain } from './radio.js';

// The game's sound (game.audio), built on the city's audio (js/audio-system.js: same AudioContext, same mute toggle
// [N] / sound button, same listener and acoustics). Everything is synthesized: one-shots and loops are rendered into
// buffers in the background while the game loads (js/audio-sfx.js), the radio's music is generated live
// (js/audio-music.js, game/radio.js). Driven by the bus: a caper's sounds — swings, punches and the cricket bat's
// knock, impacts, car doors / starts / alarms / tyres, a wreck's dying cough and hiss, pickups and money, UI blips,
// stingers, screams and shouts, police megaphone and scanner chatter, a police helicopter's rotor, and a tense
// intensity layer while wanted. No gunfire, no explosions: there are none in the game. Sirens and the engines of
// AI-driven world vehicles go through the city's own motor pool (js/audio-sources.js). The graph:
//   city sounds (audioSystem.world) -> ambience duck -+
//   game one-shots & loops ----------> sfx duck ------+-> high shelf -> pause lowpass -> sfx volume -> mix
//   hot bus (never ducked; nothing uses it now) -------+
//   UI, pickups, scanner ------------------------------------------------------> ui (sfx volume) -> mix
//   radio (game/radio.js chain) -> radio duck -+-> music volume -> mix        (mix -> compressor -> master)
//   stingers, intensity layer -----------------+
//
//   game.audio = { play(name, { x, y, z, gain, rate, delay }) -> bool, duck(amount 0..1, seconds),
//     setVolume('master' | 'sfx' | 'music', 0..1), getVolume(kind), selfTest({ seconds }) -> Promise<report>,
//     meter() -> { peak, rms } (live output),
//     ready (bool), sounds (names) }

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const SPEED_OF_SOUND = 340;
const MAX_VOICES = 24; // positional one-shots at once (loops have their own small pools)

// name: [gain, priority, reference distance (m), max distance (m), bus]; buses: sfx (ducked), hot (never ducked),
// ui (flat), stinger (music volume)
const SOUNDS = {};
const def = (names, gain, prio, ref, max, bus = 'sfx') => {
  for (const n of names.split(' ')) SOUNDS[n] = { gain, prio, ref, max, bus };
};
def('impact-concrete impact-dirt', 0.5, 3, 2, 90);
def('impact-metal impact-glass', 0.5, 3, 2.5, 100);
def('impact-flesh', 0.38, 3, 1.5, 50);
def('impact-water', 0.45, 3, 2, 80);
def('whoosh', 0.32, 3, 1.5, 25);
def('punch bat', 0.6, 5, 2, 45);
def('click switch', 0.42, 4, 1.5, 25);
def('door-open', 0.4, 4, 2, 40);
def('door-close', 0.55, 4, 2.5, 60);
def('engine-start', 0.5, 4, 3, 80);
def('bail', 0.7, 5, 3, 60);
def('backfire', 0.75, 4, 4, 220);
def('hiss', 0.3, 2, 2, 40);
def('scream', 0.42, 4, 3, 70);
def('shout', 0.4, 4, 3, 60);
def('pain', 0.34, 4, 2, 45);
def('megaphone', 0.85, 6, 8, 180);
def('pickup pickup-health pickup-armor cash coin', 0.5, 6, 1, 1, 'ui');
def('ui-move ui-select ui-back ui-pause', 0.32, 8, 1, 1, 'ui');
def('hit hit-kill', 0.24, 6, 1, 1, 'ui');
def('chatter', 0.15, 3, 1, 1, 'ui');
def('mission-start mission-passed mission-failed wanted-up wanted-down wanted-cleared wasted busted', 0.62, 9, 1, 1, 'stinger');
const LOOPS = { 'alarm-loop': [0.32, 6, 170], 'tyre-loop': [0.42], 'skid-loop': [0.36] };
// what renders first (the rest follows in the background)
const RENDER_ORDER = ['whoosh', 'punch', 'bat', 'impact-concrete', 'door-open', 'door-close', 'engine-start', 'ui-move', 'ui-select'];

export function registerAudio(game) {
  const as = game.engine.audioSystem;
  if (!as || game.sandbox) return null;
  const sfx = createSfxBank({ order: RENDER_ORDER });
  const kit = createMusicKit();
  const banks = { sfx, kit };
  let ready = false;
  Promise.all([sfx.ready, kit.ready]).then(() => {
    ready = true;
  });
  const rand = mulberry(hash(Date.now() % 1e9, 3));

  // ---- volumes: the settings menu's (game/ui.js keeps and saves them, and calls setVolume / emits settings:changed)
  const volumes = { master: 1, sfx: 1, music: 0.8 };
  const initial = game.ui?.settings;
  if (initial) for (const k of Object.keys(volumes)) if (Number.isFinite(initial[k])) volumes[k] = clamp(initial[k]);
  game.on('settings:changed', (e) => {
    if (Object.hasOwn(volumes, e?.key) && Number.isFinite(e.value)) audio.setVolume(e.key, e.value);
  });

  // =================================================================================================================
  // THE GRAPH (built once the city's audio has its context: after the first click or key)
  // =================================================================================================================
  let ctx = null;
  let g = null; // the nodes
  let scheduler = null;
  const cam = () => game.camera.camera.position;

  function build() {
    ctx = as.context;
    const gain = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    g = {};
    g.ambDuck = gain(1);
    g.sfxBus = gain(1);
    g.sfxDuck = gain(1);
    g.hotBus = gain(1);
    g.tinnitus = ctx.createBiquadFilter();
    g.tinnitus.type = 'highshelf';
    g.tinnitus.frequency.value = 2500;
    g.tinnitus.gain.value = 0;
    g.pauseLP = ctx.createBiquadFilter();
    g.pauseLP.type = 'lowpass';
    g.pauseLP.frequency.value = 20000;
    g.pauseLP.Q.value = 0.6;
    g.sfxVol = gain(volumes.sfx);
    g.uiBus = gain(1);
    g.uiVol = gain(volumes.sfx);
    g.radioDuck = gain(1);
    g.stingerBus = gain(1);
    g.intensityBus = gain(1);
    g.musicVol = gain(volumes.music);
    // the city's sounds now come through the game's ambience duck
    as.world.disconnect();
    as.world.connect(g.ambDuck);
    g.ambDuck.connect(g.tinnitus);
    g.sfxBus.connect(g.sfxDuck).connect(g.tinnitus);
    g.hotBus.connect(g.tinnitus);
    g.tinnitus.connect(g.pauseLP).connect(g.sfxVol).connect(as.mix);
    g.uiBus.connect(g.uiVol).connect(as.mix);
    g.radioDuck.connect(g.musicVol);
    g.stingerBus.connect(g.musicVol);
    g.intensityBus.connect(g.musicVol);
    g.musicVol.connect(as.mix);
    g.analyser = ctx.createAnalyser();
    g.analyser.fftSize = 2048;
    as.master.connect(g.analyser);
    g.meterData = new Float32Array(g.analyser.fftSize);
    // the caller's telephone line for dialogue murmurs
    g.phone = ctx.createBiquadFilter();
    g.phone.type = 'bandpass';
    g.phone.frequency.value = 1500;
    g.phone.Q.value = 0.7;
    g.phone.connect(g.uiBus);
    applyVolumes();
    radio.attach(ctx, banks, g.radioDuck);
    scheduler = new Scheduler(ctx, (t0, t1) => {
      radio.schedule(t0, t1);
      intensity.schedule(t0, t1);
    });
    // the sirens & engines of the game's own vehicles join the city's motor pool
    as.sources.worldVehicles = game.vehicles?.list() || null;
    as.sources.sirenPolicy = (record) => record.siren ?? ((game.wanted?.level | 0) > 0);
  }

  function applyVolumes() {
    as.volume = volumes.master;
    if (!g) return;
    const now = ctx.currentTime;
    g.sfxVol.gain.setTargetAtTime(volumes.sfx, now, 0.05);
    g.uiVol.gain.setTargetAtTime(volumes.sfx, now, 0.05);
    g.musicVol.gain.setTargetAtTime(volumes.music, now, 0.05);
  }

  const live = () => g && ctx.state === 'running' && as.enabled && !document.hidden;

  // =================================================================================================================
  // VOICES: one-shots (several layers can share one spatial chain), a priority budget, groups (one source's sounds)
  // =================================================================================================================
  const voices = [];
  const played = {}; // name -> times played (debug)

  function onSourceEnded(e) {
    const src = e.target;
    src.onended = null;
    src.disconnect();
    src._g?.disconnect();
    const rec = src._rec;
    if (rec && --rec.live === 0) {
      rec.done = true;
      for (const n of rec.nodes) n.disconnect();
      rec.nodes.length = 0;
    }
  }

  function stopVoice(rec, fade = 0.05) {
    if (rec.done || rec.stopping) return;
    rec.stopping = true;
    const now = ctx.currentTime;
    rec.out.gain.cancelScheduledValues(now);
    rec.out.gain.setTargetAtTime(0, now, fade / 3);
    for (const src of rec.srcs) {
      try {
        src.stop(now + fade);
      } catch { /* ended */ }
    }
  }

  function admit(prio, group, groupMax) {
    const now = ctx.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].done || voices[i].stopping || voices[i].end < now) voices.splice(i, 1);
    if (group && groupMax) {
      let count = 0, oldest = null;
      for (const v of voices) {
        if (v.group !== group) continue;
        count++;
        if (!oldest || v.born < oldest.born) oldest = v;
      }
      if (count >= groupMax && oldest) stopVoice(oldest, 0.06);
    }
    let live = 0, victim = null;
    for (const v of voices) {
      if (v.stopping) continue;
      live++;
      if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.born < victim.born)) victim = v;
    }
    if (live < MAX_VOICES) return true;
    if (!victim || victim.prio > prio) return false;
    stopVoice(victim, 0.03);
    return true;
  }

  /**
   * Plays layers [[name, gain, offset s, rate, variant?]] as one voice. o: { x, y, z (positional), gain, rate, delay, prio,
   * group, groupMax, bus, sound (true: start later by distance / speed of sound), obstruct, send, maxDistance, cutoff }
   */
  function voice(layers, o) {
    if (!live()) return false;
    const first = SOUNDS[layers[0][0]] || SOUNDS.click;
    const positional = o.x !== undefined && first.bus !== 'ui' && first.bus !== 'stinger';
    const c = cam();
    let distance = 0;
    if (positional) {
      distance = Math.hypot(o.x - c.x, (o.y ?? c.y) - c.y, o.z - c.z);
      if (distance > (o.maxDistance ?? first.max)) return false;
    }
    const prio = o.prio ?? first.prio;
    const group = o.group || 0;
    if (!admit(prio, group, o.groupMax || 0)) return false;
    const now = ctx.currentTime;
    const start = now + (o.delay || 0) + (o.sound && positional ? Math.min(1.6, distance / SPEED_OF_SOUND) : 0);
    const bus = o.bus || first.bus;
    const dest = bus === 'hot' ? g.hotBus : bus === 'ui' ? g.uiBus : bus === 'stinger' ? g.stingerBus : bus === 'phone' ? g.phone : g.sfxBus;
    const out = ctx.createGain();
    const rec = { srcs: [], nodes: [out], out, end: start, prio, group, born: now, live: 0, done: false, stopping: false };
    let level = o.gain ?? 1;
    if (positional) {
      const y = o.y ?? c.y;
      const obstruction = o.obstruct === false || distance < 4 ? 0 : as.acoustics.obstruction({ x: o.x, y, z: o.z }, as.listener, 0);
      level *= 1 - obstruction * 0.55;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.value = Math.min(o.cutoff ?? 20000, (1800 + 15000 * Math.exp(-distance / 75)) * Math.pow(0.08, obstruction));
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? first.ref;
      panner.rolloffFactor = 1;
      panner.maxDistance = 10000;
      panner.positionX.value = o.x;
      panner.positionY.value = y;
      panner.positionZ.value = o.z;
      out.connect(lp).connect(panner).connect(dest);
      rec.nodes.push(lp, panner);
      if (o.send !== 0 && as.reflections) {
        // the street's reflections: more for distant and loud sounds
        const send = ctx.createGain();
        send.gain.value = (o.send ?? 1) * (0.6 + Math.min(2, distance / 60));
        panner.connect(send).connect(as.reflections);
        rec.nodes.push(send);
      }
    } else out.connect(dest);
    out.gain.value = level;
    for (const [name, layerGain, offset = 0, layerRate = 1, variant = rand] of layers) {
      const s = SOUNDS[name] || first;
      const buffer = sfx.get(name, variant);
      if (!buffer) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const rate = (o.rate ?? 1) * layerRate;
      src.playbackRate.value = rate;
      const lg = ctx.createGain();
      lg.gain.value = s.gain * layerGain;
      src.connect(lg).connect(out);
      src._g = lg;
      src._rec = rec;
      src.onended = onSourceEnded;
      const at = start + offset;
      src.start(at);
      rec.end = Math.max(rec.end, at + buffer.duration / rate);
      rec.srcs.push(src);
      rec.live++;
      played[name] = (played[name] || 0) + 1;
    }
    if (!rec.live) {
      out.disconnect();
      return false;
    }
    voices.push(rec);
    return rec;
  }

  const one = [['', 1, 0, 1]];
  function play(name, o = {}) {
    if (!SOUNDS[name]) return false;
    one[0][0] = name;
    one[0][1] = 1;
    return !!voice(one, o);
  }

  // =================================================================================================================
  // DUCKING: requests (depth, until) per target; the deepest live one wins
  // =================================================================================================================
  const DUCK_TARGETS = ['amb', 'sfx', 'radio'];
  const duckReq = Array.from({ length: 24 }, () => ({ target: '', depth: 0, until: 0 }));
  const duckLevel = { amb: 1, sfx: 1, radio: 1 };
  function duckOn(target, depth, seconds, attack = 0.015) {
    if (!g || depth <= 0) return;
    const now = ctx.currentTime;
    let slot = duckReq[0];
    for (const r of duckReq) if (r.until < slot.until) slot = r;
    slot.target = target;
    slot.depth = clamp(depth);
    slot.until = now + seconds;
    const want = 1 - slot.depth;
    if (want < duckLevel[target]) {
      duckLevel[target] = want;
      duckNode(target).gain.setTargetAtTime(want * pauseFactor(target), now, attack);
    }
  }
  const duckNode = (t) => (t === 'amb' ? g.ambDuck : t === 'sfx' ? g.sfxDuck : g.radioDuck);
  const pauseFactor = (t) => (t === 'radio' && paused ? 0.3 : 1);
  function updateDucks() {
    const now = ctx.currentTime;
    for (const t of DUCK_TARGETS) {
      let deepest = 0;
      for (const r of duckReq) if (r.target === t && r.until > now) deepest = Math.max(deepest, r.depth);
      const want = 1 - deepest;
      const prev = duckLevel[t];
      if (Math.abs(want - prev) > 0.01 || forceDuck) {
        duckLevel[t] = want;
        // (dips are quick, recoveries slow)
        duckNode(t).gain.setTargetAtTime(want * pauseFactor(t), now, want > prev ? 0.3 : 0.08);
      }
    }
    forceDuck = false;
  }
  let forceDuck = false;
  let paused = false;

  // =================================================================================================================
  // LOOPS: pooled positional loops (car alarms) that follow their sources
  // =================================================================================================================
  class LoopPool {
    constructor(name, limit) {
      this.name = name;
      this.limit = limit;
      this.slots = [];
      this.cand = Array.from({ length: 8 }, () => ({ id: null, x: 0, y: 0, z: 0, level: 0, d: 0 }));
      this.count = 0;
    }

    begin() {
      this.count = 0;
    }

    offer(id, x, y, z, level) {
      const c = cam();
      const d = Math.hypot(x - c.x, y - c.y, z - c.z);
      if (d > LOOPS[this.name][2]) return;
      // keep the nearest `cand.length`
      let i = this.count;
      if (i >= this.cand.length) {
        if (d >= this.cand[i - 1].d) return;
        i--;
      } else this.count++;
      const item = this.cand[i];
      while (i > 0 && this.cand[i - 1].d > d) {
        this.cand[i] = this.cand[i - 1];
        i--;
      }
      this.cand[i] = item;
      item.id = id;
      item.x = x;
      item.y = y;
      item.z = z;
      item.level = level;
      item.d = d;
    }

    end() {
      const now = ctx.currentTime;
      for (const s of this.slots) s.keep = false;
      for (let i = 0; i < Math.min(this.count, this.limit); i++) {
        const c = this.cand[i];
        let s = null;
        for (const q of this.slots) if (q.id === c.id && !q.retiring) s = q;
        if (!s) {
          if (this.slots.length >= this.limit + 1) continue;
          s = this.create(c.id);
        }
        s.keep = true;
        s.panner.positionX.setTargetAtTime(c.x, now, 0.05);
        s.panner.positionY.setTargetAtTime(c.y, now, 0.05);
        s.panner.positionZ.setTargetAtTime(c.z, now, 0.05);
        s.lp.frequency.setTargetAtTime(1800 + 15000 * Math.exp(-c.d / 75), now, 0.2);
        s.gain.gain.setTargetAtTime(LOOPS[this.name][0] * c.level, now, 0.15);
      }
      for (let i = this.slots.length - 1; i >= 0; i--) {
        const s = this.slots[i];
        if (s.keep) continue;
        if (!s.retiring) {
          s.retiring = now + 0.5;
          s.gain.gain.setTargetAtTime(0, now, 0.12);
        } else if (now >= s.retiring) {
          s.src.stop();
          for (const n of [s.src, s.gain, s.lp, s.panner]) n.disconnect();
          this.slots.splice(i, 1);
        }
      }
    }

    create(id) {
      const src = ctx.createBufferSource();
      src.buffer = sfx.get(this.name, 0);
      src.loop = true;
      src.playbackRate.value = 0.95 + Math.random() * 0.1;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = LOOPS[this.name][1];
      panner.maxDistance = 10000;
      src.connect(gain).connect(lp).connect(panner).connect(g.sfxBus);
      src.start(ctx.currentTime, Math.random() * src.buffer.duration);
      const s = { id, src, gain, lp, panner, keep: true, retiring: 0 };
      this.slots.push(s);
      return s;
    }

    clear() {
      for (const s of this.slots) {
        try {
          s.src.stop();
        } catch { /* */ }
        for (const n of [s.src, s.gain, s.lp, s.panner]) n.disconnect();
      }
      this.slots.length = 0;
    }
  }
  const alarms = new LoopPool('alarm-loop', 2);
  const alarmCars = []; // { vehicle, until }
  const alarmed = new WeakSet();
  const drivenByPlayer = new WeakSet();

  function startAlarm(v, seconds = 14) {
    if (!v || alarmed.has(v)) return;
    alarmed.add(v);
    alarmCars.push({ vehicle: v, until: game.realTime + seconds });
  }

  // =================================================================================================================
  // THE PLAYER'S TYRES: a squeal from sideways slip, a scrub (with ABS pulsing) from hard braking
  // =================================================================================================================
  const tyres = { squeal: null, skid: null, abs: null, quietFor: 0 };
  function tyreLoop(name) {
    const src = ctx.createBufferSource();
    src.buffer = sfx.get(name, 0);
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(g.sfxBus);
    src.start();
    return { src, gain, rate: src.playbackRate };
  }
  function updateTyres(dt) {
    const v = game.player?.vehicle;
    let squeal = 0, skid = 0, pitch = 1;
    if (v && v.mode === 'car' && game.state === 'playing' && !v.hidden) {
      const e = v.entity;
      const speed = Math.abs(e.speed || 0);
      const slip = Math.hypot(e.vx || 0, e.vz || 0);
      squeal = clamp((slip - 2) / 5) * clamp(speed / 5);
      pitch = 0.9 + clamp(slip / 14) * 0.25;
      const braking = e.carState?.value?.x > 0.5;
      if (braking && speed > 6) skid = clamp((speed - 6) / 16) * 0.85;
      const c = cam();
      const near = clamp(14 / Math.max(14, Math.hypot(v.x - c.x, v.z - c.z)));
      squeal *= near;
      skid *= near;
    }
    const now = ctx.currentTime;
    if (squeal > 0.02 || skid > 0.02) {
      tyres.quietFor = 0;
      if (!tyres.squeal) {
        tyres.squeal = tyreLoop('tyre-loop');
        tyres.skid = tyreLoop('skid-loop');
        // ABS: the brakes pulse the scrub ~14 times a second
        tyres.abs = ctx.createOscillator();
        tyres.abs.type = 'square';
        tyres.abs.frequency.value = 14;
        tyres.absDepth = ctx.createGain();
        tyres.absDepth.gain.value = 0;
        tyres.abs.connect(tyres.absDepth).connect(tyres.skid.gain.gain);
        tyres.abs.start();
      }
    } else if (tyres.squeal && (tyres.quietFor += dt) > 0.8) {
      for (const t of [tyres.squeal, tyres.skid]) {
        t.src.stop();
        t.src.disconnect();
        t.gain.disconnect();
      }
      tyres.abs.stop();
      tyres.abs.disconnect();
      tyres.absDepth.disconnect();
      tyres.squeal = tyres.skid = tyres.abs = null;
      return;
    }
    if (!tyres.squeal) return;
    tyres.squeal.gain.gain.setTargetAtTime(LOOPS['tyre-loop'][0] * squeal, now, 0.06);
    tyres.squeal.rate.setTargetAtTime(pitch, now, 0.1);
    tyres.skid.gain.gain.setTargetAtTime(LOOPS['skid-loop'][0] * skid * 0.6, now, 0.05);
    tyres.absDepth.gain.setTargetAtTime(LOOPS['skid-loop'][0] * skid * 0.4, now, 0.05);
  }

  // =================================================================================================================
  // THE POLICE HELICOPTER: the city's rotor voice, at a police unit of kind 'heli'
  // =================================================================================================================
  const heli = { voice: null, panner: null, input: null, x: 0, y: 0, z: 0, d: 0, lost: 0 };
  const motorParams = { speed: 0, load: 0.6, doppler: 1, seed: 0.37, verticalSpeed: 0 };
  function updateHeli(dt) {
    const units = game.police?.units?.();
    let best = null, bestD = 600;
    const c = cam();
    if (units) {
      for (const u of units) {
        if (u.kind !== 'heli' || !Number.isFinite(u.x)) continue;
        const y = Number.isFinite(u.y) ? u.y : (u.vehicle?.y ?? game.world.groundHeight(u.x, u.z) + 55);
        const d = Math.hypot(u.x - c.x, y - c.y, u.z - c.z);
        if (d < bestD) {
          bestD = d;
          best = u;
          heli.ty = y;
        }
      }
    }
    // (a unit with a real vehicle the player can see is the city's helicopter: its rotor is already sounding)
    if (best && best.vehicle && best.vehicle.mode === 'helicopter' && !best.vehicle.record) best = null;
    const now = ctx.currentTime;
    if (!best) {
      if (heli.voice && (heli.lost += dt) > 2) {
        heli.voice.dispose();
        heli.input.disconnect();
        heli.panner.disconnect();
        heli.voice = null;
      }
      return;
    }
    heli.lost = 0;
    if (!heli.voice) {
      heli.input = ctx.createGain();
      heli.input.gain.value = 0.55;
      heli.panner = ctx.createPanner();
      heli.panner.panningModel = 'equalpower';
      heli.panner.distanceModel = 'inverse';
      heli.panner.refDistance = 14;
      heli.panner.maxDistance = 10000;
      heli.input.connect(heli.panner).connect(g.sfxBus);
      heli.voice = createMotorVoice(ctx, as.resources, 'helicopter', heli.input);
      heli.d = bestD;
    }
    const radial = clamp((bestD - heli.d) / Math.max(0.05, dt), -60, 60);
    heli.d = bestD;
    heli.panner.positionX.setTargetAtTime(best.x, now, 0.1);
    heli.panner.positionY.setTargetAtTime(heli.ty, now, 0.1);
    heli.panner.positionZ.setTargetAtTime(best.z, now, 0.1);
    motorParams.speed = Math.hypot(best.vehicle?.vx || 0, best.vehicle?.vz || 0) || 20;
    motorParams.doppler = clamp(343 / (343 + radial), 0.85, 1.18);
    heli.voice.update(motorParams, now);
  }

  // =================================================================================================================
  // INTENSITY: a tense drone and pulse under a chase, when the radio is not playing
  // =================================================================================================================
  const INTENSITY = {
    id: 'intensity', seed: 5, level: 1, reverb: 0.3,
    setup(e) {
      const ctx2 = e.ctx;
      e.drone = [];
      const lp = e.filter('lowpass', 190, 3);
      const lfo = ctx2.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoDepth = e.gain(70);
      lfo.connect(lfoDepth).connect(lp.frequency);
      lfo.start();
      e.drone.push(lfo);
      for (const det of [-9, 7]) {
        const o = ctx2.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 55 * 1.122; // (D-ish)
        o.detune.value = det;
        o.connect(lp);
        o.start();
        e.drone.push(o);
      }
      e.droneGain = e.gain(0.09);
      lp.connect(e.droneGain).connect(e.music);
      e.level = 0;
      e.next = 0;
      e.beat = 0;
    },
    schedule(e, t0, t1) {
      if (e.level <= 0) return;
      const bpm = 84 + e.level * 9 * (e.evading ? 0.8 : 1);
      const beat = 60 / bpm;
      if (e.next < t0) e.next = t0 + 0.01;
      while (e.next < t1) {
        const when = e.next;
        const b = e.beat++;
        // the heartbeat: a pair of soft thumps
        if (b % 2 === 0) {
          e.hit('kick-dub', when, 0.32 + e.level * 0.05, 0.9);
          e.hit('kick-dub', when + beat * 0.32, 0.18 + e.level * 0.03, 0.85);
        }
        if (e.level >= 2 && !e.evading) e.hit('hat', when + beat * 0.5, 0.05 + e.level * 0.01, 0.8);
        if (e.level >= 3 && b % 8 === 7) e.hit('tom', when, 0.2, 0.6, e.drums, 0.4);
        if (e.level >= 4 && b % 16 === 0) {
          e.note(e.music, when, beat * 15, 293.7, { wave: 'sawtooth', voices: 2, detune: 14, gain: 0.025, lp: 1500, a: 2, d: 2, s: 0.9, r: 1.5, vib: [7, 25], send: 0.6 });
        }
        e.next += beat;
      }
    }
  };
  const INTENSITY_LEVELS = [0, 0.4, 0.55, 0.7, 0.85, 1];
  const intensity = {
    engine: null,
    target: 0,
    quiet: 0,
    schedule(t0, t1) {
      if (this.engine) this.engine.schedule(t0, t1, 0);
    },
    update(dt) {
      const level = game.wanted?.level | 0;
      const wantOn = level > 0 && !radio.on && game.state !== 'dead';
      const target = wantOn ? INTENSITY_LEVELS[Math.min(5, level)] : 0;
      if (target > 0 && !this.engine) {
        this.engine = createStation(INTENSITY, ctx, banks, g.intensityBus, { reverb: g.intensityBus });
        this.engine.bus.gain.value = 0;
      }
      if (!this.engine) return;
      const e = this.engine;
      e.level = wantOn ? level : 0;
      e.evading = !!game.wanted?.evading;
      if (target !== this.target) {
        this.target = target;
        e.bus.gain.setTargetAtTime(target * (paused ? 0.3 : 1), ctx.currentTime, target > 0 ? 1.2 : 0.8);
      }
      if (target === 0 && (this.quiet += dt) > 4) {
        e.stop(ctx.currentTime);
        for (const o of e.drone) {
          o.stop();
          o.disconnect();
        }
        const old = e;
        setTimeout(() => old.dispose(), 500);
        this.engine = null;
        this.quiet = 0;
      } else if (target > 0) this.quiet = 0;
    }
  };

  const radio = createRadio(game, { play: (name, o) => play(name, o) });

  // =================================================================================================================
  // EVENTS
  // =================================================================================================================
  game.on('weapon:switch', () => {
    const p = game.player?.position;
    if (p) play('switch', { x: p.x, y: p.y + 1.2, z: p.z });
  });
  game.on('weapon:pickup', () => {
    const p = game.player?.position;
    if (p) play('switch', { x: p.x, y: p.y + 1.2, z: p.z, delay: 0.05 });
    play('pickup');
  });
  let lastHitMarker = 0;
  game.on('combat:hitmarker', (e) => {
    if (!live() || ctx.currentTime - lastHitMarker < 0.05) return;
    lastHitMarker = ctx.currentTime;
    play(e.kind === 'kill' ? 'hit-kill' : 'hit');
  });
  game.on('melee:swing', (e) => {
    if (!live()) return;
    const x = e.x ?? game.player.position.x, y = e.y ?? game.player.position.y + 1.2, z = e.z ?? game.player.position.z;
    play('whoosh', { x, y, z, rate: 0.9 + rand() * 0.25 });
    if (e.hit) play((e.weaponId || game.weapons?.currentId) === 'bat' ? 'bat' : 'punch', { x, y, z, delay: 0.06, rate: 0.9 + rand() * 0.2 });
  });

  // ---- people ------------------------------------------------------------------------------------------------
  let screamTokens = 3, lastScream = 0, lastPain = 0;
  const voiceOf = (id) => (Math.imul(id + 7, 2654435761) >>> 0);
  function shoutAt(kind, id, x, y, z, delay = 0) {
    const now = ctx.currentTime;
    if (kind === 'scream') {
      if (screamTokens < 1 || now - lastScream < 0.35) return;
      screamTokens--;
      lastScream = now;
    } else if (now - lastPain < 0.12) return;
    else lastPain = now;
    const h = voiceOf(id);
    // a person keeps their voice: the variant (sex, pitch) from their id, a little wobble per cry
    const variant = h % SFX_RECIPES[kind].variants;
    voice([[kind, 1, 0, (0.92 + ((h >>> 8) % 100) / 100 * 0.16) * (0.97 + rand() * 0.06), variant]], { x, y: y + 1.5, z, delay, prio: 4 });
  }
  game.on('ped:hit', (e) => {
    if (!live()) return;
    if (e.kind === 'melee' || e.kind === 'vehicle') play('punch', { x: e.x, y: e.y + 1, z: e.z, rate: 0.8 });
    if (e.health > 0) shoutAt(rand() < 0.6 ? 'pain' : 'scream', e.ped?.id ?? 0, e.x, e.y, e.z, 0.04);
  });
  game.on('ped:killed', (e) => {
    if (!live()) return;
    shoutAt('pain', e.ped?.id ?? 0, e.x, e.y, e.z, 0.02);
  });
  const nearPeds = [];
  let fleeing = null;
  function updatePanic() {
    const peds = game.world.peds;
    if (!fleeing || fleeing.length !== peds.length) fleeing = new Uint8Array(peds.length);
    const c = cam();
    game.world.nearbyPeds(c.x, c.z, 50, nearPeds);
    for (const p of nearPeds) {
      const was = fleeing[p.id];
      fleeing[p.id] = p.fleeing ? 1 : 0;
      if (p.fleeing && !was && rand() < 0.4) shoutAt(rand() < 0.75 ? 'scream' : 'shout', p.id, p.x, p.y, p.z, rand() * 0.3);
    }
    for (const p of peds) if (!p.active || !p.fleeing) fleeing[p.id] = 0;
  }

  // ---- vehicles ----------------------------------------------------------------------------------------------
  game.on('vehicle:entered', (e) => {
    const v = e.vehicle;
    if (!live() || !v) return;
    const { x, y, z } = v;
    if (v.mode === 'car') {
      play('door-open', { x, y: y + 1, z });
      play('door-close', { x, y: y + 1, z, delay: 0.42 });
      play('engine-start', { x, y: y + 0.8, z, delay: 0.55, rate: 0.95 + rand() * 0.1 });
      if (e.carjacked) shoutAt('shout', e.victim >= 0 ? e.victim : 9999, x, y, z, 0.1);
      // some parked cars are alarmed
      if (!e.carjacked && !v.hero && !drivenByPlayer.has(v) && v.id % 3 === 0) startAlarm(v, 12);
    } else if (v.mode === 'helicopter') play('door-close', { x, y: y + 1, z, delay: 0.2 });
    drivenByPlayer.add(v);
  });
  game.on('vehicle:exited', (e) => {
    const v = e.vehicle;
    if (!live() || !v) return;
    if (e.bailed) play('bail', { x: e.x, y: game.player.position.y + 0.4, z: e.z });
    else if (v.mode !== 'cyclist' && v.mode !== 'scooter') {
      play('door-open', { x: v.x, y: v.y + 1, z: v.z });
      play('door-close', { x: v.x, y: v.y + 1, z: v.z, delay: 0.5 });
    }
  });
  game.on('vehicle:hit', (e) => {
    if (!live()) return;
    // (a cricket bat on the bodywork: a dull metal knock, and sometimes the glass)
    if (e.kind === 'melee') play(rand() < 0.2 ? 'impact-glass' : 'impact-metal', { x: e.x, y: e.y, z: e.z, gain: 0.7, rate: 0.7 });
    const t = e.target;
    if (t && t.type === 'world' && !t.driver && !t.hero && t.mode === 'car' && t.state !== 'wrecked' && !drivenByPlayer.has(t)
      && (e.kind === 'melee' || e.kind === 'collision')) startAlarm(t, 14);
  });
  game.on('vehicle:state', (e) => {
    if (!live()) return;
    const t = e.target;
    const x = t.x, y = (t.y ?? 0) + 1, z = t.z;
    if (e.state === 'smoking') play('hiss', { x, y, z });
    // wrecked: the engine dies with a cough and a bang from the bonnet, then the radiator lets go
    else if (e.state === 'wrecked') {
      play('backfire', { x, y, z, rate: 0.8 });
      play('hiss', { x, y, z, delay: 0.25, rate: 0.85 });
    }
  });

  // ---- money, pickups, missions, wanted, death ------------------------------------------------------------------
  let lastPickupCash = -1;
  game.on('pickup:collected', (e) => {
    const k = String(e.kind || '');
    if (/money|cash|wallet/.test(k)) {
      play('cash');
      lastPickupCash = game.realTime;
    } else if (/health|heal|food/.test(k)) play('pickup-health');
    else if (/armou?r/.test(k)) play('pickup-armor');
    else if (k === 'weapon') return; // (the bat: weapon:pickup has rung it)
    else play('pickup');
  });
  let shopOpen = false;
  game.on('shop:opened', () => (shopOpen = true));
  game.on('shop:closed', () => (shopOpen = false));
  game.on('money:changed', (e) => {
    // (a cash pickup rings its own register)
    if (!live() || e.reason === 'pickup' || game.realTime - lastPickupCash < 0.4) return;
    if (e.delta > 0) {
      const n = Math.min(6, 1 + Math.floor(Math.log10(Math.max(1, e.delta))));
      for (let i = 0; i < n; i++) play('coin', { delay: i * 0.055, rate: 0.95 + i * 0.03 });
    } else if (e.delta < 0 && (shopOpen || /shop|buy|purchase|respray|armour|bat|food|property|bribe/i.test(String(e.reason || '')))) play('cash');
  });
  game.on('mission:started', () => {
    play('mission-start');
    duckOn('radio', 0.55, 2.4);
  });
  game.on('mission:passed', () => {
    play('mission-passed');
    duckOn('radio', 0.85, 3.6);
    duckOn('amb', 0.4, 3);
  });
  game.on('mission:failed', () => {
    play('mission-failed');
    duckOn('radio', 0.75, 3);
  });
  let lastWantedUp = -10;
  game.on('wanted:changed', (e) => {
    if (e.level > e.prev && game.realTime - lastWantedUp > 1.2) {
      lastWantedUp = game.realTime;
      play('wanted-up');
      duckOn('radio', 0.3, 1);
    } else if (e.level < e.prev && e.level > 0) play('wanted-down');
  });
  game.on('wanted:cleared', () => play('wanted-cleared'));
  game.on('player:died', () => {
    play('wasted');
    duckOn('amb', 0.6, 4);
    duckOn('sfx', 0.3, 3);
  });
  game.on('player:busted', () => {
    play('busted');
    duckOn('amb', 0.5, 3);
  });
  game.on('player:damaged', (e) => {
    if (!live() || e.amount <= 0) return;
    const p = game.player.position;
    if (e.kind === 'melee') play('punch', { x: p.x, y: p.y + 1.2, z: p.z, gain: e.armorDamage > 0 ? 0.6 : 1, rate: 0.85 });
    if ((e.kind === 'melee' || e.kind === 'vehicle') && e.amount >= 4) shoutAt('pain', 4242, p.x, p.y, p.z);
  });

  // ---- police: the megaphone when they spot you, the scanner while wanted ------------------------------------------
  let lastBark = -10;
  game.on('police:spotted', () => {
    if (!live() || game.realTime - lastBark < 5) return;
    const c = cam();
    let best = null, bestD = 140;
    for (const u of game.police?.units?.() || []) {
      if (!Number.isFinite(u.x) || u.kind === 'heli') continue;
      const d = Math.hypot(u.x - c.x, u.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    if (!best) return;
    lastBark = game.realTime;
    play('megaphone', { x: best.x, y: game.world.groundHeight(best.x, best.z) + 1.6, z: best.z, rate: 0.95 + rand() * 0.1 });
  });
  let nextChatter = 4;
  function updateScanner(dt) {
    const level = game.wanted?.level | 0;
    if (level <= 0 || (radio.on && radio.current?.id === POLICE_BAND.id)) return;
    if ((nextChatter -= dt) > 0) return;
    nextChatter = 5 + rand() * (12 - level);
    play('chatter', { gain: 0.8 + level * 0.1 });
  }
  game.on('police:dispatch', () => {
    if ((game.wanted?.level | 0) > 0 && nextChatter > 1.5) nextChatter = 0.6;
  });

  // ---- dialogue: the radio dips, and a murmur on the line ------------------------------------------------------
  game.on('dialogue', (e) => {
    const seconds = clamp(Number(e.seconds) || 3, 1, 12);
    duckOn('radio', 0.6, seconds + 0.4, 0.15);
    duckOn('amb', 0.25, seconds);
    if (!live()) return;
    const h = hash(...Array.from(String(e.who || 'x'), (ch) => ch.charCodeAt(0)));
    const bank = ['syl-hostA', 'syl-callerA', 'syl-hostB', 'syl-callerB'][h % 4];
    const r = mulberry(h ^ (Date.now() & 0xffff));
    const count = Math.min(26, Math.round(Math.min(seconds, 5) * 4.8));
    let t = 0.05;
    for (let i = 0; i < count; i++) {
      voiceSyllable(bank, Math.floor(r() * 14), t, (1.04 - 0.1 * (i % 9) / 9) * (0.97 + r() * 0.06));
      t += 0.17 + r() * 0.07 + (i % 9 === 8 ? 0.35 : 0);
    }
  });
  function voiceSyllable(bank, variant, delay, rate) {
    const buffer = sfx.get(bank, variant);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const lg = ctx.createGain();
    lg.gain.value = 0.2;
    src.connect(lg).connect(g.phone);
    src._g = lg;
    src.onended = onSourceEnded;
    src.start(ctx.currentTime + delay);
  }

  // ---- UI and pause ------------------------------------------------------------------------------------------
  for (const [type, name] of [['ui:move', 'ui-move'], ['ui:select', 'ui-select'], ['ui:back', 'ui-back']]) game.on(type, () => play(name));
  game.on('ui:navigate', (e) => play(`ui-${e?.action || 'move'}`));
  game.on('state', ({ state, prev }) => {
    if (!g) return;
    const now = ctx.currentTime;
    paused = state === 'paused';
    if (paused) play('ui-pause');
    const cutoff = paused ? 650 : state === 'dead' ? 1400 : 20000;
    g.pauseLP.frequency.setTargetAtTime(cutoff, now, paused ? 0.06 : 0.25);
    forceDuck = true;
    if (intensity.engine) intensity.engine.bus.gain.setTargetAtTime(intensity.target * (paused ? 0.3 : 1), now, 0.2);
    void prev;
  });

  // =================================================================================================================
  // EVERY FRAME
  // =================================================================================================================
  let slow = 0, heliTick = 0;
  const playerCarSmoke = { next: 0 };
  function update(dt, time, realDt) {
    if (!g) {
      if (as.context && as.resources) build();
      else return;
    }
    radio.update(realDt);
    if (!live()) return;
    scheduler.tick();
    updateDucks();
    updateTyres(realDt);
    intensity.update(realDt);
    slow += realDt;
    if (slow < 0.1) return; // (10 Hz from here)
    const step = slow;
    slow = 0;
    screamTokens = Math.min(3, screamTokens + step * 0.7);
    updatePanic();
    updateScanner(step);
    if (++heliTick % 3 === 0) updateHeli(step * 3);
    // car alarms
    alarms.begin();
    for (let i = alarmCars.length - 1; i >= 0; i--) {
      const a = alarmCars[i];
      const v = a.vehicle;
      if (game.realTime > a.until || v.hidden || v.state === 'wrecked') {
        alarmCars.splice(i, 1);
        continue;
      }
      alarms.offer(v, v.x, v.y + 1, v.z, 1);
    }
    alarms.end();
    // a damaged car of the player's pops and bangs
    const pv = game.player?.vehicle;
    if (pv && pv.mode === 'car' && pv.state === 'smoking' && time > playerCarSmoke.next) {
      playerCarSmoke.next = time + 1 + rand() * 3.5;
      if (Math.abs(pv.speed) > 2 || rand() < 0.3) play('backfire', { x: pv.x - Math.sin(pv.heading) * pv.halfL, y: pv.y + 0.4, z: pv.z - Math.cos(pv.heading) * pv.halfL });
    }
  }

  // =================================================================================================================
  // SELF-TEST: every one-shot measured from its buffer, every station rendered offline for a few seconds through the
  // radio's own chain: peak, RMS, silence, clipping, onsets, spectral balance
  // =================================================================================================================
  async function selfTest({ seconds = 6, log = true } = {}) {
    await Promise.all([sfx.ready, kit.ready]);
    const problems = [];
    const sfxRows = [];
    const bands = (d, sr) => {
      const k1 = 1 - Math.exp(-2 * Math.PI * 150 / sr), k2 = 1 - Math.exp(-2 * Math.PI * 2000 / sr);
      let lo = 0, mid = 0, hi = 0, l1 = 0, l2 = 0;
      for (let i = 0; i < d.length; i++) {
        l1 += (d[i] - l1) * k1;
        l2 += (d[i] - l2) * k2;
        lo += l1 * l1;
        mid += (l2 - l1) ** 2;
        hi += (d[i] - l2) ** 2;
      }
      const t = lo + mid + hi || 1;
      return [lo / t, mid / t, hi / t];
    };
    const EXPECT = { // name prefix -> [band index, minimum share]
      'impact-metal': [2, 0.3], 'impact-glass': [2, 0.5], 'hiss': [2, 0.6], 'scream': [1, 0.5], 'chatter': [1, 0.5], 'punch': [0, 0.5]
    };
    for (const name of Object.keys(SFX_RECIPES)) {
      const n = SFX_RECIPES[name].variants || 1;
      for (let v = 0; v < n; v++) {
        const b = sfx.get(name, v);
        const d = b.getChannelData(0);
        let peak = 0, e = 0, bad = 0;
        for (let i = 0; i < d.length; i++) {
          const x = d[i];
          if (!Number.isFinite(x)) bad++;
          const ax = Math.abs(x);
          if (ax > peak) peak = ax;
          e += x * x;
        }
        const rms = 10 * Math.log10(e / d.length + 1e-12);
        const [lo, mid, hi] = bands(d, b.sampleRate);
        if (bad) problems.push(`${name}#${v}: ${bad} NaN`);
        if (peak >= 1) problems.push(`${name}#${v}: peak ${peak.toFixed(3)}`);
        if (rms < -45) problems.push(`${name}#${v}: silent (${rms.toFixed(1)} dB)`);
        const ex = Object.entries(EXPECT).find(([p]) => name.startsWith(p));
        if (ex && [lo, mid, hi][ex[1][0]] < ex[1][1]) problems.push(`${name}#${v}: spectrum lo/mid/hi ${lo.toFixed(2)}/${mid.toFixed(2)}/${hi.toFixed(2)}`);
        if (v === 0) sfxRows.push({ name, variants: n, seconds: +b.duration.toFixed(2), rate: b.sampleRate, peak: +peak.toFixed(3), rmsDb: +rms.toFixed(1), 'lo/mid/hi': `${lo.toFixed(2)}/${mid.toFixed(2)}/${hi.toFixed(2)}` });
      }
    }
    const stationRows = [];
    const sr = 48000;
    for (const st of [...STATIONS, POLICE_BAND]) {
      const off = new OfflineAudioContext(2, Math.round(sr * seconds), sr);
      const chain = createRadioChain(off, off.destination, null);
      const engine = createStation(st, off, banks, chain.input, chain.fx);
      // a busy stretch: a chorus or a drop of some song
      let offset = 1234 * (st.slot || 60) + 20;
      if (!st.schedule) {
        const slot = 1234;
        const song = engine.songFor(slot);
        const sec = song.sections.find((s) => s.type === 'chorus' || s.type === 'drop') || song.sections[1];
        offset = slot * st.slot + song.lead + sec.start * 16 * song.stepDur - 0.25;
      }
      // schedule as the live radio does, a little ahead of the clock (all at once would keep thousands of idle
      // nodes in the graph and measure nothing real); the render time over the audio's length is the CPU share
      const chunk = 0.25;
      engine.schedule(0, chunk * 2, offset);
      for (let t = chunk; t < seconds; t += chunk) {
        off.suspend(t).then(() => {
          engine.schedule(t + chunk, t + chunk * 2, offset);
          off.resume();
        });
      }
      const t0 = performance.now();
      const buffer = await off.startRendering();
      const ms = performance.now() - t0;
      const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
      let peak = 0, e = 0, clips = 0, bad = 0;
      const frame = 1024;
      let onsets = 0, prevE = 0;
      for (let i = 0; i < L.length; i += frame) {
        let fe = 0;
        for (let j = i; j < Math.min(L.length, i + frame); j++) {
          const x = L[j], y = R[j];
          if (!Number.isFinite(x) || !Number.isFinite(y)) bad++;
          const a = Math.max(Math.abs(x), Math.abs(y));
          if (a > peak) peak = a;
          if (a > 0.999) clips++;
          fe += x * x + y * y;
        }
        if (fe > prevE * 2 && fe > frame * 2e-4) onsets++;
        prevE = fe;
        e += fe;
      }
      const rms = 10 * Math.log10(e / (2 * L.length) + 1e-12);
      const mono = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
      const [lo, mid, hi] = bands(mono, sr);
      if (bad) problems.push(`${st.id}: ${bad} NaN`);
      if (peak >= 1) problems.push(`${st.id}: peak ${peak.toFixed(3)} (${clips} clipped)`);
      if (rms < -40) problems.push(`${st.id}: near silent (${rms.toFixed(1)} dB)`);
      if (rms > -8) problems.push(`${st.id}: too hot (${rms.toFixed(1)} dB)`);
      if (!st.talk && !st.police && onsets < seconds) problems.push(`${st.id}: few onsets (${onsets})`);
      stationRows.push({ station: st.id, name: st.name, peak: +peak.toFixed(3), rmsDb: +rms.toFixed(1), onsets, 'lo/mid/hi': `${lo.toFixed(2)}/${mid.toFixed(2)}/${hi.toFixed(2)}`, renderMs: Math.round(ms), cpu: +(ms / 1000 / seconds).toFixed(3), voicesLeft: engine.voices.active.size });
      engine.dispose();
      chain.dispose();
    }
    const report = { ok: problems.length === 0, problems, sfx: sfxRows, stations: stationRows, bankMs: Math.round(sfx.renderMs + kit.renderMs) };
    if (log) {
      console.log(`[audio] self-test ${report.ok ? 'OK' : 'PROBLEMS'}; bank rendered in ${report.bankMs} ms`);
      console.table(sfxRows);
      console.table(stationRows);
      if (problems.length) console.warn('[audio] problems:', problems);
    }
    return report;
  }

  function meter() {
    if (!g) return { peak: 0, rms: 0, running: false };
    g.analyser.getFloatTimeDomainData(g.meterData);
    let peak = 0, e = 0;
    for (const x of g.meterData) {
      peak = Math.max(peak, Math.abs(x));
      e += x * x;
    }
    return { peak, rmsDb: 10 * Math.log10(e / g.meterData.length + 1e-12), running: ctx.state === 'running' };
  }

  // =================================================================================================================
  // THE PUBLIC FACE
  // =================================================================================================================
  const audio = {
    play,
    duck(amount = 0.5, seconds = 1) {
      duckOn('radio', amount, seconds);
      duckOn('amb', amount, seconds);
    },
    setVolume(kind, value) {
      if (!Object.hasOwn(volumes, kind)) return;
      volumes[kind] = clamp(Number(value));
      applyVolumes();
    },
    getVolume: (kind) => volumes[kind] ?? null,
    get volumes() {
      return { ...volumes };
    },
    selfTest,
    meter,
    get ready() {
      return ready && !!g;
    },
    get context() {
      return ctx;
    },
    /** @internal the rendered sounds ({ sfx, kit } banks), for tests */
    banks,
    sounds: Object.keys(SOUNDS),
    /** @internal for the director's console */
    get debug() {
      return { played, voices: voices.length, alarms: alarms.slots.length, tyres: !!tyres.squeal, heli: !!heli.voice, intensity: intensity.engine ? intensity.target : 0, radio: radio.debug, rendered: `${sfx.done + kit.done}/${sfx.total + kit.total}` };
    }
  };
  game.audio = audio;
  game.radio = radio;
  applyVolumes();
  game.addSystem({ name: 'audio', order: 85, update });
  if (new URLSearchParams(location.search).get('show') === 'audio') addAudioShow(game, audio);
  return audio;
}

// ?show=audio: the self-test's numbers on screen, and every few seconds a round of sounds around the player
function addAudioShow(game, audio) {
  const panel = document.createElement('pre');
  panel.style.cssText = 'position:fixed;right:8px;top:56px;z-index:9999;max-height:80vh;overflow:auto;margin:0;padding:8px 10px;'
    + 'background:rgba(10,12,16,.82);color:#cfe;font:11px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre';
  panel.textContent = 'audio self-test: click the page to start sound...';
  document.body.appendChild(panel);
  let tested = false, next = 3, round = 0;
  game.addSystem({
    name: 'audio-show',
    order: 86,
    update(dt, time, realDt) {
      if (!audio.ready) return;
      if (!tested) {
        tested = true;
        panel.textContent = 'audio self-test: rendering...';
        audio.selfTest({ log: true }).then((r) => {
          const lines = [`self-test ${r.ok ? 'OK' : 'PROBLEMS'} (bank ${r.bankMs} ms)`, ...r.problems.map((p) => '! ' + p), '', 'station       peak   rmsDb onsets lo/mid/hi'];
          for (const s of r.stations) lines.push(`${s.station.padEnd(12)} ${String(s.peak).padEnd(6)} ${String(s.rmsDb).padEnd(6)} ${String(s.onsets).padEnd(6)} ${s['lo/mid/hi']}`);
          lines.push('', 'sound           peak   rmsDb  lo/mid/hi');
          for (const s of r.sfx) lines.push(`${s.name.padEnd(15)} ${String(s.peak).padEnd(6)} ${String(s.rmsDb).padEnd(6)} ${s['lo/mid/hi']}`);
          panel.textContent = lines.join('\n');
        });
      }
      if ((next -= realDt) > 0) return;
      next = 3.5;
      const p = game.player.position;
      const h = game.engine.controllerManager.getActiveEntity().heading;
      const at = (dist, side = 0) => ({ x: p.x + Math.sin(h) * dist + Math.cos(h) * side, y: p.y + 1.4, z: p.z + Math.cos(h) * dist - Math.sin(h) * side });
      // a scuffle near by and an engine's backfire further off, then the street's impacts and voices
      const near = at(6, -2);
      audio.play('whoosh', near);
      audio.play(round % 2 ? 'bat' : 'punch', { ...near, delay: 0.06 });
      if (round % 2 === 0) audio.play('backfire', at(40, 12));
      const imp = at(8, 3);
      audio.play(['impact-concrete', 'impact-metal', 'impact-glass', 'impact-dirt'][round % 4], imp);
      audio.play(['scream', 'shout', 'pain'][round % 3], at(12, -6));
      round++;
    }
  });
}
