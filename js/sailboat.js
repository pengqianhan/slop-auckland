import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ISLAND_BOUNDS, shoreDistance, isRegionLand, PIERS } from './city-config.js';

// Sailboats on the Waitematā — the City of Sails. A 9 m keelboat (a sloop: mainsail and jib on one mast), the model
// and how it sails, shared by the boat the player sails (controllers.js 'boat' mode, js/game/vehicles.js) and the
// boats out on the harbour (js/game/sailing.js).
//
// Sailing, simplified: the harbour has one wind (WIND, which js/game/sailing.js shifts slowly). How fast a boat goes
// depends on its heading to the wind (the polar below): fastest on a beam reach, slower running before it, and barely
// at all pointed into it (in irons: a little auxiliary outboard keeps it crawling). Forward trims the sails in (more
// power), back runs the outboard astern, left / right is the tiller. The boom swings out to leeward and the boat heels
// with the power in its sails. It keeps to the water: the coast of the detailed city (its 2 m distance field), the
// region's coastline beyond it (the North Shore, Devonport, the islands) and every wharf, pier, pontoon and breakwater.

const WATER_Y = ISLAND_BOUNDS.waterLevel;

// The boat (local frame: +z forward, +y up, the waterline at y = 0)
const HULL = { halfL: 4.6, halfW: 1.35, mastZ: 1.0, mastTop: 13.2, boomY: 2.05, boomLen: 3.9 };
const DECK_Y = (t) => 0.86 + 0.32 * t * t; // sheer: the deck edge from the transom (t 0) to the bow (t 1)

// The wind: from `dir` (a heading: the way it blows from, 0 = from the south... as the world's headings), strength
// 0.6..1.3 of the design wind. js/game/sailing.js shifts it; elsewhere it is the usual afternoon north-easterly.
const WIND = { dir: Math.PI * 0.8, strength: 1 };

// The boat's speed through the water as a share of its best, by the angle off the wind (degrees)
// (generous upwind, it's a game: the run to Devonport is close to the wind in the usual north-easterly)
const POLAR = [[0, 0.3], [30, 0.5], [40, 0.72], [50, 0.86], [70, 0.97], [100, 1.0], [130, 0.97], [155, 0.9], [180, 0.82]];
const SAIL = {
  topSpeed: 36, // m/s on a beam reach in the design wind, sails trimmed in (70 knots: faster than any real yacht, it's a game)
  idleTrim: 0.07, // the share of power with the sheets eased (no throttle: she ghosts along at a few knots)
  astern: 3, // m/s under the outboard, backwards
  motor: 6, // m/s the outboard alone gives her ahead (manoeuvring, getting out of irons)
  accel: 0.55, // 1/s towards the target speed gaining way (0.6 easing off, 1.4 braking astern)
  turn: 0.7, // rad/s of the tiller at speed
  minTurn: 0.4 // rad/s even when barely moving (the outboard)
};

const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function polar(offWind) {
  const deg = (Math.abs(offWind) * 180) / Math.PI;
  for (let i = 1; i < POLAR.length; i++) {
    const [d1, f1] = POLAR[i];
    if (deg <= d1) {
      const [d0, f0] = POLAR[i - 1];
      return f0 + ((f1 - f0) * (deg - d0)) / (d1 - d0);
    }
  }
  return POLAR[POLAR.length - 1][1];
}

// =====================================================================================================================
// WHERE A BOAT CAN SAIL
// =====================================================================================================================
const [RX0, RX1, RZ0, RZ1] = [ISLAND_BOUNDS.minX, ISLAND_BOUNDS.maxX, ISLAND_BOUNDS.minZ, ISLAND_BOUNDS.maxZ];
const SEA_LIMIT = 9000; // m from the Sky Tower: the edge of the world out in the gulf

