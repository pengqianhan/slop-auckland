// The radio's music: procedural stations, each a generative engine with real musical structure (tempo, key, chord
// progressions that change over sections, intro/verse/chorus/break/outro with fills, drum patterns with swing and
// variation, bass, pads, leads, arps, sidechain-style ducking), plus a talkback station of gibberish formant speech
// and the police band. Everything is deterministic from a clock: a station's position is f(time), so a station not
// listened to "keeps playing" and tuning back lands mid-song. Engines schedule notes on the audio clock in small
// windows (the radio calls schedule(t0, t1) every 25 ms, ~120 ms ahead), work in any BaseAudioContext (live or
// offline, for game/audio.js's self-test) and release every node they create when it ends.

import { mulberry, hash, Biquad, Mode, env, onePole, createBank } from './audio-sfx.js';

const TAU = Math.PI * 2;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// =====================================================================================================================
// KIT: drum hits, plucks and loops, synthesized once (time-sliced, like the SFX bank)
// =====================================================================================================================
function kick(f0, f1, tau, click, sat, lp = 0) {
  return (out, sr, rand) => {
    let ph = 0;
    const hp = new Biquad(sr, 'highpass', 3000, 0.7), low = lp ? new Biquad(sr, 'lowpass', lp, 0.7) : null;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / 0.035)) / sr;
      let x = Math.sin(ph) * env(t, 0.0015, tau) + hp.run(rand() * 2 - 1) * env(t, 0.0002, 0.003) * click;
      x = Math.tanh(x * sat) / Math.tanh(sat);
      out[i] = low ? low.run(x) : x;
    }
  };
}
function snare(body, tone, ntau, gate = 0, lp = 0, rattle = 0) {
  return (out, sr, rand) => {
    let ph = 0;
    const bp = new Biquad(sr, 'highpass', 900, 0.7), low = new Biquad(sr, 'lowpass', lp || 12000, 0.7);
    const verb = new Biquad(sr, 'bandpass', 1800, 0.5);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      ph += TAU * (tone + 60 * Math.exp(-t / 0.01)) / sr;
      let x = Math.sin(ph) * env(t, 0.001, 0.05) * body + bp.run(n) * env(t, 0.0008, ntau);
      if (gate) x += verb.run(n) * (t < gate ? 0.45 * (1 - Math.exp(-t / 0.02)) : 0.45 * Math.exp(-(t - gate) / 0.006)); // gated reverb
      if (rattle) x += bp.run(n) * env(t - 0.01, 0.01, 0.12) * rattle;
      out[i] = Math.tanh(low.run(x) * 1.5);
    }
  };
}
function hat(tau, bright = 7000) {
  return (out, sr, rand) => {
    const hp = new Biquad(sr, 'highpass', bright, 0.7), bp = new Biquad(sr, 'bandpass', 10000, 1);
    const ratios = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1523];
    const ph = ratios.map(() => rand());
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      let m = 0;
      for (let k = 0; k < ratios.length; k++) {
        ph[k] = (ph[k] + 410 * ratios[k] / sr) % 1;
        m += ph[k] < 0.5 ? 1 : -1;
      }
      out[i] = (hp.run(rand() * 2 - 1) * 0.7 + bp.run(m * 0.15)) * env(t, 0.0005, tau);
    }
  };
}
// Karplus-Strong plucked string at a reference pitch (played back pitched by playbackRate)
function ks(freq, decay = 0.996, bright = 0.5) {
  return (out, sr, rand) => {
    const n = Math.max(2, Math.round(sr / freq));
    const line = new Float32Array(n);
    const pick = new Biquad(sr, 'lowpass', 2500 + bright * 5000, 0.7);
    for (let i = 0; i < n; i++) line[i] = pick.run(rand() * 2 - 1);
    let idx = 0, last = 0;
    for (let i = 0; i < out.length; i++) {
      const cur = line[idx];
      const next = line[(idx + 1) % n];
      const v = (cur + next) * 0.5 * decay;
      line[idx] = v * (1 - bright * 0.1) + last * bright * 0.1;
      last = v;
      out[i] = cur;
      idx = (idx + 1) % n;
    }
  };
}
const KIT = {
  'kick': { dur: 0.45, render: kick(160, 46, 0.32, 0.8, 1.6) },
  'kick-tight': { dur: 0.32, render: kick(190, 52, 0.17, 1.2, 2.2) },
  'kick-dub': { dur: 0.5, render: kick(105, 44, 0.38, 0.2, 1.2) },
  'kick-lofi': { dur: 0.36, render: kick(125, 50, 0.22, 0.4, 1.8, 1800) },
  'kick-rock': { dur: 0.32, render: kick(125, 62, 0.18, 1.4, 1.5) },
  'snare-gated': { dur: 0.42, render: snare(0.8, 190, 0.09, 0.24) },
  'snare-tight': { dur: 0.28, render: snare(0.9, 230, 0.075, 0, 0, 0.3) },
  'snare-lofi': { dur: 0.3, render: snare(0.7, 185, 0.11, 0, 5200) },
  'snare-rock': { dur: 0.36, render: snare(0.8, 200, 0.14, 0, 0, 0.5) },
  'rim': {
    dur: 0.14,
    render(out, sr, rand) {
      const a = new Mode(sr, 1720, 0.018), b = new Mode(sr, 420, 0.03, 0.6);
      for (let i = 0; i < out.length; i++) {
        const ex = i < sr * 0.0008 ? rand() * 2 - 1 : 0;
        out[i] = a.run(ex) + b.run(ex);
      }
    }
  },
  'clap': {
    dur: 0.32,
    render(out, sr, rand) {
      const bp = new Biquad(sr, 'bandpass', 1300, 1.2);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const e = env(t, 0.0005, 0.006) + env(t - 0.011, 0.0005, 0.006) + env(t - 0.022, 0.0005, 0.09);
        out[i] = bp.run(rand() * 2 - 1) * e;
      }
    }
  },
  'hat': { dur: 0.12, render: hat(0.035) },
  'hat-open': { dur: 0.5, render: hat(0.22, 6500) },
  'ride': {
    dur: 1.2,
    render(out, sr, rand) {
      const modes = [[2950, 0.7], [3700, 0.5], [5230, 0.4], [6400, 0.3]].map(([f, tau]) => new Mode(sr, f, tau, 0.4));
      const hp = new Biquad(sr, 'highpass', 6000, 0.7);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const n = rand() * 2 - 1;
        let v = 0;
        for (const m of modes) v += m.run(i < sr * 0.001 ? n : 0);
        out[i] = v * 0.3 + hp.run(n) * env(t, 0.001, 0.35) * 0.5;
      }
    }
  },
  'shaker': {
    dur: 0.13,
    render(out, sr, rand) {
      const bp = new Biquad(sr, 'bandpass', 6500, 1.5);
      for (let i = 0; i < out.length; i++) out[i] = bp.run(rand() * 2 - 1) * env(i / sr, 0.012, 0.035);
    }
  },
  'tom': { dur: 0.55, render: kick(170, 118, 0.22, 0.5, 1.3) },
  'crash': {
    dur: 1.9, sr: 44100,
    render(out, sr, rand) {
      const hp = new Biquad(sr, 'highpass', 3800, 0.7), bp = new Biquad(sr, 'bandpass', 5200, 0.8);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const n = rand() * 2 - 1;
        out[i] = (hp.run(n) * 0.8 + bp.run(n) * 0.5) * env(t, 0.002, 0.55) * (1 + 0.15 * Math.sin(t * 40));
      }
    }
  },
  'riser': {
    dur: 2.6, sr: 32000, fadeOut: 0.02,
    render(out, sr, rand) {
      const bp = new Biquad(sr, 'bandpass', 400, 2.5);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        if ((i & 31) === 0) bp.set('bandpass', 300 * Math.pow(25, t / 2.6), 2.5);
        out[i] = bp.run(rand() * 2 - 1) * (t / 2.6) ** 2;
      }
    }
  },
  'vinyl': { // crackle and hiss, a seamless loop
    dur: 3, loop: 0.2, sr: 24000, peak: 0.7,
    render(out, sr, rand) {
      const lp = new Biquad(sr, 'lowpass', 3500, 0.7), hp = new Biquad(sr, 'highpass', 900, 0.7);
      let pop = 0, decay = 0.9;
      for (let i = 0; i < out.length; i++) {
        if (rand() < 9 / sr) {
          pop = (rand() < 0.5 ? -1 : 1) * (0.3 + rand() * 0.7);
          decay = Math.exp(-1 / (sr * (0.0002 + rand() * 0.0008)));
        }
        pop *= decay;
        out[i] = hp.run(pop) + lp.run(rand() * 2 - 1) * 0.06 + Math.sin(i / sr * TAU * 0.55) * 0.004;
      }
    }
  },
  'ks-low': { dur: 2.2, sr: 32000, peak: 0.8, render: ks(110, 0.997, 0.4) },
  'ks-mid': { dur: 2.0, sr: 32000, peak: 0.8, render: ks(220, 0.996, 0.55) },
  'ks-high': { dur: 1.6, sr: 32000, peak: 0.8, render: ks(440, 0.995, 0.6) }
};
const KS_REFS = [['ks-low', 110], ['ks-mid', 220], ['ks-high', 440]];

