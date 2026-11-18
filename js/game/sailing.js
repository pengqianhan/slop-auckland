import { WIND, createSailboatEntity, poseSailboat, hullClear, sailPolar, SAILBOAT_PAINTS } from '../sailboat.js';
import { LANDINGS, landingAt } from '../city-config.js';

// The City of Sails: the wind over the Waitematā, the boats out sailing on it, and the way across to Devonport.
//   - WIND (js/sailboat.js) backs and veers slowly about the afternoon north-easterly and freshens and eases;
//   - a dozen yachts sail loops of the harbour (the routes below are open water all the way: checked against the
//     coastline), slower close to the wind and quicker across it; they give the player's boat a wide berth, and
//     bump off it if it's sailed into them;
//   - the radar shows the sailboats' berths at Queens Wharf and the landing at Devonport; the first time aboard the
//     player gets the gist of sailing, and coming up to Devonport, where to step ashore.
// game.sailing = { wind: WIND, fleet: [{ entity, route, wp }] }

const TOP = 26 * 0.4; // the fleet's cruising speed on a reach (m/s): they're out for a sail, not racing
const ROUTES = [
  // round the harbour: the city, across to Devonport, out past North Head's shoal to the east and back
  [[600, -1150], [2000, -1600], [3900, -1650], [5200, -1200], [3000, -1150]],
  // the western harbour: under the bridge's approaches, Shoal Bay's mouth, Stanley Bay
  [[-300, -1450], [-1000, -1650], [-300, -2000], [700, -2150], [1100, -1600]],
  // Devonport, round North Head and back
  [[2600, -1450], [4300, -1600], [5000, -2100], [4900, -2600], [5600, -1700], [3500, -1300]],
  // the inner harbour off the ferry terminal
  [[1000, -1300], [1800, -1250], [1500, -1550]]
];
const PER_ROUTE = [4, 3, 3, 2];
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function compass(dir) {
  // (dir: the heading the wind blows from; heading 0 is south, the world's -z is north)
  const bearing = ((Math.atan2(Math.sin(dir), -Math.cos(dir)) * 180) / Math.PI + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(bearing / 45) % 8];
}