// Every wharf, pier, pontoon and breakwater of the detailed city, in 64 m cells (boats only: people walk on them)
const PIER_CELL = 64;
const pierCells = new Map();
const pierKey = (i, j) => (i + 512) * 1024 + (j + 512);
for (const p of PIERS) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const q of p.ring) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z); }
  const box = { ring: p.ring, minX, maxX, minZ, maxZ };
  for (let i = Math.floor(minX / PIER_CELL); i <= Math.floor(maxX / PIER_CELL); i++) {
    for (let j = Math.floor(minZ / PIER_CELL); j <= Math.floor(maxZ / PIER_CELL); j++) {
      const k = pierKey(i, j);
      if (!pierCells.has(k)) pierCells.set(k, []);
      pierCells.get(k).push(box);
    }
  }
}
function onPier(x, z) {
  const list = pierCells.get(pierKey(Math.floor(x / PIER_CELL), Math.floor(z / PIER_CELL)));
  if (!list) return false;
  for (const b of list) {
    if (x < b.minX - 0.6 || x > b.maxX + 0.6 || z < b.minZ - 0.6 || z > b.maxZ + 0.6) continue;
    const r = b.ring;
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i].z > z) !== (r[j].z > z) && x < r[j].x + ((z - r[j].z) * (r[i].x - r[j].x)) / (r[i].z - r[j].z)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

const inDetail = (x, z) => x > RX0 + 1 && x < RX1 - 1 && z > RZ0 + 1 && z < RZ1 - 1;

/** Open water at (x, z), `margin` m off the shore (in the detailed city; the region's coast is coarser) */
function isNavigable(x, z, margin = 1) {
  if (Math.hypot(x, z) > SEA_LIMIT) return false;
  if (inDetail(x, z)) return shoreDistance(x, z) < -margin && !onPier(x, z);
  return !isRegionLand(x, z);
}

// The hull's outline at a pose: bow, stern quarters, beam
const HULL_POINTS = [[0, HULL.halfL], [0.75, 2.6], [-0.75, 2.6], [1.3, 0], [-1.3, 0], [1.05, -HULL.halfL + 0.2], [-1.05, -HULL.halfL + 0.2]];
function hullClear(x, z, heading) {
  const s = Math.sin(heading), c = Math.cos(heading);
  for (const [lx, lz] of HULL_POINTS) {
    if (!isNavigable(x + lx * c + lz * s, z - lx * s + lz * c, 0.5)) return false;
  }
  return true;
}

// =====================================================================================================================
// THE MODEL
// =====================================================================================================================
const COLORS = {
  antifoul: new THREE.Color(0x7c2b24),
  boot: new THREE.Color(0x1d2a3a),
  deck: new THREE.Color(0xb7966a),
  nonslip: new THREE.Color(0xe8e4da),
  cabin: new THREE.Color(0xf1efe8),
  window: new THREE.Color(0x1b2229),
  metal: new THREE.Color(0xb9bec3),
  keel: new THREE.Color(0x2a2d31)
};

// Colour every triangle of a non-indexed geometry by fn(centroid y, centroid x, centroid z) -> THREE.Color
function paintFaces(geo, fn) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const c = fn(cy, cx, cz);
    for (let k = 0; k < 3; k++) c.toArray(col, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('uv'); // (merged with parts that have none)
  return geo;
}
const solid = (geo, color) => paintFaces(geo.index ? geo.toNonIndexed() : geo, () => color);

// A rod from a to b (stays, the mast, the boom)
function rod(a, b, r, color, sides = 6) {
  const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b);
  const len = av.distanceTo(bv);
  const g = new THREE.CylinderGeometry(r, r, len, sides, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bv.clone().sub(av).normalize()));
  g.translate((av.x + bv.x) / 2, (av.y + bv.y) / 2, (av.z + bv.z) / 2);
  return solid(g, color);
}

function box(w, h, d, x, y, z, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return solid(g, color);
}

