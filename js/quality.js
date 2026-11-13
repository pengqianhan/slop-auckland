// Graphics quality: what keeps the city playable on a small graphics card.
//
// The frame is bound by the GPU, and mostly by how many pixels it shades (every material here is a long procedural
// shader), so the levers are, in the order they count:
//   - the resolution the scene is drawn at: a share of the window's (the browser scales the canvas up), under a pixel
//     budget per tier, and moved up and down by the measured frame time ("dynamic resolution");
//   - multisampling of the scene pass (4x MSAA, or none);
//   - screen-space reflections;
//   - how far out the trees and the surrounding suburbs' buildings are drawn (the fixed cost of the wide views).
// Three tiers bundle them.
//
// The default is "ultra", which is the picture Slop New York draws and nothing less: the window's full resolution
// whatever its size, 4x MSAA, reflections, everything drawn to its full distance, and a resolution that never moves.
// The lower tiers and "auto" trade picture for frame rate and are only ever chosen by hand (the gauge menu, or ?q=).
// A chosen tier keeps a fixed resolution; only on "auto" does the resolution follow the frame time, a tier is guessed
// from the graphics card, and the next tier down takes over when the lowest resolution still struggles.

const TIERS = {
  medium: { name: 'medium', label: 'Medium', scale: 0.85, floor: 0.6, pixels: 1.5e6, msaa: 0, reflections: true, reach: 0.8, trees: 0.75 },
  high: { name: 'high', label: 'High', scale: 1, floor: 0.6, pixels: 2.3e6, msaa: 4, reflections: true, reach: 1, trees: 1 },
  ultra: { name: 'ultra', label: 'Ultra', scale: 1, floor: 1, pixels: Infinity, msaa: 4, reflections: true, reach: 1, trees: 1 }
};
const ORDER = ['medium', 'high', 'ultra'];
const NEXT_DOWN = { high: 'medium' };
const DEFAULT_MODE = 'ultra';
// (not the keys of the first version, whose default was "auto": what that one stored was never anybody's choice)
const KEY_MODE = 'akl-graphics'; // 'auto' or a tier, as chosen in the menu
const KEY_AUTO = 'akl-graphics-auto'; // the tier "auto" settled on last time

const stored = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const store = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* storage is optional */ }
};

// A first guess from the graphics card's name (WebGL still tells it; WebGPU only the vendor and architecture)
function detectTier() {
  if (typeof navigator === 'undefined') return 'high';
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
  if (mobile) return 'medium';
  let gpu = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch { /* no WebGL: no hint */ }
  // software rasterisers, phone chips, integrated graphics, and the small, old or mid-range discrete cards
  if (/SwiftShader|llvmpipe|Software|Mali|Adreno|PowerVR/i.test(gpu)) return 'medium';
  if (/Intel/i.test(gpu) && !/Arc/i.test(gpu)) return 'medium';
  if (/Quadro (K|M|P)\d{3,4}\b|Quadro [0-9]|NVS |GeForce (GT|MX)|GTX (4|5|6|7|9)\d0|GTX 10[35]0|FirePro/i.test(gpu)) return 'medium';
  if (/Radeon\s*(\(TM\)\s*)?(Graphics|Vega|HD|R[579] |RX (4|5)[3-6]0|Pro WX ?[2-4])/i.test(gpu)) return 'medium';
  if (/GTX (10[678]0|16[56]0)|RTX 20[56]0|RTX 3050|RX (4|5)[78]0|RX 5[56]00|Apple M1\b/i.test(gpu)) return 'medium';
  return 'high';
}

/** The quality to start with: { mode: 'auto' | tier, tier } (?q=medium|high|ultra in the address overrides) */
function initialQuality() {
  const asked = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('q') : null;
  if (asked && TIERS[asked]) return { mode: asked, tier: TIERS[asked] };
  const mode = stored(KEY_MODE);
  if (mode && TIERS[mode]) return { mode, tier: TIERS[mode] };
  if (mode !== 'auto') return { mode: DEFAULT_MODE, tier: TIERS[DEFAULT_MODE] };
  const settled = stored(KEY_AUTO);
  return { mode: 'auto', tier: TIERS[settled && TIERS[settled] ? settled : detectTier()] };
}

/**
 * Runs the quality at run time.
 *   renderer, viewport(): { width, height } of the window in CSS pixels
 *   apply(tier, changed): put a tier's switches into effect (MSAA, reflections, reach); `changed` false on start-up
 *   onChange(state): the tier, mode or resolution changed (for the HUD)
 */
