// The game's one-shot sounds and loops, synthesized in plain JS into AudioBuffers (no audio files): the sounds of a
// caper — swings and punches and the cricket bat's knock, impacts by material, a few foley clicks, vehicle doors /
// starts / alarms / tyres / backfires and a holed radiator's hiss, pickups, UI blips, musical stingers and
// formant-synth voices (screams, shouts, pain, gibberish speech for megaphones, police radio and talkback radio).
// No gunshots and no explosions: the game has neither.
// AudioBuffers are built with the AudioBuffer constructor, so a bank can be rendered before any AudioContext exists
// (during loading, in time slices) and played in the live context and in OfflineAudioContexts (game/audio.js
// selfTest) alike. The small DSP kit at the top is shared with audio-music.js (drum kits, plucks).

const TAU = Math.PI * 2;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/** Deterministic PRNG (mulberry32): () -> [0, 1) */
export function mulberry(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of a few numbers, for seeding mulberry from (station, song, bar...) */
export function hash(...values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    h = Math.imul(h ^ (Math.floor(v) | 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
  }
  return (h ^ (h >>> 15)) >>> 0;
}

/** Attack/decay envelope: rises with time constant a, falls with time constant d (seconds) */
export const env = (t, a, d) => (t < 0 ? 0 : (1 - Math.exp(-t / a)) * Math.exp(-t / d));

/** RBJ biquad on samples (transposed direct form II); retune with set() (every few samples for sweeps) */
export class Biquad {
  constructor(sr, type = 'lowpass', f = 1000, q = 0.707, gainDb = 0) {
    this.sr = sr;
    this.z1 = this.z2 = 0;
    this.set(type, f, q, gainDb);
  }

  set(type, f, q = 0.707, gainDb = 0) {
    const w = TAU * clamp(f, 10, this.sr * 0.47) / this.sr;
    const cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'bandpass') {
      b0 = alpha * q; b1 = 0; b2 = -alpha * q; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; // (peak gain Q: lively noise)
    } else if (type === 'peaking') {
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    } else { // highshelf
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** A decaying two-pole resonance (a struck mode): excite with run(impulse) */
export class Mode {
  constructor(sr, f, tau, gain = 1) {
    const r = Math.exp(-1 / (tau * sr));
    const w = TAU * Math.min(f, sr * 0.47) / sr;
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = r * r;
    this.g = gain * Math.sin(w) * 2 * (1 - r) * 12;
    this.y1 = this.y2 = 0;
  }

  run(x) {
    const y = x * this.g + this.a1 * this.y1 - this.a2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** One-pole lowpass coefficient for a cutoff */
export const onePole = (f, sr) => 1 - Math.exp(-TAU * f / sr);

/** PolyBLEP sawtooth for phase p (0..1) advancing dt per sample: few aliases, few operations */
export function blepSaw(p, dt) {
  let v = 2 * p - 1;
  if (p < dt) {
    const x = p / dt;
    v -= x + x - x * x - 1;
  } else if (p > 1 - dt) {
    const x = (p - 1) / dt;
    v -= x * x + x + x + 1;
  }
  return v;
}

/** Removes DC, fades the ends against clicks and scales the peak; returns the data */
export function finish(data, sr, peak = 0.8, fadeOut = 0.01) {
  const k = onePole(18, sr);
  let lp = 0, max = 0;
  for (let i = 0; i < data.length; i++) {
    lp += (data[i] - lp) * k;
    data[i] -= lp;
  }
  const fi = Math.max(1, Math.round(sr * 0.0006)), fo = Math.max(1, Math.round(sr * fadeOut));
  for (let i = 0; i < data.length; i++) {
    const f = Math.min(1, i / fi, (data.length - 1 - i) / fo);
    data[i] *= f;
    if (!Number.isFinite(data[i])) data[i] = 0;
    max = Math.max(max, Math.abs(data[i]));
  }
  if (max > 0 && peak > 0) for (let i = 0; i < data.length; i++) data[i] *= peak / max;
  return data;
}

/** Seamless loop: the rendered tail beyond `length` is cross-faded into the head (equal power) */
export function loopify(data, length, sr, peak = 0.8) {
  const x = data.length - length;
  const out = new Float32Array(length);
  out.set(data.subarray(0, length));
  for (let i = 0; i < x; i++) {
    const f = i / x;
    out[i] = out[i] * Math.sin(f * Math.PI / 2) + data[length + i] * Math.cos(f * Math.PI / 2);
  }
  let mean = 0, max = 0;
  for (let i = 0; i < length; i++) mean += out[i];
  mean /= length;
  for (let i = 0; i < length; i++) {
    out[i] -= mean;
    max = Math.max(max, Math.abs(out[i]));
  }
  if (max > 0) for (let i = 0; i < length; i++) out[i] *= peak / max;
  return out;
}

export function toBuffer(data, sr) {
  const buffer = new AudioBuffer({ length: Math.max(1, data.length), sampleRate: sr, numberOfChannels: 1 });
  buffer.copyToChannel(data, 0);
  return buffer;
}

// =====================================================================================================================
// VOICES: a glottal pulse through formant resonators (after audio-events.js's speech fragments), with per-sample
// pitch, vowel and breath control so one routine makes screams, shouts, grunts and gibberish syllables
// =====================================================================================================================
export const VOWELS = {
  a: [730, 1090, 2440, 3400], e: [530, 1840, 2480, 3500], i: [300, 2250, 3010, 3700], o: [570, 840, 2410, 3400],
  u: [320, 870, 2240, 3300], ae: [700, 1700, 2410, 3400], uh: [640, 1190, 2390, 3400], er: [490, 1350, 1690, 3300]
};
const VOWEL_KEYS = Object.keys(VOWELS);
// voices: base pitch (Hz), formant scale, breathiness
export const SPEAKERS = {
  hostA: { f0: 104, fs: 0.92, breath: 0.05 },
  hostB: { f0: 196, fs: 1.13, breath: 0.09 },
  callerA: { f0: 132, fs: 0.98, breath: 0.08 },
  callerB: { f0: 232, fs: 1.18, breath: 0.12 },
  cop: { f0: 112, fs: 0.95, breath: 0.07 },
  dispatch: { f0: 205, fs: 1.12, breath: 0.08 }
};

/**
 * One voiced utterance into out: o.f0(t) Hz, o.vowel(t, F) fills F with 4 formant Hz, o.amp(t) 0..1, o.noise(t)
 * consonant/aspiration noise 0..1, o.breath, o.jitter, o.rough (period-doubling growl for screams)
 */
function formantVoice(out, sr, rand, o, offset = 0, gain = 1) {
  const F = [500, 1500, 2500, 3500];
  const bw = o.bw || [80, 110, 160, 220];
  const fg = [1, 0.62, 0.32, 0.16];
  const res = F.map(() => ({ a1: 0, a2: 0, g: 0, y1: 0, y2: 0 }));
  let phase = rand(), lastFlow = 0, jit = 1, shim = 1, breath = 0, hiss = 0, cycle = 0;
  const kb = onePole(2200, sr), kh = onePole(5200, sr);
  const n = Math.min(out.length - offset, Math.ceil(o.dur * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 15) === 0) {
      o.vowel(t, F);
      for (let k = 0; k < 4; k++) {
        const r = Math.exp(-Math.PI * bw[k] / sr);
        const w = TAU * Math.min(F[k], sr * 0.45) / sr;
        res[k].a1 = 2 * r * Math.cos(w);
        res[k].a2 = r * r;
        res[k].g = (1 - r) * fg[k];
      }
    }
    const f0 = Math.max(40, o.f0(t)) * jit;
    phase += f0 / sr;
    if (phase >= 1) {
      phase -= 1;
      cycle++;
      jit = 1 + (rand() - 0.5) * (o.jitter ?? 0.02);
      shim = 1 + (rand() - 0.5) * (o.shimmer ?? 0.12);
      if (o.rough && cycle % 2) shim *= 1 - o.rough;
    }
    const open = 0.58, close = 0.17;
    const flow = phase < open ? 0.5 - 0.5 * Math.cos(Math.PI * phase / open)
      : phase < open + close ? Math.cos(0.5 * Math.PI * (phase - open) / close) : 0;
    const pulse = (flow - lastFlow) * sr / f0 * 0.25 * shim;
    lastFlow = flow;
    const white = rand() * 2 - 1;
    breath += (white - breath) * kb;
    hiss += (white - hiss) * kh;
    const amp = o.amp(t);
    const voiced = o.voiced ? o.voiced(t) : 1;
    const exc = (pulse * voiced + breath * (o.breath ?? 0.06) * 3) * amp;
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const r = res[k];
      const y = exc + r.a1 * r.y1 - r.a2 * r.y2;
      r.y2 = r.y1;
      r.y1 = y;
      v += y * r.g;
    }
    const fric = o.noise ? o.noise(t) * (white - hiss * 0.6) * 0.5 : 0;
    out[offset + i] += (v * 6 + fric) * gain;
  }
  return n;
}

const vowelLerp = (a, b, f, scale, F) => {
  for (let k = 0; k < 4; k++) F[k] = (a[k] + (b[k] - a[k]) * f) * scale;
};

/**
 * Gibberish speech: syllables (consonant onset + vowel glide) with phrase prosody. Returns seconds used.
 * opts: { syllables, rate (syl/s), question, emphasis }
 */
export function speak(out, sr, rand, speaker, opts = {}, offset = 0, gain = 1) {
  const count = opts.syllables ?? 4 + Math.floor(rand() * 5);
  const rate = opts.rate ?? 5.2;
  const segs = [];
  let t = 0.02;
  for (let s = 0; s < count; s++) {
    const dur = (0.6 + rand() * 0.7) / rate;
    const cons = rand() < 0.75 ? Math.floor(rand() * 4) : -1; // 0 plosive, 1 fricative, 2 nasal, 3 h, -1 none
    segs.push({ t, dur, cons, vowel: VOWELS[VOWEL_KEYS[Math.floor(rand() * VOWEL_KEYS.length)]], stress: 0.65 + rand() * 0.35 });
    t += dur + (rand() < 0.18 && s < count - 1 ? 0.06 + rand() * 0.1 : 0.004);
  }
  const total = t + 0.05;
  const pitchVar = 0.08 + rand() * 0.08;
  const lastVowel = segs[0].vowel;
  let si = 0;
  formantVoice(out, sr, rand, {
    dur: total,
    breath: speaker.breath,
    jitter: 0.025,
    f0: (tt) => {
      const p = tt / total;
      // declination, a stressed peak per syllable, and a rise at the end of a question
      const seg = segs[Math.min(si, segs.length - 1)];
      const local = clamp((tt - seg.t) / seg.dur);
      const bump = Math.sin(Math.PI * local) * pitchVar * seg.stress;
      const end = opts.question ? Math.max(0, p - 0.75) * 1.6 : -Math.max(0, p - 0.7) * 0.5;
      return speaker.f0 * (1.08 - 0.14 * p + bump + end + (opts.emphasis || 0));
    },
    vowel: (tt, F) => {
      while (si + 1 < segs.length && tt >= segs[si + 1].t) si++;
      const seg = segs[si], prev = si > 0 ? segs[si - 1].vowel : lastVowel;
      const local = tt - seg.t;
      const glide = clamp(local / 0.05);
      const nasal = seg.cons === 2 && local < 0.05;
      if (nasal) {
        F[0] = 260 * speaker.fs; F[1] = 1100 * speaker.fs; F[2] = 2300 * speaker.fs; F[3] = 3300 * speaker.fs;
      } else vowelLerp(prev, seg.vowel, glide, speaker.fs, F);
    },
    voiced: (tt) => {
      const seg = segs[si];
      const local = tt - seg.t;
      if (local > seg.dur) return 0; // (a pause)
      if (seg.cons === 0) return local < 0.035 ? 0 : clamp((local - 0.035) / 0.02);
      if (seg.cons === 1 || seg.cons === 3) return clamp((local - 0.05) / 0.03);
      return 1;
    },
    amp: (tt) => {
      const seg = segs[si];
      const local = tt - seg.t;
      if (local > seg.dur) return clamp(1 - (local - seg.dur) / 0.02) * 0.5;
      return seg.stress * clamp(local / 0.015) * clamp((seg.dur - local) / 0.04 + 0.25);
    },
    noise: (tt) => {
      const seg = segs[si];
      const local = tt - seg.t;
      if (seg.cons === 0) return local > 0.03 && local < 0.045 ? 1.6 : 0;
      if (seg.cons === 1) return local < 0.06 ? 0.9 * clamp(local / 0.01) : 0;
      if (seg.cons === 3) return local < 0.05 ? 0.35 : 0;
      return 0;
    }
  }, offset, gain);
  return total;
}

// =====================================================================================================================
// RECIPES: name -> { dur, sr, variants, peak, loop, render(out, sr, rand, variant) }. Rendered once each (per variant)
// =====================================================================================================================
const R = {};

// ---- SWINGS ----------------------------------------------------------------------------------------------------------
// an arm (or a bat) through the air: band-passed noise sweeping up and back down
function whoosh(out, sr, rand, len, f0, f1, q = 1.1) {
  const bp = new Biquad(sr, 'bandpass', f0, q);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const p = clamp(t / len);
    if ((i & 31) === 0) bp.set('bandpass', f0 + (f1 - f0) * Math.sin(Math.PI * p), q);
    out[i] = bp.run(rand() * 2 - 1) * Math.pow(Math.sin(Math.PI * p), 2);
  }
}

// ---- IMPACTS by material ------------------------------------------------------------------------------------------------
R['impact-concrete'] = {
  dur: 0.32, variants: 3, peak: 0.85,
  render(out, sr, rand) {
    const hp = new Biquad(sr, 'highpass', 2500, 0.7), bp = new Biquad(sr, 'bandpass', 1800 + rand() * 1200, 0.8);
    let ph = 0, grit = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      ph += TAU * 190 / sr;
      if (rand() < 0.012 * Math.exp(-t / 0.05) * (48000 / sr)) grit = 0.2 + rand() * 0.4;
      grit *= 0.996;
      out[i] = hp.run(n) * (env(t, 0.0002, 0.005) * 1.2 + grit) + bp.run(n) * env(t, 0.0005, 0.02) * 0.8 + Math.sin(ph) * env(t, 0.001, 0.02) * 0.4;
    }
  }
};
R['impact-metal'] = {
  dur: 0.6, variants: 3, peak: 0.8,
  render(out, sr, rand) {
    const k = 0.8 + rand() * 0.4;
    const modes = [[1250, 0.22, 1], [2730, 0.14, 0.7], [3910, 0.09, 0.5], [5240, 0.06, 0.35], [760, 0.1, 0.4]]
      .map(([f, tau, g]) => new Mode(sr, f * k * (0.95 + rand() * 0.1), tau, g));
    const hp = new Biquad(sr, 'highpass', 3000, 0.7);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      const ex = t < 0.002 ? n * (1 - t / 0.002) : 0;
      let v = 0;
      for (const m of modes) v += m.run(ex);
      out[i] = v * 6 + hp.run(n) * env(t, 0.0002, 0.004) * 0.25; // (the ring carries it; the click only marks the hit)
    }
  }
};
R['impact-glass'] = {
  dur: 0.8, variants: 3, peak: 0.75,
  render(out, sr, rand) {
    const pings = Array.from({ length: 26 }, () => ({ t: 0.004 + rand() ** 2 * 0.6, f: 3000 + rand() * 6000, tau: 0.008 + rand() * 0.04, a: 0.2 + rand() * 0.6 }));
    const hp = new Biquad(sr, 'highpass', 2500, 0.7);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      let v = hp.run(n) * (env(t, 0.0003, 0.05) * 0.9);
      for (const p of pings) {
        const lt = t - p.t;
        if (lt > 0 && lt < p.tau * 6) v += Math.sin(TAU * p.f * lt) * Math.exp(-lt / p.tau) * p.a * (1 - p.t);
      }
      out[i] = v;
    }
  }
};
R['impact-flesh'] = { // tasteful: a soft, dull thud
  dur: 0.22, variants: 2, peak: 0.7,
  render(out, sr, rand) {
    const lp = new Biquad(sr, 'lowpass', 520, 0.7);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      ph += TAU * (85 + 40 * Math.exp(-t / 0.01)) / sr;
      out[i] = lp.run(rand() * 2 - 1) * env(t, 0.001, 0.028) * 1.4 + Math.sin(ph) * env(t, 0.002, 0.045) * 0.7;
    }
  }
};
R['impact-dirt'] = {
  dur: 0.4, variants: 2, peak: 0.7,
  render(out, sr, rand) {
    const lp = new Biquad(sr, 'lowpass', 320, 0.7), bp = new Biquad(sr, 'bandpass', 1500 + rand() * 600, 0.7);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      out[i] = lp.run(n) * env(t, 0.001, 0.04) * 1.8 + bp.run(n) * env(t, 0.004, 0.09) * (0.6 + 0.4 * Math.sin(t * 300 + rand()));
    }
  }
};
R['impact-water'] = {
  dur: 0.5, variants: 2, peak: 0.7,
  render(out, sr, rand) {
    const bp = new Biquad(sr, 'bandpass', 2600, 0.8);
    let ph = 0;
    const drops = Array.from({ length: 6 }, () => ({ t: 0.05 + rand() * 0.3, f: 900 + rand() * 1500 }));
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      ph += TAU * (300 + 1100 * clamp(t / 0.07)) / sr;
      let v = Math.sin(ph) * env(t, 0.002, 0.05) * 0.7 + bp.run(rand() * 2 - 1) * env(t, 0.003, 0.11);
      for (const d of drops) {
        const lt = t - d.t;
        if (lt > 0 && lt < 0.05) v += Math.sin(TAU * d.f * (1 + lt * 8) * lt) * Math.exp(-lt / 0.012) * 0.25;
      }
      out[i] = v;
    }
  }
};
// ---- MELEE ------------------------------------------------------------------------------------------------------
R['whoosh'] = { dur: 0.32, variants: 3, peak: 0.55, render(out, sr, rand) { whoosh(out, sr, rand, 0.2 + rand() * 0.1, 400 + rand() * 200, 1700 + rand() * 600); } };
R['punch'] = {
  dur: 0.25, variants: 3, peak: 0.85,
  render(out, sr, rand) {
    const lp = new Biquad(sr, 'lowpass', 900, 0.7), hp = new Biquad(sr, 'highpass', 2500, 0.7);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      ph += TAU * (48 + 40 * Math.exp(-t / 0.02)) / sr;
      out[i] = Math.tanh(Math.sin(ph) * env(t, 0.001, 0.05) * 1.1 + lp.run(n) * env(t, 0.0005, 0.02) * 1.2 + hp.run(n) * env(t, 0.0003, 0.004) * 0.5);
    }
  }
};
R['bat'] = {
  dur: 0.35, variants: 2, peak: 0.85,
  render(out, sr, rand) {
    const modes = [[420, 0.045], [1130, 0.025], [2250, 0.015]].map(([f, tau]) => new Mode(sr, f * (0.9 + rand() * 0.2), tau, 1));
    const lp = new Biquad(sr, 'lowpass', 700, 0.7);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      const ex = t < 0.0015 ? n : 0;
      let v = 0;
      for (const m of modes) v += m.run(ex);
      out[i] = v * 0.5 + lp.run(n) * env(t, 0.001, 0.03) * 1.2;
    }
  }
};

