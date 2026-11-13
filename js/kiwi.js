import * as THREE from 'three/webgpu';
import { attribute, vec2, vec3, floor, fract, sin, dot, mix, positionLocal } from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// The player's kiwi: the round brown bird with the long bill, here about the size of a person (a real one stands
// 40 cm tall and would be a speck over the city) and, unlike a real one, able to fly on its stubby wings.
// Local frame: +z forward, y up, the origin on the ground under its feet when it stands.

const BROWN = 0x6b4a30;
const BELLY = 0x8a6b4c;
const HEAD = 0x74573d;
const WING = 0x593c26;
const BILL = 0xd9c6a4;
const BILL_TIP = 0xa8926f;
const LEG = 0xa58c76;
const EYE = 0x0a0a0a;

const _c = new THREE.Color();
const _c2 = new THREE.Color();

// A reshaped sphere, smooth again: its seam & poles welded, the normals worked out afresh
function weld(geometry) {
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  const welded = mergeVertices(geometry, 1e-5);
  welded.computeVertexNormals();
  return welded;
}

// Paint a geometry: one colour, or a blend along y between two (from yLow to yHigh)
function paint(geometry, hex, hexLow = hex, yLow = 0, yHigh = 1) {
  geometry.deleteAttribute('uv'); // (nothing here is textured, and the welded parts have none)
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  _c.setHex(hex);
  _c2.setHex(hexLow);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - yLow) / (yHigh - yLow)));
    colors[i * 3] = _c2.r + (_c.r - _c2.r) * t;
    colors[i * 3 + 1] = _c2.g + (_c.g - _c2.g) * t;
    colors[i * 3 + 2] = _c2.b + (_c.b - _c2.b) * t;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const blob = (radius, x, y, z, sx = 1, sy = 1, sz = 1, w = 16, h = 12) =>
  new THREE.SphereGeometry(radius, w, h).scale(sx, sy, sz).translate(x, y, z);

// The other side's copy of a geometry: mirrored in x, its triangles turned to face outwards again
function mirrored(geometry) {
  const g = geometry.clone().scale(-1, 1, 1);
  const index = g.index.array;
  for (let i = 0; i < index.length; i += 3) {
    const t = index[i + 1];
    index[i + 1] = index[i + 2];
    index[i + 2] = t;
  }
  return g;
}

// Body, neck & head in one feathered piece: a pear, heaviest behind the legs, with no tail to speak of
function buildFeathers() {
  const body = new THREE.SphereGeometry(1, 28, 18);
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const girth = 1 + 0.16 * Math.max(0, -z) - 0.14 * Math.max(0, z) ** 2;
    p.setXYZ(i, p.getX(i) * 0.34 * girth, p.getY(i) * 0.36 * girth + 0.62, z * 0.52);
  }
  const neck = paint(blob(0.25, 0, 0.74, 0.33), BROWN);
  const nape = paint(blob(0.2, 0, 0.83, 0.47), HEAD, BROWN, 0.66, 0.9);
  const head = paint(blob(0.16, 0, 0.9, 0.6, 1, 1, 1.15), HEAD);
  return mergeGeometries([paint(weld(body), BROWN, BELLY, 0.3, 0.62), neck, nape, head]);
}

// The bill (a third as long as the bird, dipping) & the eyes
function buildBare() {
  const length = 0.56, dip = 0.3;
  const bill = new THREE.CylinderGeometry(0.014, 0.042, length, 8);
  paint(bill, BILL_TIP, BILL, 0, length * 0.5);
  bill.rotateX(Math.PI / 2 + dip).translate(0, 0.89 - Math.sin(dip) * length * 0.5, 0.72 + Math.cos(dip) * length * 0.5);
  const eyes = [1, -1].map((side) => paint(blob(0.024, side * 0.115, 0.95, 0.67, 1, 1, 1, 8, 6), EYE));
  return mergeGeometries([bill, ...eyes]);
}