// The hull: lofted from stations stern to bow, sections down from the deck edge to the keel line; coloured in bands
// (topsides, the boot stripe, antifouling below the waterline), then the deck (teak, a non-slip foredeck), the
// transom, the cabin trunk, the keel and rudder
function hullGeometry(paint) {
  const N = 16; // stations
  const levels = (sheer, draft) => [sheer, sheer * 0.6, 0.24, 0.12, 0.02, -draft * 0.45, -draft * 0.85, -draft];
  const halfBeam = (t) => {
    if (t <= 0.45) return 1.02 + 0.33 * Math.sin((t / 0.45) * Math.PI * 0.5);
    const u = (t - 0.45) / 0.55;
    return 1.35 * Math.pow(Math.max(0, 1 - Math.pow(u, 1.9)), 0.75);
  };
  // the section's half width at a level (full beam above the turn of the bilge, round below)
  const widthAt = (w, y, draft) => {
    if (y >= 0.24) return w * (1 - 0.04 * (y - 0.24));
    const k = (0.24 - y) / (0.24 + draft);
    return w * Math.sqrt(Math.max(0, 1 - k * k));
  };
  const pos = [];
  const rows = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = -HULL.halfL + 0.25 + t * (2 * HULL.halfL - 0.25);
    const w = halfBeam(t);
    const draft = 0.16 + 0.42 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.1)), 0.7);
    const L = levels(DECK_Y(t), draft);
    const row = [];
    // starboard (+x) from the deck edge down to the keel, then up the port side
    for (let k = 0; k < L.length; k++) row.push([widthAt(w, L[k], draft), L[k], z]);
    for (let k = L.length - 2; k >= 0; k--) row.push([-widthAt(w, L[k], draft), L[k], z]);
    rows.push(row);
  }
  const cols = rows[0].length;
  for (const row of rows) for (const p of row) pos.push(...p);
  const idx = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shell.setIndex(idx);
  shell.computeVertexNormals();
  const hullPaint = new THREE.Color(paint.hull), boot = new THREE.Color(paint.boot ?? 0x1d2a3a);
  const hull = paintFaces(shell.toNonIndexed(), (y) => (y > 0.24 ? hullPaint : y > 0.12 ? boot : COLORS.antifoul));

  // the deck: strips between the deck edges, teak aft of the cabin, non-slip forward
  const deck = [];
  for (let i = 0; i < N; i++) {
    const a = rows[i][0], b = rows[i + 1][0];
    deck.push(a[0], a[1], a[2], -a[0], a[1], a[2], b[0], b[1], b[2]);
    deck.push(-a[0], a[1], a[2], -b[0], b[1], b[2], b[0], b[1], b[2]);
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3));
  deckGeo.computeVertexNormals();
  paintFaces(deckGeo, (y, x, z) => (z < -0.7 ? COLORS.deck : COLORS.nonslip));

  // the transom: the stern's section, closed
  const stern = rows[0];
  const tr = [];
  for (let j = 1; j < cols - 1; j++) tr.push(...stern[0], ...stern[j + 1], ...stern[j]);
  const transom = new THREE.BufferGeometry();
  transom.setAttribute('position', new THREE.Float32BufferAttribute(tr, 3));
  transom.computeVertexNormals();
  paintFaces(transom, (y) => (y > 0.24 ? hullPaint : y > 0.12 ? boot : COLORS.antifoul));

  const deckAt = DECK_Y(0.5);
  const parts = [
    hull, deckGeo, transom,
    // the cabin trunk, with its windows; the companionway hatch
    box(1.6, 0.46, 2.7, 0, deckAt + 0.2, 0.55, COLORS.cabin),
    box(1.62, 0.13, 1.9, 0, deckAt + 0.27, 0.55, COLORS.window),
    box(1.2, 0.08, 1.5, 0, deckAt + 0.46, 0.75, COLORS.nonslip),
    // cockpit coamings
    box(0.08, 0.28, 2.3, 0.82, DECK_Y(0.2) + 0.12, -2.6, COLORS.cabin),
    box(0.08, 0.28, 2.3, -0.82, DECK_Y(0.2) + 0.12, -2.6, COLORS.cabin),
    // the keel fin and its bulb, the rudder
    box(0.16, 1.5, 1.25, 0, -1.05, 0.35, COLORS.keel),
    box(0.42, 0.34, 1.9, 0, -1.85, 0.25, COLORS.keel),
    box(0.1, 1.2, 0.6, 0, -0.45, -3.9, COLORS.keel),
    // the pulpit at the bow, the pushpit at the stern
    rod([0.45, DECK_Y(0.92), 3.7], [0, DECK_Y(1) + 0.55, 4.45], 0.025, COLORS.metal),
    rod([-0.45, DECK_Y(0.92), 3.7], [0, DECK_Y(1) + 0.55, 4.45], 0.025, COLORS.metal),
    rod([0.95, DECK_Y(0) + 0.6, -4.25], [-0.95, DECK_Y(0) + 0.6, -4.25], 0.025, COLORS.metal),
    // the mast and the standing rigging
    rod([0, deckAt, HULL.mastZ], [0, HULL.mastTop, HULL.mastZ], 0.085, COLORS.metal, 8),
    rod([0, HULL.mastTop - 1.6, HULL.mastZ], [0, DECK_Y(1) + 0.05, HULL.halfL - 0.15], 0.014, COLORS.metal),
    rod([0, HULL.mastTop, HULL.mastZ], [0, DECK_Y(0) + 0.05, -HULL.halfL + 0.3], 0.014, COLORS.metal),
    rod([0, HULL.mastTop - 0.5, HULL.mastZ], [1.25, DECK_Y(0.6), HULL.mastZ - 0.4], 0.012, COLORS.metal),
    rod([0, HULL.mastTop - 0.5, HULL.mastZ], [-1.25, DECK_Y(0.6), HULL.mastZ - 0.4], 0.012, COLORS.metal)
  ];
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