// ---- FOLEY ---------------------------------------------------------------------------------------------------------------
// clicks and scrapes placed in time: [time, 'click'|'scrape'|'thud'|'rustle', strength, pitch] (car doors use it too)
function foley(out, sr, rand, events) {
  for (const [at, kind, amp, pitch = 1] of events) {
    const start = Math.floor(at * sr);
    if (kind === 'click') {
      const m1 = new Mode(sr, 3300 * pitch * (0.9 + rand() * 0.2), 0.009, 1), m2 = new Mode(sr, 5600 * pitch, 0.006, 0.6);
      const m3 = new Mode(sr, 1500 * pitch, 0.012, 0.5);
      for (let i = 0; i < sr * 0.06 && start + i < out.length; i++) {
        const t = i / sr;
        const ex = t < 0.0008 ? (rand() * 2 - 1) : 0;
        out[start + i] += (m1.run(ex) + m2.run(ex) + m3.run(ex)) * amp * 0.5;
      }
    } else if (kind === 'scrape') {
      const bp = new Biquad(sr, 'bandpass', 2600 * pitch, 1.4);
      const len = 0.06 * (pitch > 1 ? 0.8 : 1.3);
      for (let i = 0; i < sr * len && start + i < out.length; i++) {
        const t = i / sr;
        out[start + i] += bp.run(rand() * 2 - 1) * Math.sin(Math.PI * t / len) * amp * (0.7 + 0.3 * Math.sin(t * 900));
      }
    } else if (kind === 'rustle') {
      const lp = new Biquad(sr, 'bandpass', 1400, 0.6);
      for (let i = 0; i < sr * 0.18 && start + i < out.length; i++) {
        const t = i / sr;
        out[start + i] += lp.run(rand() * 2 - 1) * Math.sin(Math.PI * t / 0.18) * amp * (0.5 + 0.5 * Math.abs(Math.sin(t * 70)));
      }
    } else { // thud
      const lp = new Biquad(sr, 'lowpass', 420 * pitch, 0.8);
      for (let i = 0; i < sr * 0.08 && start + i < out.length; i++) {
        const t = i / sr;
        out[start + i] += lp.run(rand() * 2 - 1) * env(t, 0.001, 0.02) * amp * 2;
      }
    }
  }
}
const FOLEY = {
  'click': [0.08, [[0, 'click', 1]]],
  'switch': [0.3, [[0, 'rustle', 0.5], [0.15, 'thud', 0.5, 1.2]]] // (the bat out of the hand, or into it)
};
for (const [name, [dur, events]] of Object.entries(FOLEY)) {
  R[name] = { dur, variants: 2, peak: 0.7, render(out, sr, rand) { foley(out, sr, rand, events); } };
}