// One leg, hanging from its hip at the origin: the shank, and three toes forward on the ground
function buildLeg() {
  const length = 0.4;
  const shank = new THREE.CylinderGeometry(0.046, 0.03, length, 7).translate(0, -length * 0.5, 0);
  const ankle = blob(0.036, 0, -length, 0, 1, 1, 1, 8, 6);
  const toes = [-0.5, 0, 0.5].map((splay) => {
    const toe = new THREE.CylinderGeometry(0.008, 0.024, 0.17, 6);
    return toe.rotateX(Math.PI / 2).translate(0, 0, 0.085).rotateY(splay).translate(0, -length + 0.012, 0.01);
  });
  return paint(mergeGeometries([shank, ankle, ...toes]), LEG);
}

// One wing, out along +x from its shoulder at the origin: a stub, swept back
function buildWing() {
  const wing = new THREE.SphereGeometry(1, 14, 8).scale(0.27, 0.04, 0.16).translate(0.25, 0, 0);
  const p = wing.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - p.getX(i) * 0.4);
  return paint(weld(wing), WING);
}

// Shaggy, hair-like feathers: long streaks down the bird, lighter & darker
function createFeatherMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
  // (strands a centimetre across and a hand long, each row starting somewhere else along the bird)
  const row = vec2(floor(positionLocal.x.mul(95)), floor(positionLocal.y.mul(95)));
  const shift = fract(sin(dot(row, vec2(12.9898, 78.233))).mul(43758.5453));
  const cell = vec3(row, floor(positionLocal.z.mul(5.5).add(shift.mul(9))));
  const streak = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  mat.colorNode = attribute('color', 'vec3').mul(mix(0.74, 1.12, streak));
  return mat;
}

function createBareMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
  mat.colorNode = attribute('color', 'vec3');
  return mat;
}

/** The kiwi's model: { root, tiltPivot (banks & pitches), wings: [left, right], legs: [left, right] } */
function buildKiwi() {
  const root = new THREE.Group();
  root.name = 'PlayerKiwi';
  const tiltPivot = new THREE.Group();
  root.add(tiltPivot);

  const feathers = createFeatherMaterial();
  const bare = createBareMaterial();
  tiltPivot.add(new THREE.Mesh(buildFeathers(), feathers), new THREE.Mesh(buildBare(), bare));

  const wingGeometry = buildWing();
  const legGeometry = buildLeg();
  const wings = [1, -1].map((side) => {
    const wing = new THREE.Mesh(side > 0 ? wingGeometry : mirrored(wingGeometry), feathers);
    wing.position.set(side * 0.3, 0.76, 0.08);
    tiltPivot.add(wing);
    return wing;
  });
  const legs = [1, -1].map((side) => {
    const leg = new THREE.Mesh(legGeometry, bare);
    leg.position.set(side * 0.15, 0.42, -0.05);
    tiltPivot.add(leg);
    return leg;
  });
  return { root, tiltPivot, wings, legs };
}

/**
 * Pose it for this frame. flap: the wingbeat's phase; air: 0 standing on the ground .. 1 flying; stride: the phase of
 * its run when on the ground; speed in m/s.
 */
function poseKiwi(kiwi, flap, air, stride, speed) {
  // (in the air the stubs beat fast and wide; folded against the body on the ground)
  const beat = (0.2 + Math.sin(flap) * 0.95) * air - 1.25 * (1 - air);
  kiwi.wings[0].rotation.z = beat;
  kiwi.wings[1].rotation.z = -beat;
  // legs trail behind in flight, swing in turn on the ground
  const trail = 1.05 + Math.min(0.35, Math.abs(speed) * 0.014);
  const swing = Math.sin(stride) * Math.min(0.8, Math.abs(speed) * 0.2);
  kiwi.legs[0].rotation.x = trail * air + swing * (1 - air);
  kiwi.legs[1].rotation.x = trail * air - swing * (1 - air);
}

export { buildKiwi, poseKiwi };
