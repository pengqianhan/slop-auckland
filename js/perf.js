// In-page profiler, ?debug only: window.akl.perf (main.js installs it once the frame loop exists).
//
// It wraps, in place, the per-frame entry points main.js calls (controllers, camera, traffic, the game and each of its
// systems, the city's level-of-detail updates, audio, the render pipeline) with timers, so nothing in the engine knows
// about it and it costs nothing when it is not installed. Per frame it keeps the CPU time of each stage, the frame's
// draw calls and triangles (renderer.info, summed over every pass of the frame: both shadow cascades, the scene, the
// post-processing quads), the GPU time of the frame from WebGPU timestamp queries when the device has them (perf.gpu(),
// off by default: it adds a query pair to every render pass), and the JS heap (Chrome's performance.memory).
//
//   akl.perf.start() / stop() / reset()       collect (start() also resets)
//   akl.perf.report()                          { frames, cpu: { stage: { avg, p95, max } }, frame, draws, tris, gpu, heap, load }
//   akl.perf.table()                           the report as rows for console.table
//   akl.perf.step(n = 60, ms = 16.7)           run n frames of ms each, synchronously (a hidden pane renders ~1 fps)
//   akl.perf.gpu(on = true)                    WebGPU timestamp queries on/off
//   akl.perf.show(on = true)                   a small overlay (top left), refreshed 4x a second
//   akl.perf.load                              the "[init]" start-up stage timings (ms), from main.js's log line
//   akl.perf.hitches                           frames over 50 ms of CPU since start() (time, ms, worst stage)

const now = () => performance.now();

/** Start-up stage timings: main.js logs them once as "[init] renderer 75ms, lighting 44ms, ..." */
const load = { stages: null, total: 0, line: null };
const parseInit = (line) => {
  const stages = {};
  let total = 0;
  for (const part of line.slice(7).split(',')) {
    const m = /^\s*(\S+)\s+(\d+)ms/.exec(part);
    if (!m) continue;
    stages[m[1]] = +m[2];
    total += +m[2];
  }
  load.stages = stages;
  load.total = total;
  load.line = line;
};
if (typeof console !== 'undefined' && !console.log.__perf) {
  const log = console.log;
  const wrapped = function (first, ...rest) {
    if (typeof first === 'string' && first.startsWith('[init] ') && !load.line) parseInit(first);
    return log.call(this, first, ...rest);
  };
  wrapped.__perf = true;
  console.log = wrapped;
}

