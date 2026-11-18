import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  uv,
  vec2,
  vec3,
  float,
  abs,
  cross,
  normalize,
  mix,
  pow,
  sin,
  clamp,
  length,
  smoothstep,
  texture,
  cameraPosition,
  time
} from 'three/tsl';
import { cityUniforms, getSmokeCloudTexture, transparentEffectMRT } from '../tsl-materials.js';
import { gameGrade } from '../post-processing.js';
import { terrainHeight, surfaceHeight } from '../terrain.js';
import { ISLAND_BOUNDS } from '../city-config.js';

// Pooled effects for everyone: sparks, smoke, fire, explosions, muzzle flashes, tracers, impact puffs, debris,
// decals (scorch marks, bullet holes, blood), mission beacons and a few flashing point lights. Every pool is a fixed
// struct of Float32Arrays with a free list, drawn as one instanced draw (soft alpha sprites, additive glow sprites,
// additive streaks, lit debris boxes, decals, beacon columns & rings): nothing is allocated per frame, a full pool
// steals its oldest slot, and an empty pool is hidden. The materials exist from start-up, so main.js compiles them
// behind the loading screen like the rest of the scene (one degenerate instance each for the first frames).
// Positions are world space; the group stays at the origin (scene.matrixWorldAutoUpdate is off: the lights update
// their own matrices).

const SOFT_CAP = 1400;
const GLOW_CAP = 1200;
const STREAK_CAP = 3200;
const DEBRIS_CAP = 256;
const DECAL_CAP = 160;
const BEACON_CAP = 24;
// (a 5-star chase lights sirens' glow, sparks and the helicopter's searchlight pool at once;
// parked lights are out of every cluster and cost nothing; 236 of ClusteredLighting's 256 with the city's own)
const LIGHT_CAP = 10;
const EMITTER_CAP = 48;
const GRAVITY = 18;
const WATER_Y = ISLAND_BOUNDS.waterLevel;

const rand = (a, b) => a + Math.random() * (b - a);

// A pool's particle arrays and free list
function createPool(cap, fields) {
  const pool = { cap, live: 0, free: new Int32Array(cap), freeTop: cap, alive: new Uint8Array(cap), born: new Float64Array(cap), steal: 0 };
  for (let i = 0; i < cap; i++) pool.free[i] = cap - 1 - i;
  for (const f of fields) pool[f] = new Float32Array(cap);
  return pool;
}

function take(pool) {
  let i;
  if (pool.freeTop > 0) {
    i = pool.free[--pool.freeTop];
  } else {
    // full: reuse the oldest (scanning a few from a rotating start keeps this cheap)
    let oldest = pool.steal, bestAge = -Infinity;
    for (let k = 0; k < 32; k++) {
      const j = (pool.steal + k) % pool.cap;
      const age = pool.age[j] / Math.max(pool.life[j], 1e-3);
      if (age > bestAge) {
        bestAge = age;
        oldest = j;
      }
    }
    pool.steal = (pool.steal + 32) % pool.cap;
    i = oldest;
    pool.alive[i] = 0;
    pool.live--;
  }
  pool.alive[i] = 1;
  pool.live++;
  return i;
}

function release(pool, i) {
  pool.alive[i] = 0;
  pool.live--;
  pool.free[pool.freeTop++] = i;
}

function flag(attr, count) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------------------------------
// Daylight on smoke: dim at dusk and night (cityUniforms.uInteriorGlow rises after sunset)
const dayShade = () => clamp(float(1.45).sub(cityUniforms.uInteriorGlow.mul(0.75)), 0.22, 1.0);

function createSoftMaterial() {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.mrtNode = transparentEffectMRT;
  const pos = attribute('sPos', 'vec4');
  const col = attribute('sCol', 'vec4');
  const misc = attribute('sMisc', 'vec4'); // rotation, -, -, -
  mat.positionNode = pos.xyz;
  mat.scaleNode = vec2(pos.w, pos.w);
  mat.rotationNode = misc.x;
  const tex = texture(getSmokeCloudTexture(), uv());
  mat.colorNode = Fn(() => col.rgb.mul(mix(0.62, 1.08, tex.g)).mul(dayShade()))();
  mat.opacityNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2.0);
    return clamp(tex.a.mul(smoothstep(1.0, 0.55, r)).mul(col.a).mul(1.6), 0.0, 1.0);
  })();
  return mat;
}

function createGlowMaterial() {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  mat.mrtNode = transparentEffectMRT;
  const pos = attribute('gPos', 'vec4');
  const col = attribute('gCol', 'vec4');
  const misc = attribute('gMisc', 'vec4'); // rotation, texture share (fire), -, -
  mat.positionNode = pos.xyz;
  mat.scaleNode = vec2(pos.w, pos.w);
  mat.rotationNode = misc.x;
  const tex = texture(getSmokeCloudTexture(), uv());
  mat.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2.0);
    const radial = pow(clamp(float(1.0).sub(r), 0.0, 1.0), 1.6);
    const core = smoothstep(0.45, 0.0, r);
    const billow = mix(float(1.0), tex.a.mul(1.7).mul(smoothstep(1.0, 0.3, r)), misc.y);
    return col.rgb.mul(radial.add(core.mul(0.8))).mul(billow);
  })();
  mat.opacityNode = float(1.0);
  return mat;
}

function createStreakMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  mat.mrtNode = transparentEffectMRT;
  const head = attribute('kA', 'vec4'); // head x, y, z, width
  const tail = attribute('kB', 'vec4'); // tail x, y, z, -
  const col = attribute('kC', 'vec4');
  mat.positionNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const along = head.xyz.sub(tail.xyz).add(vec3(0.0, 1e-4, 0.0));
    const mid = mix(tail.xyz, head.xyz, p.y.add(0.5));
    const side = normalize(cross(along, cameraPosition.sub(mid)));
    return mid.add(side.mul(head.w.mul(p.x)));
  })();
  mat.colorNode = Fn(() => {
    const across = abs(uv().x.sub(0.5)).mul(2.0);
    const w = float(1.0).sub(across.mul(across));
    return col.rgb.mul(w).mul(mix(0.12, 1.0, uv().y));
  })();
  return mat;
}

function createDecalMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.mrtNode = transparentEffectMRT;
  const col = attribute('dCol', 'vec4'); // rgb, alpha
  const misc = attribute('dMisc', 'vec4'); // kind (0 scorch, 1 bullet hole, 2 blood), seed
  const tex = texture(getSmokeCloudTexture(), uv());
  mat.colorNode = col.rgb;
  mat.opacityNode = Fn(() => {
    const d = uv().sub(0.5).mul(2.0);
    const r = length(d);
    const noise = tex.a;
    const scorch = smoothstep(1.0, 0.25, r.add(noise.mul(0.35)).sub(0.12)).mul(0.92);
    const hole = smoothstep(0.42, 0.3, r).add(smoothstep(0.9, 0.45, r).mul(0.35)).mul(0.95);
    const lobes = sin(d.x.mul(9.0).add(misc.y)).mul(sin(d.y.mul(7.0).sub(misc.y))).mul(0.18);
    const blood = smoothstep(0.85, 0.55, r.add(lobes).add(noise.mul(0.25)));
    const isHole = smoothstep(0.5, 0.6, misc.x).mul(smoothstep(1.5, 1.4, misc.x));
    const isBlood = smoothstep(1.5, 1.6, misc.x);
    const scorchW = float(1.0).sub(isHole).sub(isBlood);
    return clamp(scorch.mul(scorchW).add(hole.mul(isHole)).add(blood.mul(isBlood)), 0.0, 1.0).mul(col.a);
  })();
  return mat;
}