// ---- VEHICLES ------------------------------------------------------------------------------------------------------
R['door-open'] = {
  dur: 0.45, variants: 2, peak: 0.6,
  render(out, sr, rand) {
    foley(out, sr, rand, [[0, 'click', 0.9, 0.6], [0.02, 'thud', 0.3, 1.4]]);
    const bp = new Biquad(sr, 'bandpass', 420, 4);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr - 0.05;
      if (t > 0 && t < 0.35) out[i] += bp.run((rand() * 2 - 1) * (0.5 + 0.5 * Math.sin(t * 130))) * Math.sin(Math.PI * t / 0.35) * 0.25;
    }
  }
};
R['door-close'] = {
  dur: 0.5, variants: 2, peak: 0.85, sr: 32000,
  render(out, sr, rand) {
    const lp = new Biquad(sr, 'lowpass', 260, 0.8);
    const panel = new Mode(sr, 520 + rand() * 160, 0.05, 1);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      ph += TAU * (62 + 30 * Math.exp(-t / 0.02)) / sr;
      out[i] = lp.run(n) * env(t, 0.002, 0.06) * 2 + Math.sin(ph) * env(t, 0.003, 0.08) * 0.9 + panel.run(t < 0.002 ? n : 0) * 0.3;
    }
    foley(out, sr, rand, [[0.012, 'click', 0.7, 0.7]]);
  }
};
R['engine-start'] = { // starter motor cranking against compression, then the engine catches
  dur: 1.5, variants: 2, peak: 0.75, fadeOut: 0.3, sr: 32000,
  render(out, sr, rand) {
    const crankEnd = 0.6 + rand() * 0.3;
    const lp = new Biquad(sr, 'lowpass', 300, 0.8), lp2 = new Biquad(sr, 'lowpass', 900, 0.7);
    let ph = 0, cph = 0, fire = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      const crankRate = 6.5 + 2 * clamp(t / crankEnd);
      cph += crankRate / sr;
      const comp = 0.5 + 0.5 * Math.cos(TAU * cph);
      ph += TAU * (720 + 120 * comp) / sr;
      let v = 0;
      if (t < crankEnd + 0.05) {
        const fade = clamp((crankEnd + 0.05 - t) / 0.05);
        v += (Math.sin(ph) * 0.18 + Math.sin(ph * 2.01) * 0.08) * (0.4 + 0.6 * comp) * fade; // starter whine
        v += lp.run(n) * comp * comp * 1.2 * fade; // compression strokes
      }
      if (t >= crankEnd) { // catches: firing pulses accelerating, then settling
        const lt = t - crankEnd;
        const rate = 14 + 30 * clamp(lt / 0.25) - 12 * clamp((lt - 0.25) / 0.4);
        fire += rate / sr;
        const pulse = Math.pow(0.5 + 0.5 * Math.cos(TAU * fire), 6);
        v += lp2.run(n) * pulse * 2.2 * env(lt, 0.01, 0.6);
      }
      out[i] = Math.tanh(v * 1.4);
    }
  }
};
R['bail'] = { // thrown out at speed: tumbling thuds and a scrape along the tarmac
  dur: 1.2, variants: 2, peak: 0.8, fadeOut: 0.2, sr: 32000,
  render(out, sr, rand) {
    foley(out, sr, rand, [[0, 'thud', 1.4, 0.8], [0.22 + rand() * 0.05, 'thud', 1, 0.9], [0.48 + rand() * 0.08, 'thud', 0.7, 1]]);
    const bp = new Biquad(sr, 'bandpass', 1100, 0.9);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] += bp.run(rand() * 2 - 1) * env(t - 0.05, 0.05, 0.35) * (0.6 + 0.4 * Math.sin(t * 47)) * 0.9;
    }
  }
};
R['backfire'] = {
  dur: 0.35, variants: 3, peak: 0.85,
  render(out, sr, rand) {
    const lp = new Biquad(sr, 'lowpass', 700 + rand() * 400, 0.8);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      ph += TAU * 55 / sr;
      out[i] = Math.tanh(lp.run(n) * env(t, 0.0006, 0.03) * 2.5 + Math.sin(ph) * env(t, 0.002, 0.05) + n * env(t, 0.0002, 0.002) * 0.6);
    }
  }
};
R['hiss'] = { // a holed radiator
  dur: 1.4, variants: 1, peak: 0.5, fadeOut: 0.4,
  render(out, sr, rand) {
    const hp = new Biquad(sr, 'highpass', 3200, 0.7);
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      out[i] = hp.run(rand() * 2 - 1) * env(t, 0.03, 0.55) * (0.8 + 0.2 * Math.sin(t * 23));
    }
  }
};
// loops (rendered past their length; the tail is cross-faded into the head)
R['alarm-loop'] = { // whoops, then a warble: 2.4 s
  dur: 2.4, loop: 0.05, variants: 1, peak: 0.8,
  render(out, sr) {
    let ph = 0;
    const L = 2.4;
    for (let i = 0; i < out.length; i++) {
      const t = (i / sr) % L;
      let f, a = 1;
      if (t < 1.2) {
        const w = (t % 0.4) / 0.4;
        f = 650 + 900 * w;
        a = clamp(w / 0.05) * clamp((1 - w) / 0.08);
      } else {
        f = Math.floor((t - 1.2) * 12) % 2 ? 1250 : 980;
      }
      ph += TAU * f / sr;
      out[i] = (Math.sin(ph) + Math.sin(ph * 3) * 0.33 + Math.sin(ph * 5) * 0.15) * a * 0.6;
    }
  }
};
R['tyre-loop'] = { // tyre squeal: a few wobbling partials over rubber hiss
  dur: 1.6, loop: 0.2, variants: 1, peak: 0.7, sr: 32000,
  render(out, sr, rand) {
    const bp = new Biquad(sr, 'bandpass', 1800, 1.2);
    let ph = 0, wob = 0, am = 0;
    for (let i = 0; i < out.length; i++) {
      wob += ((rand() - 0.5) * 0.06 - wob) * 0.0008;
      am += ((rand() < 0.5 ? 0.4 : 1) - am) * 0.004;
      const f = 1050 * (1 + wob + 0.012 * Math.sin(i / sr * 37));
      ph += TAU * f / sr;
      out[i] = (Math.sin(ph) + Math.sin(ph * 2.03) * 0.45 + Math.sin(ph * 3.1) * 0.2) * (0.5 + 0.5 * am) * 0.5 + bp.run(rand() * 2 - 1) * 0.45;
    }
  }
};
R['skid-loop'] = { // locked wheels scrubbing (hard braking)
  dur: 1.2, loop: 0.2, variants: 1, peak: 0.7, sr: 32000,
  render(out, sr, rand) {
    const bp = new Biquad(sr, 'bandpass', 900, 0.9), lp = new Biquad(sr, 'lowpass', 220, 0.7);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const n = rand() * 2 - 1;
      ph += TAU * (720 + 30 * Math.sin(i / sr * 11)) / sr;
      out[i] = bp.run(n) * 0.9 + lp.run(n) * 0.6 + Math.sin(ph) * 0.12;
    }
  }
};
// ---- PICKUPS, MONEY, UI -------------------------------------------------------------------------------------------------
function bell(out, sr, at, f, dur, amp, ratio = 3.5, index = 2.2) {
  const start = Math.floor(at * sr);
  for (let i = 0; i < dur * sr && start + i < out.length; i++) {
    const t = i / sr;
    const mod = Math.sin(TAU * f * ratio * t) * index * Math.exp(-t / (dur * 0.25));
    out[start + i] += Math.sin(TAU * f * t + mod) * env(t, 0.001, dur * 0.3) * amp;
  }
}
function blip(out, sr, at, f, dur, amp, f1 = f) {
  const start = Math.floor(at * sr);
  let ph = 0;
  for (let i = 0; i < dur * sr && start + i < out.length; i++) {
    const t = i / sr;
    ph += TAU * (f + (f1 - f) * t / dur) / sr;
    out[start + i] += Math.sin(ph) * clamp(t / 0.002) * Math.exp(-t / (dur * 0.35)) * amp;
  }
}
R['pickup'] = { dur: 0.55, variants: 1, peak: 0.6, render(out, sr) { bell(out, sr, 0, 1318.5, 0.35, 0.8); bell(out, sr, 0.075, 1975.5, 0.45, 0.9); } };
R['pickup-health'] = { dur: 0.7, variants: 1, peak: 0.6, render(out, sr) { [1046.5, 1318.5, 1568].forEach((f, k) => bell(out, sr, k * 0.07, f, 0.5, 0.7, 1, 1.2)); } };
R['pickup-armor'] = {
  dur: 0.6, variants: 1, peak: 0.65,
  render(out, sr, rand) { foley(out, sr, rand, [[0, 'click', 1.2, 0.35], [0.01, 'thud', 0.6]]); bell(out, sr, 0.06, 880, 0.4, 0.5, 1.41, 3); bell(out, sr, 0.12, 1320, 0.4, 0.4, 1.41, 3); }
};
R['cash'] = { // a cash register: drawer, bell, coins
  dur: 0.95, variants: 1, peak: 0.7,
  render(out, sr, rand) {
    foley(out, sr, rand, [[0, 'scrape', 0.6, 0.5], [0.1, 'thud', 0.5, 1.2]]);
    bell(out, sr, 0.1, 2637, 0.7, 0.9, 2.76, 1.4);
    for (let k = 0; k < 7; k++) bell(out, sr, 0.16 + rand() * 0.4, 3800 + rand() * 3500, 0.12, 0.2, 1.53, 1.5);
  }
};
R['coin'] = { dur: 0.13, variants: 2, peak: 0.5, render(out, sr, rand) { bell(out, sr, 0, 3200 + rand() * 900, 0.12, 0.8, 1.53, 1.2); } };
R['ui-move'] = { dur: 0.06, variants: 1, peak: 0.4, render(out, sr) { blip(out, sr, 0, 1500, 0.05, 1); } };
R['ui-select'] = { dur: 0.2, variants: 1, peak: 0.45, render(out, sr) { blip(out, sr, 0, 880, 0.08, 1); blip(out, sr, 0.06, 1320, 0.12, 1); } };
R['ui-back'] = { dur: 0.2, variants: 1, peak: 0.45, render(out, sr) { blip(out, sr, 0, 1320, 0.08, 1); blip(out, sr, 0.06, 880, 0.12, 1); } };
R['ui-pause'] = { dur: 0.35, variants: 1, peak: 0.4, render(out, sr) { blip(out, sr, 0, 700, 0.3, 1, 380); blip(out, sr, 0, 1050, 0.25, 0.4, 560); } };
R['hit'] = {
  dur: 0.08, variants: 1, peak: 0.45,
  render(out, sr, rand) { blip(out, sr, 0, 2300, 0.04, 1); for (let i = 0; i < sr * 0.002; i++) out[i] += (rand() * 2 - 1) * 0.5; }
};
R['hit-kill'] = { dur: 0.2, variants: 1, peak: 0.5, render(out, sr) { blip(out, sr, 0, 1900, 0.05, 1); blip(out, sr, 0.05, 2800, 0.12, 0.8); blip(out, sr, 0, 160, 0.12, 0.8, 70); } };

