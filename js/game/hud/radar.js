// The radar: a round minimap turning with the camera (up is where you look), drawn on a 2D canvas every other frame.
// The ground comes from city-map.js (drawGround), rendered once into 256 px tiles at two or three fixed scales and
// kept in a small cache, so a frame only blits a rotated window of cached tiles (never the vector streets): at most
// one new tile is drawn per radar frame, the coarser level standing in for a fine tile not drawn yet. Over it: the
// GPS route, area blips, blips from game.blips (an icon per kind, held to the rim when out of range, with a height
// arrow), police units, north and the player's arrow. The same icons & route are drawn over the full map.

const TILE = 256; // px per tile side
const LEVELS = [0.42, 0.105, 0.026]; // device px per metre at dpr 1 (x dpr)
const MAX_TILES = 44; // per level
const BASE_SCALE = 0.36; // CSS px per metre on foot (the radar's radius sees ~230 m)

// Harbour-night ground: deep water, slate blocks with the streets a lighter blue-grey between them, a teal shoreline
const GAME_PALETTE = {
  water: '#04101a', land: '#0e151d', landEdge: '#1b2633', islands: '#0f1a16', islandsEdge: '#1d2f27', piers: '#1c2733',
  streets: '#364a60', shore: '#2a8a8f', park: '#0f2a1d', parkEdge: '#173a29', block: '#111923', blockEdge: '#18222e',
  lawn: '#14331f', drive: '#204032', transverse: '#183025', pond: '#08202e', pondEdge: '#14405a',
  buildings: ['#18212c', '#1d2834', '#25313e'], buildingEdge: '#0c1219', landmarkFill: 'rgba(45, 226, 208, 0.08)',
  landmarkEdge: 'rgba(45, 226, 208, 0.55)', mainRoads: '#33465a', highway: '#a07a2c', bridge: '#c09236', route: '#ffcb2e',
  search: '#2de2d0', halo: 'rgba(3, 7, 12, 0.9)'
};

// Blip kinds: colour and glyph
const KIND_COLOR = {
  mission: '#ffcb2e', objective: '#ffcb2e', destination: '#ffcb2e', enemy: '#ff3355', police: '#4d8dff',
  'shop-sports': '#2de2d0', 'shop-spray': '#c38bff', 'shop-food': '#ff9f43', safehouse: '#5cf28c', hospital: '#ff5a6e',
  pickup: '#2de2d0', race: '#f4f1ea', collectible: '#ffe066', vehicle: '#7cc4ff', friend: '#5cf28c'
};
const SMALL_KINDS = new Set(['enemy', 'pickup', 'friend', 'collectible']);

function colorOf(b) {
  const c = b.color;
  if (typeof c === 'number') return `#${c.toString(16).padStart(6, '0')}`;
  return c || KIND_COLOR[b.kind] || '#f4f1ea';
}

// ---- icons: drawn once per kind & colour into a small sprite ---------------------------------------------------------
const sprites = new Map(); // kind -> Map(colour -> canvas)
function sprite(kind, color) {
  let byColor = sprites.get(kind);
  if (!byColor) sprites.set(kind, (byColor = new Map()));
  let c = byColor.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d');
  g.translate(24, 24);
  g.scale(2, 2);
  drawGlyph(g, kind, color);
  byColor.set(color, c);
  return c;
}