export function createMusicKit(opts) {
  return createBank(KIT, opts);
}

/** A stereo reverb impulse (decaying noise, a little pre-delay, damped); ConvolverNodes need the context's rate */
export function makeImpulse(ctx, seconds = 1.8, decay = 0.5, damp = 6000, seed = 7) {
  const sr = ctx.sampleRate;
  const len = Math.round(seconds * sr);
  const buffer = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const rand = mulberry(seed + c * 101);
    const data = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const k = onePole(damp * Math.exp(-t / (seconds * 0.6)) + 400, sr);
      lp += (rand() * 2 - 1 - lp) * k;
      data[i] = lp * Math.exp(-t / decay) * clamp((t - 0.012) / 0.01) * 0.6;
    }
  }
  return buffer;
}

// =====================================================================================================================
// THE INSTRUMENT TOOLKIT: every note a few short-lived nodes, tracked so a station can stop at once and every node is
// disconnected when it ends
// =====================================================================================================================
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], phrygianDominant: [0, 1, 4, 5, 7, 8, 10]
};
function degree(root, scale, d) {
  const n = scale.length;
  const oct = Math.floor(d / n);
  return root + scale[((d % n) + n) % n] + 12 * oct;
}
function chordNotes(root, scale, d, size = 3) {
  const notes = [];
  for (let k = 0; k < size; k++) notes.push(degree(root, scale, d + 2 * k));
  return notes;
}
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

class Voices {
  constructor() {
    this.active = new Set();
    this.onEnded = (e) => this.release(e.target);
  }

  track(src, nodes) {
    src._nodes = nodes;
    src.onended = this.onEnded;
    this.active.add(src);
  }

  release(src) {
    if (!this.active.delete(src)) return;
    src.onended = null;
    src.disconnect();
    if (src._nodes) for (const n of src._nodes) n.disconnect();
    src._nodes = null;
  }

  stopAll(when) {
    for (const src of this.active) {
      try {
        src.stop(when);
      } catch { /* already stopped */ }
    }
  }
}

/** A station's playing context: buses, effects and the note helpers its genre code calls */
class Engine {
  constructor(def, ctx, banks, out, fx) {
    this.def = def;
    this.ctx = ctx;
    this.kit = banks.kit;
    this.sfx = banks.sfx;
    this.voices = new Voices();
    this.persistent = [];
    this.songs = new Map();
    this.bus = this.gain(def.level ?? 1);
    this.bus.connect(out);
    this.drumLP = this.filter('lowpass', 20000, 0.7);
    this.drums = this.gain(1);
    this.drums.connect(this.drumLP).connect(this.bus);
    this.music = this.gain(1);
    this.music.connect(this.bus);
    this.pumped = this.gain(1); // pads & bass: ducked on every kick (sidechain-style)
    this.pumped.connect(this.music);
    this.rev = this.gain(def.reverb ?? 0.3);
    this.rev.connect(fx.reverb);
    this.started = false;
    def.setup?.(this);
  }

  gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    this.persistent.push(g);
    return g;
  }

  filter(type, f, q = 0.7, gainDb = 0) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = Math.min(f, this.ctx.sampleRate * 0.45);
    b.Q.value = q;
    b.gain.value = gainDb;
    this.persistent.push(b);
    return b;
  }

  /** A sampled hit: returns its end time */
  hit(name, when, gain = 1, rate = 1, dest = this.drums, send = 0, bank = this.kit, variant = 0) {
    const buffer = bank.get(name, variant);
    if (!buffer || gain <= 0) return when;
    // (a hit due before now, e.g. a riser leading into an ident, starts part-way through so it still ends on time)
    const now = this.ctx.currentTime;
    const skip = when < now ? (now - when) * rate : 0;
    if (skip >= buffer.duration) return when;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    if (send) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      g.connect(s).connect(this.rev);
      this.voices.track(src, [g, s]);
    } else this.voices.track(src, [g]);
    const end = when + buffer.duration / rate;
    src.start(Math.max(when, now), skip);
    src.stop(end);
    return end;
  }

  /**
   * An oscillator note: o = { wave, voices (detuned copies), detune (cents spread), gain, a, d, s, r, lp (cutoff),
   * lpEnv (Hz added at the attack), lpDecay, q, bp (bandpass centre instead), vib (Hz, cents), glide (from Hz), send }
   */
  note(dest, when, dur, freq, o) {
    const ctx = this.ctx;
    when = Math.max(when, ctx.currentTime);
    const end = when + dur + (o.r ?? 0.05);
    const g = ctx.createGain();
    const peak = o.gain ?? 0.1;
    const a = o.a ?? 0.005, d = o.d ?? 0.1, s = o.s ?? 0.6;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + a);
    g.gain.setTargetAtTime(peak * s, when + a, d / 3);
    g.gain.setTargetAtTime(0, when + dur, (o.r ?? 0.05) / 4);
    const nodes = [g];
    let head = g;
    if (o.lp || o.bp) {
      const f = ctx.createBiquadFilter();
      f.type = o.bp ? 'bandpass' : 'lowpass';
      f.Q.value = o.q ?? (o.bp ? 1.2 : 0.8);
      const base = o.bp || o.lp;
      if (o.lpEnv) {
        f.frequency.setValueAtTime(base + o.lpEnv, when);
        f.frequency.setTargetAtTime(base, when + 0.002, (o.lpDecay ?? 0.15) / 3);
      } else f.frequency.value = base;
      f.connect(g);
      nodes.push(f);
      head = f;
    }
    g.connect(dest);
    if (o.send) {
      const sg = ctx.createGain();
      sg.gain.value = o.send;
      g.connect(sg).connect(this.rev);
      nodes.push(sg);
    }
    const count = o.voices ?? 1;
    let vib = null;
    if (o.vib) {
      vib = ctx.createOscillator();
      vib.frequency.value = o.vib[0];
      const vg = ctx.createGain();
      vg.gain.value = o.vib[1];
      vib.connect(vg);
      nodes.push(vg);
      vib.start(when);
      vib.stop(end);
      this.voices.track(vib, []);
      vib._vg = vg;
    }
    for (let k = 0; k < count; k++) {
      const osc = ctx.createOscillator();
      osc.type = o.wave ?? 'sawtooth';
      if (o.glide) {
        osc.frequency.setValueAtTime(o.glide, when);
        osc.frequency.exponentialRampToValueAtTime(freq, when + (o.glideTime ?? 0.06));
      } else osc.frequency.value = freq;
      osc.detune.value = count > 1 ? (k / (count - 1) - 0.5) * (o.detune ?? 10) * 2 : (o.detune1 ?? 0);
      if (vib) vib._vg.connect(osc.detune);
      osc.connect(head);
      osc.start(when);
      osc.stop(end);
      this.voices.track(osc, k === 0 ? nodes : []);
    }
    return end;
  }

  /** Two-operator FM: o = { ratio, index, indexEnd, indexTime, gain, a, d, s, r, send, detune1 } */
  fm(dest, when, dur, freq, o) {
    const ctx = this.ctx;
    when = Math.max(when, ctx.currentTime);
    const end = when + dur + (o.r ?? 0.1);
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    car.frequency.value = freq;
    mod.frequency.value = freq * (o.ratio ?? 1);
    if (o.detune1) car.detune.value = o.detune1;
    const mg = ctx.createGain();
    const i0 = freq * (o.ratio ?? 1) * (o.index ?? 2);
    mg.gain.setValueAtTime(i0, when);
    mg.gain.setTargetAtTime(freq * (o.ratio ?? 1) * (o.indexEnd ?? 0.3), when, (o.indexTime ?? 0.3) / 3);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    const peak = o.gain ?? 0.1;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + (o.a ?? 0.004));
    g.gain.setTargetAtTime(peak * (o.s ?? 0.3), when + (o.a ?? 0.004), (o.d ?? 0.4) / 3);
    g.gain.setTargetAtTime(0, when + dur, (o.r ?? 0.1) / 4);
    car.connect(g).connect(dest);
    const nodes = [mg, g];
    if (o.send) {
      const sg = ctx.createGain();
      sg.gain.value = o.send;
      g.connect(sg).connect(this.rev);
      nodes.push(sg);
    }
    car.start(when);
    mod.start(when);
    car.stop(end);
    mod.stop(end);
    this.voices.track(car, nodes);
    this.voices.track(mod, []);
    return end;
  }

  /** A plucked string (Karplus-Strong reference nearest in pitch); dur cuts it short (palm mute) */
  pluck(dest, when, freq, gain = 0.2, dur = 1.5, send = 0) {
    when = Math.max(when, this.ctx.currentTime);
    let best = KS_REFS[0];
    for (const ref of KS_REFS) if (Math.abs(Math.log(freq / ref[1])) < Math.abs(Math.log(freq / best[1]))) best = ref;
    const buffer = this.kit.get(best[0], 0);
    if (!buffer) return when;
    const rate = freq / best[1];
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    const len = Math.min(dur, buffer.duration / rate);
    g.gain.setValueAtTime(gain, when);
    g.gain.setTargetAtTime(0, when + len, 0.02);
    src.connect(g).connect(dest);
    const nodes = [g];
    if (send) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      g.connect(s).connect(this.rev);
      nodes.push(s);
    }
    src.start(when);
    src.stop(when + len + 0.1);
    this.voices.track(src, nodes);
    return when + len;
  }

  /** Sidechain-style duck of the pumped bus at a kick */
  pump(when, depth = 0.5, release = 0.12) {
    when = Math.max(when, this.ctx.currentTime);
    const p = this.pumped.gain;
    p.setValueAtTime(1 - depth, when);
    p.setTargetAtTime(1, when + 0.015, release / 3);
  }

  songFor(slot) {
    let song = this.songs.get(slot);
    if (!song) {
      if (this.songs.size > 3) this.songs.clear();
      song = buildSong(this.def, slot);
      this.songs.set(slot, song);
    }
    return song;
  }

  /** Schedules everything that starts in [t0, t1) of the context clock; offset = station time - context time */
  schedule(t0, t1, offset) {
    const def = this.def;
    if (def.schedule) return def.schedule(this, t0, t1, offset);
    const s0 = t0 + offset, s1 = t1 + offset;
    for (let slot = Math.floor(s0 / def.slot); slot * def.slot < s1; slot++) {
      const song = this.songFor(slot);
      const start = slot * def.slot + song.lead;
      const sd = song.stepDur;
      if (!this.started) {
        this.started = true;
        const k = Math.floor((s0 - start) / sd);
        if (k >= 0 && k < song.steps) def.resume?.(this, song, k, t0, start + (Math.floor(k / 16) + 1) * 16 * sd - offset);
      }
      for (let k = Math.max(0, Math.floor((s0 - start) / sd) - 1); k < song.steps; k++) {
        const t = start + k * sd + (k & 1 ? song.swing * sd : 0);
        if (t >= s1) break;
        if (t >= s0) def.step(this, song, k, t - offset);
      }
      const identAt = slot * def.slot + 0.4;
      if (def.ident && identAt >= s0 && identAt < s1) def.ident(this, identAt - offset);
    }
  }

  stop(when) {
    const g = this.bus.gain;
    g.cancelScheduledValues(when);
    g.setTargetAtTime(0, when, 0.03);
    this.voices.stopAll(when + 0.2);
    this.def.teardown?.(this, when);
  }

  dispose() {
    this.voices.stopAll(0);
    for (const src of [...this.voices.active]) this.voices.release(src);
    for (const n of this.persistent) n.disconnect();
    this.persistent.length = 0;
  }
}

// A song: tempo, key, sections over bars, the chord of every bar, a motif; deterministic from (station, slot)
function buildSong(def, slot) {
  const rand = mulberry(hash(def.seed, slot, 77));
  const song = { slot, rand };
  def.song(song, rand);
  const barDur = 240 / song.bpm;
  song.stepDur = barDur / 16;
  song.swing ??= 0;
  song.lead ??= 1.2;
  const bars = Math.floor((def.slot - song.lead - 1.6) / barDur);
  // sections from the station's template, trimmed to fit, always ending with the outro
  const template = song.template;
  const sections = [];
  const outroBars = template[template.length - 1][1];
  let used = 0;
  const add = (type, n) => {
    sections.push({ type, start: used, bars: n });
    used += n;
  };
  for (let i = 0; i < template.length - 1; i++) {
    // a section that does not fit is cut to whole phrases (4 bars); one that cannot be is left out
    const n = Math.min(template[i][1], Math.floor((bars - used - outroBars) / 4) * 4);
    if (n < 4) break;
    add(template[i][0], n);
  }
  // time left over: the last chorus (or drop) again, so the outro stays an outro
  const hook = template.find(([t]) => t === 'chorus' || t === 'drop')?.[0] || template[1][0];
  while (bars - used - outroBars >= 4) add(hook, Math.min(16, Math.floor((bars - used - outroBars) / 4) * 4));
  sections.push({ type: template[template.length - 1][0], start: used, bars: Math.max(2, bars - used) });
  song.bars = used + sections[sections.length - 1].bars;
  song.steps = song.bars * 16;
  song.sections = sections;
  song.barInfo = [];
  for (const sec of sections) {
    const prog = song.progs[sec.type] || song.progs.verse;
    for (let b = 0; b < sec.bars; b++) {
      const ci = Math.floor(b / song.chordBars) % prog.length;
      const deg = prog[ci];
      song.barInfo.push({
        sec, local: b, last: b === sec.bars - 1, chordStart: b % song.chordBars === 0,
        deg, chord: chordNotes(song.root, song.scale, deg, song.chordSize ?? 3), bass: degree(song.root - 12, song.scale, deg)
      });
    }
  }
  // a two-bar motif: rhythm (steps) and scale degrees above the chord, repeated with a varied answer
  const motif = [];
  const density = song.motifDensity ?? 0.45;
  let deg = 0;
  for (let s = 0; s < 32; s += 2) {
    if (rand() < (s % 8 === 0 ? 0.85 : density)) {
      deg += pick(rand, [-2, -1, -1, 0, 1, 1, 2, 3]);
      deg = Math.max(-2, Math.min(6, deg));
      const len = pick(rand, [2, 2, 4, 4, 6]);
      motif.push({ s, len, deg: s % 8 === 0 ? pick(rand, [0, 2, 4]) : deg });
    }
  }
  song.motif = motif;
  song.answer = motif.map((m) => ({ ...m, deg: m.s >= 24 ? m.deg + pick(rand, [-1, 1, 2]) : m.deg }));
  return song;
}