// ---- STINGERS: chords of band-limited saws through a moving lowpass, bells, booms ---------------------------------------
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
function brass(out, sr, rand, at, dur, notes, amp = 0.3, bright = 2200, attack = 0.03) {
  const start = Math.floor(at * sr);
  for (const note of notes) {
    const f = midi(note), lp = new Biquad(sr, 'lowpass', bright, 1.2);
    const detune = [1, 1.004 + rand() * 0.002, 0.996 - rand() * 0.002];
    const ph = [rand(), rand(), rand()];
    for (let i = 0; i < dur * sr && start + i < out.length; i++) {
      const t = i / sr;
      if ((i & 31) === 0) lp.set('lowpass', 300 + bright * env(t, attack * 1.5, dur * 0.5) + f, 1.1);
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const dt = f * detune[k] / sr;
        ph[k] = (ph[k] + dt) % 1;
        v += blepSaw(ph[k], dt);
      }
      const a = clamp(t / attack) * clamp((dur - t) / 0.12) * (0.75 + 0.25 * Math.exp(-t / 0.3));
      out[start + i] += lp.run(v) * a * amp;
    }
  }
}
function boom(out, sr, rand, at, amp = 1, f0 = 55, tau = 0.5) {
  const start = Math.floor(at * sr);
  const lp = new Biquad(sr, 'lowpass', 220, 0.7);
  let ph = 0;
  for (let i = 0; i < sr * tau * 4 && start + i < out.length; i++) {
    const t = i / sr;
    ph += TAU * (f0 * 0.6 + f0 * Math.exp(-t / 0.08)) / sr;
    out[start + i] += (Math.sin(ph) * env(t, 0.003, tau) + lp.run(rand() * 2 - 1) * env(t, 0.002, tau * 0.3) * 1.5) * amp;
  }
}
function riser(out, sr, rand, at, dur, amp = 0.4, f0 = 400, f1 = 5000) {
  const start = Math.floor(at * sr);
  const bp = new Biquad(sr, 'bandpass', f0, 2);
  for (let i = 0; i < dur * sr && start + i < out.length; i++) {
    const t = i / sr;
    if ((i & 31) === 0) bp.set('bandpass', f0 * Math.pow(f1 / f0, t / dur), 2);
    out[start + i] += bp.run(rand() * 2 - 1) * (t / dur) ** 2 * amp;
  }
}
R['mission-start'] = {
  dur: 2.4, variants: 1, peak: 0.8, fadeOut: 0.3, sr: 32000,
  render(out, sr, rand) {
    riser(out, sr, rand, 0, 0.55, 0.6);
    boom(out, sr, rand, 0.55, 1, 60, 0.45);
    brass(out, sr, rand, 0.55, 1.6, [50, 57, 62, 65, 69], 0.16, 3000, 0.01);
    bell(out, sr, 0.58, 1174.7, 1.2, 0.3, 2, 1.2);
  }
};
R['mission-passed'] = {
  dur: 3.4, variants: 1, peak: 0.85, fadeOut: 0.5, sr: 32000,
  render(out, sr, rand) {
    const stabs = [[0, [60, 64, 67, 72]], [0.2, [60, 65, 69, 72]], [0.4, [62, 67, 71, 74]], [0.62, [60, 64, 67, 72, 76]]];
    for (const [at, notes] of stabs) brass(out, sr, rand, at, at < 0.6 ? 0.18 : 2.4, notes, 0.13, 3600, 0.008);
    boom(out, sr, rand, 0, 0.6, 70, 0.25);
    boom(out, sr, rand, 0.62, 0.9, 60, 0.6);
    for (let k = 0; k < 4; k++) bell(out, sr, 0.62 + k * 0.09, midi(84 + [0, 4, 7, 12][k]), 1.2, 0.25, 2, 1);
    riser(out, sr, rand, 0.62, 1.4, 0.15, 6000, 9000);
  }
};
R['mission-failed'] = {
  dur: 3, variants: 1, peak: 0.8, fadeOut: 0.5, sr: 24000,
  render(out, sr, rand) {
    boom(out, sr, rand, 0, 1, 50, 0.7);
    brass(out, sr, rand, 0, 0.9, [48, 55, 60, 63], 0.14, 1600, 0.02);
    brass(out, sr, rand, 0.75, 0.9, [44, 51, 56, 60], 0.13, 1200, 0.03);
    brass(out, sr, rand, 1.5, 1.5, [43, 50, 55, 59], 0.13, 900, 0.05);
  }
};
R['wanted-up'] = {
  dur: 1.3, variants: 1, peak: 0.75, fadeOut: 0.3, sr: 32000,
  render(out, sr, rand) {
    riser(out, sr, rand, 0, 0.25, 0.5, 800, 6000);
    boom(out, sr, rand, 0.22, 0.9, 65, 0.35);
    brass(out, sr, rand, 0.22, 0.9, [50, 51, 57, 62, 63], 0.11, 2600, 0.006);
  }
};
R['wanted-down'] = { dur: 1.2, variants: 1, peak: 0.55, render(out, sr) { bell(out, sr, 0, 1046.5, 0.8, 0.6, 2, 1.2); bell(out, sr, 0.16, 784, 1, 0.6, 2, 1.2); } };
R['wanted-cleared'] = {
  dur: 2.4, variants: 1, peak: 0.6, fadeOut: 0.5, sr: 32000,
  render(out, sr, rand) {
    brass(out, sr, rand, 0, 2.2, [53, 60, 64, 69], 0.08, 900, 0.5);
    for (let k = 0; k < 3; k++) bell(out, sr, 0.3 + k * 0.12, midi(77 + [0, 4, 7][k]), 1.2, 0.35, 2, 1);
  }
};
R['wasted'] = {
  dur: 3.8, variants: 1, peak: 0.85, fadeOut: 0.6, sr: 24000,
  render(out, sr, rand) {
    boom(out, sr, rand, 0, 1.2, 45, 0.9);
    const lp = new Biquad(sr, 'lowpass', 800, 1.5);
    const ph = [0, 0.3, 0.6];
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const f = 110 * Math.pow(0.5, t / 3.2);
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const dt = f * [1, 1.006, 1.498][k] / sr;
        ph[k] = (ph[k] + dt) % 1;
        v += blepSaw(ph[k], dt);
      }
      if ((i & 31) === 0) lp.set('lowpass', 1400 * Math.exp(-t / 1.2) + 150, 1.5);
      out[i] += lp.run(v) * clamp(t / 0.1) * 0.22;
    }
    for (const at of [0.9, 1.65, 2.5]) boom(out, sr, rand, at, 0.35, 48, 0.12);
  }
};
R['busted'] = {
  dur: 3, variants: 1, peak: 0.8, fadeOut: 0.4, sr: 32000,
  render(out, sr, rand) {
    let ph = 0;
    for (let i = 0; i < sr * 0.9; i++) { // a siren's two-tone chirp
      const t = i / sr;
      ph += TAU * (Math.floor(t / 0.15) % 2 ? 960 : 720) / sr;
      out[i] += (Math.sin(ph) + Math.sin(3 * ph) * 0.3) * 0.25 * clamp((0.9 - t) / 0.1);
    }
    brass(out, sr, rand, 0.9, 1.6, [45, 52, 57, 60], 0.14, 1500, 0.01);
    boom(out, sr, rand, 0.9, 1, 55, 0.4);
    // the cell door: a big low metal clang
    const modes = [[180, 0.6], [420, 0.4], [870, 0.25], [1430, 0.15]].map(([f, tau]) => new Mode(sr, f, tau, 1));
    const s = Math.floor(1.8 * sr);
    for (let i = 0; i + s < out.length; i++) {
      const ex = i < sr * 0.003 ? rand() * 2 - 1 : 0;
      let v = 0;
      for (const m of modes) v += m.run(ex);
      out[s + i] += v * 0.35;
    }
  }
};

