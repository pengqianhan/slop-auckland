import * as THREE from 'three/webgpu';
import { LL, HARBOUR_BRIDGE, ISLAND_BOUNDS } from './city-config.js';
import { terrainHeight } from './terrain.js';

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   category: 'follow', fov: 68 },
  { id: 'queenSt',     name: 'Queen Street',             category: 'scenic', fov: 50 },
  { id: 'skyTower',    name: 'Under the Sky Tower',      category: 'scenic', fov: 58 },
  { id: 'viaduct',     name: 'Viaduct Harbour',          category: 'scenic', fov: 50 },
  { id: 'bridge',      name: 'Harbour Bridge',           category: 'scenic', fov: 48 },
  { id: 'observatory', name: 'Sky Tower Sky Deck',       category: 'scenic', fov: 54 },
  { id: 'maungawhau',  name: 'Maungawhau / Mt Eden',     category: 'scenic', fov: 40 },
  { id: 'waterfront',  name: 'Waitematā & Skyline',      category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Auto-Director Aerial',     category: 'scenic', fov: 50 }
];


// Scenic viewpoints at real places: [longitude, latitude, metres above the ground there]
const VIEW = (lon, lat, up) => {
  const p = LL(lon, lat);
  return new THREE.Vector3(p.x, terrainHeight(p.x, p.z) + up, p.z);
};
const VIEWS = {
  queenSt: { from: VIEW(174.76462, -36.85105, 7), to: VIEW(174.76690, -36.84330, 30) }, // from Wellesley St down to the Ferry Building
  skyTower: { from: VIEW(174.76335, -36.84770, 2.2), to: VIEW(174.762191, -36.848448, 215) },
  viaduct: { from: VIEW(174.75985, -36.84185, 9), to: VIEW(174.762191, -36.848448, 150) },
  bridge: { from: VIEW(174.74790, -36.83960, 14), to: new THREE.Vector3((HARBOUR_BRIDGE.a.x + HARBOUR_BRIDGE.b.x) / 2, 44, (HARBOUR_BRIDGE.a.z + HARBOUR_BRIDGE.b.z) / 2) },
  observatory: { from: VIEW(174.762191, -36.848448, 221.5), to: VIEW(174.8590, -36.7870, 0) }, // out to Rangitoto
  maungawhau: { from: VIEW(174.76405, -36.87690, 5), to: VIEW(174.762191, -36.848448, 130) },
  waterfront: { from: VIEW(174.7690, -36.8322, 55), to: VIEW(174.7630, -36.8475, 110) }
};

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // the gulf & the isthmus run out 20 km and more to the hazy horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = VIEWS.queenSt.from.clone();
    this.currentLookAt = VIEWS.queenSt.to.clone();
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          entity.position.y + height,
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : entity.type === 'kiwi' ? 0.45 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : entity.type === 'kiwi' ? 1.5 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + (entity.type === 'kiwi' ? 0.5 : 0.92);

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          lowY,
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        } else if (entity.type === 'kiwi') {
          // (from the tip of its bill)
          fwdOffset = 1.35;
          eyeY = 0.9;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'queenSt':
      case 'skyTower':
      case 'viaduct':
      case 'bridge':
      case 'maungawhau':
      case 'waterfront': {
        const view = VIEWS[this.activePresetId];
        const sway = Math.sin(elapsed * 0.24) * (this.activePresetId === 'waterfront' ? 40 : 2.2);
        desiredPos.copy(view.from);
        desiredPos.x += sway;
        desiredLook.copy(view.to);
        break;
      }

      case 'observatory': {
        // the Sky Deck, panning across the harbour from the bridge to Rangitoto and the port
        const view = VIEWS.observatory;
        const pan = Math.sin(elapsed * 0.11) * 0.9;
        const dx = view.to.x - view.from.x, dz = view.to.z - view.from.z;
        desiredPos.copy(view.from);
        desiredPos.x += 9;
        desiredLook.set(view.from.x + dx * Math.cos(pan) - dz * Math.sin(pan), 20, view.from.z + dx * Math.sin(pan) + dz * Math.cos(pan));
        break;
      }

      case 'drone': {
        // circling the city centre, from over the harbour round behind the towers
        const angle = elapsed * 0.07 - 1.2;
        const radius = 1050.0 + Math.sin(elapsed * 0.23) * 180.0;
        const alt = 380.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(
          Math.cos(angle) * radius + 150.0,
          alt,
          Math.sin(angle) * radius - 150.0
        );
        desiredLook.set(150.0, 130.0, -150.0);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      // never under the ground (a hill behind the car, the lip of a cutting)
      this.currentPos.y = Math.max(terrainHeight(this.currentPos.x, this.currentPos.z) + 0.6, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    void ISLAND_BOUNDS;
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
