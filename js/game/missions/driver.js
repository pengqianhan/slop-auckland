// Game AI drivers for mission vehicles (a van to tail, a getaway car to run down, rival racers, a convoy): routes
// planned over traffic's lane network (A* on its directed edges, so they keep left and take real turns) or given as
// a polyline (the motorway over the Harbour Bridge, which traffic's network does not include), then driven with
// pure pursuit through game.vehicles.setControls. They slow for corners and for whatever is in front of them (unless
// told to barge), back out when stuck, and report their progress. All per-frame work is allocation-free.
//   const d = driving.drive(vehicle, { points, speed: 14, onArrive, barge, loop });
//   d.stop();  d.done;  d.remaining (m);  d.setSpeed(s)
//   driving.route(fromX, fromZ, toX, toZ, heading?) -> [x0, z0, x1, z1, ...] | null

const TAU = Math.PI * 2;
const wrap = (a) => a - Math.round(a / TAU) * TAU;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const EDGE_CELL = 48;
const CLEAR_AFTER = 1.5; // s stood behind traffic before the unseen queue ahead is cleared (drivers with clear: true)
const CLEAR_REACH = 45; // m ahead
const KEEP_LEFT = 2.4; // m left of a street's centre line for routes that ignore its lanes (routeAny)

function createDriving(game) {
  const network = game.engine.trafficSystem.network;
  const edges = network.edges;
  const drivers = [];

  // ---- spatial index of the lane edges (sampled along their length), built on first use ----
  let edgeCells = null;
  const ck = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  function buildIndex() {
    edgeCells = new Map();
    for (const e of edges) {
      if (!(e.len > 0) || !e.lanes?.length) continue;
      const n = Math.max(1, Math.ceil(e.len / (EDGE_CELL * 0.5)));
      const seen = new Set();
      for (let k = 0; k <= n; k++) {
        const s = (k / n) * e.len;
        const key = ck(Math.floor((e.sx + e.dx * s) / EDGE_CELL), Math.floor((e.sz + e.dz * s) / EDGE_CELL));
        if (seen.has(key)) continue;
        seen.add(key);
        let list = edgeCells.get(key);
        if (!list) edgeCells.set(key, (list = []));
        list.push(e);
      }
    }
  }

  /** The lane edge nearest (x, z) (along heading if given): { edge, s (m along it), d (m away) } */
  function nearestEdge(x, z, heading = null, maxDist = 160) {
    if (!edgeCells) buildIndex();
    let best = null, bestScore = Infinity, bestS = 0, bestD = 0;
    const reach = Math.ceil(maxDist / EDGE_CELL);
    const cx = Math.floor(x / EDGE_CELL), cz = Math.floor(z / EDGE_CELL);
    const hs = heading === null ? 0 : Math.sin(heading), hc = heading === null ? 0 : Math.cos(heading);
    for (let r = 0; r <= reach; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
          const list = edgeCells.get(ck(ix, iz));
          if (!list) continue;
          for (const e of list) {
            const s = clamp((x - e.sx) * e.dx + (z - e.sz) * e.dz, 0, e.len);
            const px = e.sx + e.dx * s, pz = e.sz + e.dz * s;
            const d = Math.hypot(px - x, pz - z);
            // against the heading costs as much as 25 m
            const score = d + (heading === null ? 0 : (1 - (e.dx * hs + e.dz * hc)) * 12.5);
            if (score < bestScore) {
              bestScore = score;
              best = e;
              bestS = s;
              bestD = d;
            }
          }
        }
      }
      if (best && bestD < r * EDGE_CELL - EDGE_CELL) break;
    }
    return best ? { edge: best, s: bestS, d: bestD } : null;
  }

  // ---- A* over directed lane edges (an edge leads on to its moves' edges) ----
  let gScore = null, from = null, closed = null, stamp = null, curStamp = 0;
  const heap = [];
  function heapPush(id, f) {
    heap.push(id, f);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2 + 1] <= heap[i * 2 + 1]) break;
      const ti = heap[i * 2], tf = heap[i * 2 + 1];
      heap[i * 2] = heap[p * 2]; heap[i * 2 + 1] = heap[p * 2 + 1];
      heap[p * 2] = ti; heap[p * 2 + 1] = tf;
      i = p;
    }
  }
  function heapPop() {
    const top = heap[0];
    const lastF = heap.pop(), lastId = heap.pop();
    const n = heap.length / 2;
    if (n > 0) {
      heap[0] = lastId;
      heap[1] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < n && heap[l * 2 + 1] < heap[m * 2 + 1]) m = l;
        if (r < n && heap[r * 2 + 1] < heap[m * 2 + 1]) m = r;
        if (m === i) break;
        const ti = heap[i * 2], tf = heap[i * 2 + 1];
        heap[i * 2] = heap[m * 2]; heap[i * 2 + 1] = heap[m * 2 + 1];
        heap[m * 2] = ti; heap[m * 2 + 1] = tf;
        i = m;
      }
    }
    return top;
  }

  const laneOf = (e) => e.lanes[0];
  function pushEdgePoints(out, e, s0, s1) {
    const off = laneOf(e);
    out.push(e.sx + e.dx * s0 + e.rx * off, e.sz + e.dz * s0 + e.rz * off);
    out.push(e.sx + e.dx * s1 + e.rx * off, e.sz + e.dz * s1 + e.rz * off);
  }

  /** A road route from (fx, fz) to (tx, tz) as a flat [x, z, ...] polyline along the lanes, or null */
  function route(fx, fz, tx, tz, heading = null, arriveHeading = null) {
    // the lanes to leave and arrive by, when not told: the ones heading roughly our way (on a dual carriageway the far
    // side's lane is as near as ours, and taking it means a U-turn kilometres round)
    const bearing = Math.hypot(tx - fx, tz - fz) > 30 ? Math.atan2(tx - fx, tz - fz) : null;
    const a = nearestEdge(fx, fz, heading ?? bearing);
    const b = nearestEdge(tx, tz, arriveHeading ?? bearing);
    if (!a || !b) return null;
    const n = edges.length;
    if (!gScore || gScore.length < n) {
      gScore = new Float64Array(n);
      from = new Int32Array(n);
      closed = new Uint8Array(n);
      stamp = new Uint32Array(n);
    }
    curStamp++;
    heap.length = 0;
    const touch = (id) => {
      if (stamp[id] !== curStamp) {
        stamp[id] = curStamp;
        gScore[id] = Infinity;
        from[id] = -1;
        closed[id] = 0;
      }
    };
    const startId = a.edge.id, goalId = b.edge.id;
    touch(startId);
    gScore[startId] = a.edge.len - a.s;
    heapPush(startId, gScore[startId]);
    let found = startId === goalId && b.s >= a.s;
    let guard = 0;
    while (!found && heap.length && guard++ < 60000) {
      const id = heapPop();
      if (closed[id]) continue;
      closed[id] = 1;
      const e = edges[id];
      for (const m of e.moves) {
        const f = m.to;
        if (!f || !f.lanes?.length) continue;
        touch(f.id);
        if (closed[f.id]) continue;
        const g = gScore[id] + (f.id === goalId ? b.s : f.len) + (m.turn === 'S' ? 0 : 6);
        if (g < gScore[f.id]) {
          gScore[f.id] = g;
          from[f.id] = id;
          if (f.id === goalId) {
            found = true;
            break;
          }
          const hx = f.sx + f.dx * f.len - tx, hz = f.sz + f.dz * f.len - tz;
          heapPush(f.id, g + Math.hypot(hx, hz));
        }
      }
    }
    if (!found) return null;
    const chain = [];
    for (let id = goalId; id !== -1 && chain.length < 4000; id = id === startId ? -1 : from[id]) chain.push(edges[id]);
    chain.reverse();
    const out = [];
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i];
      const s0 = i === 0 ? a.s : 0;
      const s1 = i === chain.length - 1 ? (chain.length === 1 ? Math.max(b.s, a.s) : b.s) : e.len;
      if (s1 - s0 > 0.5) pushEdgePoints(out, e, s0, s1);
    }
    return out.length >= 4 ? out : null;
  }

  // ---- the streets either way (node to node, one-ways ignored): what a player — or a racer — would drive ----
  let adj = null;
  function buildAdj() {
    const nodes = network.nodes;
    adj = nodes.map(() => []);
    for (const e of edges) {
      if (!e.from || !e.to || !(e.len > 0) || e.from === e.to) continue;
      adj[e.from.id].push(e.to.id);
      adj[e.to.id].push(e.from.id);
    }
  }
  function nearestNode(x, z) {
    const nodes = network.nodes;
    let best = -1, bd = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!adj[i].length) continue;
      const d = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  /** A route along the streets' centre lines, one-way or not: flat [x, z, ...] from (fx, fz) to (tx, tz), or null */
  function routeAny(fx, fz, tx, tz) {
    if (!adj) buildAdj();
    const nodes = network.nodes;
    const a = nearestNode(fx, fz), b = nearestNode(tx, tz);
    if (a < 0 || b < 0) return null;
    const n = nodes.length;
    const g = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const open = [a];
    g[a] = 0;
    const f = (i) => g[i] + Math.hypot(nodes[i].x - tx, nodes[i].z - tz);
    while (open.length) {
      let k = 0;
      for (let i = 1; i < open.length; i++) if (f(open[i]) < f(open[k])) k = i;
      const u = open[k];
      open[k] = open[open.length - 1];
      open.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === b) break;
      for (const w of adj[u]) {
        const ng = g[u] + Math.hypot(nodes[w].x - nodes[u].x, nodes[w].z - nodes[u].z);
        if (ng < g[w]) {
          g[w] = ng;
          came[w] = u;
          open.push(w);
        }
      }
    }
    if (!done[b]) return null;
    const chain = [];
    for (let u = b; u !== -1 && chain.length < 4000; u = came[u]) chain.push(u);
    chain.reverse();
    const out = [fx, fz];
    for (const u of chain) out.push(nodes[u].x, nodes[u].z);
    out.push(tx, tz);
    return keepLeft(out, KEEP_LEFT);
  }

  // Node to node is the street's centre line: shifted `d` m to the left of the way of travel (traffic keeps left),
  // so a driver on it meets the oncoming lane's cars beside it, not head on. The ends stay put.
  function keepLeft(P, d) {
    const n = P.length / 2;
    if (n < 3) return P;
    const out = P.slice();
    for (let i = 1; i < n - 1; i++) {
      let ax = P[i * 2] - P[i * 2 - 2], az = P[i * 2 + 1] - P[i * 2 - 1];
      let bx = P[i * 2 + 2] - P[i * 2], bz = P[i * 2 + 3] - P[i * 2 + 1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      ax /= la; az /= la; bx /= lb; bz /= lb;
      // the left of a heading (sin h, cos h) is (cos h, -sin h): of a direction (dx, dz), (dz, -dx)
      let nx = az + bz, nz = -ax - bx;
      const ln = Math.hypot(nx, nz);
      if (ln < 0.2) continue; // (a U-turn: leave it)
      nx /= ln;
      nz /= ln;
      // (on a bend the offset grows so the two straights' offsets meet; capped)
      const k = Math.min(2, 1 / Math.max(0.5, (ax * bx + az * bz + 1) / 2) ** 0.5);
      out[i * 2] = P[i * 2] + nx * d * k;
      out[i * 2 + 1] = P[i * 2 + 1] + nz * d * k;
    }
    return out;
  }

  /** Concatenates routes through several stops: [[x, z], ...] -> flat polyline (straight lines where no road route) */
  function routeVia(stops, heading = null) {
    const out = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const [ax, az] = stops[i], [bx, bz] = stops[i + 1];
      const leg = route(ax, az, bx, bz, i === 0 ? heading : null) || [ax, az, bx, bz];
      for (let k = 0; k < leg.length; k++) out.push(leg[k]);
    }
    return out;
  }

  // ---- driving ----
  const near = [];
  class Driver {
    constructor(v, opts) {
      this.v = v;
      this.points = opts.points;
      this.speed = opts.speed ?? 13;
      this.barge = !!opts.barge; // drives through rather than queueing
      this.clear = opts.clear !== false; // a mission's driver: unseen traffic queued ahead is cleared (see clearQueue)
      this.ram = !!opts.ram; // barging includes the player's car (escorts); otherwise a barging driver goes round it
      this.clearT = 0;
      this.loop = !!opts.loop;
      this.onArrive = opts.onArrive || null;
      this.arriveRadius = opts.arriveRadius ?? 7;
      this.seg = 0;
      this.done = false;
      this.stopped = false;
      this.stuckTime = 0;
      this.reverseLeft = 0;
      this.blocked = 0;
      this.remaining = Infinity;
      this.lengths = new Float64Array(this.points.length / 2);
      let total = 0;
      for (let i = this.points.length / 2 - 1; i >= 0; i--) {
        this.lengths[i] = total;
        if (i > 0) total += Math.hypot(this.points[i * 2] - this.points[i * 2 - 2], this.points[i * 2 + 1] - this.points[i * 2 - 1]);
      }
      this.total = total;
    }
    setSpeed(s) {
      this.speed = s;
    }
    stop(park = true) {
      if (this.stopped) return;
      this.stopped = true;
      if (park && this.v && !this.v.hidden && this.v.driver === 'ai') game.vehicles.setControls(this.v, null);
      const i = drivers.indexOf(this);
      if (i >= 0) drivers.splice(i, 1);
    }
    /** Where along the route (0..1) */
    get progress() {
      return this.total > 0 ? 1 - this.remaining / this.total : 1;
    }
  }

  function drive(v, opts) {
    if (!v || !opts?.points || opts.points.length < 4) return null;
    for (const d of drivers) if (d.v === v) d.stop(false);
    const d = new Driver(v, opts);
    drivers.push(d);
    return d;
  }

  function step(d, dt) {
    const v = d.v;
    if (v.hidden || v.state === 'wrecked' || v.driver === 'player' || game.vehicles.current === v) {
      d.stop(false);
      return;
    }
    const e = v.entity;
    const x = e.position.x, z = e.position.z, h = e.heading;
    const speed = e.speed || 0;
    const P = d.points;
    const n = P.length / 2;
    // the nearest point on the polyline from the current segment on (a few segments ahead)
    let bestSeg = d.seg, bestT = 0, bestD2 = Infinity;
    for (let i = d.seg; i < Math.min(n - 1, d.seg + 6); i++) {
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
      const sx = bx - ax, sz = bz - az;
      const l2 = sx * sx + sz * sz || 1e-6;
      const t = clamp(((x - ax) * sx + (z - az) * sz) / l2, 0, 1);
      const px = ax + sx * t - x, pz = az + sz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < bestD2 - 0.01) {
        bestD2 = d2;
        bestSeg = i;
        bestT = t;
      }
    }
    d.seg = bestSeg;
    const segLen = Math.hypot(P[bestSeg * 2 + 2] - P[bestSeg * 2], P[bestSeg * 2 + 3] - P[bestSeg * 2 + 1]);
    d.remaining = d.lengths[bestSeg + 1] + segLen * (1 - bestT);
    const ex = P[(n - 1) * 2], ez = P[(n - 1) * 2 + 1];
    if (d.remaining < d.arriveRadius || (bestSeg >= n - 2 && Math.hypot(ex - x, ez - z) < d.arriveRadius)) {
      if (d.loop) {
        d.seg = 0;
      } else {
        d.done = true;
        d.stop(true);
        if (d.onArrive) d.onArrive(d);
        return;
      }
    }
    // the look-ahead point (pure pursuit; short enough not to cut a city corner through someone's garden), and how
    // much the road bends within the next 12 + 1.6 v metres: the largest heading change from ours of 8 m chords
    // along it (chords, not the polyline's own segments, so the little jogs where one lane edge meets the next
    // don't count as corners)
    const look = clamp(4.5 + Math.abs(speed) * 0.55, 4.5, 22);
    pointAlong(P, n, bestSeg, bestT, look, pa);
    const lx = pa.x, lz = pa.z;
    let turn = 0;
    {
      const reach = 12 + Math.abs(speed) * 1.6;
      let px = x, pz = z;
      for (let s = 8; s <= reach + 8; s += 8) {
        if (!pointAlong(P, n, bestSeg, bestT, s, pa)) break;
        turn = Math.max(turn, Math.abs(wrap(Math.atan2(pa.x - px, pa.z - pz) - h)));
        px = pa.x;
        pz = pa.z;
      }
    }
    const desired = Math.atan2(lx - x, lz - z);
    const err = wrap(desired - h);
    let target = d.speed * (1 - Math.min(0.75, Math.max(0, turn - 0.15) * 0.6));
    if (Math.abs(err) > 1.2) target = Math.min(target, 6);
    // what is in front: traffic, world vehicles, the player on foot
    const sin = Math.sin(h), cos = Math.cos(h);
    const reachAhead = 7 + Math.abs(speed) * 1.3;
    let gap = Infinity, dodge = 0;
    game.world.nearbyCars(x, z, reachAhead + 4, near);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      const dx = c.x - x, dz = c.z - z;
      const fwd = dx * sin + dz * cos, lat = dx * cos - dz * sin;
      if (fwd > 0.5 && fwd < reachAhead && Math.abs(lat) < 2.3) {
        if (fwd < gap) {
          gap = fwd;
          dodge = lat > 0 ? -1 : 1;
        }
      }
    }
    // a mission's driver doesn't sit in a jam for minutes: queued behind traffic, the queue in front of it that the
    // camera can't see is taken off the road (traffic puts those cars back somewhere else, out of sight)
    const trafficGap = gap;
    if (d.clear && trafficGap < Infinity && Math.abs(speed) < 2.5) {
      if ((d.clearT += dt) > CLEAR_AFTER) {
        d.clearT = 0;
        clearQueue(x, z, sin, cos);
      }
    } else {
      d.clearT = 0;
    }
    const list = game.vehicles.list();
    const mine = game.vehicles.current;
    let playerAhead = false;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === v || o.hidden) continue;
      const dx = o.x - x, dz = o.z - z;
      if (Math.abs(dx) > reachAhead + 4 || Math.abs(dz) > reachAhead + 4) continue;
      const fwd = dx * sin + dz * cos, lat = dx * cos - dz * sin;
      if (fwd > 0.5 && fwd < reachAhead && Math.abs(lat) < 2.4 && fwd < gap) {
        gap = fwd;
        dodge = lat > 0 ? -1 : 1;
        playerAhead = o === mine;
      }
    }
    const pl = game.player;
    if (pl?.alive && !pl.vehicle) {
      const dx = pl.position.x - x, dz = pl.position.z - z;
      const fwd = dx * sin + dz * cos, lat = dx * cos - dz * sin;
      if (fwd > 0.5 && fwd < reachAhead && Math.abs(lat) < 1.8 && fwd < gap) {
        gap = fwd;
        dodge = lat > 0 ? -1 : 1;
      }
    }
    let steer = clamp(err * 2.4, -1, 1);
    // queued too long behind something that isn't moving (a jam, a parked car): go round it for a moment
    if (d.passLeft > 0) d.passLeft -= dt;
    else if (d.blocked > (d.clear ? 2 : 3.5)) {
      d.blocked = 0;
      d.passLeft = 3;
    }
    if (gap < Infinity) {
      if (playerAhead && d.barge && !d.ram) {
        // (barging through traffic is one thing; a race rival or a getaway car ramming the player's car to bits from
        // behind is another: it keeps its distance and goes round, hard)
        steer = clamp(steer + dodge * 0.8 * clamp(1.2 - gap / reachAhead, 0, 1), -1, 1);
        const ps = mine ? Math.abs(mine.speed || 0) : 0;
        target = Math.min(target, ps + Math.max(0, gap - 7) * 0.8);
      } else if (d.barge || d.passLeft > 0) {
        // swerve round it at speed
        steer = clamp(steer + dodge * 0.35 * clamp(1 - gap / reachAhead, 0, 1), -1, 1);
      } else {
        target = Math.min(target, Math.max(0, (gap - 5.5) * 0.9));
      }
    }
    // stuck (against a wall, a jam): back out a little, the other way
    if (d.reverseLeft > 0) {
      d.reverseLeft -= dt;
      game.vehicles.setControls(v, -0.75, -Math.sign(err || 1));
      return;
    }
    if (target > 2 && Math.abs(speed) < 0.9 && gap > 8) {
      d.stuckTime += dt;
      if (d.stuckTime > 2.2) {
        d.stuckTime = 0;
        d.reverseLeft = 1.4;
      }
    } else {
      d.stuckTime = Math.max(0, d.stuckTime - dt);
    }
    // (crawling in a queue counts as blocked: Auckland's jams can take minutes to clear)
    d.blocked = gap < Infinity && !d.barge && target < 2.5 && Math.abs(speed) < 2.5 ? d.blocked + dt : Math.max(0, d.blocked - dt);
    if (d.passLeft > 0) target = Math.max(target, 5);
    let throttle;
    if (target > speed) throttle = clamp((target - speed) * 0.35 + 0.25, 0, 1);
    else if (speed > 0.6) throttle = clamp((target - speed) * 0.28, -1, 0);
    else throttle = 0;
    game.vehicles.setControls(v, throttle, steer);
  }

  // The traffic queued in a lane-wide corridor up to CLEAR_REACH m ahead, unseen by the camera, off the road
  const queue = [];
  function clearQueue(x, z, sin, cos) {
    const tg = game.engine.trafficSystem.game;
    game.world.nearbyCars(x, z, CLEAR_REACH, queue);
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      if (c.kind === 'bus' || c.police) continue;
      const dx = c.x - x, dz = c.z - z;
      const fwd = dx * sin + dz * cos, lat = dx * cos - dz * sin;
      if (fwd < 0.5 || fwd > CLEAR_REACH || Math.abs(lat) > 2.8) continue;
      if (tg.nearView(c.x, c.z, 3, 320)) continue;
      game.world.removeCar(c.id);
    }
  }

  // The point `dist` m along the polyline from (segment seg, fraction t), into out; false past its end (out = end)
  const pa = { x: 0, z: 0 };
  function pointAlong(P, n, seg, t, dist, out) {
    let i = seg;
    let left = dist + t * Math.hypot(P[i * 2 + 2] - P[i * 2], P[i * 2 + 3] - P[i * 2 + 1]);
    for (; i < n - 1; i++) {
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
      const l = Math.hypot(bx - ax, bz - az);
      if (left <= l) {
        const f = l > 0 ? left / l : 1;
        out.x = ax + (bx - ax) * f;
        out.z = az + (bz - az) * f;
        return true;
      }
      left -= l;
    }
    out.x = P[(n - 1) * 2];
    out.z = P[(n - 1) * 2 + 1];
    return false;
  }

  function update(dt) {
    if (!(dt > 0)) return;
    for (let i = drivers.length - 1; i >= 0; i--) {
      const d = drivers[i];
      if (d.stopped) continue;
      step(d, dt);
    }
  }

  return {
    route,
    routeAny,
    routeVia,
    nearestEdge,
    drive,
    drivers,
    update,
    stopAll() {
      for (let i = drivers.length - 1; i >= 0; i--) drivers[i].stop(true);
    }
  };
}

/** A polyline (flat [x, z, ...]) resampled to points every `step` m (for routes over open ground) */
function densify(points, step = 15) {
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], bx = points[i], bz = points[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 1; k <= n; k++) out.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }
  return out;
}

export { createDriving, densify };
