import { nearestRoads, streetArrival, isLand, blockAt, KEEP } from '../../city-config.js';

// Putting things on valid ground: a lane on the street nearest a point (where a car is parked or a checkpoint
// stands), the footpath beside it (where someone waits, where a shop door is), or the nearest clear patch of land
// (a park, a wharf). Every mission, shop and pickup position goes through here once, so they never end up inside
// a building or in the harbour.

function createPlaces(game) {
  const cm = game.engine.controllerManager;

  const ground = (x, z) => game.world.groundHeight(x, z);
  const clear = (x, z, r = 0.5) => isLand(x, z) && cm.isClear(x, z, ground(x, z), r);

  /** The nearest clear spot to (x, z) on land, searched in rings out to maxR: { x, z } (or the point itself) */
  function findClear(x, z, maxR = 30, r = 0.6) {
    if (clear(x, z, r)) return { x, z };
    for (let ring = 1.5; ring <= maxR; ring += 1.5) {
      const n = Math.max(8, Math.round(ring * 2));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * ring, pz = z + Math.sin(a) * ring;
        if (clear(px, pz, r)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  /** A lane of the street nearest (x, z), heading along it (towards face if given): { x, z, heading } */
  function road(x, z, face = null, radius = 220) {
    const a = streetArrival(x, z, face, radius);
    return { x: a.x, z: a.z, heading: a.heading };
  }

  /** The footpath of the street nearest (x, z), on the side facing (x, z): { x, z, heading (along the street) } */
  function kerb(x, z, radius = 160) {
    const near = nearestRoads(x, z, radius).filter((n) => !n.road.closed);
    for (const n of near.slice(0, 3)) {
      // the side of the street (x, z) is on (a point on the street itself: its left, where traffic pulls in)
      let px = -n.dz, pz = n.dx;
      const side = (x - n.x) * px + (z - n.z) * pz;
      // (on the street itself: the side traffic keeps to, the left, (dz, -dx) of the way it runs)
      if (side < -0.5 || (Math.abs(side) <= 0.5 && KEEP < 0)) {
        px = -px;
        pz = -pz;
      }
      const half = Math.max(3, (n.road.w || 8) / 2);
      for (const extra of [1.7, 1.1, 2.5, 3.4]) {
        for (const along of [0, 4, -4, 8, -8]) {
          const qx = n.x + px * (half + extra) + n.dx * along;
          const qz = n.z + pz * (half + extra) + n.dz * along;
          if (clear(qx, qz, 0.55)) return { x: qx, z: qz, heading: Math.atan2(n.dx, n.dz) };
        }
      }
    }
    const c = findClear(x, z, 40);
    return { x: c.x, z: c.z, heading: 0 };
  }

  /**
   * Like kerb, but a little into the street's parking lane (a parked car, a pick-up point for a vehicle). face:
   * { x, z } to park on the side whose traffic heads that way (a car about to drive off there)
   */
  function kerbLane(x, z, radius = 160, face = null) {
    const near = nearestRoads(x, z, radius).filter((n) => !n.road.closed && n.road.w >= 6);
    const n = near[0];
    if (!n) return road(x, z, face);
    let px = -n.dz, pz = n.dx;
    if (face) {
      // the left kerb of the way towards face
      const along = (face.x - n.x) * n.dx + (face.z - n.z) * n.dz >= 0 ? 1 : -1;
      px = n.dz * along;
      pz = -n.dx * along;
    } else if ((x - n.x) * px + (z - n.z) * pz < 0) {
      px = -px;
      pz = -pz;
    }
    const half = Math.max(3, (n.road.w || 8) / 2);
    // parked facing the way traffic on that side goes: keeping left, the kerb on the left of (dx, dz) — (dz, -dx)
    // in this frame (x east, z south) — has its traffic heading along (dx, dz)
    const lx = n.dz, lz = -n.dx;
    const sameSide = lx * px + lz * pz > 0;
    const heading = sameSide ? Math.atan2(n.dx, n.dz) : Math.atan2(-n.dx, -n.dz);
    // as near the kerb as the roadway goes (never up on the footpath, where a car can't follow)
    for (const off of [Math.min(3.2, half - 1.2), 2.4, 1.8]) {
      const x2 = n.x + px * off, z2 = n.z + pz * off;
      if (off > 0 && isLand(x2, z2) && !blockAt(x2, z2)) return { x: x2, z: z2, heading };
    }
    return road(x, z);
  }

  return { ground, clear, findClear, road, kerb, kerbLane };
}

export { createPlaces };
