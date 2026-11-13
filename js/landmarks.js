import * as THREE from 'three/webgpu';
import { Fn, float, color, positionWorld, positionLocal, uv, mix, smoothstep, step, fract, abs, sin, time, max } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HARBOUR_BRIDGE, SKY_TOWER, ISLAND_BOUNDS } from './city-config.js';
import { terrainHeight, deckHeight } from './terrain.js';
import { cityUniforms } from './tsl-materials.js';

// Auckland's hand-modelled landmarks: the Sky Tower and the Harbour Bridge's steel arch. (The bridge's deck & piers
// come from the surveyed bridge decks, city-grid.js; every other building is its surveyed footprint, buildings.js.)

// ---------------------------------------------------------------------------------------------------------------------
// The Sky Tower (1997): 328 m. A 12 m concrete shaft on eight raking legs, the pod of restaurants & observation decks
// between 182 and 220 m, a concrete collar and the steel mast above.
// ---------------------------------------------------------------------------------------------------------------------
function buildSkyTower(group, colliders) {
  const ground = terrainHeight(SKY_TOWER.x, SKY_TOWER.z);
  const tower = new THREE.Group();
  tower.name = 'SkyTower';
  tower.position.set(SKY_TOWER.x, ground - 1, SKY_TOWER.z);

  const night = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  // Concrete, floodlit after dark: the shaft washes from magenta at its foot to blue under the pod
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0xd3cfc4, roughness: 0.82 });
  concrete.emissiveNode = Fn(() => {
    const h = positionWorld.y.sub(ground).div(180.0);
    const wash = mix(color(0xd0188c), color(0x1848e0), smoothstep(0.1, 0.95, h));
    return wash.mul(night).mul(0.5);
  })();
  // The pod: bands of dark glass between pale spandrels, lit from inside at night
  const pod = new THREE.MeshStandardNodeMaterial({ color: 0xc9ccd0, roughness: 0.35, metalness: 0.5 });
  pod.colorNode = Fn(() => {
    const y = positionLocal.y;
    const band = step(0.42, fract(y.div(3.6)));
    return mix(color(0xcfd2d6), color(0x16283a), band);
  })();
  pod.roughnessNode = mix(float(0.6), float(0.08), step(0.42, fract(positionLocal.y.div(3.6))));
  pod.emissiveNode = Fn(() => {
    const band = step(0.42, fract(positionLocal.y.div(3.6)));
    const flicker = step(0.35, fract(sin(uv().x.mul(160.0).floor().mul(12.9898)).mul(43758.5453)));
    return color(0xffd9a0).mul(band).mul(flicker).mul(night).mul(0.9);
  })();
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0xe6e8ea, roughness: 0.45, metalness: 0.6 });
  // aircraft warning light on the mast's tip
  const beacon = new THREE.MeshBasicNodeMaterial();
  beacon.colorNode = color(0xff2a1a).mul(max(float(0.15), step(0.5, fract(time.mul(0.7))).mul(night).mul(3.0)));

  const lathe = (profile, material, segments = 32) => {
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments), material);
    mesh.castShadow = mesh.receiveShadow = true;
    tower.add(mesh);
    return mesh;
  };
  // shaft: 6 m radius, flaring into the pod's underside
  lathe([[6.6, 0], [6.1, 40], [6.0, 150], [6.6, 166], [9.5, 176], [15.2, 181]], concrete, 24);
  // pod: main observation level & restaurants, the upper decks stepping in to the Sky Deck at 220 m
  lathe([[15.2, 181], [16.4, 183], [16.4, 194.5], [14.6, 195.2], [14.6, 199.5], [15.4, 200], [15.4, 203.6], [12.2, 204.4], [12.2, 211.5],
    [10.4, 212.2], [10.4, 219.6], [8.6, 220.4], [8.6, 223.5], [5.2, 224.5]], pod, 40);
  // collar & upper shaft
  lathe([[5.2, 224.5], [4.6, 226], [4.2, 240], [4.8, 241], [4.8, 244], [3.6, 245], [3.2, 262], [3.9, 263], [3.9, 266], [2.4, 267]], concrete, 20);
  // mast
  lathe([[2.4, 267], [2.0, 270], [1.5, 296], [1.9, 297], [1.9, 299], [1.0, 300], [0.55, 322], [0.2, 329]], steel, 12);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), beacon);
  tip.position.y = 329.4;
  tower.add(tip);
  // eight raking legs
  const legs = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const leg = new THREE.BoxGeometry(2.2, 46, 2.6);
    leg.translate(0, 23, 0);
    leg.rotateZ(-0.26);
    leg.translate(17, 0, 0);
    leg.rotateY(a);
    legs.push(leg);
  }
  const legMesh = new THREE.Mesh(mergeGeometries(legs), concrete);
  legMesh.castShadow = legMesh.receiveShadow = true;
  tower.add(legMesh);
  group.add(tower);

  colliders.push({ minX: SKY_TOWER.x - 7, maxX: SKY_TOWER.x + 7, minZ: SKY_TOWER.z - 7, maxZ: SKY_TOWER.z + 7, minY: ground - 1, maxY: ground + 181 });
  // the pod & mast, for the helicopter
  colliders.push({ minX: SKY_TOWER.x - 15, maxX: SKY_TOWER.x + 15, minZ: SKY_TOWER.z - 15, maxZ: SKY_TOWER.z + 15, minY: ground + 181, maxY: ground + 224, reserve: false });
  colliders.push({ minX: SKY_TOWER.x - 3, maxX: SKY_TOWER.x + 3, minZ: SKY_TOWER.z - 3, maxZ: SKY_TOWER.z + 3, minY: ground + 224, maxY: ground + 328, reserve: false });
  return tower;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Harbour Bridge (1959): over the navigation span the deck hangs in a steel arch truss, its top chords rising