function createQualityManager({ renderer, viewport, apply, onChange = () => {}, start }) {
  let mode = start.mode;
  let tier = start.tier;
  let ratio = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  // Dynamic resolution: a share of the tier's own, stepped by the frame time averaged over the last 45 frames
  const dyn = { scale: 1, acc: 0, n: 0, settle: 3.5, upWait: 4, upDelay: 4, floorHits: 0 };
  const dynamicResolution = typeof location === 'undefined' || new URLSearchParams(location.search).get('dynres') !== '0';

  const state = () => ({ mode, tier: tier.name, label: tier.label, scale: ratio });

  function resize() {
    const { width, height } = viewport();
    let scale = tier.scale * dyn.scale;
    const pixels = width * height * scale * scale;
    if (pixels > tier.pixels) scale *= Math.sqrt(tier.pixels / pixels);
    // (in steps of 5%: every change reallocates the render targets)
    scale = Math.max(0.25, Math.round(scale * 20) / 20);
    const resized = width !== lastWidth || height !== lastHeight;
    lastWidth = width;
    lastHeight = height;
    if (scale !== ratio) {
      ratio = scale;
      renderer.setPixelRatio(scale);
    }
    if (resized) renderer.setSize(width, height);
    onChange(state());
  }

  function setTier(name, settleFor = 3.5) {
    tier = TIERS[name];
    dyn.acc = dyn.n = dyn.floorHits = 0;
    dyn.settle = settleFor;
    dyn.upDelay = 4;
    apply(tier, true);
    resize();
  }

  /** Auto, or one of the tiers */
  function setMode(next) {
    if (next !== 'auto' && !TIERS[next]) return;
    mode = next;
    store(KEY_MODE, mode);
    dyn.scale = 1;
    if (mode === 'auto') {
      const settled = stored(KEY_AUTO);
      setTier(settled && TIERS[settled] ? settled : detectTier());
    } else {
      setTier(mode);
    }
  }

  /** Call once per frame with the wall time since the last one (ms) */
  function sample(ms) {
    // Only "auto" moves the resolution: a tier chosen by hand, the default among them, keeps the picture it promises.
    // (and a stalled or hidden tab, a shader compiling, are not what the card can do)
    if (mode !== 'auto' || !dynamicResolution || !(ms > 0) || ms > 400) return;
    dyn.settle -= ms / 1000;
    dyn.upWait -= ms / 1000;
    if (dyn.settle > 0) {
      dyn.acc = dyn.n = 0;
      return;
    }
    dyn.acc += ms;
    dyn.n++;
    if (dyn.n < 45 && dyn.acc < 900) return;
    const frame = dyn.acc / dyn.n;
    dyn.acc = dyn.n = 0;
    let scale = dyn.scale;
    const floor = tier.floor / tier.scale; // dyn.scale at which the tier's lowest resolution is reached
    if (frame > 21.5 && scale > floor + 1e-3) {
      // too slow: down a step (two when well off, straight to the floor when far off), and wait longer each time
      // before trying to go back up
      scale = frame > 45 ? floor : Math.max(floor, scale - (frame > 30 ? 0.2 : 0.1));
      dyn.upDelay = Math.min(60, dyn.upDelay * 2);
      dyn.upWait = dyn.upDelay;
    } else if (frame < 17.4 && scale < 1 && dyn.upWait <= 0) {
      scale = Math.min(1, scale + 0.1);
      dyn.upWait = 2;
    } else if (frame < 17.4 && scale >= 1) {
      dyn.upDelay = 4;
    }
    scale = Math.round(scale * 1000) / 1000;
    if (scale <= floor + 1e-3 && frame > 26) {
      // still struggling at the tier's lowest resolution, twice running: on auto, the next tier down
      dyn.floorHits++;
      const down = NEXT_DOWN[tier.name];
      if (dyn.floorHits >= 2 && down && mode === 'auto') {
        console.info(`[quality] ${frame.toFixed(0)} ms a frame at the lowest resolution of "${tier.name}": down to "${down}"`);
        dyn.scale = 0.8;
        store(KEY_AUTO, down);
        setTier(down, 4);
        return;
      }
    } else {
      dyn.floorHits = 0;
    }
    if (Math.abs(scale - dyn.scale) > 1e-3) {
      dyn.scale = scale;
      dyn.settle = 1;
      resize();
    }
  }

  apply(tier, false);
  resize();
  return { setMode, sample, resize, state, tiers: ORDER.map((name) => TIERS[name]) };
}

export { TIERS as QUALITY_TIERS, initialQuality, createQualityManager };