// A sail: a triangle (luff from tack to head, the foot from tack to clew), cambered to leeward (-x), with a coloured
// band and a number patch
function sailGeometry(tack, head, clew, camber, cloth, band) {
  const R = 10, C = 6;
  const T = new THREE.Vector3(...tack), H = new THREE.Vector3(...head), K = new THREE.Vector3(...clew);
  const grid = [];
  for (let r = 0; r <= R; r++) {
    const v = r / R;
    const lead = T.clone().lerp(H, v), trail = K.clone().lerp(H, v);
    const chord = lead.distanceTo(trail);
    const row = [];
    for (let c = 0; c <= C; c++) {
      const u = c / C;
      const p = lead.clone().lerp(trail, u);
      p.x -= camber * chord * Math.sin(Math.PI * Math.pow(u, 0.8));
      row.push(p);
    }
    grid.push(row);
  }
  const pos = [];
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const a = grid[r][c], b = grid[r][c + 1], cc = grid[r + 1][c], d = grid[r + 1][c + 1];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, cc.x, cc.y, cc.z, b.x, b.y, b.z, d.x, d.y, d.z, cc.x, cc.y, cc.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const clothC = new THREE.Color(cloth), bandC = new THREE.Color(band);
  const y0 = Math.min(T.y, K.y), y1 = H.y;
  return paintFaces(g, (y) => {
    const v = (y - y0) / (y1 - y0);
    return v > 0.62 && v < 0.7 ? bandC : clothC;
  });
}

// Shared materials (vertex colours carry the paint)
let MATS = null;
function materials() {
  if (MATS) return MATS;
  MATS = {
    hull: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05, side: THREE.DoubleSide }),
    sail: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, side: THREE.DoubleSide })
  };
  return MATS;
}