// (in a 24 px box centred on the origin)
function drawGlyph(g, kind, color) {
  const ink = '#05080f';
  const disc = (r, fill, stroke = ink, lw = 2) => {
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.lineWidth = lw;
      g.strokeStyle = stroke;
      g.stroke();
    }
  };
  const token = () => disc(8.6, ink, color, 1.8);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (kind) {
    case 'mission': {
      g.beginPath();
      g.moveTo(0, -10);
      g.lineTo(10, 0);
      g.lineTo(0, 10);
      g.lineTo(-10, 0);
      g.closePath();
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = ink;
      g.stroke();
      g.fillStyle = ink;
      g.fillRect(-1.3, -5.2, 2.6, 6.2);
      g.fillRect(-1.3, 2.6, 2.6, 2.6);
      break;
    }
    case 'objective':
      disc(6.2, color);
      break;
    case 'destination':
      disc(7.4, color);
      disc(2.6, ink, null);
      break;
    case 'enemy':
      disc(4.4, color);
      break;
    case 'friend':
      disc(4.4, color);
      g.beginPath();
      g.arc(0, 0, 7, 0, Math.PI * 2);
      g.lineWidth = 1.4;
      g.strokeStyle = color;
      g.stroke();
      break;
    case 'police':
      disc(4.6, color);
      break;
    case 'pickup':
      g.rotate(Math.PI / 4);
      g.fillStyle = ink;
      g.fillRect(-5.4, -5.4, 10.8, 10.8);
      g.fillStyle = color;
      g.fillRect(-3.6, -3.6, 7.2, 7.2);
      break;
    case 'collectible': {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        const r = i % 2 ? 2.6 : 6.4;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 1.6;
      g.strokeStyle = ink;
      g.stroke();
      break;
    }
    case 'hospital':
      g.fillStyle = '#f4f1ea';
      roundRect(g, -8, -8, 16, 16, 3.5);
      g.fill();
      g.fillStyle = color;
      g.fillRect(-1.9, -5.6, 3.8, 11.2);
      g.fillRect(-5.6, -1.9, 11.2, 3.8);
      break;
    case 'safehouse':
      token();
      g.beginPath();
      g.moveTo(0, -5.2);
      g.lineTo(5.2, -0.4);
      g.lineTo(3.6, -0.4);
      g.lineTo(3.6, 4.6);
      g.lineTo(-3.6, 4.6);
      g.lineTo(-3.6, -0.4);
      g.lineTo(-5.2, -0.4);
      g.closePath();
      g.fillStyle = color;
      g.fill();
      break;
    case 'shop-sports':
      // a cricket bat leaning on a ball
      token();
      g.fillStyle = color;
      g.save();
      g.rotate(-0.6);
      roundRect(g, -1.6, -5.6, 3.2, 7.4, 1.1);
      g.fill();
      g.fillRect(-0.55, 1.6, 1.1, 3.6);
      g.restore();
      g.beginPath();
      g.arc(3.4, 3.2, 2, 0, Math.PI * 2);
      g.fill();
      break;
    case 'shop-spray':
      token();
      g.fillStyle = color;
      roundRect(g, -2.8, -2.4, 5.6, 7.6, 1.2);
      g.fill();
      g.fillRect(-1.2, -4.8, 2.4, 2);
      g.beginPath();
      g.arc(3.8, -4.6, 0.9, 0, Math.PI * 2);
      g.arc(5.4, -2.8, 0.7, 0, Math.PI * 2);
      g.fill();
      break;
    case 'shop-food':
      // a mince & cheese pie
      token();
      g.fillStyle = color;
      g.beginPath();
      g.ellipse(0, 1.2, 5.6, 3.6, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ink;
      g.fillRect(-3.4, -0.2, 6.8, 1.1);
      g.fillRect(-0.6, -2.2, 1.2, 1.6);
      break;
    case 'race': {
      g.fillStyle = ink;
      g.fillRect(-7.4, -7.4, 14.8, 14.8);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          g.fillStyle = (i + j) % 2 ? ink : color;
          g.fillRect(-6 + i * 3, -6 + j * 3, 3, 3);
        }
      }
      break;
    }
    case 'vehicle':
      token();
      g.fillStyle = color;
      roundRect(g, -5.2, -2.6, 10.4, 4.6, 1.6);
      g.fill();
      roundRect(g, -3, -4.6, 6, 2.6, 1.2);
      g.fill();
      g.fillStyle = ink;
      g.beginPath();
      g.arc(-2.8, 2.4, 1.3, 0, Math.PI * 2);
      g.arc(2.8, 2.4, 1.3, 0, Math.PI * 2);
      g.fill();
      break;
    default:
      disc(5.6, color);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------------------------------------------------------------