function installPerf(akl, extra = {}) {
  if (!akl || akl.perf) return akl?.perf;
  const renderer = akl.renderer;
  const game = akl.game;
  const MAX_STAGES = 64;
  const names = [];
  const index = new Map();
  const frameAcc = new Float64Array(MAX_STAGES); // this frame's time per stage
  const sum = new Float64Array(MAX_STAGES);
  const max = new Float64Array(MAX_STAGES);
  const HIST = 2048; // per-stage samples of the last frames, for percentiles
  const hist = [];
  let histN = 0;

  const stageId = (name) => {
    let i = index.get(name);
    if (i === undefined) {
      if (names.length >= MAX_STAGES) return MAX_STAGES - 1;
      i = names.length;
      names.push(name);
      index.set(name, i);
      hist.push(new Float32Array(HIST));
    }
    return i;
  };

  // A timer around obj[method] (fixed arity: no rest arrays, so the profiler itself allocates nothing per call)
  const wrap = (obj, method, name) => {
    const orig = obj && obj[method];
    if (typeof orig !== 'function' || orig.__perf) return;
    const id = stageId(name);
    const timed = function (a, b, c, d, e, f) {
      const t = now();
      try {
        return orig.call(this, a, b, c, d, e, f);
      } finally {
        frameAcc[id] += now() - t;
      }
    };
    timed.__perf = true;
    timed.__orig = orig;
    obj[method] = timed;
  };

  wrap(akl.controllerManager, 'update', 'controllers');
  wrap(akl.cameraSystem, 'update', 'camera');
  wrap(akl.trafficSystem, 'update', 'traffic');
  wrap(akl.highwayTraffic, 'update', 'highway');
  wrap(akl.cityGrid, 'update', 'terrainLod');
  wrap(akl.cityBlocks, 'update', 'blocks');
  wrap(akl.cityBlocks, 'updateLights', 'blockLights');
  wrap(akl.streetDetails, 'update', 'streetDetails');
  wrap(akl.lightingSystem, 'update', 'lighting');
  wrap(akl.mapSystem, 'update', 'map');
  wrap(akl.audioSystem, 'update', 'audio');
  wrap(extra.surroundings, 'update', 'suburbs');
  wrap(akl.renderPipeline, 'render', 'render');
  // the game: the whole update, then each system (and the ones registered later)
  if (game) {
    wrap(game, 'update', 'game');
    const wrapSystem = (s) => wrap(s, 'update', 'g:' + s.name);
    for (const s of game._systems) wrapSystem(s);
    const addSystem = game.addSystem;
    game.addSystem = function (system) {
      const r = addSystem.call(this, system);
      if (system) wrapSystem(system);
      return r;
    };
  }
  const idFrame = stageId('frame');

  // frame totals
  let collecting = false;
  let frames = 0;
  let drawSum = 0, drawMax = 0, triSum = 0, triMax = 0, callSum = 0;
  const frameHist = new Float32Array(HIST);
  const hitches = [];
  let t0 = 0;
  let heap0 = 0, heapLast = 0, heapUp = 0, heapSamples = 0, heapPeak = 0;
  let gcDrops = 0;
  // GPU
  let gpuOn = false;
  let gpuSum = 0, gpuN = 0, gpuMax = 0, gpuLast = 0;
  const gpuHist = new Float32Array(HIST);
  let doneSum = 0, doneN = 0, donePending = false;

  const heapNow = () => performance.memory?.usedJSHeapSize || 0;

  // The frame loop: wrap the animation loop main.js set (renderer._animation._animationLoop), which is also what
  // step() calls
  const anim = renderer._animation;
  const loop = anim._animationLoop;
  const frame = function (time, xr) {
    frameAcc.fill(0);
    const t = now();
    loop(time, xr);
    const ms = now() - t;
    frameAcc[idFrame] = ms;
    if (!collecting) return;
    frames++;
    const h = histN % HIST;
    histN++;
    for (let i = 0; i < names.length; i++) {
      const v = frameAcc[i];
      sum[i] += v;
      if (v > max[i]) max[i] = v;
      hist[i][h] = v;
    }
    frameHist[h] = ms;
    const info = renderer.info.render;
    drawSum += info.drawCalls;
    triSum += info.triangles;
    callSum += info.frameCalls;
    if (info.drawCalls > drawMax) drawMax = info.drawCalls;
    if (info.triangles > triMax) triMax = info.triangles;
    const hp = heapNow();
    if (ms > 50 && hitches.length < 200) {
      let worst = '', wv = 0;
      const stages = [];
      for (let i = 0; i < names.length; i++) {
        if (i === idFrame) continue;
        if (frameAcc[i] > 2) stages.push(names[i] + ' ' + frameAcc[i].toFixed(1));
        if (!names[i].startsWith('g:') && frameAcc[i] > wv) {
          wv = frameAcc[i];
          worst = names[i];
        }
      }
      // (a heap that dropped by megabytes around this frame: a garbage collection in it, most likely)
      const gcMb = heapLast && hp < heapLast - 1e6 ? +((heapLast - hp) / 1048576).toFixed(1) : 0;
      hitches.push({ at: +((t - t0) / 1000).toFixed(2), ms: +ms.toFixed(1), worst, worstMs: +wv.toFixed(1), unaccounted: +(ms - stageSum()).toFixed(1), gcMb, stages: stages.join(', ') });
    }
    if (hp) {
      if (heapLast && hp > heapLast) heapUp += hp - heapLast;
      if (heapLast && hp < heapLast - 1e6) gcDrops++;
      heapLast = hp;
      if (hp > heapPeak) heapPeak = hp;
      heapSamples++;
    }
    if (gpuOn) {
      const pool = renderer.backend.timestampQueryPool?.render;
      if (pool && !pool.__perf) patchPool(pool);
      renderer.resolveTimestampsAsync('render').catch(() => {});
    } else if (!donePending && renderer.backend.device) {
      // without timestamps: how long the queue takes to drain what this frame submitted (an upper bound of the GPU
      // time when the GPU was idle at submit)
      donePending = true;
      const ts = now();
      renderer.backend.device.queue.onSubmittedWorkDone().then(() => {
        donePending = false;
        if (!collecting) return;
        doneSum += now() - ts;
        doneN++;
      });
    }
  };
  frame.__perf = true;
  anim._animationLoop = frame;
  // the stages main.js calls directly (not the game's systems, which are inside 'game')
  function stageSum() {
    let sum = 0;
    for (let i = 0; i < names.length; i++) if (i !== idFrame && !names[i].startsWith('g:')) sum += frameAcc[i];
    return sum;
  }

  // three's pool sums the durations of a frame's render passes. On a tiled GPU (Apple) consecutive passes overlap, so
  // that sum overcounts several times over: this resolver measures the time the GPU had any of the frame's passes in
  // flight (the union of their [begin, end] intervals), and keeps the plain sum and the pass count beside it.
  let gpuSumPasses = 0, gpuPasses = 0;
  function patchPool(pool) {
    pool.__perf = true;
    pool._resolveQueries = async function () {
      if (this.isDisposed || this.resultBuffer.mapState !== 'unmapped') return this.lastValue;
      const offsets = Array.from(this.queryOffsets);
      const count = this.currentQueryIndex;
      this.currentQueryIndex = 0;
      this.queryOffsets.clear();
      if (!count) return this.lastValue;
      const enc = this.device.createCommandEncoder();
      enc.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
      enc.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, count * 8);
      this.device.queue.submit([enc.finish()]);
      await this.resultBuffer.mapAsync(GPUMapMode.READ, 0, count * 8);
      if (this.isDisposed) return this.lastValue;
      const times = new BigUint64Array(this.resultBuffer.getMappedRange(0, count * 8)).slice();
      this.resultBuffer.unmap();
      // the last frame among the resolved ones
      let lastFrame = -1;
      for (const [uid] of offsets) {
        const f = +uid.slice(uid.lastIndexOf(':f') + 2);
        if (f > lastFrame) lastFrame = f;
      }
      const spans = [];
      let base = null;
      for (const [uid, off] of offsets) {
        if (+uid.slice(uid.lastIndexOf(':f') + 2) !== lastFrame) continue;
        const b = times[off], e = times[off + 1];
        if (!(e > b) || b === 0n) continue;
        if (base === null || b < base) base = b;
        spans.push([b, e]);
      }
      if (!spans.length) return this.lastValue;
      const iv = spans.map(([b, e]) => [Number(b - base) / 1e6, Number(e - base) / 1e6]).sort((p, q) => p[0] - q[0]);
      let busy = 0, sumP = 0, cb = iv[0][0], ce = iv[0][1];
      for (const [b, e] of iv) {
        sumP += e - b;
        if (b > ce) {
          busy += ce - cb;
          cb = b;
          ce = e;
        } else if (e > ce) ce = e;
      }
      busy += ce - cb;
      this.lastValue = busy;
      if (collecting) {
        gpuLast = busy;
        gpuHist[gpuN % HIST] = busy;
        gpuSum += busy;
        gpuN++;
        if (busy > gpuMax) gpuMax = busy;
        gpuSumPasses += sumP;
        gpuPasses += iv.length;
      }
      return busy;
    };
  }

  function reset() {
    frames = 0;
    histN = 0;
    sum.fill(0);
    max.fill(0);
    drawSum = drawMax = triSum = triMax = callSum = 0;
    hitches.length = 0;
    gpuSum = gpuN = gpuMax = gpuSumPasses = gpuPasses = 0;
    doneSum = doneN = 0;
    heap0 = heapLast = heapNow();
    heapUp = heapSamples = gcDrops = 0;
    heapPeak = heap0;
    t0 = now();
  }

  const pct = (arr, n, p) => {
    const m = Math.min(n, HIST);
    if (!m) return 0;
    const s = Array.from(arr.subarray(0, m)).sort((a, b) => a - b);
    return s[Math.min(m - 1, Math.floor(m * p))];
  };
  const r2 = (v) => Math.round(v * 100) / 100;

  function report() {
    const n = Math.max(1, frames);
    const cpu = {};
    for (let i = 0; i < names.length; i++) {
      if (sum[i] === 0 && max[i] === 0) continue;
      cpu[names[i]] = { avg: r2(sum[i] / n), p95: r2(pct(hist[i], histN, 0.95)), max: r2(max[i]) };
    }
    const seconds = (now() - t0) / 1000;
    const heap = heapNow();
    return {
      frames,
      seconds: r2(seconds),
      cpu,
      frame: { avg: r2(sum[idFrame] / n), p50: r2(pct(frameHist, histN, 0.5)), p95: r2(pct(frameHist, histN, 0.95)), max: r2(max[idFrame]) },
      draws: { avg: Math.round(drawSum / n), max: drawMax, passes: r2(callSum / n) },
      tris: { avg: Math.round(triSum / n), max: triMax },
      gpu: gpuOn
        ? { timestamp: true, avg: r2(gpuSum / Math.max(1, gpuN)), p95: r2(pct(gpuHist, gpuN, 0.95)), max: r2(gpuMax), n: gpuN,
          passSum: r2(gpuSumPasses / Math.max(1, gpuN)), passes: r2(gpuPasses / Math.max(1, gpuN)) }
        : { timestamp: false, submitLatencyAvg: r2(doneSum / Math.max(1, doneN)), n: doneN },
      heap: heap
        ? {
          mb: r2(heap / 1048576),
          deltaMb: r2((heap - heap0) / 1048576),
          // allocation rate estimate: the sum of the heap's rises between frames (GCs drop it), per frame & minute
          allocKbPerFrame: r2(heapUp / 1024 / n),
          allocMbPerMin: seconds > 0 ? r2((heapUp / 1048576) * (60 / seconds)) : 0,
          gcDrops,
          peakMb: r2(heapPeak / 1048576)
        }
        : null,
      hitches: hitches.length,
      load: load.stages ? { total: load.total, ...load.stages } : null
    };
  }

  function table() {
    const r = report();
    return Object.entries(r.cpu).map(([stage, v]) => ({ stage, ...v }));
  }

  /** n frames of ms each, run now (as the browser's frame callback would: info reset, node frame advanced) */
  function step(n = 60, ms = 16.7) {
    let t = Math.max(perf._t || 0, now());
    for (let i = 0; i < n; i++) {
      t += ms;
      if (renderer.info.autoReset) renderer.info.reset();
      renderer._nodes?.nodeFrame?.update?.();
      if (renderer._nodes?.nodeFrame) renderer.info.frame = renderer._nodes.nodeFrame.frameId;
      anim._animationLoop(t);
    }
    perf._t = t;
    return report();
  }

  function gpu(on = true) {
    const backend = renderer.backend;
    gpuOn = !!on && typeof backend.hasFeature === 'function' && backend.hasFeature('timestamp-query');
    backend.trackTimestamp = gpuOn;
    gpuSum = gpuN = gpuMax = gpuSumPasses = gpuPasses = 0;
    return gpuOn;
  }

  // overlay
  let panel = null, panelTimer = 0;
  function show(on = true) {
    if (!on) {
      clearInterval(panelTimer);
      panel?.remove();
      panel = null;
      return;
    }
    if (panel) return;
    panel = document.createElement('pre');
    panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;margin:0;padding:6px 8px;background:rgba(0,0,0,.72);color:#cfe;font:11px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre';
    document.body.appendChild(panel);
    if (!collecting) start();
    let last = '';
    panelTimer = setInterval(() => {
      const r = report();
      const top = Object.entries(r.cpu).filter(([k]) => k !== 'frame').sort((a, b) => b[1].avg - a[1].avg).slice(0, 10);
      const text = [
        `frame ${r.frame.avg} ms (p95 ${r.frame.p95}, max ${r.frame.max})  ${r.draws.avg} draws  ${(r.tris.avg / 1e6).toFixed(2)} M tris`,
        r.gpu.timestamp ? `gpu ${r.gpu.avg} ms (p95 ${r.gpu.p95})` : `gpu (queue drain) ${r.gpu.submitLatencyAvg} ms`,
        r.heap ? `heap ${r.heap.mb} MB  alloc ${r.heap.allocMbPerMin} MB/min  hitches ${r.hitches}` : '',
        ...top.map(([k, v]) => `${k.padEnd(18)} ${String(v.avg).padStart(6)} ${String(v.max).padStart(7)}`)
      ].join('\n');
      if (text !== last) panel.textContent = last = text;
      if (r.frames > 600) reset();
    }, 250);
  }

  function start() {
    reset();
    collecting = true;
  }
  function stop() {
    collecting = false;
    return report();
  }

  /**
   * KB a call of fn allocates (Chrome): fn runs back to back for minMs inside one task, between two reads of
   * performance.memory (which refreshes at most every ~50 ms, hence the waits and the long runs). A garbage collection
   * during a run spoils it (dropped); a read that was not refreshed under-reports, so the largest clean run counts.
   */
  async function alloc(fn, { minMs = 60, runs = 7 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    let gc = 0;
    for (let k = 0; k < runs; k++) {
      await sleep(70);
      const a = heapNow();
      const t = now();
      let n = 0;
      do {
        fn();
        n++;
      } while (now() - t < minMs);
      const b = heapNow();
      if (b < a) gc++;
      else out.push((b - a) / n / 1024);
    }
    return { kbPerCall: out.length ? r2(Math.max(...out)) : null, runs: out.map((v) => r2(v)), gc };
  }

  const perf = { start, stop, reset, report, table, step, gpu, show, alloc, load, hitches, wrap, _t: 0 };
  akl.perf = perf;
  return perf;
}

export { installPerf };