function createBeaconMaterial(ring) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  mat.mrtNode = transparentEffectMRT;
  const pos = attribute('bPos', 'vec4'); // x, y, z, radius
  const col = attribute('bCol', 'vec4'); // rgb, column height
  mat.positionNode = Fn(() => {
    const p = attribute('position', 'vec3');
    return ring
      ? vec3(p.x.mul(pos.w), p.y.add(0.06), p.z.mul(pos.w)).add(pos.xyz)
      : vec3(p.x.mul(pos.w), p.y.mul(col.w), p.z.mul(pos.w)).add(pos.xyz);
  })();
  mat.colorNode = Fn(() => {
    const pulse = sin(time.mul(3.2)).mul(0.25).add(0.75);
    if (ring) return col.rgb.mul(pulse).mul(0.9);
    const fade = pow(float(1.0).sub(uv().y), 2.2);
    return col.rgb.mul(fade).mul(pulse).mul(0.32);
  })();
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// The FX system
// ---------------------------------------------------------------------------------------------------------------------
function createFx(scene) {
  const group = new THREE.Group();
  group.name = 'GameFx';
  scene.add(group);

  const plane = new THREE.PlaneGeometry(1, 1);

  // Soft sprites (smoke, dust, steam, blood mist)
  const soft = createPool(SOFT_CAP, ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'r', 'g', 'b', 'a', 'drag', 'lift', 'rot', 'spin']);
  const softGeo = plane.clone();
  const sPos = new THREE.InstancedBufferAttribute(new Float32Array(SOFT_CAP * 4), 4);
  const sCol = new THREE.InstancedBufferAttribute(new Float32Array(SOFT_CAP * 4), 4);
  const sMisc = new THREE.InstancedBufferAttribute(new Float32Array(SOFT_CAP * 4), 4);
  for (const a of [sPos, sCol, sMisc]) a.setUsage(THREE.DynamicDrawUsage);
  softGeo.setAttribute('sPos', sPos);
  softGeo.setAttribute('sCol', sCol);
  softGeo.setAttribute('sMisc', sMisc);
  const softMesh = new THREE.Mesh(softGeo, createSoftMaterial());
  softMesh.name = 'FxSoft';
  softMesh.renderOrder = 3;

  // Additive glow sprites (fire, flashes, muzzle flashes, embers)
  const glow = createPool(GLOW_CAP, ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'r', 'g', 'b', 'r2', 'g2', 'b2', 'i', 'drag', 'lift', 'rot', 'spin', 'tex']);
  const glowGeo = plane.clone();
  const gPos = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAP * 4), 4);
  const gCol = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAP * 4), 4);
  const gMisc = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAP * 4), 4);
  for (const a of [gPos, gCol, gMisc]) a.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('gPos', gPos);
  glowGeo.setAttribute('gCol', gCol);
  glowGeo.setAttribute('gMisc', gMisc);
  const glowMesh = new THREE.Mesh(glowGeo, createGlowMaterial());
  glowMesh.name = 'FxGlow';
  glowMesh.renderOrder = 4;

  // Additive streaks (sparks, embers in flight, tracers)
  const streak = createPool(STREAK_CAP, ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'w', 'len', 'r', 'g', 'b', 'grav', 'floor', 'tx', 'ty', 'tz']);
  const streakGeo = plane.clone();
  const kA = new THREE.InstancedBufferAttribute(new Float32Array(STREAK_CAP * 4), 4);
  const kB = new THREE.InstancedBufferAttribute(new Float32Array(STREAK_CAP * 4), 4);
  const kC = new THREE.InstancedBufferAttribute(new Float32Array(STREAK_CAP * 4), 4);
  for (const a of [kA, kB, kC]) a.setUsage(THREE.DynamicDrawUsage);
  streakGeo.setAttribute('kA', kA);
  streakGeo.setAttribute('kB', kB);
  streakGeo.setAttribute('kC', kC);
  const streakMesh = new THREE.Mesh(streakGeo, createStreakMaterial());
  streakMesh.name = 'FxStreaks';
  streakMesh.renderOrder = 4;

  // Debris (lit, tumbling boxes)
  const debris = createPool(DEBRIS_CAP, ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'size', 'ax', 'ay', 'az', 'wx', 'wy', 'wz', 'floor', 'rest']);
  const debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.45, 0.7), new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.35 }), DEBRIS_CAP);
  debrisMesh.name = 'FxDebris';
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.setColorAt(0, new THREE.Color(0x222222));
  debrisMesh.castShadow = false;
  const debrisColors = new Float32Array(DEBRIS_CAP * 3);

  // Decals (a ring buffer of flat quads laid on surfaces)
  const decalGeo = plane.clone();
  decalGeo.rotateX(-Math.PI / 2);
  const dCol = new THREE.InstancedBufferAttribute(new Float32Array(DECAL_CAP * 4), 4);
  const dMisc = new THREE.InstancedBufferAttribute(new Float32Array(DECAL_CAP * 4), 4);
  decalGeo.setAttribute('dCol', dCol);
  decalGeo.setAttribute('dMisc', dMisc);
  const decalMesh = new THREE.InstancedMesh(decalGeo, createDecalMaterial(), DECAL_CAP);
  decalMesh.name = 'FxDecals';
  decalMesh.renderOrder = 2;
  const decalAge = new Float32Array(DECAL_CAP);
  const decalLife = new Float32Array(DECAL_CAP);
  const decalAlpha = new Float32Array(DECAL_CAP);
  let decalCursor = 0;
  let decalUsed = 0;

  // Beacons: a column of light and a ring on the ground
  const columnGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true).translate(0, 0.5, 0);
  const ringGeo = new THREE.RingGeometry(0.82, 1, 56).rotateX(-Math.PI / 2);
  const bPos = new THREE.InstancedBufferAttribute(new Float32Array(BEACON_CAP * 4), 4);
  const bCol = new THREE.InstancedBufferAttribute(new Float32Array(BEACON_CAP * 4), 4);
  columnGeo.setAttribute('bPos', bPos);
  columnGeo.setAttribute('bCol', bCol);
  ringGeo.setAttribute('bPos', bPos);
  ringGeo.setAttribute('bCol', bCol);
  const columnMesh = new THREE.Mesh(columnGeo, createBeaconMaterial(false));
  columnMesh.name = 'FxBeaconColumns';
  const ringMesh = new THREE.Mesh(ringGeo, createBeaconMaterial(true));
  ringMesh.name = 'FxBeaconRings';
  columnMesh.renderOrder = ringMesh.renderOrder = 4;

  const meshes = [softMesh, glowMesh, streakMesh, debrisMesh, decalMesh, columnMesh, ringMesh];
  for (const m of meshes) {
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.count = 1; // one degenerate instance until warm-up is over (see update)
    group.add(m);
  }
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  debrisMesh.setMatrixAt(0, zero);
  decalMesh.setMatrixAt(0, zero);

  // Point lights for flashes (muzzle, explosions, fires): the oldest is taken when all are lit
  const lights = [];
  for (let i = 0; i < LIGHT_CAP; i++) {
    const light = new THREE.PointLight(0xffa040, 0, 20, 1.6);
    light.position.set(0, -1000, 0);
    group.add(light);
    light.updateMatrixWorld();
    lights.push({ light, ttl: 0, life: 1, peak: 0, key: null, born: 0 });
  }

  let clock = 0;
  let updates = 0;
  // (the pools' attributes, for finish(): built once, not every frame)
  const softAttrs = [sPos, sCol, sMisc];
  const glowAttrs = [gPos, gCol, gMisc];
  const streakAttrs = [kA, kB, kC];

  // ===================================================================================================================
  // Spawning
  // ===================================================================================================================
  function softParticle(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 1.2, lift = 1.2) {
    const i = take(soft);
    soft.x[i] = x; soft.y[i] = y; soft.z[i] = z;
    soft.vx[i] = vx; soft.vy[i] = vy; soft.vz[i] = vz;
    soft.age[i] = 0; soft.life[i] = life;
    soft.s0[i] = s0; soft.s1[i] = s1;
    soft.r[i] = r; soft.g[i] = g; soft.b[i] = b; soft.a[i] = a;
    soft.drag[i] = drag; soft.lift[i] = lift;
    soft.rot[i] = Math.random() * Math.PI * 2;
    soft.spin[i] = (Math.random() - 0.5) * 1.2;
    return i;
  }

  function glowParticle(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, r2, g2, b2, intensity, drag = 1.5, lift = 0, tex = 0) {
    const i = take(glow);
    glow.x[i] = x; glow.y[i] = y; glow.z[i] = z;
    glow.vx[i] = vx; glow.vy[i] = vy; glow.vz[i] = vz;
    glow.age[i] = 0; glow.life[i] = life;
    glow.s0[i] = s0; glow.s1[i] = s1;
    glow.r[i] = r; glow.g[i] = g; glow.b[i] = b;
    glow.r2[i] = r2; glow.g2[i] = g2; glow.b2[i] = b2;
    glow.i[i] = intensity;
    glow.drag[i] = drag; glow.lift[i] = lift;
    glow.rot[i] = Math.random() * Math.PI * 2;
    glow.spin[i] = (Math.random() - 0.5) * 2;
    glow.tex[i] = tex;
    return i;
  }

  function streakParticle(x, y, z, vx, vy, vz, life, width, len, r, g, b, grav, floor) {
    const i = take(streak);
    streak.x[i] = x; streak.y[i] = y; streak.z[i] = z;
    streak.vx[i] = vx; streak.vy[i] = vy; streak.vz[i] = vz;
    streak.age[i] = 0; streak.life[i] = life;
    streak.w[i] = width; streak.len[i] = len;
    streak.r[i] = r; streak.g[i] = g; streak.b[i] = b;
    streak.grav[i] = grav; streak.floor[i] = floor;
    streak.tx[i] = NaN;
    return i;
  }

  // a random direction in the hemisphere around (nx, ny, nz), into out
  const _d = { x: 0, y: 0, z: 0 };
  function hemi(nx, ny, nz, spread) {
    let x = nx + (Math.random() - 0.5) * 2 * spread;
    let y = ny + (Math.random() - 0.5) * 2 * spread;
    let z = nz + (Math.random() - 0.5) * 2 * spread;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    _d.x = x; _d.y = y; _d.z = z;
    return _d;
  }

  /** Bright sparks bursting from (x, y, z) around normal n, bouncing on the ground */
  function sparks(x, y, z, nx = 0, ny = 1, nz = 0, count = 12, speed = 8, hot = 1) {
    const floor = surfaceHeight(x, z, y + 0.5) + 0.02;
    for (let k = 0; k < count; k++) {
      const d = hemi(nx, ny + 0.35, nz, 0.75);
      const s = speed * rand(0.35, 1.1);
      streakParticle(x, y, z, d.x * s, d.y * s, d.z * s, rand(0.18, 0.5), rand(0.018, 0.035), 0.035,
        3.2 * hot, 1.9 * hot, 0.55 * hot, GRAVITY, floor);
    }
  }

  /** A puff (or a column) of smoke. opts: count, size, life, color (hex), alpha, rise, spread, grow */
  const _c = new THREE.Color();
  function smoke(x, y, z, opts = null) {
    const count = opts?.count ?? 6;
    const size = opts?.size ?? 1.2;
    const life = opts?.life ?? 2.5;
    const spread = opts?.spread ?? 0.4;
    const rise = opts?.rise ?? 1.4;
    const alpha = opts?.alpha ?? 0.55;
    _c.setHex(opts?.color ?? 0x6a6a6a);
    for (let k = 0; k < count; k++) {
      softParticle(x + rand(-spread, spread), y + rand(0, spread), z + rand(-spread, spread),
        rand(-0.6, 0.6), rise * rand(0.5, 1.2), rand(-0.6, 0.6), life * rand(0.7, 1.25),
        size * rand(0.6, 1), size * (opts?.grow ?? 2.6) * rand(0.8, 1.2), _c.r, _c.g, _c.b, alpha, 0.9, 0.6);
    }
  }

  /** Flames licking up from (x, y, z). opts: count, size, life */
  function fire(x, y, z, opts = null) {
    const count = opts?.count ?? 5;
    const size = opts?.size ?? 1.1;
    const life = opts?.life ?? 0.65;
    for (let k = 0; k < count; k++) {
      glowParticle(x + rand(-0.4, 0.4) * size, y + rand(0, 0.3), z + rand(-0.4, 0.4) * size,
        rand(-0.4, 0.4), rand(1.5, 3.2), rand(-0.4, 0.4), life * rand(0.7, 1.3), size * rand(0.7, 1.1), size * rand(0.25, 0.5),
        3.4, 2.1, 0.7, 2.2, 0.38, 0.06, 1.0, 0.6, 1.2, 0.85);
    }
  }

  /** A gunshot's flash: a hot star at the muzzle, along (dx, dy, dz), and a brief light */
  function muzzleFlash(x, y, z, dx = 0, dy = 0, dz = 1, scale = 1) {
    glowParticle(x, y, z, 0, 0, 0, 0.05, 0.55 * scale, 0.35 * scale, 4, 3.2, 1.6, 2.5, 1.2, 0.3, 1.3, 0, 0, 0);
    glowParticle(x + dx * 0.18 * scale, y + dy * 0.18 * scale, z + dz * 0.18 * scale, dx * 6, dy * 6, dz * 6, 0.05,
      0.35 * scale, 0.2 * scale, 4, 2.8, 1.2, 2, 0.8, 0.2, 1, 0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const d = hemi(dx, dy, dz, 0.25);
      streakParticle(x, y, z, d.x * 30, d.y * 30, d.z * 30, 0.035, 0.03 * scale, 0.012, 3.5, 2.4, 0.9, 0, -1e9);
    }
    softParticle(x + dx * 0.3, y + dy * 0.3, z + dz * 0.3, dx * 1.2, dy * 1.2 + 0.4, dz * 1.2, 0.6, 0.25 * scale, 0.9 * scale, 0.75, 0.75, 0.72, 0.18, 2, 0.4);
    light(x + dx * 0.3, y + dy * 0.3, z + dz * 0.3, 0xffb050, 60 * scale, 9, 0.06);
  }

  /** A tracer from a to b at `speed` m/s (opts: speed, color hex, width, length) */
  function tracer(ax, ay, az, bx, by, bz, opts = null) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return;
    const speed = opts?.speed ?? 420;
    const len = Math.min(opts?.length ?? 9, dist);
    _c.setHex(opts?.color ?? 0xffd890);
    const i = streakParticle(ax, ay, az, (dx / dist) * speed, (dy / dist) * speed, (dz / dist) * speed, dist / speed + 0.02,
      opts?.width ?? 0.035, len / speed, _c.r * 3, _c.g * 3, _c.b * 3, 0, -1e9);
    // remember where it ends, so it stops there
    streak.tx[i] = bx; streak.ty[i] = by; streak.tz[i] = bz;
  }

  /** Bits flying (and bouncing): count, speed, color (hex) */
  function debrisBurst(x, y, z, count = 8, speed = 9, colorHex = 0x2a2724, size = 0.35) {
    const floor = surfaceHeight(x, z, y + 1) + 0.03;
    _c.setHex(colorHex);
    for (let k = 0; k < count; k++) {
      const i = take(debris);
      const d = hemi(0, 1, 0, 0.9);
      const s = speed * rand(0.4, 1.1);
      debris.x[i] = x + rand(-0.4, 0.4); debris.y[i] = y + rand(0, 0.4); debris.z[i] = z + rand(-0.4, 0.4);
      debris.vx[i] = d.x * s; debris.vy[i] = Math.abs(d.y) * s + 3; debris.vz[i] = d.z * s;
      debris.age[i] = 0; debris.life[i] = rand(4, 7);
      debris.size[i] = size * rand(0.4, 1.3);
      debris.ax[i] = Math.random() * 6; debris.ay[i] = Math.random() * 6; debris.az[i] = Math.random() * 6;
      debris.wx[i] = rand(-12, 12); debris.wy[i] = rand(-12, 12); debris.wz[i] = rand(-12, 12);
      debris.floor[i] = floor;
      debris.rest[i] = 0;
      const shade = rand(0.6, 1.2);
      debrisColors[i * 3] = _c.r * shade; debrisColors[i * 3 + 1] = _c.g * shade; debrisColors[i * 3 + 2] = _c.b * shade;
    }
  }

  // ---- decals ----
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const DECAL_KIND = { scorch: 0, hole: 1, blood: 2 };
  /** A mark laid on a surface: kind 'scorch' | 'hole' | 'blood', normal n, size (m), life (s) */
  function decal(kind, x, y, z, nx = 0, ny = 1, nz = 0, size = 1, life = 40, colorHex = null) {
    const i = decalCursor;
    decalCursor = (decalCursor + 1) % DECAL_CAP;
    decalUsed = Math.max(decalUsed, decalCursor === 0 ? DECAL_CAP : decalCursor);
    _n.set(nx, ny, nz).normalize();
    _q.setFromUnitVectors(UP, _n);
    _q2.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
    _q.multiply(_q2);
    _p.set(x + _n.x * 0.025, y + _n.y * 0.025, z + _n.z * 0.025);
    _s.set(size, 1, size);
    _m.compose(_p, _q, _s);
    decalMesh.setMatrixAt(i, _m);
    const k = DECAL_KIND[kind] ?? 0;
    _c.setHex(colorHex ?? (k === 2 ? 0x3a0606 : k === 1 ? 0x0c0b0a : 0x0a0908));
    dCol.array[i * 4] = _c.r; dCol.array[i * 4 + 1] = _c.g; dCol.array[i * 4 + 2] = _c.b;
    dCol.array[i * 4 + 3] = decalAlpha[i] = k === 0 ? 0.85 : 0.9;
    dMisc.array[i * 4] = k;
    dMisc.array[i * 4 + 1] = Math.random() * 10;
    decalAge[i] = 0;
    decalLife[i] = life;
    decalMesh.instanceMatrix.needsUpdate = true;
    dCol.needsUpdate = true;
    dMisc.needsUpdate = true;
  }

  // ---- lights ----
  /** A light flashing at (x, y, z) for ttl s (fading); key keeps re-using one light (a fire flickering) */
  function light(x, y, z, colorHex = 0xffa040, intensity = 100, distance = 18, ttl = 0.15, key = null) {
    let slot = null;
    if (key) {
      for (let k = 0; k < LIGHT_CAP; k++) if (lights[k].key === key && lights[k].ttl > 0) slot = lights[k];
    }
    if (!slot) {
      slot = lights[0];
      for (let k = 0; k < LIGHT_CAP; k++) {
        const l = lights[k];
        if (l.ttl <= 0) {
          slot = l;
          break;
        }
        if (l.born < slot.born) slot = l;
      }
      slot.born = clock;
    }
    slot.key = key;
    slot.ttl = ttl;
    slot.life = ttl;
    slot.peak = intensity;
    slot.light.color.setHex(colorHex);
    slot.light.distance = distance;
    slot.light.position.set(x, y, z);
    slot.light.intensity = intensity;
    slot.light.updateMatrixWorld();
    return slot;
  }

  /** The big one: flash, fireball, smoke, sparks, debris, a scorch mark and a light (scale 1 ~ a car) */
  function explosion(x, y, z, scale = 1) {
    const s = Math.max(0.3, scale);
    glowParticle(x, y + 0.8 * s, z, 0, 0, 0, 0.16, 9 * s, 13 * s, 5, 4.4, 3, 3, 1.4, 0.4, 1.6, 0, 0, 0);
    for (let k = 0; k < 16; k++) {
      const d = hemi(0, 0.7, 0, 0.8);
      const sp = rand(2.5, 9) * s;
      glowParticle(x + d.x * 0.6 * s, y + 0.5 * s + d.y * 0.4 * s, z + d.z * 0.6 * s, d.x * sp, d.y * sp + 2, d.z * sp,
        rand(0.55, 1.05), rand(1.8, 3) * s, rand(3.5, 5.5) * s, 3.6, 2.4, 0.9, 1.6, 0.25, 0.04, 1.25, 2.4, 2.5, 0.9);
    }
    for (let k = 0; k < 22; k++) {
      const d = hemi(0, 1, 0, 0.7);
      const sp = rand(1, 4.5) * s;
      const shade = rand(0.06, 0.16);
      softParticle(x + d.x * s, y + 0.6 * s + Math.random() * s, z + d.z * s, d.x * sp, d.y * sp + 1.5, d.z * sp,
        rand(3, 6), rand(1.6, 2.6) * s, rand(5, 8.5) * s, shade, shade * 0.95, shade * 0.9, 0.85, 1.1, 1.6);
    }
    const floor = surfaceHeight(x, z, y + 1) + 0.02;
    for (let k = 0; k < 70; k++) {
      const d = hemi(0, 0.8, 0, 1);
      const sp = rand(6, 22) * s;
      streakParticle(x, y + 0.6 * s, z, d.x * sp, d.y * sp + 2, d.z * sp, rand(0.4, 1.3), rand(0.03, 0.06), 0.04, 3.4, 1.8, 0.5, GRAVITY, floor);
    }
    debrisBurst(x, y + 0.5 * s, z, Math.round(12 * s), 11 * s, 0x1e1c1a, 0.42 * Math.min(1.4, s));
    if (y - floor < 2.5) decal('scorch', x, floor, z, 0, 1, 0, 6.5 * s, 60);
    // (as bright as it must be to show in daylight; after dark that whites out every wall around it for half a
    // second, so it is turned down as the night comes on)
    const night = Math.min(1, Math.max(0, (cityUniforms.uInteriorGlow.value - 0.5) / 1.05));
    light(x, y + 1.5 * s, z, 0xff8a30, 1100 * s * (1 - 0.6 * night), 30 * s, 0.8);
  }

  /** A bullet's (or anything's) hit on a surface material, along normal n */
  function impact(kind, x, y, z, nx = 0, ny = 1, nz = 0) {
    switch (kind) {
      case 'metal':
        sparks(x, y, z, nx, ny, nz, 10, 9, 1);
        decal('hole', x, y, z, nx, ny, nz, 0.12, 30);
        break;
      case 'glass':
        sparks(x, y, z, nx, ny, nz, 6, 5, 0.6);
        for (let k = 0; k < 6; k++) {
          const d = hemi(nx, ny, nz, 0.8);
          streakParticle(x, y, z, d.x * 4, d.y * 4, d.z * 4, rand(0.3, 0.7), 0.02, 0.02, 1.2, 1.4, 1.6, GRAVITY, terrainHeight(x, z));
        }
        break;
      case 'flesh':
        for (let k = 0; k < 5; k++) {
          const d = hemi(nx, ny, nz, 0.6);
          softParticle(x, y, z, d.x * 2.2, d.y * 2.2, d.z * 2.2, rand(0.35, 0.6), 0.18, 0.55, 0.45, 0.02, 0.02, 0.8, 3, -1.5);
        }
        decal('blood', x, surfaceHeight(x, z, y) + 0.01, z, 0, 1, 0, rand(0.5, 0.9), 45);
        break;
      case 'water':
        for (let k = 0; k < 8; k++) {
          const d = hemi(0, 1, 0, 0.35);
          streakParticle(x, y, z, d.x * 3, d.y * rand(4, 7), d.z * 3, rand(0.4, 0.7), 0.05, 0.05, 1.1, 1.2, 1.3, GRAVITY, WATER_Y);
        }
        smoke(x, y, z, { count: 3, size: 0.4, life: 0.8, color: 0xe8eef2, alpha: 0.5, rise: 1.2, grow: 2 });
        break;
      case 'dirt':
        smoke(x, y, z, { count: 4, size: 0.35, life: 1.1, color: 0x6b5a44, alpha: 0.6, rise: 0.8, spread: 0.1, grow: 2.4 });
        for (let k = 0; k < 5; k++) {
          const d = hemi(nx, ny, nz, 0.5);
          streakParticle(x, y, z, d.x * 5, d.y * 5, d.z * 5, rand(0.25, 0.5), 0.03, 0.02, 0.45, 0.35, 0.25, GRAVITY, terrainHeight(x, z));
        }
        break;
      default: // concrete, brick, wood
        smoke(x, y, z, { count: 4, size: 0.3, life: 1.0, color: 0xa39d92, alpha: 0.55, rise: 0.7, spread: 0.08, grow: 2.6 });
        sparks(x, y, z, nx, ny, nz, 4, 6, 0.8);
        decal('hole', x, y, z, nx, ny, nz, 0.14, 30);
    }
  }

  // ---- emitters ----
  class Emitter {
    constructor() {
      this.active = false;
      this.kind = 'smoke';
      this.x = this.y = this.z = 0;
      this.rate = 6;
      this.acc = 0;
      this.size = 1;
      this.life = 2.5;
      this.color = 0x555555;
      this.alpha = 0.5;
      this.rise = 1.5;
      this.light = false;
      this.lightKey = this;
    }
    /** Move it (call every frame for a moving source) */
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    /** Stop emitting (what it already emitted lives out its life) */
    stop() {
      this.active = false;
    }
  }
  const emitters = Array.from({ length: EMITTER_CAP }, () => new Emitter());
  function emitter(kind, x, y, z, opts) {
    let e = emitters.find((m) => !m.active);
    if (!e) e = emitters[0];
    e.active = true;
    e.kind = kind;
    e.set(x, y, z);
    e.acc = 0;
    e.rate = opts?.rate ?? (kind === 'fire' ? 22 : 7);
    e.size = opts?.size ?? 1;
    e.life = opts?.life ?? (kind === 'fire' ? 0.6 : 2.6);
    e.color = opts?.color ?? 0x4a4a4a;
    e.alpha = opts?.alpha ?? 0.5;
    e.rise = opts?.rise ?? 1.6;
    e.light = opts?.light ?? kind === 'fire';
    return e;
  }

  // ===================================================================================================================
  // Beacons
  // ===================================================================================================================
  class Beacon {
    constructor() {
      this.active = false;
      this.x = this.y = this.z = 0;
      this.radius = 1.6;
      this.height = 40;
      this.r = 1;
      this.g = 0.8;
      this.b = 0.2;
      this.visible = true;
    }
    /** Move it; y defaults to the ground there */
    set(x, z, y = null) {
      this.x = x;
      this.z = z;
      this.y = y ?? surfaceHeight(x, z, Infinity);
      return this;
    }
    setColor(hex) {
      _c.setHex(hex);
      this.r = _c.r * 1.6;
      this.g = _c.g * 1.6;
      this.b = _c.b * 1.6;
      return this;
    }
    remove() {
      this.active = false;
    }
  }
  const beacons = Array.from({ length: BEACON_CAP }, () => new Beacon());
  /** A mission marker: a light column and a ring on the ground at (x, z). opts: y, radius, height, visible */
  function beacon(x, z, colorHex = 0xffc02a, opts = null) {
    const b = beacons.find((m) => !m.active) || beacons[0];
    b.active = true;
    b.radius = opts?.radius ?? 1.6;
    b.height = opts?.height ?? 40;
    b.visible = opts?.visible ?? true;
    b.set(x, z, opts?.y ?? null);
    b.setColor(colorHex);
    return b;
  }

  // ===================================================================================================================
  // Update: simulate & write the live particles of each pool compactly
  // ===================================================================================================================
  const _e = new THREE.Euler();
  function update(dt, camera) {
    clock += dt;
    updates++;
    const warm = updates <= 3;

    // emitters
    for (let k = 0; k < EMITTER_CAP; k++) {
      const e = emitters[k];
      if (!e.active || dt <= 0) continue;
      e.acc += e.rate * dt;
      while (e.acc >= 1) {
        e.acc -= 1;
        if (e.kind === 'fire') {
          fire(e.x, e.y, e.z, { count: 1, size: e.size, life: e.life });
          if (Math.random() < 0.35) {
            const shade = rand(0.05, 0.12);
            softParticle(e.x + rand(-0.3, 0.3), e.y + 0.8 * e.size, e.z + rand(-0.3, 0.3), rand(-0.3, 0.3), e.rise * rand(1, 1.6), rand(-0.3, 0.3),
              rand(2.5, 4), e.size * 0.9, e.size * 4, shade, shade, shade, 0.7, 0.8, 1.2);
          }
        } else if (e.kind === 'sparks') {
          sparks(e.x, e.y, e.z, 0, 1, 0, 2, 5, 1);
        } else {
          _c.setHex(e.color);
          softParticle(e.x + rand(-0.15, 0.15), e.y, e.z + rand(-0.15, 0.15), rand(-0.3, 0.3), e.rise * rand(0.7, 1.2), rand(-0.3, 0.3),
            e.life * rand(0.8, 1.2), e.size * rand(0.4, 0.7), e.size * rand(2.2, 3.2), _c.r, _c.g, _c.b, e.alpha, 0.8, 0.9);
        }
      }
      if (e.light && e.kind === 'fire') light(e.x, e.y + 1, e.z, 0xff7a28, (180 + Math.random() * 90) * e.size, 14 * e.size, 0.12, e.lightKey);
    }

    // soft sprites
    let n = 0;
    {
      const P = soft, pos = sPos.array, col = sCol.array, misc = sMisc.array;
      for (let i = 0; i < SOFT_CAP && (n < P.live || warm); i++) {
        if (!P.alive[i]) continue;
        P.age[i] += dt;
        const t = P.age[i] / P.life[i];
        if (t >= 1) {
          release(P, i);
          continue;
        }
        const damp = Math.exp(-P.drag[i] * dt);
        P.vx[i] *= damp;
        P.vz[i] *= damp;
        P.vy[i] = P.vy[i] * damp + P.lift[i] * dt;
        P.x[i] += P.vx[i] * dt;
        P.y[i] += P.vy[i] * dt;
        P.z[i] += P.vz[i] * dt;
        P.rot[i] += P.spin[i] * dt;
        const grow = 1 - (1 - t) * (1 - t);
        const o = n * 4;
        pos[o] = P.x[i]; pos[o + 1] = P.y[i]; pos[o + 2] = P.z[i];
        pos[o + 3] = P.s0[i] + (P.s1[i] - P.s0[i]) * grow;
        col[o] = P.r[i]; col[o + 1] = P.g[i]; col[o + 2] = P.b[i];
        col[o + 3] = P.a[i] * Math.min(1, t * 10) * (1 - t) ** 1.2;
        misc[o] = P.rot[i];
        n++;
      }
      finish(softMesh, n, warm, softAttrs);
    }

    // glow sprites
    n = 0;
    {
      const P = glow, pos = gPos.array, col = gCol.array, misc = gMisc.array;
      for (let i = 0; i < GLOW_CAP; i++) {
        if (!P.alive[i]) continue;
        P.age[i] += dt;
        const t = P.age[i] / P.life[i];
        if (t >= 1) {
          release(P, i);
          continue;
        }
        const damp = Math.exp(-P.drag[i] * dt);
        P.vx[i] *= damp;
        P.vz[i] *= damp;
        P.vy[i] = P.vy[i] * damp + P.lift[i] * dt;
        P.x[i] += P.vx[i] * dt;
        P.y[i] += P.vy[i] * dt;
        P.z[i] += P.vz[i] * dt;
        P.rot[i] += P.spin[i] * dt;
        const o = n * 4;
        const fade = P.i[i] * (1 - t) ** 1.4;
        pos[o] = P.x[i]; pos[o + 1] = P.y[i]; pos[o + 2] = P.z[i];
        pos[o + 3] = P.s0[i] + (P.s1[i] - P.s0[i]) * Math.sqrt(t);
        col[o] = (P.r[i] + (P.r2[i] - P.r[i]) * t) * fade;
        col[o + 1] = (P.g[i] + (P.g2[i] - P.g[i]) * t) * fade;
        col[o + 2] = (P.b[i] + (P.b2[i] - P.b[i]) * t) * fade;
        misc[o] = P.rot[i];
        misc[o + 1] = P.tex[i];
        n++;
      }
      finish(glowMesh, n, warm, glowAttrs);
    }

    // streaks
    n = 0;
    {
      const P = streak, A = kA.array, B = kB.array, C = kC.array;
      for (let i = 0; i < STREAK_CAP; i++) {
        if (!P.alive[i]) continue;
        P.age[i] += dt;
        const t = P.age[i] / P.life[i];
        if (t >= 1) {
          release(P, i);
          continue;
        }
        P.vy[i] -= P.grav[i] * dt;
        P.x[i] += P.vx[i] * dt;
        P.y[i] += P.vy[i] * dt;
        P.z[i] += P.vz[i] * dt;
        if (P.y[i] < P.floor[i]) {
          P.y[i] = P.floor[i];
          P.vy[i] = Math.abs(P.vy[i]) * 0.4;
          P.vx[i] *= 0.7;
          P.vz[i] *= 0.7;
        }
        let hx = P.x[i], hy = P.y[i], hz = P.z[i];
        // the tail trails by `len` seconds of travel, never back past where it started
        const tl = Math.min(P.len[i], P.age[i]);
        let tx = hx - P.vx[i] * tl, ty = hy - P.vy[i] * tl, tz = hz - P.vz[i] * tl;
        if (!Number.isNaN(P.tx[i])) {
          // a tracer: clamp its head at the end point
          const ex = P.tx[i] - tx, ey = P.ty[i] - ty, ez = P.tz[i] - tz;
          const ax = hx - tx, ay = hy - ty, az = hz - tz;
          if (ex * ax + ey * ay + ez * az > ax * ax + ay * ay + az * az) { /* not there yet */ } else {
            hx = P.tx[i]; hy = P.ty[i]; hz = P.tz[i];
          }
        }
        const fade = (1 - t) ** 0.7;
        const o = n * 4;
        A[o] = hx; A[o + 1] = hy; A[o + 2] = hz; A[o + 3] = P.w[i];
        B[o] = tx; B[o + 1] = ty; B[o + 2] = tz;
        C[o] = P.r[i] * fade; C[o + 1] = P.g[i] * fade; C[o + 2] = P.b[i] * fade;
        n++;
      }
      finish(streakMesh, n, warm, streakAttrs);
    }

    // debris
    n = 0;
    {
      const P = debris;
      for (let i = 0; i < DEBRIS_CAP; i++) {
        if (!P.alive[i]) continue;
        P.age[i] += dt;
        const t = P.age[i] / P.life[i];
        if (t >= 1) {
          release(P, i);
          continue;
        }
        if (!P.rest[i]) {
          P.vy[i] -= GRAVITY * dt;
          P.x[i] += P.vx[i] * dt;
          P.y[i] += P.vy[i] * dt;
          P.z[i] += P.vz[i] * dt;
          P.ax[i] += P.wx[i] * dt;
          P.ay[i] += P.wy[i] * dt;
          P.az[i] += P.wz[i] * dt;
          if (P.y[i] < P.floor[i] + P.size[i] * 0.2) {
            P.y[i] = P.floor[i] + P.size[i] * 0.2;
            P.vy[i] = Math.abs(P.vy[i]) * 0.3;
            P.vx[i] *= 0.55;
            P.vz[i] *= 0.55;
            P.wx[i] *= 0.5; P.wy[i] *= 0.5; P.wz[i] *= 0.5;
            if (Math.abs(P.vy[i]) < 1) P.rest[i] = 1;
          }
        }
        const shrink = t > 0.8 ? (1 - t) / 0.2 : 1;
        _e.set(P.ax[i], P.ay[i], P.az[i]);
        _q.setFromEuler(_e);
        _p.set(P.x[i], P.y[i], P.z[i]);
        _s.setScalar(P.size[i] * shrink);
        _m.compose(_p, _q, _s);
        debrisMesh.setMatrixAt(n, _m);
        _c.setRGB(debrisColors[i * 3], debrisColors[i * 3 + 1], debrisColors[i * 3 + 2]);
        debrisMesh.setColorAt(n, _c);
        n++;
      }
      if (warm && n === 0) {
        debrisMesh.setMatrixAt(0, zero);
        n = 1;
      }
      debrisMesh.count = n;
      debrisMesh.visible = n > 0 && (warm || debris.live > 0);
      if (n > 0) {
        flag(debrisMesh.instanceMatrix, n);
        if (debrisMesh.instanceColor) flag(debrisMesh.instanceColor, n);
      }
    }

    // decals fade at the end of their life
    let decalDirty = false;
    let decalsLive = 0;
    for (let i = 0; i < decalUsed; i++) {
      if (decalAlpha[i] <= 0) continue;
      decalsLive++;
      decalAge[i] += dt;
      const left = decalLife[i] - decalAge[i];
      if (left < 4) {
        const a = Math.max(0, decalAlpha[i] * (left / 4));
        dCol.array[i * 4 + 3] = a;
        if (left <= 0) decalAlpha[i] = 0;
        decalDirty = true;
      }
    }
    if (decalDirty) dCol.needsUpdate = true;
    decalMesh.count = Math.max(1, decalUsed);
    decalMesh.visible = decalsLive > 0 || warm;

    // beacons
    n = 0;
    {
      const P = bPos.array, C = bCol.array;
      for (let k = 0; k < BEACON_CAP; k++) {
        const b = beacons[k];
        if (!b.active || !b.visible) continue;
        const o = n * 4;
        P[o] = b.x; P[o + 1] = b.y; P[o + 2] = b.z; P[o + 3] = b.radius;
        C[o] = b.r; C[o + 1] = b.g; C[o + 2] = b.b; C[o + 3] = b.height;
        n++;
      }
      const shown = n > 0;
      if (warm && n === 0) {
        P.fill(0, 0, 4);
        n = 1;
      }
      columnMesh.count = ringMesh.count = n;
      columnMesh.visible = ringMesh.visible = shown || warm;
      if (n > 0) {
        flag(bPos, n);
        flag(bCol, n);
      }
    }

    // lights fade
    for (let k = 0; k < LIGHT_CAP; k++) {
      const l = lights[k];
      if (l.ttl <= 0) continue;
      l.ttl -= dt;
      if (l.ttl <= 0) {
        l.light.intensity = 0;
        l.light.position.set(0, -1000, 0);
        l.light.updateMatrixWorld();
        l.key = null;
      } else {
        const t = l.ttl / l.life;
        l.light.intensity = l.peak * t * t;
      }
    }
    void camera;
  }

  function finish(mesh, n, warm, attrs) {
    if (warm && n === 0) {
      // one degenerate instance (size 0) so the warm-up frames compile the pipeline
      for (const a of attrs) a.array.fill(0, 0, 4);
      n = 1;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) for (const a of attrs) flag(a, n);
  }

  // The screen's grade (post-processing.js): what low health, a hit or 'wasted' do to the picture. Set the fields
  // directly every frame (no allocation): game.fx.grade.desaturate = 0.6, or several at once with set({ ... }).
  //   desaturate 0..1, vignette 0..1, damagePulse 0..1 (a red rush from the edges: decay it yourself), brightness
  //   (1), tint (hex, 0xffffff = none)
  const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
  const grade = {
    get desaturate() { return gameGrade.desaturate.value; },
    set desaturate(v) { gameGrade.desaturate.value = clamp01(+v || 0); },
    get vignette() { return gameGrade.vignette.value; },
    set vignette(v) { gameGrade.vignette.value = clamp01(+v || 0); },
    get damagePulse() { return gameGrade.damagePulse.value; },
    set damagePulse(v) { gameGrade.damagePulse.value = clamp01(+v || 0); },
    get brightness() { return gameGrade.brightness.value; },
    set brightness(v) { gameGrade.brightness.value = Math.max(0, Math.min(2, Number.isFinite(+v) ? +v : 1)); },
    set tint(hex) { gameGrade.tint.value.setHex(Number.isFinite(hex) ? hex : 0xffffff); },
    get tint() { return gameGrade.tint.value.getHex(); },
    set(o) {
      if (!o) return grade;
      if (o.desaturate !== undefined) grade.desaturate = o.desaturate;
      if (o.vignette !== undefined) grade.vignette = o.vignette;
      if (o.damagePulse !== undefined) grade.damagePulse = o.damagePulse;
      if (o.brightness !== undefined) grade.brightness = o.brightness;
      if (o.tint !== undefined) grade.tint = o.tint;
      return grade;
    },
    reset() {
      return grade.set({ desaturate: 0, vignette: 0, damagePulse: 0, brightness: 1, tint: 0xffffff });
    }
  };

  return {
    group,
    meshes,
    grade,
    sparks,
    smoke,
    fire,
    explosion,
    muzzleFlash,
    tracer,
    impact,
    debris: debrisBurst,
    decal,
    light,
    /** A persistent smoke source: returns an Emitter (set(x, y, z) to move it, stop() to end it). opts: rate, size, life, color, alpha, rise */
    smokeEmitter: (x, y, z, opts) => emitter('smoke', x, y, z, opts),
    /** A persistent fire (with flickering light): opts: rate, size, life, light */
    fireEmitter: (x, y, z, opts) => emitter('fire', x, y, z, opts),
    /** A persistent shower of sparks */
    sparkEmitter: (x, y, z, opts) => emitter('sparks', x, y, z, opts),
    beacon,
    update,
    stats: () => ({ soft: soft.live, glow: glow.live, streaks: streak.live, debris: debris.live, decals: decalUsed, beacons: beacons.filter((b) => b.active).length })
  };
}

export { createFx };