function createRadar(game, { canvas, mapSystem, gps, extraBlips }) {
  const ctx = canvas.getContext('2d');
  let dpr = 1, W = 0, H = 0, size = 0;
  let scale = BASE_SCALE;
  let version = -1;
  let frame = 0;
  // tiles: per level, Map key -> { canvas, ctx, used }
  const levels = LEVELS.map(() => new Map());
  const spare = [];
  const queue = []; // [level, ix, iz] triples of tiles wanted & missing
  const wanted = new Set();

  function resize() {
    const css = canvas.clientWidth || 160;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (css === size && d === dpr) return;
    size = css;
    if (d !== dpr) clearTiles();
    dpr = d;
    W = H = Math.round(css * dpr);
    canvas.width = W;
    canvas.height = H;
  }

  function clearTiles() {
    for (const lv of levels) {
      for (const t of lv.values()) spare.push(t);
      lv.clear();
    }
    queue.length = 0;
    wanted.clear();
  }

  const key = (l, ix, iz) => (l * 4096 + ix + 2048) * 4096 + iz + 2048;
  const tileMetres = (l) => TILE / (LEVELS[l] * dpr);

  function tile(l, ix, iz) {
    const t = levels[l].get(key(l, ix, iz));
    if (t) {
      t.used = frame;
      return t;
    }
    const k = key(l, ix, iz);
    if (!wanted.has(k)) {
      wanted.add(k);
      queue.push(l, ix, iz);
    }
    return null;
  }

  // Draws the nearest wanted tile (coarse levels first: they cover for the fine ones)
  function pump() {
    if (!queue.length || !mapSystem?.drawGround) return;
    let best = -1, bestScore = Infinity;
    const p = game.player?.position;
    for (let q = 0; q < queue.length; q += 3) {
      const l = queue[q];
      const T = tileMetres(l);
      const dx = p ? (queue[q + 1] + 0.5) * T - p.x : 0;
      const dz = p ? (queue[q + 2] + 0.5) * T - p.z : 0;
      const score = -l * 1e6 + dx * dx + dz * dz;
      if (score < bestScore) {
        bestScore = score;
        best = q;
      }
    }
    const l = queue[best], ix = queue[best + 1], iz = queue[best + 2];
    queue.splice(best, 3);
    const k = key(l, ix, iz);
    wanted.delete(k);
    const lv = levels[l];
    if (lv.has(k)) return;
    let t;
    if (lv.size >= MAX_TILES) {
      // the least recently drawn tile of the level makes room
      let oldK = -1, oldUsed = Infinity;
      for (const [kk, tt] of lv) {
        if (tt.used < oldUsed) {
          oldUsed = tt.used;
          oldK = kk;
        }
      }
      t = lv.get(oldK);
      lv.delete(oldK);
    } else {
      t = spare.pop();
      if (!t) {
        const c = document.createElement('canvas');
        c.width = c.height = TILE;
        t = { canvas: c, ctx: c.getContext('2d'), used: 0 };
      }
    }
    const T = tileMetres(l);
    mapSystem.drawGround(t.ctx, (ix + 0.5) * T, (iz + 0.5) * T, LEVELS[l] * dpr, TILE, TILE);
    t.used = frame;
    lv.set(k, t);
  }

  // ---- per draw -------------------------------------------------------------------------------------------------
  let yaw = 0;
  let rx = -1, rz = 0, fx = 0, fz = 1;
  let px = 0, pz = 0, py = 0;

  function frameView(realDt) {
    const cam = game.engine.cameraSystem;
    const dx = cam.currentLookAt.x - cam.currentPos.x, dz = cam.currentLookAt.z - cam.currentPos.z;
    if (dx * dx + dz * dz > 1e-6) yaw = Math.atan2(dx, dz);
    rx = -Math.cos(yaw);
    rz = Math.sin(yaw);
    fx = Math.sin(yaw);
    fz = Math.cos(yaw);
    const p = game.player.position;
    px = p.x;
    pz = p.z;
    py = p.y;
    // zoom: out with speed in a vehicle and with height in the air
    const v = game.player.vehicle;
    let target = BASE_SCALE;
    if (v) {
      target = v.mode === 'helicopter'
        ? BASE_SCALE / (1 + Math.max(0, py - 20) / 110)
        : BASE_SCALE / (1 + Math.abs(v.speed || 0) / 24);
    }
    target = Math.max(0.045, target) * (size / 168);
    scale += (target - scale) * (1 - Math.exp(-realDt * 2.2));
  }

  /** CSS px offset of world (x, z) from the radar centre, into out[0..1] */
  const out = [0, 0];
  function toRadar(x, z) {
    const dx = x - px, dz = z - pz;
    out[0] = (dx * rx + dz * rz) * scale;
    out[1] = -(dx * fx + dz * fz) * scale;
    return out;
  }

  function worldTransform() {
    const S = scale * dpr;
    const a = S * rx, b = -S * fx, c = S * rz, d = -S * fz;
    ctx.setTransform(a, b, c, d, W / 2 - (a * px + c * pz), H / 2 - (b * px + d * pz));
  }

  function drawTiles(l, reach) {
    const T = tileMetres(l);
    const x0 = Math.floor((px - reach) / T), x1 = Math.floor((px + reach) / T);
    const z0 = Math.floor((pz - reach) / T), z1 = Math.floor((pz + reach) / T);
    let missing = 0;
    const pad = T / TILE; // a pixel's overlap hides seams
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        // only tiles the circle touches
        const cx = Math.max(ix * T, Math.min(px, (ix + 1) * T));
        const cz = Math.max(iz * T, Math.min(pz, (iz + 1) * T));
        if ((cx - px) ** 2 + (cz - pz) ** 2 > reach * reach) continue;
        const t = tile(l, ix, iz);
        if (t) ctx.drawImage(t.canvas, ix * T - pad, iz * T - pad, T + 2 * pad, T + 2 * pad);
        else missing++;
      }
    }
    return missing;
  }

  function levelFor(s) {
    // the coarsest level still at least as sharp as the view
    for (let l = LEVELS.length - 1; l >= 0; l--) if (LEVELS[l] >= s * 0.95) return l;
    return 0;
  }

  // the blips' painters (made once: the radar allocates nothing per frame)
  let drawT = 0, drawR = 0;
  function areaBlip(b, bx, bz) {
    if (!(b.radius > 0)) return;
    const color = colorOf(b);
    ctx.beginPath();
    ctx.arc(bx, bz, b.radius, 0, Math.PI * 2);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  function iconBlip(b, bx, bz) {
    if (b.radius > 0 && b.kind !== 'mission') return;
    toRadar(bx, bz);
    const sx = out[0], sy = out[1];
    const d = Math.hypot(sx, sy);
    const rim = drawR - 9;
    let x = sx, y = sy, edge = false;
    if (d > rim) {
      if (b.short) return;
      x = (sx / d) * rim;
      y = (sy / d) * rim;
      edge = true;
    }
    const color = colorOf(b);
    const small = SMALL_KINDS.has(b.kind);
    const iconSize = (small ? 13 : 18) * (edge ? 0.8 : 1);
    if (b.kind === 'objective' || (b.route && b.kind !== 'destination')) {
      // a slow pulse round what the game wants you at
      const ph = (drawT * 0.8) % 1;
      ctx.beginPath();
      ctx.arc(x, y, 6 + ph * 9, 0, Math.PI * 2);
      ctx.globalAlpha = 0.7 * (1 - ph);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(sprite(b.kind, color), x - iconSize / 2, y - iconSize / 2, iconSize, iconSize);
    // above or below: a small arrow beside it
    const by = b.target && Number.isFinite(b.target.y) ? b.target.y : b.y;
    if (Number.isFinite(by) && Math.abs(by - py) > 7 && !edge) {
      const up = by > py;
      ctx.beginPath();
      ctx.moveTo(x + iconSize / 2 + 1, y + (up ? 2 : -2));
      ctx.lineTo(x + iconSize / 2 + 7, y + (up ? 2 : -2));
      ctx.lineTo(x + iconSize / 2 + 4, y + (up ? -3 : 3));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  /** Draws the radar (call every other frame) */
  function draw(realDt, now) {
    if (!game.player || !game.engine?.cameraSystem) return;
    frame++;
    resize();
    const gv = mapSystem?.groundVersion ?? 0;
    if (gv !== version) {
      version = gv;
      clearTiles();
    }
    frameView(realDt);
    const R = size / 2;
    const reach = (R + 4) / scale;
    const P = mapSystem?.palette || GAME_PALETTE;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = P.water;
    ctx.fillRect(0, 0, W, H);

    worldTransform();
    ctx.imageSmoothingEnabled = true;
    const l = levelFor(scale);
    // the coarser level first wherever fine tiles are still missing
    const fineMissing = countMissing(l, reach);
    if (fineMissing && l + 1 < LEVELS.length) drawTiles(l + 1, reach);
    drawTiles(l, reach);

    // area blips & the route, in world units
    const blips = game.blips?.list;
    eachBlip(blips, areaBlip);
    drawRouteWorld(ctx, 1 / scale, 3.2);
    ctx.restore();

    // screen-space marks, from the centre
    ctx.setTransform(dpr, 0, 0, dpr, W / 2, H / 2);
    const t = now * 0.001;
    drawT = t;
    drawR = R;
    eachBlip(blips, iconBlip);

    // police units: red & blue, alternating
    const units = game.police?.units?.();
    if (units && units.length) {
      const flip = Math.floor(t * 5) % 2;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || !Number.isFinite(u.x)) continue;
        toRadar(u.x, u.z);
        const sx = out[0], sy = out[1];
        if (Math.hypot(sx, sy) > R - 6) continue;
        const heli = u.kind === 'heli';
        ctx.beginPath();
        ctx.arc(sx, sy, heli ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = (i + flip) % 2 ? '#ff3355' : '#4d8dff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#05080f';
        ctx.stroke();
        if (heli) {
          ctx.beginPath();
          ctx.arc(sx, sy, 9 + Math.sin(t * 6) * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // north on the rim
    const na = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
    const nx = Math.sin(na) * (R - 10), ny = -Math.cos(na) * (R - 10);
    ctx.beginPath();
    ctx.arc(nx, ny, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = '#05080f';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(244, 241, 234, 0.6)';
    ctx.stroke();
    ctx.fillStyle = '#f4f1ea';
    ctx.font = '700 10px "Barlow Condensed", "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);

    // the player: an arrow along their heading
    const ent = game.engine.controllerManager?.getActiveEntity?.();
    const heading = ent ? ent.heading : yaw;
    ctx.save();
    ctx.rotate(yaw - heading);
    ctx.beginPath();
    ctx.moveTo(0, -8.5);
    ctx.lineTo(6, 6.5);
    ctx.lineTo(0, 3.4);
    ctx.lineTo(-6, 6.5);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#05080f';
    ctx.stroke();
    ctx.fillStyle = '#f4f1ea';
    ctx.fill();
    ctx.restore();

    // one new ground tile a frame at most
    pump();
  }

  function countMissing(l, reach) {
    const T = tileMetres(l);
    let missing = 0;
    for (let ix = Math.floor((px - reach) / T); ix <= Math.floor((px + reach) / T); ix++) {
      for (let iz = Math.floor((pz - reach) / T); iz <= Math.floor((pz + reach) / T); iz++) {
        if (!levels[l].has(key(l, ix, iz))) missing++;
      }
    }
    return missing;
  }

  function eachBlip(list, fn) {
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!b || b.visible === false) continue;
        const t = b.target;
        const x = t && Number.isFinite(t.x) ? t.x : b.x;
        const z = t && Number.isFinite(t.z) ? t.z : b.z;
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        fn(b, x, z);
      }
    }
    const extra = extraBlips();
    for (let i = 0; i < extra.length; i++) {
      const b = extra[i];
      if (b.visible !== false) fn(b, b.x, b.z);
    }
  }

  // The GPS route in the current (world) transform; unit: metres per CSS px
  function drawRouteWorld(g, unit, width) {
    const r = gps.route;
    if (!r.active || !r.blip) return;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(px, pz);
    const pts = r.points;
    if (pts) for (let k = r.from; k < pts.length >> 1; k++) g.lineTo(pts[2 * k], pts[2 * k + 1]);
    g.lineTo(r.tx, r.tz);
    g.strokeStyle = 'rgba(3, 7, 12, 0.85)';
    g.lineWidth = (width + 3) * unit;
    g.stroke();
    g.strokeStyle = r.color;
    g.lineWidth = width * unit;
    g.stroke();
  }

  /** Over the full map (city-map.js drawOverlay): the route, area blips, blips & police, in screen px from the centre */
  function drawMapOverlay(g, v) {
    if (!game.player) return;
    const p = game.player.position;
    px = p.x;
    pz = p.z;
    // the route & areas in world units through the view's transform
    g.save();
    v.world(g);
    eachBlip(game.blips?.list, (b, bx, bz) => {
      if (!(b.radius > 0)) return;
      g.beginPath();
      g.arc(bx, bz, b.radius, 0, Math.PI * 2);
      g.fillStyle = withAlpha(colorOf(b), 0.2);
      g.fill();
    });
    drawRouteWorld(g, 1 / v.s, 4);
    g.restore();
    v.screen(g);
    g.font = '700 12px "Barlow Condensed", "Inter", sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const t = performance.now() * 0.001;
    eachBlip(game.blips?.list, (b, bx, bz) => {
      const x = v.toX(bx), y = v.toY(bz);
      if (Math.abs(x) > v.w / 2 + 20 || Math.abs(y) > v.h / 2 + 20) return;
      const color = colorOf(b);
      const s = SMALL_KINDS.has(b.kind) ? 16 : 24;
      if (b.kind === 'objective' || b.route) {
        const ph = (t * 0.8) % 1;
        g.beginPath();
        g.arc(x, y, 8 + ph * 14, 0, Math.PI * 2);
        g.globalAlpha = 0.75 * (1 - ph);
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.stroke();
        g.globalAlpha = 1;
      }
      g.drawImage(sprite(b.kind, color), x - s / 2, y - s / 2, s, s);
      if (b.label && !SMALL_KINDS.has(b.kind)) {
        g.lineWidth = 3.5;
        g.strokeStyle = 'rgba(3, 7, 12, 0.92)';
        g.strokeText(b.label, x + s / 2 + 4, y);
        g.fillStyle = color;
        g.fillText(b.label, x + s / 2 + 4, y);
      }
    });
    const units = game.police?.units?.();
    if (units) {
      const flip = Math.floor(t * 5) % 2;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || !Number.isFinite(u.x)) continue;
        g.beginPath();
        g.arc(v.toX(u.x), v.toY(u.z), u.kind === 'heli' ? 6.5 : 5, 0, Math.PI * 2);
        g.fillStyle = (i + flip) % 2 ? '#ff3355' : '#4d8dff';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = '#05080f';
        g.stroke();
      }
    }
  }

  /** Draws ground tiles around the player ahead of time (the title screen warms the cache up) */
  function prefetch() {
    if (!game.player || !mapSystem?.drawGround) return;
    resize();
    if (!size) return;
    const p = game.player.position;
    px = p.x;
    pz = p.z;
    frame++;
    const reach = (size / 2 + 4) / BASE_SCALE;
    countMissing(0, reach);
    // ask for both levels around the player, then draw one
    for (let l = 1; l >= 0; l--) {
      const T = tileMetres(l);
      for (let ix = Math.floor((px - reach) / T); ix <= Math.floor((px + reach) / T); ix++) {
        for (let iz = Math.floor((pz - reach) / T); iz <= Math.floor((pz + reach) / T); iz++) tile(l, ix, iz);
      }
    }
    pump();
  }

  return { draw, drawMapOverlay, prefetch, resize, sprite, colorOf, get yaw() { return yaw; } };
}

// '#rrggbb' + alpha -> rgba(); other colour strings as they are
const alphaCache = new Map();
function withAlpha(color, a) {
  const key = `${color}|${a}`;
  let c = alphaCache.get(key);
  if (c) return c;
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const n = parseInt(color.slice(1), 16);
    c = `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  } else {
    c = color;
  }
  if (alphaCache.size > 512) alphaCache.clear();
  alphaCache.set(key, c);
  return c;
}

export { createRadar, GAME_PALETTE, KIND_COLOR, colorOf, sprite };