const info = (song, k) => song.barInfo[Math.min(song.barInfo.length - 1, Math.floor(k / 16))];
/** The motif note at step k (of a 4-bar phrase: motif, answer), as MIDI, or null */
function motifAt(song, k, octave = 12) {
  const bar = Math.floor(k / 16);
  const phrase = bar % 4;
  const list = phrase < 2 ? song.motif : song.answer;
  const s = (phrase % 2) * 16 + (k % 16);
  for (const m of list) {
    if (m.s === s) {
      const b = info(song, k);
      return { midi: degree(song.root + octave, song.scale, b.deg + m.deg), len: m.len };
    }
  }
  return null;
}

// =====================================================================================================================
// THE STATIONS
// =====================================================================================================================
const SYNTHWAVE = {
  id: 'neon', name: 'Harbour Neon 91.7', genre: 'Synthwave', seed: 11, slot: 172, level: 0.95, reverb: 0.35,
  song(song, rand) {
    song.bpm = 96 + Math.floor(rand() * 16);
    song.root = 45 + pick(rand, [0, 2, 3, 5, 7, 9]) + 12;
    song.scale = SCALES.minor;
    song.chordBars = rand() < 0.5 ? 1 : 2;
    song.progs = {
      verse: pick(rand, [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 2, 5, 6]]),
      chorus: pick(rand, [[5, 6, 0, 0], [5, 2, 6, 0], [3, 4, 5, 6], [5, 6, 2, 4]]),
      break: [5, 6]
    };
    song.template = [['intro', 8], ['verse', 16], ['chorus', 16], ['break', 8], ['verse', 8], ['chorus', 16], ['chorus', 8], ['outro', 8]];
    song.arpShape = pick(rand, [[0, 1, 2, 1], [0, 1, 2, 3], [0, 2, 1, 2], [2, 1, 0, 1]]);
    song.fmIndex = 1.2 + rand() * 1.5;
  },
  step(e, song, k, when) {
    const s = k % 16;
    const b = info(song, k);
    const type = b.sec.type;
    const sd = song.stepDur;
    const full = type === 'verse' || type === 'chorus';
    if ((full || (type === 'outro' && b.local < b.sec.bars - 2)) && s % 4 === 0) {
      e.hit('kick', when, 0.68);
      e.pump(when, 0.55, 0.16);
    }
    if (full && (s === 4 || s === 12)) e.hit('snare-gated', when, 0.62, 1, e.drums, 0.25);
    if ((full || type === 'intro') && s % 2 === 0) {
      if (type === 'chorus' && s % 4 === 2) e.hit('hat-open', when, 0.15);
      else e.hit('hat', when, s % 4 === 2 ? 0.3 : 0.17);
    }
    if (type === 'chorus' && b.local === 0 && s === 0) e.hit('crash', when, 0.3);
    if (b.last && type !== 'outro' && s >= 8 && s % 2 === 0) e.hit('tom', when, 0.5, 1.25 - (s - 8) * 0.05, e.drums, 0.3);
    // bass: pumping octave eighths
    if (type !== 'break' && type !== 'intro' && s % 2 === 0) {
      e.note(e.pumped, when, sd * 1.5, mtof(b.bass + (s % 4 === 2 ? 12 : 0)), { wave: 'sawtooth', gain: 0.1, lp: 380, lpEnv: 1100, lpDecay: 0.09, a: 0.003, d: 0.15, s: 0.4, r: 0.05 });
    }
    // pad
    if (s === 0 && b.chordStart) {
      const dur = song.chordBars * 16 * sd;
      for (const n of b.chord) e.note(e.pumped, when, dur, mtof(n), { wave: 'sawtooth', voices: 2, detune: 9, gain: 0.03, lp: type === 'chorus' ? 2200 : 1300, a: 0.4, d: 0.8, s: 0.85, r: 0.7, send: 0.6 });
    }
    // arpeggio
    if ((type === 'intro' || type === 'verse' || type === 'outro') && s % 1 === 0) {
      const n = b.chord[song.arpShape[s % 4] % b.chord.length] + 12 + (s >= 8 ? 12 : 0);
      e.note(e.music, when, sd * 0.9, mtof(n), { wave: 'square', gain: 0.03, lp: 1800, lpEnv: 2500, lpDecay: 0.06, a: 0.002, d: 0.08, s: 0.2, r: 0.04, send: 0.3 });
    }
    // lead
    if (type === 'chorus' || type === 'break') {
      const m = motifAt(song, k, 12);
      if (m) e.fm(e.music, when, m.len * sd * 0.95, mtof(m.midi), { ratio: 1, index: song.fmIndex, indexEnd: 0.5, indexTime: 0.4, gain: type === 'break' ? 0.05 : 0.08, a: 0.01, d: 0.4, s: 0.6, r: 0.25, send: 0.6, detune1: 4 });
    }
  },
  resume(e, song, k, when, barEnd) {
    const b = info(song, k);
    for (const n of b.chord) e.note(e.pumped, when, Math.max(0.2, barEnd - when), mtof(n), { wave: 'sawtooth', voices: 2, detune: 9, gain: 0.03, lp: 1300, a: 0.3, s: 0.85, r: 0.5, send: 0.6 });
  },
  ident(e, when) {
    e.hit('riser', when - 0.4, 0.2, 1.4, e.music);
    [57, 64, 69, 72].forEach((m, i) => e.fm(e.music, when + 0.6 + i * 0.12, 0.5, mtof(m + 12), { ratio: 2, index: 2.5, indexEnd: 0.3, gain: 0.08, s: 0.2, send: 0.6 }));
  }
};