// Paint schemes for the fleet (hull, boot stripe, sail cloth, sail band)
const PAINTS = [
  { hull: 0xf4f3ee, boot: 0x1d2a3a, cloth: 0xf3f0e6, band: 0x1f4e8c },
  { hull: 0x1f3554, boot: 0xf2efe6, cloth: 0xf1eee4, band: 0xc8372d },
  { hull: 0xf2f0ea, boot: 0xb22a2a, cloth: 0xe9e2cf, band: 0x2a2a2a },
  { hull: 0x8b1e24, boot: 0xf2efe6, cloth: 0xf4f1e8, band: 0x8b1e24 },
  { hull: 0xeae7dc, boot: 0x1f6a5a, cloth: 0x2c2f33, band: 0xd8b13a },
  { hull: 0x2d4f3f, boot: 0xe6dfc8, cloth: 0xf2ece0, band: 0x2d4f3f },
  { hull: 0xf5f5f2, boot: 0x0f7da5, cloth: 0xf5f3ec, band: 0xef7a1a },
  { hull: 0x3a3f46, boot: 0xd9d4c8, cloth: 0xdcd3bd, band: 0x3a6db5 }
];

// Geometry per paint scheme, shared by every boat painted alike
const GEOS = new Map();
function geometries(paintIndex) {
  const key = paintIndex % PAINTS.length;
  if (GEOS.has(key)) return GEOS.get(key);
  const p = PAINTS[key];
  // the mainsail in its pivot's frame (the pivot is on the mast at the boom: the boom swings about the mast)
  const mainH = HULL.mastTop - 0.3 - HULL.boomY;
  const main = sailGeometry([0, 0.06, -0.05], [0, mainH, -0.05], [0, 0.12, -HULL.boomLen + 0.1], 0.09, p.cloth, p.band);
  const boom = rod([0, 0, 0], [0, 0, -HULL.boomLen], 0.06, COLORS.metal);
  // the jib in its pivot's frame: luff up the forestay (+y), the clew aft and down
  const jibLen = forestay().length - 0.6;
  const jib = sailGeometry([0, 0.15, 0], [0, jibLen, 0], jibClew(), 0.1, p.cloth, p.cloth);
  const g = { hull: hullGeometry(p), main: mergeGeometries([main, boom]), jib };
  for (const k of Object.keys(g)) g[k].computeBoundingSphere();
  GEOS.set(key, g);
  return g;
}

// The forestay: tack at the bow to the hounds on the mast; the jib's pivot frame has +y along it
function forestay() {
  const tack = new THREE.Vector3(0, DECK_Y(1) + 0.05, HULL.halfL - 0.15);
  const top = new THREE.Vector3(0, HULL.mastTop - 1.6, HULL.mastZ);
  const dir = top.clone().sub(tack);
  const length = dir.length();
  dir.normalize();
  return { tack, dir, length, q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir) };
}
// The jib's clew (beside the mast, just above the deck) in the forestay frame
function jibClew() {
  const f = forestay();
  const clew = new THREE.Vector3(0, DECK_Y(0.6) + 0.45, HULL.mastZ - 0.6).sub(f.tack).applyQuaternion(f.q.clone().invert());
  return [clew.x, clew.y, clew.z];
}

/**
 * A sailboat entity: the fields the controllers & cameras read (position, heading, speed, chase camera), the model
 * (mesh: heading; heel: pitch & roll; main & jib: the sails, swung by trim) and its sailing state.
 */