// ~25 m above the road on either side of the four centre lanes (the "Nippon clip-ons" of 1969 ride outside it)
// ---------------------------------------------------------------------------------------------------------------------
function buildHarbourBridgeArch(group, colliders) {
  const B = HARBOUR_BRIDGE;
  const steelMat = new THREE.MeshStandardNodeMaterial({ color: 0x8b9199, roughness: 0.5, metalness: 0.55 });
  const parts = [];
  // s: metres along the navigation span from its southern pier
  const at = (s) => ({ x: B.a.x + B.sx * s, z: B.a.z + B.sz * s });
  const rx = B.sz, rz = -B.sx; // across the bridge
  const deckAt = (s) => {
    const p = at(s);
    const y = deckHeight(p.x, p.z, Infinity, 2, 6);
    return Number.isFinite(y) ? y : B.deckY;
  };
  // a steel member between two points
  const member = (ax, ay, az, bx, by, bz, w) => {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    if (len < 0.1) return;
    const g = new THREE.BoxGeometry(w, w, len);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), new THREE.Vector3(0, 1, 0));
    g.applyMatrix4(m);
    g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    parts.push(g);
  };
  const HALF = 9.2; // the trusses stand either side of the centre carriageway
  const PANELS = 14;
  const span = B.span;
  const top = [], bottom = [];
  for (let k = 0; k <= PANELS; k++) {
    const t = k / PANELS;
    const s = span * t;
    const deck = deckAt(s);
    // through-arch: the top chord a parabola 25 m over the deck at mid span, coming down to meet it at the piers;
    // the bottom chord dips below the deck towards the piers
    const rise = 25 * 4 * t * (1 - t) + 2.5;
    const dip = -7 * (1 - 4 * t * (1 - t)) - 1.2;
    top.push({ s, y: deck + rise });
    bottom.push({ s, y: deck + dip });
  }
  for (const side of [-1, 1]) {
    const P = (q) => { const p = at(q.s); return [p.x + rx * HALF * side, q.y, p.z + rz * HALF * side]; };
    for (let k = 0; k < PANELS; k++) {
      member(...P(top[k]), ...P(top[k + 1]), 1.1);
      member(...P(bottom[k]), ...P(bottom[k + 1]), 1.0);
      // diagonals alternate
      if (k % 2 === 0) member(...P(bottom[k]), ...P(top[k + 1]), 0.6);
      else member(...P(top[k]), ...P(bottom[k + 1]), 0.6);
    }
    for (let k = 0; k <= PANELS; k++) member(...P(bottom[k]), ...P(top[k]), 0.6);
  }
  // sway bracing between the two top chords, clear of the traffic
  for (let k = 2; k <= PANELS - 2; k++) {
    const p = at(top[k].s);
    member(p.x - rx * HALF, top[k].y, p.z - rz * HALF, p.x + rx * HALF, top[k].y, p.z + rz * HALF, 0.5);
  }
  if (parts.length) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), steelMat);
    mesh.name = 'HarbourBridgeArch';
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  void colliders;
}

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'AucklandLandmarks';
  const colliders = [];
  buildSkyTower(group, colliders);
  buildHarbourBridgeArch(group, colliders);
  scene.add(group);
  void ISLAND_BOUNDS;
  void abs;
  return { group, colliders };
}

export { buildLandmarks };