const DUB = {
  id: 'roots', name: 'Rangitoto Roots 96.2', genre: 'Dub / Roots Reggae', seed: 23, slot: 180, level: 1, reverb: 0.25,
  setup(e) {
    // the dub delay: dotted-eighth echoes, filtered on every repeat; "throws" open its send for a beat
    const ctx = e.ctx;
    const d = ctx.createDelay(2);
    e.persistent.push(d);
    e.delayIn = e.gain(0);
    e.delayFb = e.gain(0.55);
    const hp = e.filter('highpass', 280, 0.7), lp = e.filter('lowpass', 2300, 0.8);
    e.delayIn.connect(d);
    d.connect(hp).connect(lp).connect(e.delayFb).connect(d);
    lp.connect(e.music);
    e.delay = d;
    e.delayTime = 0;
  },
  song(song, rand) {
    song.bpm = 68 + Math.floor(rand() * 12);
    song.swing = 0.1 + rand() * 0.08;
    song.root = 40 + pick(rand, [0, 2, 4, 5, 7]) + 12;
    const minor = rand() < 0.6;
    song.scale = minor ? SCALES.minor : SCALES.major;
    song.chordBars = rand() < 0.6 ? 2 : 1;
    song.progs = minor
      ? { verse: pick(rand, [[0, 3], [0, 6], [0, 3, 0, 4]]), chorus: pick(rand, [[5, 6], [3, 4], [0, 6, 5, 4]]), break: [0] }
      : { verse: pick(rand, [[0, 3], [0, 4], [1, 0]]), chorus: pick(rand, [[3, 4], [3, 0, 4, 0], [5, 4]]), break: [0] };
    song.template = [['intro', 4], ['verse', 16], ['chorus', 8], ['dub', 8], ['verse', 16], ['chorus', 8], ['dub', 8], ['outro', 4]];
    song.progs.dub = song.progs.verse;
    // the bass riff: two bars, rests on the one
    const riff = [];
    for (let s = 2; s < 32; s += 2) {
      if (rand() < (s % 16 === 0 ? 0.15 : 0.6)) riff.push({ s, len: pick(rand, [1, 2, 3]), deg: pick(rand, [0, 0, 0, 4, 7, 9, 12, 2, 5]) });
    }
    song.riff = riff;
    song.motifDensity = 0.3;
  },
  step(e, song, k, when) {
    const s = k % 16;
    const b = info(song, k);
    const type = b.sec.type;
    const sd = song.stepDur;
    const r = mulberry(hash(song.slot, k, 5))();
    if (e.delayTime !== song.stepDur * 3) {
      e.delayTime = song.stepDur * 3;
      e.delay.delayTime.setValueAtTime(e.delayTime, when);
    }
    const steppers = type === 'chorus';
    // (the intro: the one drop, skank and organ; the bass joins half-way)
    if (type === 'intro' && s === 8) e.hit('rim', when, 0.4, 1, e.drums, 0.3);
    if (type === 'intro' && s === 8 && b.local >= 1) e.hit('kick-dub', when, 0.6);
    if (type !== 'intro') {
      if (s === 8 || (steppers && s % 4 === 0)) e.hit('kick-dub', when, 0.7);
      if (s === 8) e.hit('rim', when, 0.4, 1, e.drums);
      if (s === 14 && r < 0.3) e.hit('rim', when, 0.25);
      if (type === 'dub' && s === 12 && b.local % 2 === 1) {
        e.hit('snare-lofi', when, 0.4);
        e.delayIn.gain.setValueAtTime(0.9, when);
        e.delayIn.gain.setValueAtTime(0, when + sd);
      }
    }
    if (s % 2 === 0 && type !== 'dub') e.hit('hat', when, s % 4 === 2 ? 0.17 : 0.1);
    if (type === 'dub' && s % 4 === 2) e.hit('shaker', when, 0.12);
    // skank on 2 and 4, the organ bubble on the off-beat eighths
    if (s === 4 || s === 12) {
      const throwIt = (b.local % 4 === 3 && s === 12) || (type === 'dub' && r < 0.5);
      if (throwIt) {
        e.delayIn.gain.setValueAtTime(0.85, when);
        e.delayIn.gain.setValueAtTime(0, when + sd * 1.5);
      }
      if (type !== 'dub' || r < 0.6) for (const n of b.chord) e.note(e.music, when, sd * 0.6, mtof(n + 12), { wave: 'square', gain: 0.045, bp: 1700, q: 1.1, a: 0.002, d: 0.05, s: 0.1, r: 0.03, send: 0.1 });
      if (throwIt) for (const n of b.chord) e.note(e.delayIn, when, sd * 0.6, mtof(n + 12), { wave: 'square', gain: 0.03, bp: 1700, a: 0.002, d: 0.05, s: 0.1, r: 0.03 });
    }
    if ((type === 'verse' || type === 'chorus' || type === 'intro') && s % 4 === 2) {
      for (const n of b.chord) e.note(e.music, when, sd * 1.1, mtof(n), { wave: 'triangle', gain: 0.032, lp: 1400, a: 0.004, d: 0.1, s: 0.5, r: 0.04 });
    }
    // bass: the riff (the heart of it), dropped out for bars of the dub section
    if ((type !== 'intro' || b.local >= b.sec.bars / 2) && !(type === 'dub' && b.local % 4 === 2)) {
      const local = (Math.floor(k / 16) % 2) * 16 + s;
      for (const n of song.riff) {
        if (n.s !== local) continue;
        const midi = b.bass - 12 + n.deg;
        e.note(e.pumped, when, n.len * sd * 1.8, mtof(midi), { wave: 'sine', gain: 0.26, a: 0.008, d: 0.25, s: 0.75, r: 0.08 });
        e.note(e.pumped, when, n.len * sd * 1.8, mtof(midi + 12), { wave: 'triangle', gain: 0.07, lp: 600, a: 0.008, d: 0.2, s: 0.5, r: 0.06 });
      }
    }
    // melodica in the chorus
    if (type === 'chorus') {
      const m = motifAt(song, k, 12);
      if (m) e.note(e.music, when, m.len * sd, mtof(m.midi), { wave: 'sawtooth', gain: 0.045, bp: 1300, q: 0.7, a: 0.03, d: 0.2, s: 0.8, r: 0.1, vib: [5.5, 12], send: 0.3 });
    }
    // a dub siren in the dub sections, now and then
    if (type === 'dub' && b.local === 4 && s === 0) {
      e.note(e.delayIn, when, sd * 6, 900, { wave: 'sine', gain: 0.05, glide: 400, glideTime: sd * 6, a: 0.02, s: 1, r: 0.05 });
      e.delayIn.gain.setValueAtTime(0.7, when);
      e.delayIn.gain.setValueAtTime(0, when + sd * 6);
    }
  },
  resume(e, song, k, when) {
    e.hit('rim', when, 0.2);
  },
  teardown(e, when) {
    e.delayFb.gain.setTargetAtTime(0, when, 0.05);
  },
  ident(e, when) {
    e.hit('riser', when - 0.4, 0.15, 1, e.music);
    for (const n of [52, 56, 59]) e.note(e.delayIn, when + 0.5, 0.15, mtof(n + 12), { wave: 'square', gain: 0.04, bp: 1700, a: 0.002, d: 0.05, s: 0.1 });
    e.delayIn.gain.setValueAtTime(0.9, when + 0.5);
    e.delayIn.gain.setValueAtTime(0, when + 0.75);
  }
};