// ---- PEOPLE ----------------------------------------------------------------------------------------------------------
R['scream'] = { // panic: a high, rough, rising-then-falling "aah"
  dur: 1.2, variants: 8, peak: 0.75, sr: 24000, fadeOut: 0.05,
  render(out, sr, rand, v) {
    const female = v % 2 === 0;
    const base = female ? 560 + rand() * 260 : 280 + rand() * 120;
    const len = 0.55 + rand() * 0.55;
    const vowel = [VOWELS.a, VOWELS.ae, VOWELS.e, VOWELS.o][Math.floor(rand() * 4)];
    const fs = female ? 1.18 : 1.02;
    formantVoice(out, sr, rand, {
      dur: len, breath: 0.22, jitter: 0.04, shimmer: 0.25, rough: 0.25 + rand() * 0.2, bw: [140, 180, 240, 300],
      f0: (t) => base * (0.82 + 0.3 * clamp(t / 0.12) - 0.25 * clamp((t - len * 0.6) / (len * 0.4))) * (1 + 0.035 * Math.sin(t * 38)),
      vowel: (t, F) => { F[0] = vowel[0] * fs * 1.15; F[1] = vowel[1] * fs; F[2] = vowel[2] * fs; F[3] = vowel[3] * fs; },
      amp: (t) => clamp(t / 0.04) * clamp((len - t) / 0.18),
      noise: (t) => (t < 0.05 ? 0.4 : 0.12)
    });
  }
};
R['shout'] = { // "hey!" / "oi!"
  dur: 0.55, variants: 6, peak: 0.75, sr: 24000,
  render(out, sr, rand, v) {
    const female = v % 3 === 0;
    const base = female ? 300 + rand() * 80 : 165 + rand() * 60;
    const len = 0.3 + rand() * 0.18;
    const a = rand() < 0.5 ? VOWELS.e : VOWELS.o, b = rand() < 0.5 ? VOWELS.i : VOWELS.e;
    const fs = female ? 1.15 : 1;
    formantVoice(out, sr, rand, {
      dur: len, breath: 0.12, jitter: 0.03, rough: 0.12,
      f0: (t) => base * (1.12 - 0.3 * (t / len)),
      vowel: (t, F) => vowelLerp(a, b, clamp((t - 0.06) / (len * 0.6)), fs, F),
      voiced: (t) => clamp((t - 0.04) / 0.02),
      amp: (t) => clamp(t / 0.01) * clamp((len - t) / 0.08),
      noise: (t) => (t < 0.05 ? 0.8 : 0)
    });
  }
};
R['pain'] = { // a grunt: "uh!" / "oof"
  dur: 0.4, variants: 6, peak: 0.7, sr: 24000,
  render(out, sr, rand, v) {
    const female = v % 3 === 0;
    const base = female ? 250 + rand() * 60 : 120 + rand() * 50;
    const len = 0.16 + rand() * 0.16;
    const vw = rand() < 0.5 ? VOWELS.uh : VOWELS.o;
    const fs = female ? 1.15 : 1;
    formantVoice(out, sr, rand, {
      dur: len, breath: 0.15, jitter: 0.05, rough: 0.3,
      f0: (t) => base * (1.15 - 0.4 * (t / len)),
      vowel: (t, F) => vowelLerp(vw, VOWELS.u, clamp(t / len), fs, F),
      amp: (t) => clamp(t / 0.006) * Math.exp(-t / (len * 0.5)),
      noise: (t) => (t < 0.02 ? 0.5 : 0.05)
    });
  }
};
// gibberish syllables for the talkback radio, one bank per speaker (played with prosody by audio-music.js)
for (const name of ['hostA', 'hostB', 'callerA', 'callerB']) {
  R[`syl-${name}`] = {
    dur: 0.3, variants: 14, peak: 0.7, sr: 24000, fadeOut: 0.03,
    render(out, sr, rand) { speak(out, sr, rand, SPEAKERS[name], { syllables: 1, rate: 3.4 + rand() * 1.6 }); }
  };
}
// police megaphone: a phrase through a horn speaker (band-limited, clipped, a slap echo)
R['megaphone'] = {
  dur: 1.8, variants: 4, peak: 0.8, sr: 24000, fadeOut: 0.1,
  render(out, sr, rand) {
    const tmp = new Float32Array(out.length);
    speak(tmp, sr, rand, SPEAKERS.cop, { syllables: 4 + Math.floor(rand() * 3), rate: 5.5, emphasis: 0.25 });
    const hp = new Biquad(sr, 'highpass', 650, 0.8), lp = new Biquad(sr, 'lowpass', 2900, 0.9), pk = new Biquad(sr, 'peaking', 1600, 1.5, 8);
    let max = 0;
    for (let i = 0; i < tmp.length; i++) max = Math.max(max, Math.abs(tmp[i]));
    const slap = Math.floor(0.11 * sr);
    for (let i = 0; i < out.length; i++) {
      const x = Math.tanh(pk.run(lp.run(hp.run(tmp[i] / (max || 1)))) * 4);
      out[i] = x + (i >= slap ? out[i - slap] * 0.3 : 0);
    }
  }
};
// police radio: squelch open, a phrase through a narrow, crunchy band, squelch close ("kssht")
R['chatter'] = {
  dur: 2.8, variants: 8, peak: 0.75, sr: 16000, fadeOut: 0.02,
  render(out, sr, rand, v) {
    const speaker = v % 2 ? SPEAKERS.dispatch : SPEAKERS.cop;
    const tmp = new Float32Array(out.length);
    const used = speak(tmp, sr, rand, speaker, { syllables: 5 + Math.floor(rand() * 7), rate: 6.2 }, Math.floor(0.08 * sr));
    const end = Math.min(out.length - sr * 0.2, Math.floor((0.08 + used) * sr));
    const hp = new Biquad(sr, 'highpass', 480, 0.9), lp = new Biquad(sr, 'lowpass', 2500, 1.1), pk = new Biquad(sr, 'peaking', 1300, 1, 6);
    const hiss = new Biquad(sr, 'bandpass', 2600, 0.6);
    let max = 0;
    for (let i = 0; i < tmp.length; i++) max = Math.max(max, Math.abs(tmp[i]));
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      const open = i < end ? 1 : 0;
      const kssht = i >= end && i < end + sr * 0.16 ? Math.exp(-(i - end) / (sr * 0.05)) : 0;
      const voice = Math.tanh(pk.run(lp.run(hp.run(tmp[i] / (max || 1)))) * 3) * 0.8;
      out[i] = (voice + hiss.run(n) * 0.12) * open + n * (env(t, 0.001, 0.025) * 0.8 + kssht * 0.7);
    }
  }
};

