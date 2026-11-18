import * as THREE from 'three/webgpu';
import { Fn, uv, float, length, smoothstep, pow, clamp, sin, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { transparentEffectMRT } from '../tsl-materials.js';

// Pickups: things lying about that the player collects by touching them: health, armour, a cricket bat (the only
// weapon there is besides fists), cash (dropped by the knocked out too), bribe stars, the hidden golden kiwis and
// mission packages. Each kind is one instanced mesh (an emissive little model spinning and bobbing over a glowing
// disc on the ground) with a fixed capacity; every
// mesh and material is made here at start-up, before main.js compiles the scene's shaders (one degenerate instance
// each until the first frames are drawn), and the frame loop only rewrites instance matrices: no allocation.
//   game.pickups.spawn(kind, x, z, { value, weaponId ('bat'), respawn, ttl, y, inVehicle, onCollect, label })
//   game.pickups.remove(p)   game.pickups.dropCash(x, z, amount)   game.pickups.list (live pickups)
// Collecting emits 'pickup:collected' { kind, value, x, z }.

const KINDS = {
  health: { cap: 24, color: 0x3ddc84, emissive: 0x1d9a55, halo: 0x45ff9a, radius: 1.2 },
  armor: { cap: 16, color: 0x3d7dff, emissive: 0x1d46b8, halo: 0x5a9bff, radius: 1.2 },
  weapon: { cap: 8, color: 0xd9c08c, emissive: 0x3a2a10, halo: 0xff9a3c, radius: 1.3 },
  cash: { cap: 40, color: 0x5fbf5a, emissive: 0x1e5a1c, halo: 0x8cff7a, radius: 1.3, inVehicle: true },
  bribe: { cap: 8, color: 0x2f6dff, emissive: 0x1840b0, halo: 0x6fa0ff, radius: 1.4 },
  collectible: { cap: 30, color: 0xffc83a, emissive: 0x7a5200, halo: 0xffd84a, radius: 1.3, metal: true },
  package: { cap: 12, color: 0x9a6a3a, emissive: 0x3a2008, halo: 0xffd23f, radius: 2.2, inVehicle: true }
};
const DRAW_DIST = 190;
const FLOAT = 0.62; // m above the ground
const WARM_FRAMES = 3;

// ---------------------------------------------------------------------------------------------------------------------
// Little models (merged, made once)
// ---------------------------------------------------------------------------------------------------------------------
function box(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function makeGeometry(kind) {
  switch (kind) {
    case 'health':
      return mergeGeometries([box(0.5, 0.16, 0.16), box(0.16, 0.5, 0.16)]);
    case 'armor': {
      const disc = new THREE.CylinderGeometry(0.27, 0.22, 0.09, 20).rotateX(Math.PI / 2);
      return mergeGeometries([disc, box(0.06, 0.36, 0.11), box(0.3, 0.06, 0.11)]);
    }
    case 'weapon':
      // a cricket bat, blade down: the blade, the splice, the handle
      return mergeGeometries([box(0.11, 0.5, 0.035, 0, -0.08, 0), box(0.05, 0.08, 0.03, 0, 0.21, 0), box(0.034, 0.26, 0.034, 0, 0.36, 0)]);
    case 'cash':
      return mergeGeometries([box(0.44, 0.07, 0.22, 0, -0.07, 0), box(0.44, 0.07, 0.22, 0.02, 0, 0.01), box(0.44, 0.07, 0.22, -0.01, 0.07, -0.01)]);
    case 'bribe': {
      const shape = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
        const r = i % 2 ? 0.13 : 0.32;
        if (i) shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        else shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      return new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false }).translate(0, 0, -0.04);
    }
    case 'collectible': {
      // a golden kiwi: round body, small head, long beak, two stubby legs
      const body = new THREE.SphereGeometry(0.24, 16, 12).scale(1, 0.82, 1.18);
      const head = new THREE.SphereGeometry(0.1, 12, 10).translate(0, 0.1, 0.27);
      const beak = new THREE.CylinderGeometry(0.012, 0.03, 0.3, 8).rotateX(Math.PI / 2 + 0.55).translate(0, -0.02, 0.44);
      const legA = box(0.035, 0.18, 0.035, 0.08, -0.25, 0.02);
      const legB = box(0.035, 0.18, 0.035, -0.08, -0.25, 0.02);
      return mergeGeometries([body, head, beak, legA, legB].map((g) => g.toNonIndexed()));
    }
    case 'package':
    default:
      return mergeGeometries([box(0.5, 0.36, 0.42), box(0.52, 0.06, 0.12, 0, 0.16, 0), box(0.12, 0.38, 0.44)]);
  }
}

function createHaloMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  mat.mrtNode = transparentEffectMRT;
  mat.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2.0);
    const disc = pow(clamp(float(1.0).sub(r), 0.0, 1.0), 1.8);
    const rim = smoothstep(0.62, 0.8, r).mul(smoothstep(1.0, 0.86, r)).mul(0.9);
    const pulse = sin(time.mul(3.0)).mul(0.18).add(0.82);
    return disc.mul(0.55).add(rim).mul(pulse);
  })();
  mat.opacityNode = float(1.0);
  return mat;
}

function createPickups(game) {
  const scene = game.engine.scene;
  const group = new THREE.Group();
  group.name = 'GamePickups';
  group.matrixAutoUpdate = false;
  scene.add(group);

  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const meshes = {};
  let haloCap = 0;
  for (const [kind, k] of Object.entries(KINDS)) {
    const mat = new THREE.MeshStandardNodeMaterial({
      color: k.color, emissive: k.emissive, emissiveIntensity: 1.4,
      roughness: k.metal ? 0.28 : 0.55, metalness: k.metal ? 0.85 : 0.1
    });
    const mesh = new THREE.InstancedMesh(makeGeometry(kind), mat, k.cap);
    mesh.name = `Pickup-${kind}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.setMatrixAt(0, zero);
    mesh.count = 1; // one degenerate instance until warm-up is over (the shaders compile behind the loading screen)
    group.add(mesh);
    mesh.updateMatrixWorld();
    meshes[kind] = mesh;
    haloCap += k.cap;
  }
  const haloGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const halo = new THREE.InstancedMesh(haloGeo, createHaloMaterial(), haloCap);
  halo.name = 'PickupHalos';
  halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  halo.frustumCulled = false;
  halo.castShadow = halo.receiveShadow = false;
  halo.matrixAutoUpdate = false;
  halo.renderOrder = 4;
  const haloColor = new THREE.Color();
  for (let i = 0; i < haloCap; i++) halo.setColorAt(i, haloColor.setHex(0xffffff));
  halo.instanceColor.setUsage(THREE.DynamicDrawUsage);
  halo.setMatrixAt(0, zero);
  halo.count = 1;
  group.add(halo);
  halo.updateMatrixWorld();
  // per-kind halo colours, as floats
  const haloRGB = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    haloColor.setHex(k.halo);
    haloRGB[kind] = [haloColor.r, haloColor.g, haloColor.b];
  }

  // the records: a fixed pool per kind
  const pools = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    pools[kind] = Array.from({ length: k.cap }, (_, i) => ({
      id: `${kind}-${i}`, kind, active: false, collected: false, x: 0, y: 0, z: 0, value: 0, weaponId: null,
      respawn: 0, respawnAt: 0, expires: 0, inVehicle: !!k.inVehicle, radius: k.radius, onCollect: null, label: '',
      phase: Math.random() * Math.PI * 2, persistent: false
    }));
  }
  const live = []; // active (or waiting to respawn) pickups
  const collectedEvent = { kind: '', value: 0, x: 0, z: 0, pickup: null };
  let updates = 0;

  function take(kind) {
    const pool = pools[kind];
    if (!pool) return null;
    for (const p of pool) if (!p.active && !p.persistent) return p;
    // full: the oldest expiring one (cash) goes; persistent ones are never taken
    let oldest = null;
    for (const p of pool) if (!p.persistent && p.expires > 0 && (!oldest || p.expires < oldest.expires)) oldest = p;
    if (oldest) release(oldest);
    return oldest;
  }

  function release(p) {
    p.active = false;
    p.persistent = false;
    p.onCollect = null;
    const i = live.indexOf(p);
    if (i >= 0) live.splice(i, 1);
  }

  const pickups = {
    KINDS,
    list: live,
    meshes: [...Object.values(meshes), halo],
    /**
     * A pickup of kind at (x, z). opts: value (health / armour points, dollars), weaponId (the bat),
     * respawn (s: comes back after being taken), ttl (s: disappears), y (height; default the ground there),
     * inVehicle (collectable from a vehicle), onCollect(p) (return false to refuse it), label.
     */
    spawn(kind, x, z, opts = null) {
      const p = take(kind);
      if (!p) return null;
      p.active = true;
      p.collected = false;
      p.x = x;
      p.z = z;
      p.y = (opts?.y ?? game.world.groundHeight(x, z)) + FLOAT;
      p.value = opts?.value ?? (kind === 'health' ? 50 : kind === 'armor' ? 50 : kind === 'cash' ? 25 : 1);
      p.weaponId = opts?.weaponId ?? null;
      p.respawn = opts?.respawn ?? 0;
      p.respawnAt = 0;
      p.expires = opts?.ttl ? game.time + opts.ttl : 0;
      p.inVehicle = opts?.inVehicle ?? !!KINDS[kind].inVehicle;
      p.onCollect = opts?.onCollect ?? null;
      p.label = opts?.label ?? '';
      p.persistent = !!(opts?.persistent || p.respawn > 0);
      if (!live.includes(p)) live.push(p);
      return p;
    },
    remove(p) {
      if (p) release(p);
    },
    /** Cash on the ground (a dead pedestrian's wallet, a gang member's roll) for a minute */
    dropCash(x, z, amount) {
      if (!(amount > 0)) return null;
      return pickups.spawn('cash', x + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.6, { value: Math.round(amount), ttl: 60 });
    },
    update(dt, realDt) {
      updates++;
      const player = game.player;
      const pos = player?.position;
      const canTake = player && player.alive && game.state === 'playing';
      const inVehicle = !!player?.vehicle;
      const now = game.time;
      // collection & expiry
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        if (!p.active) {
          live.splice(i, 1);
          continue;
        }
        if (p.collected) {
          if (p.respawn > 0 && now >= p.respawnAt) p.collected = false;
          continue;
        }
        if (p.expires > 0 && now >= p.expires) {
          release(p);
          continue;
        }
        if (!canTake || (inVehicle && !p.inVehicle)) continue;
        const dx = pos.x - p.x, dz = pos.z - p.z, dy = pos.y + 0.9 - p.y;
        const r = inVehicle ? p.radius + 1.4 : p.radius;
        if (dx * dx + dz * dz > r * r || Math.abs(dy) > 2.6) continue;
        collect(p);
      }
      draw(realDt);
    }
  };

  function collect(p) {
    const player = game.player;
    const w = game.weapons;
    switch (p.kind) {
      case 'health':
        if (player.health >= player.maxHealth) return;
        player.heal(p.value);
        break;
      case 'armor':
        if (player.armor >= player.maxArmor) return;
        player.addArmor(p.value);
        break;
      case 'cash':
        player.addMoney(p.value, 'pickup');
        break;
      case 'weapon':
        // (only what game.weapons allows; one already carried is left lying there for later)
        if (!w || !p.weaponId || !w.defs?.[p.weaponId] || w.has?.(p.weaponId)) return;
        if (!w.give(p.weaponId)) return;
        break;
      case 'bribe':
        if (!game.wanted || !(game.wanted.level > 0)) return;
        if (typeof game.wanted.bribe === 'function') game.wanted.bribe();
        else game.wanted.set?.(game.wanted.level - 1);
        break;
      default:
        break;
    }
    if (p.onCollect && p.onCollect(p) === false) return;
    game.fx?.sparks(p.x, p.y, p.z, 0, 1, 0, 14, 4.5, 0.6);
    game.fx?.light(p.x, p.y + 0.4, p.z, KINDS[p.kind].halo, 40, 8, 0.25);
    collectedEvent.kind = p.kind;
    collectedEvent.value = p.kind === 'weapon' ? 0 : p.value;
    collectedEvent.x = p.x;
    collectedEvent.z = p.z;
    collectedEvent.pickup = p;
    collectedEvent.weaponId = p.weaponId;
    game.emit('pickup:collected', collectedEvent);
    if (p.respawn > 0) {
      p.collected = true;
      p.respawnAt = game.time + p.respawn;
    } else {
      release(p);
    }
  }

  // ---- drawing: the near ones, compacted into each kind's instances ----
  const counts = {};
  let spin = 0;
  function writeMatrix(arr, o, x, y, z, yaw, s, tilt = 0) {
    const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
    arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
    arr[o + 12] = x; arr[o + 13] = y + tilt; arr[o + 14] = z; arr[o + 15] = 1;
  }

  function draw(realDt) {
    spin += realDt;
    const cam = game.engine.cameraSystem.currentPos || game.camera.camera.position;
    const warm = updates <= WARM_FRAMES;
    for (const kind in meshes) counts[kind] = 0;
    let nh = 0;
    const hArr = halo.instanceMatrix.array;
    const hCol = halo.instanceColor.array;
    const r2 = DRAW_DIST * DRAW_DIST;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      if (!p.active || p.collected) continue;
      const dx = p.x - cam.x, dz = p.z - cam.z;
      if (dx * dx + dz * dz > r2) continue;
      const mesh = meshes[p.kind];
      const n = counts[p.kind];
      if (n >= mesh.instanceMatrix.count) continue;
      const bob = Math.sin(spin * 2.2 + p.phase) * 0.1;
      const s = p.kind === 'collectible' ? 1.15 : p.kind === 'package' ? 1.1 : 1;
      writeMatrix(mesh.instanceMatrix.array, n * 16, p.x, p.y + bob, p.z, spin * 1.6 + p.phase, s);
      counts[p.kind] = n + 1;
      const hr = p.kind === 'package' ? 2.4 : 1.5;
      writeMatrix(hArr, nh * 16, p.x, p.y - FLOAT + 0.07, p.z, 0, hr);
      const c = haloRGB[p.kind];
      hCol[nh * 3] = c[0];
      hCol[nh * 3 + 1] = c[1];
      hCol[nh * 3 + 2] = c[2];
      nh++;
    }
    for (const kind in meshes) {
      const mesh = meshes[kind];
      const n = counts[kind];
      if (n === 0 && warm) {
        mesh.instanceMatrix.array.set(zero.elements, 0);
        mesh.count = 1;
        mesh.visible = true;
      } else {
        mesh.count = n;
        mesh.visible = n > 0;
      }
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (nh === 0 && warm) {
      hArr.set(zero.elements, 0);
      halo.count = 1;
      halo.visible = true;
    } else {
      halo.count = nh;
      halo.visible = nh > 0;
    }
    if (nh > 0) {
      halo.instanceMatrix.clearUpdateRanges();
      halo.instanceMatrix.addUpdateRange(0, nh * 16);
      halo.instanceMatrix.needsUpdate = true;
      halo.instanceColor.clearUpdateRanges();
      halo.instanceColor.addUpdateRange(0, nh * 3);
      halo.instanceColor.needsUpdate = true;
    }
  }

  return pickups;
}

export { createPickups, KINDS as PICKUP_KINDS };