const DNB = {
  id: 'pressure', name: 'K Road Pressure 104.4', genre: 'Drum & Bass', seed: 37, slot: 176, level: 0.9, reverb: 0.3,
  setup(e) {
    // reese bass through a soft clipper
    const shaper = e.ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    e.persistent.push(shaper);
    e.reese = e.gain(1);
    e.reese.connect(shaper).connect(e.pumped);
  },
  song(song, rand) {
    song.bpm = 170 + Math.floor(rand() * 6);
    song.root = 38 + pick(rand, [0, 1, 3, 5, 7, 8]) + 12;
    song.scale = rand() < 0.6 ? SCALES.minor : SCALES.dorian;
    song.chordBars = 2;
    song.progs = {
      intro: [0, 5], build: [0, 5],
      drop: pick(rand, [[0, 5, 3, 4], [0, 0, 5, 6], [0, 3, 0, 6]]),
      breakdown: pick(rand, [[5, 3, 0, 4], [3, 5, 6, 0]]), verse: [0, 5]
    };
    song.template = [['intro', 16], ['build', 8], ['drop', 32], ['breakdown', 16], ['build', 8], ['drop', 32], ['outro', 8]];
    song.ghost = 0.12 + rand() * 0.14;
    song.chordSize = 4;
  },
  step(e, song, k, when) {
    const s = k % 16;
    const b = info(song, k);
    const type = b.sec.type;
    const sd = song.stepDur;
    const r = mulberry(hash(song.slot, k, 9))();
    if (s === 0 && b.local === 0) {
      const lp = Math.min(e.ctx.sampleRate * 0.45, type === 'intro' ? 900 : type === 'build' ? 2500 : type === 'breakdown' ? 400 : 18000);
      e.drumLP.frequency.setTargetAtTime(lp, when, type === 'build' ? 1.2 : 0.05);
      if (type === 'drop') e.hit('crash', when, 0.32);
    }
    const drums = type !== 'breakdown' && !(type === 'outro' && b.local >= b.sec.bars - 2);
    if (drums) {
      const variation = b.local % 4 === 3;
      if (type !== 'intro' && (s === 0 || s === 10 || (variation && s === 7))) {
        e.hit('kick-tight', when, 0.66);
        e.pump(when, 0.45, 0.12);
      }
      if (s === 4 || s === 12) e.hit('snare-tight', when, 0.7, 1, e.drums, 0.15);
      else if (s % 2 === 1 && r < song.ghost) e.hit('snare-tight', when, 0.1 + r * 0.6, 1.08);
      if (s % 2 === 0) e.hit(type === 'drop' && b.local >= 16 ? 'ride' : 'hat', when, s % 4 === 2 ? 0.2 : 0.13);
      else if (type === 'drop') e.hit('hat', when, 0.06);
      if (s === 2 && type === 'drop' && r < 0.4) e.hit('shaker', when, 0.15);
    }
    // the roll into a drop
    if (type === 'build' && b.local >= b.sec.bars - 2) {
      const steps = b.local === b.sec.bars - 1 ? 1 : 2;
      if (s % steps === 0) e.hit('snare-tight', when, 0.15 + 0.5 * (s / 16) * (b.local === b.sec.bars - 1 ? 1 : 0.6), 1.05);
      if (b.local === b.sec.bars - 2 && s === 0) e.hit('riser', when, 0.18, 1, e.music);
    }
    // reese + sub on chord changes, re-struck for movement in the drop
    if (type === 'drop' || type === 'outro' || (type === 'build' && b.local < 4)) {
      if ((s === 0 && b.chordStart) || (type === 'drop' && s === 10 && r < 0.5)) {
        const len = s === 0 ? sd * 14 : sd * 5;
        const f = mtof(b.bass);
        for (const det of [-14, 14]) {
          e.note(e.reese, when, len, f, { wave: 'sawtooth', gain: 0.09, lp: 380, lpEnv: 700, lpDecay: len * 0.8, q: 2, a: 0.01, d: 0.4, s: 0.8, r: 0.08, detune1: det });
        }
        e.note(e.pumped, when, len, f / 2, { wave: 'sine', gain: 0.24, a: 0.01, d: 0.3, s: 0.9, r: 0.08 });
      }
      if (type === 'drop' && (s === 6 || s === 14) && r < 0.25) {
        for (const n of b.chord) e.note(e.music, when, sd * 0.8, mtof(n + 12), { wave: 'square', gain: 0.022, lp: 2200, lpEnv: 2000, lpDecay: 0.08, a: 0.002, d: 0.1, s: 0.2, send: 0.5 });
      }
    }
    // pads: intro & breakdown
    if ((type === 'intro' || type === 'breakdown' || type === 'build') && s === 0 && b.chordStart) {
      for (const n of b.chord) e.note(e.music, when, sd * 16 * song.chordBars, mtof(n), { wave: 'sawtooth', voices: 2, detune: 12, gain: 0.022, lp: 1600, a: 1.2, d: 1, s: 0.9, r: 1.2, send: 0.8 });
    }
    if (type === 'breakdown' && s % 4 === 0 && r < 0.35) {
      e.fm(e.music, when, sd * 3, mtof(b.chord[Math.floor(r * 4) % b.chord.length] + 24), { ratio: 3.5, index: 1.5, indexEnd: 0.1, gain: 0.035, s: 0.2, send: 0.9 });
    }
  },
  resume(e, song, k, when, barEnd) {
    const b = info(song, k);
    e.drumLP.frequency.setValueAtTime(b.sec.type === 'drop' ? e.ctx.sampleRate * 0.45 : b.sec.type === 'breakdown' ? 400 : 1500, when);
  },
  ident(e, when) {
    e.hit('riser', when - 0.6, 0.2, 1.6, e.music);
    e.hit('snare-tight', when + 0.6, 0.5, 1, e.drums, 0.6);
    e.fm(e.music, when + 0.6, 0.8, mtof(74), { ratio: 3.5, index: 3, indexEnd: 0.1, gain: 0.07, s: 0.3, send: 0.8 });
  }
};

const LOFI = {
  id: 'lofi', name: 'Ponsonby Lo-Fi 88.1', genre: 'Lo-fi Hip-Hop', seed: 53, slot: 150, level: 1.1, reverb: 0.3,
  setup(e) {
    // the dusty bus: rolled-off top, a little saturation, vinyl underneath
    const lp = e.filter('lowpass', 4600, 0.6);
    const shaper = e.ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
    }
    shaper.curve = curve;
    e.persistent.push(shaper);
    e.dusty = e.gain(1);
    e.drums.disconnect();
    e.drums.connect(e.drumLP);
    e.drumLP.disconnect();
    e.drumLP.connect(e.dusty);
    e.music.disconnect();
    e.music.connect(e.dusty);
    e.dusty.connect(lp).connect(shaper).connect(e.bus);
    e.vinylOn = false;
  },
  song(song, rand) {
    song.bpm = 72 + Math.floor(rand() * 14);
    song.swing = 0.18 + rand() * 0.12;
    song.root = 48 + pick(rand, [0, 2, 3, 5, 7, 8, 10]);
    song.scale = rand() < 0.5 ? SCALES.major : SCALES.dorian;
    song.chordBars = 1;
    song.chordSize = 4;
    song.progs = {
      verse: pick(rand, [[1, 4, 0, 5], [0, 5, 1, 4], [3, 2, 1, 0], [0, 2, 5, 4]]),
      chorus: pick(rand, [[3, 4, 2, 5], [1, 4, 0, 0], [5, 1, 4, 0]]), break: [3, 2]
    };
    song.template = [['intro', 4], ['verse', 16], ['chorus', 8], ['verse', 8], ['break', 4], ['chorus', 8], ['verse', 8], ['outro', 4]];
    song.wobble = 6 + rand() * 14;
    song.kick2 = pick(rand, [7, 10, 11]);
    song.motifDensity = 0.3;
  },
  step(e, song, k, when) {
    const s = k % 16;
    const b = info(song, k);
    const type = b.sec.type;
    const sd = song.stepDur;
    const r = mulberry(hash(song.slot, k, 13))();
    if (!e.vinylOn) {
      e.vinylOn = true;
      const src = e.ctx.createBufferSource();
      src.buffer = e.kit.get('vinyl', 0);
      src.loop = true;
      const g = e.ctx.createGain();
      g.gain.value = 0.22;
      src.connect(g).connect(e.bus);
      src.start(when);
      e.voices.track(src, [g]);
    }
    const drums = type === 'verse' || type === 'chorus';
    if (drums) {
      if (s === 0 || (s === song.kick2 && r < 0.85)) e.hit('kick-lofi', when, 0.58);
      if (s === 4 || s === 12) e.hit('snare-lofi', when, 0.5, 1, e.drums, 0.2);
      if (s % 2 === 0) e.hit('hat', when, (s % 4 === 2 ? 0.1 : 0.06) * (0.7 + r * 0.6), 0.92);
      else if (r < 0.12) e.hit('hat', when, 0.04, 0.92);
      if (s === 14 && r < 0.3) e.hit('rim', when, 0.2);
    }
    // detuned keys: the chord on the one, re-struck off the beat now and then
    if ((s === 0 || (s === 10 && r < 0.35 && type !== 'intro')) && type !== 'outro') {
      const detune = (mulberry(hash(song.slot, Math.floor(k / 16), 3))() - 0.5) * song.wobble;
      for (const n of b.chord) {
        e.fm(e.music, when + Math.random() * 0.012, sd * (s === 0 ? 14 : 5), mtof(n), { ratio: 1, index: 1.3, indexEnd: 0.15, indexTime: 0.7, gain: 0.032, a: 0.005, d: 1.6, s: 0.25, r: 0.4, detune1: detune, send: 0.35 });
      }
    }
    if (type === 'outro' && s === 0) for (const n of b.chord) e.fm(e.music, when, sd * 16, mtof(n), { ratio: 1, index: 1, indexEnd: 0.1, gain: 0.03, d: 2, s: 0.3, r: 1, send: 0.5 });
    // bass
    if (type !== 'intro' && type !== 'break') {
      if (s === 0) e.note(e.pumped, when, sd * 6, mtof(b.bass), { wave: 'triangle', gain: 0.22, lp: 520, a: 0.01, d: 0.3, s: 0.7, r: 0.1 });
      if (s === 10 && r < 0.6) e.note(e.pumped, when, sd * 3, mtof(b.bass + pick(mulberry(hash(k, 4)), [7, 12, 10, 5])), { wave: 'triangle', gain: 0.18, lp: 520, a: 0.01, d: 0.2, s: 0.6, r: 0.08 });
    }
    // a soft lead in the chorus
    if (type === 'chorus') {
      const m = motifAt(song, k, 12);
      if (m) e.note(e.music, when, m.len * sd, mtof(m.midi), { wave: 'triangle', gain: 0.05, lp: 2200, a: 0.03, d: 0.3, s: 0.6, r: 0.2, vib: [4.5, 9], send: 0.5 });
    }
  },
  ident(e, when) {
    for (const [i, n] of [64, 67, 71, 74].entries()) e.fm(e.music, when + i * 0.09, 0.9, mtof(n), { ratio: 1, index: 1.2, indexEnd: 0.1, gain: 0.05, d: 0.8, s: 0.2, send: 0.5 });
  }
};