export const SFX_RECIPES = R;

/** Renders one variant of a recipe (of `recipes`, the SFX by default) into an AudioBuffer (synchronous: milliseconds) */
export function renderSfx(name, variant = 0, recipes = R, sampleRate = 48000) {
  const recipe = recipes[name];
  if (!recipe) return null;
  const sr = recipe.sr || sampleRate;
  const rand = mulberry(hash(name.length, variant + 1, ...Array.from(name, (c) => c.charCodeAt(0))));
  if (recipe.loop) {
    const length = Math.round(recipe.dur * sr);
    const data = new Float32Array(length + Math.round(recipe.loop * sr));
    recipe.render(data, sr, rand, variant);
    return toBuffer(loopify(data, length, sr, recipe.peak ?? 0.8), sr);
  }
  const data = new Float32Array(Math.round(recipe.dur * sr));
  recipe.render(data, sr, rand, variant);
  return toBuffer(finish(data, sr, recipe.peak ?? 0.8, recipe.fadeOut ?? 0.01), sr);
}

/**
 * The bank of every recipe's variants, rendered in the background in small time slices (a few ms each, yielding to
 * the page between) so loading and the first frames never hitch; get() renders a missing sound at once if asked
 * before its turn. bank.ready resolves when all are done.
 */
export function createSfxBank(opts = {}) {
  return createBank(R, opts);
}

