import { STATIONS, POLICE_BAND, createStation, makeImpulse } from './audio-music.js';

// The car radio (game.radio): procedural stations (js/audio-music.js) that play while the player is in a car or the
// helicopter (not on a bicycle); police cars get the police band instead. Stations run on the wall clock ("live"):
// one not listened to keeps going, and tuning back lands mid-song. A change of station is a burst of static, the
// station fading in, its ident and a 'radio:changed' event. Get out and the radio carries on from the car, muffled
// and positional, for a few seconds. Keys , and . (and LB / RB in a vehicle on a pad: the d-pad's left and right are
// the camera and the phone) tune down and up; the last station is saved.
//   game.radio = { stations: [{ id, name, genre }], current (station | null = off), on (bool: audible now), next(),
//     prev(), set(id | null), off(), policeBand }
//   event 'radio:changed' { station (| null), reason: 'tune' | 'enter' | 'off' } on tuning and on getting in

const OUTSIDE_SECONDS = 9; // the radio plays on from the car after the player gets out
const OUTSIDE_RANGE = 45;

/**
 * The radio's master chain in any BaseAudioContext: input -> light compression -> car-speaker EQ -> inside (direct) or
 * outside (muffled, positional) -> destination; plus the stations' shared reverb and a tuning-static voice
 */