function createSailboatEntity({ paint = 0, x = 0, z = 0, heading = 0, castShadow = true } = {}) {
  const g = geometries(paint);
  const m = materials();
  const mesh = new THREE.Group();
  mesh.name = 'Sailboat';
  const heel = new THREE.Group();
  mesh.add(heel);
  const hull = new THREE.Mesh(g.hull, m.hull);
  hull.castShadow = castShadow;
  hull.receiveShadow = true;
  heel.add(hull);
  const main = new THREE.Group();
  main.position.set(0, HULL.boomY, HULL.mastZ);
  const mainSail = new THREE.Mesh(g.main, m.sail);
  mainSail.castShadow = castShadow;
  main.add(mainSail);
  heel.add(main);
  const f = forestay();
  const stay = new THREE.Group();
  stay.position.copy(f.tack);
  stay.quaternion.copy(f.q);
  const jib = new THREE.Group();
  const jibSail = new THREE.Mesh(g.jib, m.sail);
  jibSail.castShadow = castShadow;
  jib.add(jibSail);
  stay.add(jib);
  heel.add(stay);
  const position = new THREE.Vector3(x, WATER_Y, z);
  mesh.position.copy(position);
  mesh.rotation.y = heading;
  // (furled until she's sailed: poseSailboat hoists them)
  mainSail.visible = jibSail.visible = false;
  mesh.updateMatrixWorld(true);
  return {
    type: 'boat', label: 'Sailboat', mesh, heel, main, jib, mainSail, jibSail,
    position, prevX: x, prevZ: z, heading, speed: 0, vx: 0, vz: 0, angularVel: 0, turnRate: 0,
    heelAngle: 0, boom: 0, jibAngle: 0, sailsUp: false, sailShow: 0, offWind: 0, power: 0, bump: 0,
    phase: Math.random() * 100,
    halfW: HULL.halfW, halfL: HULL.halfL, mass: 3200,
    cameraTargetOffset: new THREE.Vector3(0, 2.4, 0), chaseDistance: 15, chaseHeight: 5.2,
    engineOff: true
  };
}

/**
 * One step of sailing: throttle -1..1 (forward: trim in; back: the outboard astern), steer +1 left..-1 right.
 * Moves the boat, keeps it on the water (bump: the speed it hit something at, 0 if not) and poses the model.
 */
function stepSailboat(e, throttle, steer, dt, time, wind = WIND) {
  if (dt <= 0) return;
  e.prevX = e.position.x;
  e.prevZ = e.position.z;
  e.bump = 0;
  const offWind = wrap(e.heading - wind.dir); // 0: head to wind, +-PI: dead downwind
  e.offWind = offWind;
  const f = polar(offWind);
  const trim = throttle > 0 ? SAIL.idleTrim + (1 - SAIL.idleTrim) * throttle : throttle < 0 ? 0 : e.sailsUp ? SAIL.idleTrim : 0;
  let target = e.sailsUp ? SAIL.topSpeed * wind.strength * f * trim : 0;
  if (throttle > 0) target = Math.max(target, SAIL.motor * throttle);
  if (throttle < 0) target = -SAIL.astern * -throttle;
  // gaining way: the outboard pulls her up to a few knots briskly, the sails do the rest more slowly
  const gaining = Math.abs(target) > Math.abs(e.speed) && target * e.speed >= 0;
  const rate = !gaining ? (throttle < 0 ? 1.4 : 0.6) : Math.abs(e.speed) < SAIL.motor ? 1.1 : SAIL.accel;
  e.speed += (target - e.speed) * (1 - Math.exp(-dt * rate));
  e.power = e.sailsUp ? f * trim * wind.strength : 0;

  // the tiller: more bite with way on
  const way = Math.min(1, Math.abs(e.speed) / 4);
  const turnRate = steer * (SAIL.minTurn + (SAIL.turn - SAIL.minTurn) * way) * (e.speed < -0.2 ? -1 : 1);
  e.turnRate += (turnRate - e.turnRate) * (1 - Math.exp(-dt * 3));
  const heading = e.heading + e.turnRate * dt;
  const s = Math.sin(heading), c = Math.cos(heading);
  // leeway: a little sideways slip downwind, most when stopped
  const drift = (1 - way) * 0.35 * wind.strength;
  const dx = s * e.speed * dt - Math.sin(wind.dir) * drift * dt;
  const dz = c * e.speed * dt - Math.cos(wind.dir) * drift * dt;
  let x = e.position.x + dx, z = e.position.z + dz;
  // (fast, a frame's move can be longer than a pontoon is wide: check along it, and stop where it first hits)
  const len = Math.hypot(dx, dz);
  if (len > 0.8) {
    const n = Math.ceil(len / 0.8);
    for (let i = 1; i < n; i++) {
      const px = e.position.x + (dx * i) / n, pz = e.position.z + (dz * i) / n;
      if (!hullClear(px, pz, heading)) {
        x = px;
        z = pz;
        break;
      }
    }
  }
  if (hullClear(x, z, heading)) {
    e.position.x = x;
    e.position.z = z;
    e.heading = heading;
  } else if (hullClear(x, e.position.z, heading)) {
    e.position.x = x;
    e.heading = heading;
    e.bump = Math.abs(e.speed) * Math.abs(c);
    e.speed *= 0.85;
  } else if (hullClear(e.position.x, z, heading)) {
    e.position.z = z;
    e.heading = heading;
    e.bump = Math.abs(e.speed) * Math.abs(s);
    e.speed *= 0.85;
  } else {
    e.bump = Math.abs(e.speed);
    e.speed *= -0.25;
    e.turnRate = 0;
    if (hullClear(e.position.x, e.position.z, heading)) e.heading = heading;
  }
  e.vx = e.vz = 0;
  poseSailboat(e, dt, time, wind);
}

