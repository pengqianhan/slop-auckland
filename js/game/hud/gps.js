// GPS: the shortest way by road from the player to a blip, on the traffic network (road-network.js: straight edges
// between junction & bend nodes). The graph is packed into typed arrays the first time a route is asked for, and A*
// reuses its scratch arrays, so a search allocates only the route it returns. Searches run between frames
// (setTimeout), never inside the frame loop; a route is searched again when its blip moves or the player strays off it.
// In a car the one-way streets count (the wrong way only when the way round is over three times as long); on foot or
// on a bike every street goes both ways; in the air it is a straight
// line. Off the network (the harbour, the suburbs beyond the detailed city) it is a straight line too.

const CELL = 64; // m: the grid that finds the node nearest a point
const SNAP = 260; // m: no node this close, no road route
const STRAY = 38; // m off the route: search again
const RECHECK = 0.45; // s between checks of the player against the route
const WRONG_WAY = 3; // cost factor of a one-way street driven the wrong way (car routes)

function createGps(game) {
  let graph = null;
  let graphFailed = false;

  // ---- the graph -----------------------------------------------------------------------------------------------
  function build() {
    const net = game.engine?.trafficSystem?.network;
    if (!net || !net.nodes?.length || !net.edges?.length) {
      graphFailed = true;
      return null;
    }
    const nodes = net.nodes;
    const n = nodes.length;
    const index = new Map();
    const x = new Float32Array(n), z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      index.set(nodes[i], i);
      x[i] = nodes[i].x;
      z[i] = nodes[i].z;
    }
    // directed (cars) and undirected (feet, bikes) adjacency, compressed rows
    const from = [], to = [];
    for (const e of net.edges) {
      const a = index.get(e.from), b = index.get(e.to);
      if (a === undefined || b === undefined || a === b) continue;
      from.push(a);
      to.push(b);
    }
    const pack = (pairs, weights = null) => {
      const start = new Int32Array(n + 1);
      for (let k = 0; k < pairs.length; k += 2) start[pairs[k] + 1]++;
      for (let i = 0; i < n; i++) start[i + 1] += start[i];
      const fill = start.slice(0, n);
      const next = new Int32Array(pairs.length >> 1);
      const cost = new Float32Array(pairs.length >> 1);
      for (let k = 0; k < pairs.length; k += 2) {
        const a = pairs[k], b = pairs[k + 1];
        const slot = fill[a]++;
        next[slot] = b;
        cost[slot] = Math.hypot(x[a] - x[b], z[a] - z[b]) * (weights ? weights[k >> 1] : 1);
      }
      return { start, next, cost };
    };
    // (in a car a one-way street the wrong way costs WRONG_WAY times its length: the GPS keeps to the one-ways
    // unless the way round is far longer — Westhaven Drive's lanes, say, which run one way only on traffic's map)
    const directed = [];
    const weights = [];
    const both = [];
    const forward = new Set();
    for (let k = 0; k < from.length; k++) forward.add(from[k] * n + to[k]);
    for (let k = 0; k < from.length; k++) {
      directed.push(from[k], to[k]);
      weights.push(1);
      if (!forward.has(to[k] * n + from[k])) {
        directed.push(to[k], from[k]);
        weights.push(WRONG_WAY);
        forward.add(to[k] * n + from[k]);
      }
      both.push(from[k], to[k], to[k], from[k]);
    }
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const key = cellKey(Math.floor(x[i] / CELL), Math.floor(z[i] / CELL));
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    }
    graph = {
      n, x, z, grid,
      car: pack(directed, weights),
      walk: pack(both),
      g: new Float32Array(n),
      came: new Int32Array(n),
      stamp: new Int32Array(n),
      closed: new Int32Array(n),
      run: 0,
      heap: new Int32Array(Math.max(16, n * 2)),
      heapF: new Float32Array(Math.max(16, n * 2))
    };
    return graph;
  }

  const cellKey = (ix, iz) => (ix + 4096) * 8192 + iz + 4096;

  function nearestNode(G, px, pz, maxD = SNAP) {
    let best = -1, bd = maxD * maxD;
    const r = Math.ceil(maxD / CELL);
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    for (let ring = 0; ring <= r; ring++) {
      // rings outward: stop once a node is closer than the ring could hold
      if (best >= 0 && (ring - 1) * CELL > Math.sqrt(bd)) break;
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iz = cz - ring; iz <= cz + ring; iz++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== ring) continue;
          const list = G.grid.get(cellKey(ix, iz));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const i = list[k];
            const d = (G.x[i] - px) ** 2 + (G.z[i] - pz) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }

  /** A* from node s to node t: the nodes' positions along the way as [x0, z0, x1, z1, ...], or null */
  function search(G, adj, s, t) {
    const run = ++G.run;
    const { g, came, stamp, closed, heap, heapF, x, z } = G;
    const tx = x[t], tz = z[t];
    let size = 0;
    const push = (i, f) => {
      if (size >= heap.length) return; // (cannot happen: each node is pushed at most once per improvement)
      let k = size++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heapF[p] <= f) break;
        heap[k] = heap[p];
        heapF[k] = heapF[p];
        k = p;
      }
      heap[k] = i;
      heapF[k] = f;
    };
    const pop = () => {
      const top = heap[0];
      const lastI = heap[--size], lastF = heapF[size];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= size) break;
        if (c + 1 < size && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lastF) break;
        heap[k] = heap[c];
        heapF[k] = heapF[c];
        k = c;
      }
      heap[k] = lastI;
      heapF[k] = lastF;
      return top;
    };
    stamp[s] = run;
    g[s] = 0;
    came[s] = -1;
    push(s, Math.hypot(x[s] - tx, z[s] - tz));
    let found = false;
    while (size > 0) {
      const u = pop();
      if (closed[u] === run) continue;
      closed[u] = run;
      if (u === t) {
        found = true;
        break;
      }
      const gu = g[u];
      for (let k = adj.start[u], end = adj.start[u + 1]; k < end; k++) {
        const v = adj.next[k];
        if (closed[v] === run) continue;
        const gv = gu + adj.cost[k];
        if (stamp[v] !== run || gv < g[v]) {
          stamp[v] = run;
          g[v] = gv;
          came[v] = u;
          if (size + 1 >= heap.length) break;
          push(v, gv + Math.hypot(x[v] - tx, z[v] - tz));
        }
      }
    }
    if (!found) return null;
    let count = 0;
    for (let i = t; i !== -1; i = came[i]) count++;
    const out = new Float32Array(count * 2);
    let k = count - 1;
    for (let i = t; i !== -1; i = came[i], k--) {
      out[2 * k] = x[i];
      out[2 * k + 1] = z[i];
    }
    return out;
  }

  // ---- the route the HUD shows -----------------------------------------------------------------------------------
  // route.points: [x0, z0, ...] from the first node past the player to the target; route.from: index of the first
  // point still ahead; straight: no road route (draw a line)
  const route = { active: false, blip: null, points: null, from: 0, straight: true, tx: 0, tz: 0, color: '#ffcb2e', mode: '' };
  let pending = false;
  let checkLeft = 0;
  let lastTargetX = NaN, lastTargetZ = NaN;

  function targetOf(b) {
    const t = b.target;
    return t && Number.isFinite(t.x) ? t : b;
  }

  function modeOf() {
    const v = game.player?.vehicle;
    if (!v) return 'walk';
    if (v.mode === 'helicopter') return 'air';
    return v.mode === 'car' ? 'car' : 'walk';
  }

  function compute() {
    pending = false;
    if (!route.active || !route.blip) return;
    const p = game.player?.position;
    if (!p) return;
    const t = targetOf(route.blip);
    route.tx = t.x;
    route.tz = t.z;
    lastTargetX = t.x;
    lastTargetZ = t.z;
    route.mode = modeOf();
    route.points = null;
    route.from = 0;
    route.straight = true;
    if (route.mode === 'air') return;
    const G = graph || (graphFailed ? null : build());
    if (!G) return;
    const s = nearestNode(G, p.x, p.z);
    const e = nearestNode(G, t.x, t.z);
    if (s < 0 || e < 0) return;
    const pts = s === e ? new Float32Array([G.x[s], G.z[s]]) : search(G, route.mode === 'car' ? G.car : G.walk, s, e) ||
      (route.mode === 'car' ? search(G, G.walk, s, e) : null);
    if (!pts) return;
    route.points = pts;
    route.straight = false;
    advance(p.x, p.z, pts.length >> 1);
  }

  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(compute, 0);
  }

  // Moves route.from past the points the player has gone by (the nearest segment among the next few)
  function advance(px, pz, lookahead = 12) {
    const pts = route.points;
    if (!pts) return Infinity;
    const n = pts.length >> 1;
    let best = Infinity, bestK = route.from;
    const last = Math.min(n - 1, route.from + lookahead);
    for (let k = route.from; k < last; k++) {
      const d = segDist(px, pz, pts[2 * k], pts[2 * k + 1], pts[2 * k + 2], pts[2 * k + 3]);
      if (d < best) {
        best = d;
        bestK = k;
      }
    }
    if (n === 1 || route.from >= n - 1) best = Math.hypot(px - pts[2 * (n - 1)], pz - pts[2 * (n - 1) + 1]);
    // past segment bestK's start: draw from its end
    route.from = Math.min(n - 1, bestK + (best < Infinity && n > 1 && bestK < n - 1 ? 1 : 0));
    return best;
  }

  function segDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - dx * t, pz - az - dz * t);
  }

  /** The blip to route to (or null): searched now, then kept up to date by update() */
  function setTarget(blip, color) {
    if (blip === route.blip && route.active) return;
    route.blip = blip;
    route.active = !!blip;
    route.color = color || '#ffcb2e';
    route.points = null;
    route.straight = true;
    if (blip) schedule();
  }

  function update(realDt) {
    if (!route.active || !route.blip) return;
    const p = game.player?.position;
    if (!p) return;
    const t = targetOf(route.blip);
    route.tx = t.x;
    route.tz = t.z;
    if ((checkLeft -= realDt) > 0) return;
    checkLeft = RECHECK;
    const mode = modeOf();
    if (mode !== route.mode || Math.hypot(t.x - lastTargetX, t.z - lastTargetZ) > 25) {
      schedule();
      return;
    }
    if (route.points) {
      const off = advance(p.x, p.z);
      if (off > STRAY) schedule();
    } else if (!route.straight || mode !== 'air') {
      // no road route yet (off the network): try again now and then, the player may have reached a street
      if (Math.random() < 0.25) schedule();
    }
  }

  return { route, setTarget, update, refresh: schedule };
}

export { createGps };