export function createRadioChain(ctx, destination, noiseBuffer = null) {
  const nodes = [];
  const own = (n) => (nodes.push(n), n);
  const gain = (v) => {
    const g = own(ctx.createGain());
    g.gain.value = v;
    return g;
  };
  const filter = (type, f, q = 0.7, db = 0) => {
    const b = own(ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = db;
    return b;
  };
  const input = gain(0.5); // (the stations are mixed hot; this sets the radio's level against the city)
  const comp = own(ctx.createDynamicsCompressor());
  comp.threshold.value = -20;
  comp.knee.value = 10;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  // (a door speaker: no deep sub, a little boom, soft top)
  const hp = filter('highpass', 58, 0.7);
  const boom = filter('peaking', 150, 0.9, 1.2);
  const presence = filter('peaking', 2600, 0.8, 1.5);
  const top = filter('highshelf', 7500, 0.7, -5);
  const makeup = gain(0.6); // (Chrome's compressors add their own makeup gain)
  // (and a fast limiter for the drum transients the compressor lets through)
  const limiter = own(ctx.createDynamicsCompressor());
  limiter.threshold.value = -7;
  limiter.knee.value = 2;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  input.connect(comp).connect(hp).connect(boom).connect(presence).connect(top).connect(limiter).connect(makeup);
  const inside = gain(1);
  makeup.connect(inside).connect(destination);
  const muffle = filter('lowpass', 520, 0.9);
  const panner = own(ctx.createPanner());
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = 3;
  panner.rolloffFactor = 1;
  panner.maxDistance = 500;
  const outside = gain(0);
  makeup.connect(muffle).connect(panner).connect(outside).connect(destination);
  // the shared reverb send (each station sets its own amount)
  const reverbSend = gain(1);
  const convolver = own(ctx.createConvolver());
  convolver.normalize = false;
  convolver.buffer = makeImpulse(ctx, 1.7, 0.45, 5500);
  const reverbOut = gain(0.55);
  reverbSend.connect(convolver).connect(reverbOut).connect(input);
  // tuning static: a band of noise swept across the dial
  const staticGain = gain(0);
  const staticBand = filter('bandpass', 1800, 0.9);
  let staticSource = null;
  if (noiseBuffer) {
    staticSource = ctx.createBufferSource();
    staticSource.buffer = noiseBuffer;
    staticSource.loop = true;
    staticSource.connect(staticBand).connect(staticGain).connect(input);
    staticSource.start();
  }
  return {
    input,
    fx: { reverb: reverbSend },
    inside,
    outside,
    panner,
    muffle,
    /** a burst of static between stations */
    static(when, seconds = 0.3, level = 0.22) {
      const g = staticGain.gain;
      g.cancelScheduledValues(when);
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(level, when + 0.02);
      g.setValueAtTime(level, when + seconds - 0.06);
      g.linearRampToValueAtTime(0, when + seconds);
      const f = staticBand.frequency;
      f.cancelScheduledValues(when);
      f.setValueAtTime(600 + Math.random() * 600, when);
      f.exponentialRampToValueAtTime(2500 + Math.random() * 2500, when + seconds);
    },
    dispose() {
      try {
        staticSource?.stop();
      } catch { /* not started */ }
      staticSource?.disconnect();
      for (const n of nodes) n.disconnect();
    }
  };
}

export function createRadio(game, audio) {
  const stations = STATIONS.map((def) => ({ id: def.id, name: def.name, genre: def.genre, def }));
  const policeBand = { id: POLICE_BAND.id, name: POLICE_BAND.name, genre: POLICE_BAND.genre, def: POLICE_BAND };
  const byId = new Map([...stations, policeBand].map((s) => [s.id, s]));
  let selected = stations[0]; // (the dial's station in ordinary cars; null = off)
  let playing = null; // the station whose engine is running
  let engine = null;
  let chain = null;
  let ctx = null;
  let vehicle = null; // the vehicle the radio is in (the player's, or the one just left)
  let leftAt = -Infinity;
  let inside = false;
  let audible = false;
  let lastAudible = null;
  const event = { station: null, reason: 'tune' };

  const radio = {
    stations: stations.map(({ id, name, genre }) => ({ id, name, genre })),
    policeBand: { id: policeBand.id, name: policeBand.name, genre: policeBand.genre },
    get current() {
      const s = police() ? (policeOn ? policeBand : null) : selected;
      return s ? { id: s.id, name: s.name, genre: s.genre } : null;
    },
    get on() {
      return audible;
    },
    next: () => step(1),
    prev: () => step(-1),
    set(id) {
      if (police()) {
        policeOn = id === policeBand.id;
      } else {
        selected = id == null ? null : byId.get(id) && byId.get(id) !== policeBand ? byId.get(id) : selected;
      }
      retune('tune');
    },
    off() {
      radio.set(null);
    },
    /** @internal game/audio.js: the live graph is ready (ctx, banks, destination) */
    attach,
    /** @internal every frame */
    update,
    /** @internal the scheduler's window */
    schedule,
    /** @internal for the director: what is playing */
    get debug() {
      return { playing: playing?.id ?? null, inside, vehicle: vehicle?.label ?? null, voices: engine?.voices.active.size ?? 0 };
    }
  };
  let policeOn = true;

  const radioVehicle = (v) => v && !v.hidden && (v.mode === 'car' || v.mode === 'helicopter');
  function police() {
    return !!(vehicle && vehicle.police);
  }

  function step(dir) {
    if (!vehicle || !inside) return;
    if (police()) {
      policeOn = !policeOn;
    } else {
      // the dial: stations then "off"
      const list = [...stations, null];
      const i = list.indexOf(selected);
      selected = list[(i + dir + list.length) % list.length];
    }
    audio.play('ui-move', { gain: 0.5 });
    retune('tune');
  }

  function wanted() {
    if (!vehicle) return null;
    if (police()) return policeOn ? policeBand : null;
    return selected;
  }

  function attach(context, banks, destination) {
    ctx = context;
    radio.banks = banks;
    chain = createRadioChain(ctx, destination, game.engine.audioSystem?.resources?.noise || null);
    if (vehicle) retune('enter', true);
  }

  function emit(station, reason) {
    event.station = station ? { id: station.id, name: station.name, genre: station.genre } : null;
    event.reason = reason;
    game.emit('radio:changed', event);
  }

  // Swap the running engine for the wanted station: static, fade in, ident, event
  function retune(reason, quiet = false) {
    const want = wanted();
    if (!ctx || !chain) {
      if (reason !== 'exit') emit(want, want ? reason : 'off');
      return;
    }
    if (want === playing && engine) {
      if (reason === 'enter') emit(want, reason);
      return;
    }
    const now = ctx.currentTime;
    if (engine) {
      const old = engine;
      old.stop(now);
      setTimeout(() => old.dispose(), 600);
      engine = null;
    }
    playing = want;
    if (want && reason !== 'exit') {
      chain.static(now, quiet ? 0.2 : 0.32, quiet ? 0.12 : 0.22);
      engine = createStation(want.def, ctx, banks(), chain.input, chain.fx);
      const g = engine.bus.gain;
      g.setValueAtTime(0, now);
      g.setTargetAtTime(want.def.level ?? 1, now + 0.22, 0.06);
      engine.offset = wallClock() - now;
      // the station's own ident over the first moments (talkback: its jingle)
      const def = want.def;
      if (def.ident) def.ident(engine, now + 0.45);
      else if (def.jingle) def.jingle.call(def, engine, now + 0.3);
    } else if (reason !== 'exit') {
      chain.static(now, 0.15, 0.1);
    }
    if (reason !== 'exit') emit(want, want ? reason : 'off'); // (the radio going quiet after getting out is no news)
  }

  const banks = () => radio.banks;
  // stations play "live": their position follows the wall clock (seconds since 2026, so numbers stay modest)
  const wallClock = () => Date.now() / 1000 - 1767225600;

  function schedule(t0, t1) {
    if (engine && audible) engine.schedule(t0, t1, engine.offset);
  }

  // ---- controls: , and . on the keyboard (game.input actions), LB / RB on a pad in a vehicle ----------------------
  game.input?.bind('radioNext', ['Period']);
  game.input?.bind('radioPrev', ['Comma']);
  game.on('input:action', (e) => {
    if (game.state !== 'playing') return;
    if (e.action === 'radioNext') radio.next();
    else if (e.action === 'radioPrev') radio.prev();
  });
  const pad = { lb: false, rb: false };
  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return;
    let lb = false, rb = false;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      lb = lb || !!p.buttons[4]?.pressed;
      rb = rb || !!p.buttons[5]?.pressed;
    }
    if (lb && !pad.lb) radio.prev();
    if (rb && !pad.rb) radio.next();
    pad.lb = lb;
    pad.rb = rb;
  }

  // ---- getting in and out ------------------------------------------------------------------------------------
  game.on('vehicle:entered', ({ vehicle: v }) => {
    if (!radioVehicle(v)) return;
    vehicle = v;
    inside = true;
    if (v.police) policeOn = true;
    retune('enter');
  });
  // (getting out is not a change of station: the radio plays on from the car for a moment, then stops quietly)
  game.on('vehicle:exited', ({ vehicle: v }) => {
    if (v !== vehicle) return;
    inside = false;
    leftAt = game.realTime;
  });
  game.on('player:died', () => {
    if (!vehicle) return;
    vehicle = null;
    inside = false;
    retune('exit');
  });

  function update() {
    if (inside && game.player?.vehicle !== vehicle) {
      // (ejected without an exit event, or the vehicle swapped)
      inside = false;
      leftAt = game.realTime;
    }
    if (inside) pollPad();
    if (!chain) return;
    const now = ctx.currentTime;
    // out of the car: carry on from it, muffled, until it is far or a few seconds have gone
    let outside = 0;
    if (vehicle && !inside) {
      const cam = game.camera.camera.position;
      const d = Math.hypot(vehicle.x - cam.x, vehicle.y - cam.y, vehicle.z - cam.z);
      const age = game.realTime - leftAt;
      if (age > OUTSIDE_SECONDS || d > OUTSIDE_RANGE || vehicle.hidden || vehicle.state === 'wrecked') {
        vehicle = null;
        retune('exit');
      } else outside = 1 - Math.max(0, (age - OUTSIDE_SECONDS + 2) / 2);
    }
    const nowAudible = !!engine && (inside || outside > 0);
    audible = nowAudible;
    if (game.frame % 6 === 0 || nowAudible !== lastAudible) {
      lastAudible = nowAudible;
      const ig = inside ? 1 : 0;
      chain.inside.gain.setTargetAtTime(ig, now, 0.08);
      chain.outside.gain.setTargetAtTime(inside ? 0 : outside * 0.9, now, 0.12);
      if (vehicle && !inside) {
        chain.panner.positionX.setTargetAtTime(vehicle.x, now, 0.05);
        chain.panner.positionY.setTargetAtTime(vehicle.y + 1, now, 0.05);
        chain.panner.positionZ.setTargetAtTime(vehicle.z, now, 0.05);
      }
    }
  }

  // ---- save: the dial ------------------------------------------------------------------------------------------
  game.save.register('radio', {
    get: () => ({ station: selected ? selected.id : null }),
    set: (data) => {
      if (data && Object.hasOwn(data, 'station')) selected = data.station === null ? null : byId.get(data.station) && byId.get(data.station) !== policeBand ? byId.get(data.station) : selected;
    }
  });

  return radio;
}