const SURF = {
  id: 'surf', name: 'Piha Surf Radio 99.0', genre: 'Surf / Indie', seed: 71, slot: 160, level: 0.95, reverb: 0.5,
  song(song, rand) {
    const misirlou = rand() < 0.3;
    song.bpm = misirlou ? 160 + Math.floor(rand() * 10) : 140 + Math.floor(rand() * 22);
    song.root = 40 + pick(rand, [0, 2, 5, 7]) + 12;
    song.scale = misirlou ? SCALES.phrygianDominant : SCALES.major;
    song.chordBars = 1;
    song.progs = misirlou
      ? { verse: [0, 1, 0, 1], chorus: [5, 1, 0, 0], break: [0] }
      : { verse: pick(rand, [[0, 3, 4, 3], [0, 5, 3, 4], [0, 0, 3, 4]]), chorus: pick(rand, [[3, 4, 0, 5], [3, 0, 4, 4]]), break: [5, 4] };
    song.template = [['intro', 4], ['verse', 16], ['chorus', 8], ['verse', 16], ['break', 8], ['chorus', 16], ['outro', 4]];
    song.walk = pick(rand, [[0, 0, 2, 4, 5, 4, 2, 0], [0, 4, 7, 4, 0, 4, 7, 9], [0, 2, 4, 2, 0, 7, 5, 4]]);
    song.tremolo = misirlou || rand() < 0.6;
    song.motifDensity = 0.55;
  },
  step(e, song, k, when) {
    const s = k % 16;
    const b = info(song, k);
    const type = b.sec.type;
    const sd = song.stepDur;
    const r = mulberry(hash(song.slot, k, 17))();
    const full = type !== 'intro' && type !== 'break';
    if (full && type !== 'outro') {
      if (s === 0 || s === 8 || (s === 10 && r < 0.3)) e.hit('kick-rock', when, 0.62);
      if (s === 4 || s === 12) e.hit('snare-rock', when, 0.6, 1, e.drums, 0.3);
      if (s % 2 === 0) e.hit(type === 'chorus' ? 'ride' : 'hat', when, s % 4 === 0 ? 0.18 : 0.12);
      if (type === 'chorus' && b.local === 0 && s === 0) e.hit('crash', when, 0.3);
    }
    if (type === 'break' && s % 4 === 0) e.hit('tom', when, 0.4, 0.9);
    if (b.last && type !== 'outro' && s >= 8) e.hit('tom', when, 0.35 + (s - 8) * 0.03, 1.35 - (s - 8) * 0.06, e.drums, 0.2);
    // bass walks in eighths
    if (type !== 'intro' && s % 2 === 0) {
      const deg = b.deg + song.walk[s / 2];
      e.pluck(e.music, when, mtof(degree(song.root - 12, song.scale, deg)), 0.26, sd * 1.8);
    }
    // rhythm guitar: palm-muted chord chops on the off-beats
    if (full && s % 4 === 2) {
      b.chord.forEach((n, i) => e.pluck(e.music, when + i * 0.009, mtof(n), 0.07, sd * 1.2, 0.3));
    }
    if (type === 'intro' && s === 0) b.chord.forEach((n, i) => e.pluck(e.music, when + i * 0.03, mtof(n), 0.1, sd * 14, 0.6));
    // lead: tremolo-picked melody in the chorus (or single picks), drenched in spring reverb
    if (type === 'chorus' || type === 'break' || (type === 'verse' && b.local % 8 >= 4)) {
      const m = motifAt(song, k, 12);
      if (m) {
        e.leadNote = m;
        e.leadEnd = k + m.len;
      }
      const ln = e.leadNote && k < e.leadEnd ? e.leadNote : null;
      if (ln && song.tremolo && type !== 'verse') e.pluck(e.music, when, mtof(ln.midi), s % 2 ? 0.07 : 0.1, sd * 1.1, 0.7);
      else if (m) e.pluck(e.music, when, mtof(m.midi), 0.12, m.len * sd, 0.6);
    }
  },
  ident(e, when) {
    [64, 68, 71, 76].forEach((n, i) => e.pluck(e.music, when + i * 0.05, mtof(n), 0.12, 1.2, 0.8));
    e.hit('snare-rock', when, 0.4, 1, e.drums, 0.8);
  }
};