function registerSailing(game) {
  const scene = game.engine.scene;
  const baseDir = WIND.dir;

  // ---- the fleet ----------------------------------------------------------------------------------------------------
  const fleet = [];
  let paint = 1;
  ROUTES.forEach((route, r) => {
    const legs = route.map((a, i) => {
      const b = route[(i + 1) % route.length];
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    });
    const total = legs.reduce((s, l) => s + l, 0);
    for (let k = 0; k < PER_ROUTE[r]; k++) {
      // spread along the loop
      let along = (total * (k + 0.37 * r)) / PER_ROUTE[r];
      along %= total;
      let i = 0;
      while (along > legs[i]) along -= legs[i++];
      const a = route[i], b = route[(i + 1) % route.length];
      const t = along / legs[i];
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const e = createSailboatEntity({ paint: paint++ % SAILBOAT_PAINTS.length, x, z, heading, castShadow: false });
      e.sailsUp = true;
      e.sailShow = 1;
      e.speed = TOP * 0.6;
      scene.add(e.mesh);
      fleet.push({ entity: e, route, wp: (i + 1) % route.length, pace: 0.85 + ((k * 37 + r * 11) % 30) / 100 });
    }
  });

  // the boat the player is sailing (or null)
  const playerBoat = () => {
    const v = game.vehicles?.current;
    return v && v.mode === 'boat' ? v.entity : null;
  };

  // Hulls as three circles along their length: the push to separate two (into out), or false
  const sep = { x: 0, z: 0, depth: 0 };
  function hullsTouch(a, b) {
    const sa = Math.sin(a.heading), ca = Math.cos(a.heading), sb = Math.sin(b.heading), cb = Math.cos(b.heading);
    let best = 0;
    for (const oa of [-3, 0, 3]) {
      for (const ob of [-3, 0, 3]) {
        const dx = a.position.x + sa * oa - (b.position.x + sb * ob), dz = a.position.z + ca * oa - (b.position.z + cb * ob);
        const d = Math.hypot(dx, dz);
        const depth = 3.1 - d;
        if (depth > best) {
          best = depth;
          sep.x = d > 1e-3 ? dx / d : 1;
          sep.z = d > 1e-3 ? dz / d : 0;
        }
      }
    }
    sep.depth = best;
    return best > 0;
  }

  function sailFleet(dt, time) {
    const me = playerBoat();
    for (const n of fleet) {
      const e = n.entity;
      const [tx, tz] = n.route[n.wp];
      let dx = tx - e.position.x, dz = tz - e.position.z;
      if (Math.hypot(dx, dz) < 70) {
        n.wp = (n.wp + 1) % n.route.length;
        continue;
      }
      let desired = Math.atan2(dx, dz);
      // give the player's boat a wide berth: bear away from it when it's close ahead
      if (me) {
        const ox = me.position.x - e.position.x, oz = me.position.z - e.position.z;
        const d = Math.hypot(ox, oz);
        if (d < 60) {
          const rel = wrap(Math.atan2(ox, oz) - e.heading);
          if (Math.abs(rel) < 1.2) desired = e.heading - Math.sign(rel || 1) * 0.9;
        }
      }
      const diff = wrap(desired - e.heading);
      const turn = clamp(diff * 0.5, -0.3, 0.3);
      e.turnRate = turn;
      e.heading += turn * dt;
      const f = Math.max(0.45, sailPolar(wrap(e.heading - WIND.dir)));
      const target = TOP * WIND.strength * f * n.pace;
      e.speed += (target - e.speed) * (1 - Math.exp(-dt * 0.3));
      e.prevX = e.position.x;
      e.prevZ = e.position.z;
      e.position.x += Math.sin(e.heading) * e.speed * dt;
      e.position.z += Math.cos(e.heading) * e.speed * dt;
      e.power = f * 0.85 * WIND.strength;
      // into the player's boat: both knocked off their way, the player's boat shoved clear (if there's water there)
      if (me && hullsTouch(me, e)) {
        const px = me.position.x + sep.x * sep.depth, pz = me.position.z + sep.z * sep.depth;
        if (hullClear(px, pz, me.heading)) {
          me.position.x = px;
          me.position.z = pz;
        } else {
          e.position.x -= sep.x * sep.depth;
          e.position.z -= sep.z * sep.depth;
        }
        const closing = Math.abs(me.speed) + e.speed * 0.5;
        me.speed *= 0.55;
        e.speed *= 0.5;
        if (closing > 2) game.camera?.shake(Math.min(0.35, closing * 0.03));
      }
      poseSailboat(e, dt, time);
    }
  }

  // ---- the wind -----------------------------------------------------------------------------------------------------
  function blow(time) {
    WIND.dir = baseDir + Math.sin(time / 170) * 0.35 + Math.sin(time / 53 + 1.3) * 0.12;
    WIND.strength = clamp(1 + Math.sin(time / 90) * 0.14 + Math.sin(time / 23 + 0.7) * 0.06, 0.7, 1.3);
  }

  // ---- the radar: the berths and the landing --------------------------------------------------------------------------
  const blips = [];
  if (game.blips) {
    const berths = game.vehicles?.heroes?.boats || [];
    if (berths[0]) blips.push(game.blips.add({ x: berths[1]?.home.x ?? berths[0].home.x, z: berths[1]?.home.z ?? berths[0].home.z, kind: 'vehicle', label: 'Sailboats · Queens Wharf' }));
    for (const l of LANDINGS) blips.push(game.blips.add({ x: l.berth.x, z: l.berth.z, kind: 'vehicle', label: `${l.name} landing` }));
  }

  // ---- hints ----------------------------------------------------------------------------------------------------------
  const told = { aboard: false, landing: new Set() };
  const help = (text, s) => (typeof game.ui?.help === 'function' ? game.ui.help(text, s) : game.ui?.toast?.(text, s));
  game.on('player:mode', ({ mode }) => {
    if (mode !== 'boat' || told.aboard) return;
    told.aboard = true;
    help(`Under sail. W trims her in, S motors astern, A / D the tiller. Wind from the ${compass(WIND.dir)}: fastest across it, no good straight into it. Devonport is across the harbour to the north-east.`, 9);
  });
  let lastLanding = null;
  function landings() {
    const p = game.player?.position;
    if (!p) return;
    const l = landingAt(p.x, p.z);
    if (l !== lastLanding) {
      lastLanding = l;
      if (l && playerBoat() && !told.landing.has(l.id)) {
        told.landing.add(l.id);
        help(`${l.name}. Bring her alongside the seawall by the wharf and ${game.input?.label?.('enterExit') || 'F'} to step ashore.`, 7);
      }
    }
  }

  game.addSystem({
    name: 'sailing',
    order: 30,
    update: (dt, time) => {
      if (dt <= 0) return;
      blow(time);
      sailFleet(dt, time);
      if (game.frame % 15 === 0) landings();
    },
    dispose: () => {
      for (const n of fleet) scene.remove(n.entity.mesh);
      for (const b of blips) b.remove?.();
    }
  });

  game.sailing = { wind: WIND, fleet };
  return game.sailing;
}

export { registerSailing };