/** The model: bobbing on the swell, heeled by the power in the sails, the boom out to leeward */
function poseSailboat(e, dt, time, wind = WIND) {
  const k = 1 - Math.exp(-dt * 2.2);
  const offWind = wrap(e.heading - wind.dir);
  e.offWind = offWind;
  const a = Math.abs(offWind);
  // the wind's side: +1 when it comes over the boat's +x side (the sails go out to -x), -1 the other way
  const side = -Math.sign(Math.sin(offWind)) || 1;
  const luffing = a < 0.55;
  const boomTarget = e.sailsUp ? side * clamp(0.55 * (a - 0.28), 0.06, 1.35) : 0;
  const flap = luffing && e.sailsUp ? Math.sin(time * 11 + e.phase) * 0.06 : 0;
  e.boom += (boomTarget - e.boom) * k;
  e.jibAngle += (side * clamp(0.38 * (a - 0.3), 0.05, 0.9) - e.jibAngle) * k;
  e.main.rotation.y = e.boom + flap;
  e.jib.rotation.y = e.jibAngle + flap * 1.5;
  // (the sails' camber bulges to -x: mirror them when the wind is on the other side)
  e.mainSail.scale.x = side;
  e.jibSail.scale.x = side;
  e.sailShow += ((e.sailsUp ? 1 : 0) - e.sailShow) * (1 - Math.exp(-dt * 2.5));
  const shown = e.sailShow > 0.02;
  e.mainSail.visible = e.jibSail.visible = shown;
  e.mainSail.scale.y = e.jibSail.scale.y = Math.max(0.02, e.sailShow);
  // heel: to leeward with the side force (most on a reach), against the turn a little
  const heelTarget = side * (e.power || 0) * Math.sin(Math.min(a, Math.PI / 2)) * 0.32 - (e.turnRate || 0) * Math.abs(e.speed) * 0.012;
  e.heelAngle += (heelTarget - e.heelAngle) * (1 - Math.exp(-dt * 1.6));
  const bob = Math.sin(time * 1.25 + e.phase) * 0.07 + Math.sin(time * 0.71 + e.phase * 1.7) * 0.05;
  const pitch = Math.sin(time * 0.93 + e.phase * 0.6) * 0.022 - Math.min(0.05, Math.abs(e.speed) * 0.003);
  e.heel.rotation.set(pitch, 0, e.heelAngle + Math.sin(time * 1.1 + e.phase) * 0.018);
  e.position.y = WATER_Y + bob;
  e.mesh.position.copy(e.position);
  e.mesh.rotation.set(0, e.heading, 0);
  // (the scene doesn't update world matrices by itself: main.js refreshes only its dynamic roots)
  e.mesh.updateMatrixWorld(true);
}

export { WIND, HULL as SAILBOAT, PAINTS as SAILBOAT_PAINTS, createSailboatEntity, stepSailboat, poseSailboat, isNavigable, hullClear, polar as sailPolar };