// ---- TALKBACK: hosts, callers on a phone line, jingles and an ad break; a plan of events per slot ----------------
const TALK_VOICES = ['hostA', 'hostB', 'callerA', 'callerB'];
const TALK = {
  id: 'talk', name: 'Talkback Tāmaki 702AM', genre: 'Talkback', seed: 97, slot: 140, level: 1.05, reverb: 0.05, talk: true,
  setup(e) {
    // the caller's telephone line
    const hp = e.filter('highpass', 420, 0.8), lp = e.filter('lowpass', 3100, 0.9), pk = e.filter('peaking', 1500, 1, 5);
    e.phone = e.gain(1.3);
    e.phone.connect(hp).connect(pk).connect(lp).connect(e.bus);
    e.voice = e.gain(1);
    e.voice.connect(e.bus);
    e.plans = new Map();
  },
  plan(slot) {
    const rand = mulberry(hash(this.seed, slot, 3));
    const ev = []; // [t, kind, a, b, c] kinds: 0 syllable (voice, variant, rate, gain/phone), 1 jingle, 2 ad bed (end)
    let t = 0.3;
    ev.push({ t, k: 1 });
    t += 3.4;
    const host = rand() < 0.5 ? 'hostA' : 'hostB';
    const other = host === 'hostA' ? 'hostB' : 'hostA';
    const phrases = (who, seconds, phone = false, excited = 0) => {
      const end = t + seconds;
      while (t < end) {
        const n = 3 + Math.floor(rand() * 9);
        const question = rand() < 0.2;
        const base = 0.96 + rand() * 0.08 + excited * 0.08;
        for (let i = 0; i < n; i++) {
          const p = i / n;
          const rate = base * (1.06 - 0.12 * p + (question && p > 0.7 ? (p - 0.7) * 0.6 : 0) + (rand() - 0.5) * 0.06);
          ev.push({ t, k: 0, who, v: Math.floor(rand() * 14), rate, gain: 0.8 + rand() * 0.3, phone });
          t += (0.15 + rand() * 0.08) / (1 + excited * 0.25);
        }
        t += 0.22 + rand() * 0.45;
      }
    };
    while (t < this.slot - 8) {
      const kind = rand();
      if (kind < 0.3) phrases(host, 10 + rand() * 14);
      else if (kind < 0.6) { // a caller
        const caller = rand() < 0.5 ? 'callerA' : 'callerB';
        phrases(host, 3 + rand() * 3);
        for (let turn = 0; turn < 3 + Math.floor(rand() * 4); turn++) {
          phrases(caller, 3 + rand() * 7, true);
          t += 0.2;
          phrases(host, 1.5 + rand() * 4);
          t += 0.2;
        }
      } else if (kind < 0.8) { // banter
        for (let turn = 0; turn < 4 + Math.floor(rand() * 4); turn++) {
          phrases(turn % 2 ? other : host, 1.5 + rand() * 4);
          t += 0.1;
        }
      } else { // an ad: a bed under an excited voice, a jingle after
        const start = t;
        t += 0.8;
        phrases(other, 9 + rand() * 6, false, 1);
        ev.push({ t: start, k: 2, end: t + 0.8, seed: Math.floor(rand() * 1e6) });
        t += 1;
        ev.push({ t, k: 1 });
        t += 3.4;
      }
      t += 0.6;
    }
    ev.sort((a, b) => a.t - b.t);
    return ev;
  },
  schedule(e, t0, t1, offset) {
    const s0 = t0 + offset, s1 = t1 + offset;
    for (let slot = Math.floor(s0 / this.slot); slot * this.slot < s1; slot++) {
      let plan = e.plans.get(slot);
      if (!plan) {
        if (e.plans.size > 2) e.plans.clear();
        e.plans.set(slot, (plan = this.plan(slot)));
      }
      const base = slot * this.slot;
      // (binary search the first event at or after s0)
      let lo = 0, hi = plan.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (base + plan[mid].t < s0) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < plan.length && base + plan[i].t < s1; i++) {
        const ev = plan[i];
        const when = base + ev.t - offset;
        if (ev.k === 0) e.hit(`syl-${ev.who}`, when, ev.gain * 0.75, ev.rate, ev.phone ? e.phone : e.voice, 0, e.sfx, ev.v);
        else if (ev.k === 1) this.jingle(e, when);
      }
      // ad beds playing in this window: a bouncy 116 bpm loop
      for (const ev of plan) {
        if (ev.k !== 2 || base + ev.end < s0 || base + ev.t >= s1) continue;
        const sd = 60 / 116 / 4;
        const from = Math.max(0, Math.floor((s0 - base - ev.t) / sd));
        for (let k = from; ; k++) {
          const st = base + ev.t + k * sd;
          if (st >= s1 || st >= base + ev.end) break;
          if (st < s0) continue;
          this.bed(e, k, st - offset, sd, ev.seed);
        }
      }
    }
  },
  bed(e, k, when, sd, seed) {
    const s = k % 16;
    const root = 53 + (seed % 5);
    const prog = [0, 5, 3, 4];
    const deg = prog[Math.floor(k / 16) % 4];
    if (s % 4 === 0) e.hit('kick', when, 0.35);
    if (s === 4 || s === 12) e.hit('clap', when, 0.25);
    if (s % 2 === 0) e.hit('hat', when, 0.08);
    if (s % 4 === 2) e.note(e.music, when, sd * 1.4, mtof(degree(root - 12, SCALES.major, deg)), { wave: 'square', gain: 0.06, lp: 700, a: 0.003, d: 0.1, s: 0.4 });
    if ((s === 0 || s === 6 || s === 10) && (k >> 4) % 2 === 1) {
      e.fm(e.music, when, sd * 2, mtof(degree(root + 12, SCALES.major, deg + [0, 2, 4][s % 3])), { ratio: 3.5, index: 1.4, indexEnd: 0.1, gain: 0.03, s: 0.2 });
    }
  },
  jingle(e, when) {
    e.hit('riser', when - 0.3, 0.12, 2, e.music);
    const notes = [60, 64, 67, 72, 76];
    notes.forEach((n, i) => e.fm(e.music, when + 0.3 + i * 0.1, 0.6, mtof(n + 12), { ratio: 2, index: 2, indexEnd: 0.2, gain: 0.06, s: 0.3, send: 0.4 }));
    for (const n of [60, 64, 67, 72]) e.note(e.music, when + 0.8, 1.6, mtof(n), { wave: 'sawtooth', voices: 2, detune: 8, gain: 0.025, lp: 2400, a: 0.05, d: 0.6, s: 0.7, r: 0.6, send: 0.5 });
    e.hit('kick', when + 0.8, 0.5);
    e.hit('crash', when + 0.8, 0.2);
  }
};

// ---- POLICE BAND: dispatcher and units, squelch and hiss ------------------------------------------------------------
const POLICE = {
  id: 'police', name: 'Police Band', genre: 'Scanner', seed: 113, slot: 40, level: 0.9, reverb: 0, police: true,
  setup(e) {
    e.hissOn = false;
  },
  schedule(e, t0, t1, offset) {
    const s0 = t0 + offset, s1 = t1 + offset;
    if (!e.hissOn) {
      e.hissOn = true;
      const src = e.ctx.createBufferSource();
      src.buffer = e.kit.get('vinyl', 0);
      src.loop = true;
      src.playbackRate.value = 2.6;
      const bp = e.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      const g = e.ctx.createGain();
      g.gain.value = 0.05;
      src.connect(bp).connect(g).connect(e.bus);
      src.start(t0);
      e.voices.track(src, [bp, g]);
    }
    for (let slot = Math.floor(s0 / this.slot); slot * this.slot < s1; slot++) {
      const rand = mulberry(hash(this.seed, slot));
      let t = slot * this.slot + rand() * 3;
      while (t < (slot + 1) * this.slot) {
        if (t >= s0 && t < s1) e.hit('chatter', t - offset, 0.9, 1, e.bus, 0, e.sfx, Math.floor(rand() * 8));
        t += 2.6 + rand() * 6.5;
      }
    }
  }
};

export const STATIONS = [SYNTHWAVE, DUB, DNB, LOFI, SURF, TALK];
export const POLICE_BAND = POLICE;

/** Starts a station's engine into `out` (fx.reverb: the radio's reverb send). Engines are cheap to make and drop */
export function createStation(def, ctx, banks, out, fx) {
  return new Engine(def, ctx, banks, out, fx);
}

/**
 * Lookahead scheduler: tick() asks for everything in [scheduled, now + ahead). A 25 ms timer drives it, and the game
 * loop calls tick() too, so a throttled timer never leaves a gap; a late tick skips the past instead of cramming it.
 */
export class Scheduler {
  constructor(ctx, run, { ahead = 0.12, interval = 25 } = {}) {
    this.ctx = ctx;
    this.run = run; // run(t0, t1)
    this.ahead = ahead;
    this.until = 0;
    this.timer = setInterval(() => this.tick(), interval);
  }

  tick() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const end = now + this.ahead;
    if (this.until < now) this.until = now + 0.005; // (late: skip what is already past)
    if (end <= this.until) return;
    const from = this.until;
    this.until = end;
    this.run(from, end);
  }

  dispose() {
    clearInterval(this.timer);
  }
}