/** A bank over any recipe table (audio-music.js renders its drum kits and plucks through it) */
export function createBank(R, { sliceMs = 6, order = null } = {}) {
  const buffers = new Map(); // name -> AudioBuffer[]
  const queue = [];
  const names = order ? [...order, ...Object.keys(R).filter((n) => !order.includes(n))] : Object.keys(R);
  for (const name of names) for (let v = 0; v < (R[name].variants || 1); v++) queue.push([name, v]);
  const total = queue.length;
  let renderMs = 0;
  const renderOne = (name, v) => {
    let list = buffers.get(name);
    if (!list) buffers.set(name, (list = new Array(R[name].variants || 1).fill(null)));
    if (list[v]) return;
    const t0 = performance.now();
    list[v] = renderSfx(name, v, R);
    renderMs += performance.now() - t0;
  };
  const yieldTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));
  const bank = {
    buffers,
    get total() { return total; },
    get done() { return total - queue.length; },
    get renderMs() { return renderMs; },
    has: (name) => Object.hasOwn(R, name),
    /** a variant (index, or a random one from rand()) */
    get(name, pick = Math.random) {
      const recipe = R[name];
      if (!recipe) return null;
      const n = recipe.variants || 1;
      const v = typeof pick === 'number' ? ((pick % n) + n) % n : Math.floor(pick() * n) % n;
      const list = buffers.get(name);
      if (!list || !list[v]) renderOne(name, v);
      return buffers.get(name)[v];
    },
    ready: null
  };
  bank.ready = (async () => {
    while (queue.length) {
      const start = performance.now();
      while (queue.length && performance.now() - start < sliceMs) {
        const [name, v] = queue.shift();
        renderOne(name, v);
      }
      await yieldTask();
    }
    return bank;
  })();
  return bank;
}
