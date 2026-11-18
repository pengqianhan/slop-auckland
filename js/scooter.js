import * as THREE from 'three/webgpu';
import { createContactShadowMaterial } from './tsl-materials.js';

export const SCOOTER = {
  halfW: 0.28, halfL: 0.72, height: 1.18, mass: 90,
  axle: 0.56, wheelRadius: 0.14, collisionRadius: 0.68, topSpeed: 25 / 3.6
};

let parts;

function buildParts() {
  const standard = (color, roughness, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  const box = (w, h, l) => new THREE.BoxGeometry(w, h, l);
  return {
    frame: standard(0x20c7a3, 0.42, 0.25),
    rubber: standard(0x222734, 0.85),
    metal: standard(0x83919d, 0.36, 0.7),
    headlight: new THREE.MeshBasicNodeMaterial({ color: 0xe5f8ff }),
    tailLight: new THREE.MeshBasicNodeMaterial({ color: 0xff453b }),
    deck: box(0.23, 0.095, 0.83),
    pad: box(0.197, 0.012, 0.74),
    neck: box(0.12, 0.115, 0.29),
    mudguard: new THREE.CylinderGeometry(0.165, 0.165, 0.12, 12, 1, true, Math.PI / 2 - 1.1, 2.2).rotateZ(Math.PI / 2),
    stem: new THREE.CylinderGeometry(0.025, 0.036, 1.02, 10),
    bars: new THREE.CylinderGeometry(0.017, 0.017, 0.53, 10).rotateZ(Math.PI / 2),
    grip: new THREE.CylinderGeometry(0.027, 0.027, 0.12, 10).rotateZ(Math.PI / 2),
    tire: new THREE.CylinderGeometry(SCOOTER.wheelRadius, SCOOTER.wheelRadius, 0.083, 16).rotateZ(Math.PI / 2),
    hub: new THREE.CylinderGeometry(0.071, 0.071, 0.088, 6).rotateZ(Math.PI / 2),
    lamp: box(0.067, 0.039, 0.034),
    shadow: new THREE.PlaneGeometry(0.7, 1.65).rotateX(-Math.PI / 2),
    shadowMaterial: createContactShadowMaterial()
  };
}

export function createScooterEntity(x, y, z, heading) {
  const p = parts ??= buildParts();
  const mesh = new THREE.Group();
  mesh.name = 'E-Scooter';
  const leanPivot = new THREE.Group();
  const steerPivot = new THREE.Group();
  mesh.add(leanPivot);
  leanPivot.add(steerPivot);
  steerPivot.position.set(0, 1.13, 0.40);

  function add(parent, geometry, material, x, y, z) {
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    part.castShadow = part.receiveShadow = material.isMeshStandardNodeMaterial;
    parent.add(part);
    return part;
  }

  add(leanPivot, p.deck, p.frame, 0, 0.15, -0.16);
  add(leanPivot, p.pad, p.rubber, 0, 0.203, -0.17);
  add(leanPivot, p.neck, p.frame, 0, 0.19, 0.36).rotation.x = -0.48;
  add(leanPivot, p.mudguard, p.rubber, 0, SCOOTER.wheelRadius, -SCOOTER.axle);
  add(leanPivot, p.lamp, p.tailLight, 0, 0.26, -0.65);
  add(steerPivot, p.stem, p.frame, 0, -0.5, 0.08).rotation.x = -0.16;
  add(steerPivot, p.bars, p.metal, 0, 0, 0);
  for (const side of [-1, 1]) add(steerPivot, p.grip, p.rubber, side * 0.22, 0, 0);
  add(steerPivot, p.lamp, p.headlight, 0, -0.065, 0.052);

  function wheel(parent, y, z) {
    const tire = add(parent, p.tire, p.rubber, 0, y, z);
    add(tire, p.hub, p.metal, 0, 0, 0);
    return tire;
  }
  const frontWheel = wheel(steerPivot, SCOOTER.wheelRadius - steerPivot.position.y, SCOOTER.axle - steerPivot.position.z);
  const rearWheel = wheel(leanPivot, SCOOTER.wheelRadius, -SCOOTER.axle);
  const shadow = add(mesh, p.shadow, p.shadowMaterial, 0, 0.025, 0);
  shadow.renderOrder = 998;

  return {
    type: 'scooter', label: 'E-Scooter', mesh, leanPivot, steerPivot, frontWheel, rearWheel,
    riderFrame: {
      bars: steerPivot.position, gripHalf: 0.22, deck: 0.209, steerPivot
    },
    position: new THREE.Vector3(x, y, z), prevX: x, prevZ: z, heading, speed: 0,
    leanAngle: 0, groundPitch: 0, groundRoll: 0,
    cameraTargetOffset: new THREE.Vector3(0, 1.22, 0), chaseDistance: 4.6, chaseHeight: 2
  };
}
