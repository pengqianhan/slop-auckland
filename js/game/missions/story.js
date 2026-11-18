import { MOTORWAYS } from '../../city-config.js';
import { terrainHeight } from '../../terrain.js';
import { densify } from './driver.js';

// The story: "Meter Running" — ten jobs for a washed-up cabbie who owes Aunty Mere for his taxi, and finds himself
// between Dougie "Two Flats" (a Viaduct hustler with a catamaran called Unpaid Invoice) and the Gull, who runs the
// wharves. Rising stakes, from repossessing a ute in Ponsonby to shunting the Gull's cash van off Quay Street. A caper:
// cars, chases, a cricket bat and the police's handcuffs, nobody shot at (the only weapons are fists and the bat).
// Positions are world metres (x east, z south, the Sky Tower at 0, 0), snapped to valid ground when a mission
// starts: { kerb } a footpath, { lane } a street's parking lane, { road } a traffic lane, { open } clear ground.

const MERE = 'Aunty Mere';
const DOUGIE = 'Dougie';
const JASE = 'Jase';
const GULL = 'The Gull';

// Places
const AT = {
  queenSt: { kerb: [318, 30] }, // Queen St by Victoria St
  ponsonbyUte: { lane: [-1461, 624], face: [-1420, 760] }, // Ponsonby Rd
  meresYard: { lane: [-610, 262] }, // Union St, Freemans Bay: "Mere's Motor Finance"
  viaduct: { kerb: [-204, -449] },
  viaductBoat: { lane: [-128, -546] }, // by the Viaduct basin
  britomart: { kerb: [456, -471] },
  newmarket: { kerb: [1383, 2290] },
  vanStart: { lane: [1419, 2200], face: [1430, 2100] }, // Broadway, facing north
  domainDrop: { road: [1100, 1250] }, // the Domain, by the Wintergardens
  domainLookout: { kerb: [1125, 1215] },
  kroad: { kerb: [-258, 1038] },
  kroadPickup: { lane: [-300, 1031] }, // outside the Naval and Family
  freemansDrop: { lane: [-982, 562] }, // Freemans Bay
  westhaven: { kerb: [-1495, -858] },
  raceStart: { road: [-1560, -930], face: [-1738, -1062] },
  copShop: { lane: [-1060, -40] }, // College Hill
  bledisloe: { road: [1600, -700] }, // the container yard
  ferry: { kerb: [429, -610] },
  aotea: { kerb: [120, 470] },
  // Mechanics Bay: open ground with open sky (a clear-ground search from [2330, -160] found a spot under a deck,
  // where the helicopter was pushed off a roof edge every frame until it was a write-off)
  heliport: { raw: [2340, -140] },
  parnell: { kerb: [1749, 894] },
  accountant: { lane: [1716, 937], face: [1750, 1010] }, // Parnell Rd
  skytower: { kerb: [147, -77] },
  quaySt: { road: [640, -520] },
  ferryPier: { kerb: [420, -640] }
};

// The Harbour Bridge race: Westhaven Drive, up onto the motorway at Westhaven, over the arch to Northcote Point
const BRIDGE_CPS = [[-1755, -1080], [-1790, -1249], [-1797, -1371], [-1667, -1615], [-1461, -2003], [-1386, -2145], [-1198, -2498], [-1063, -2787]];
function bridgePath(ctx) {
  // rivals: the streets to the motorway's start, then the northbound carriageway's own line (traffic's lane
  // network stops at the motorway)
  const start = ctx.refs.r1 || { x: -1560, z: -930 };
  // Westhaven Drive to the on-ramp along the street's own line (traffic's lanes there run the other way only, so a
  // lane route goes round by Ponsonby: 4.8 km), then the northbound carriageway's own line to the finish
  // (from the first checkpoint the checkpoints themselves: the second is on the far carriageway, which traffic's map
  // joins to the near one only 400 m on, and from there the on-ramp onto the motorway at the third)
  const D = ctx.game.missions.driving;
  const [c0, c1, c2] = BRIDGE_CPS;
  const out = D.routeAny(start.x, start.z, c0[0], c0[1]) || [start.x, start.z, c0[0], c0[1]];
  out.push(c1[0], c1[1], c2[0], c2[1]);
  const nb = MOTORWAYS.find((m) => Math.hypot(m.pts[0].x + 1792, m.pts[0].z + 1379) < 5 && m.pts.length > 100);
  const fin = BRIDGE_CPS[BRIDGE_CPS.length - 1];
  if (nb) {
    for (const p of nb.pts) {
      out.push(p.x, p.z);
      // (the motorway goes on up the North Shore: the race ends at Northcote Point)
      if (Math.hypot(p.x - fin[0], p.z - fin[1]) < 25) break;
    }
  } else {
    for (const [x, z] of BRIDGE_CPS.slice(3)) out.push(x, z);
  }
  out.push(fin[0], fin[1]);
  return densify(out, 14);
}

// Maungawhau's summit: the highest ground near its mapped top (the region's terrain is coarse there)
function summit() {
  let best = { x: 197, z: 3135, y: -Infinity };
  for (let dx = -120; dx <= 120; dx += 8) {
    for (let dz = -120; dz <= 120; dz += 8) {
      const y = terrainHeight(197 + dx, 3135 + dz);
      if (y > best.y) best = { x: 197 + dx, z: 3135 + dz, y };
    }
  }
  return best;
}

const STORY = [
  // 1 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'meter-running',
    title: 'Meter Running',
    giver: MERE,
    blurb: 'Repossess a ute on Ponsonby Road for Aunty Mere. Not a scratch on it.',
    start: AT.queenSt,
    reward: 350,
    claim: ['ute'],
    intro: [
      [MERE, 'Kia ora, Taxi. You\'re three months behind on that cab. I could take the wheels. Or a kidney.'],
      [MERE, 'Or you do me a wee job. Flash boy on Ponsonby Road stopped paying for his ute.'],
      [MERE, 'Bring it to my yard on Union Street. Not a scratch on it, or the scratch comes out of you.']
    ],
    setup(ctx) {
      ctx.spawnAt('ute', 'pickup', AT.ponsonbyUte, { paint: 0xb3202a, label: 'Red Ute' });
      ctx.protect('ute', 'You wrote off the ute. Mere is adding it to your tab.');
    },
    steps: [
      { type: 'goto', at: (ctx) => ctx.refs.ute, radius: 30, text: 'Head to Ponsonby Road and find the red ute.', label: 'Red ute', beacon: false },
      {
        type: 'enter', ref: 'ute', text: 'Get in the red ute.',
        say: [['Ute Owner', 'OI! That\'s my ute! I was gonna pay! Next week! Probably!']]
      },
      {
        type: 'goto', at: AT.meresYard, mode: 'ute', vehicleLabel: 'ute', stop: true, minHealth: 55, radius: 5,
        text: 'Deliver the ute to Mere\'s yard. Keep it pretty.', label: 'Mere\'s yard',
        say: [[MERE, 'Lovely. Now drive it like it\'s your nan\'s.']]
      }
    ],
    outro: [
      [MERE, 'Look at that. Barely a ding. You might be useful after all.'],
      [MERE, 'Here\'s a bit for your trouble. Don\'t spend it on scratchies.']
    ]
  },

  // 2 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'flat-white-express',
    title: 'Flat White Express',
    giver: DOUGIE,
    requires: ['meter-running'],
    blurb: 'Collect Dougie\'s three parcels around Britomart and get them to his boat before the clock runs out.',
    start: AT.viaduct,
    reward: 500,
    call: [[DOUGIE, 'Mate! Dougie. Mere says you can drive. Come see me at the Viaduct, I\'ve got a job that pays in actual money.']],
    intro: [
      [DOUGIE, 'Legend! Three parcels, dropped round Britomart and up by Albert Park. Grab them before the harbour patrol clocks on.'],
      [DOUGIE, 'What\'s in them? Coffee beans. Very rare. Very… legal-adjacent.'],
      [DOUGIE, 'Then bring them to my boat. She\'s called Unpaid Invoice. Clock\'s ticking!']
    ],
    steps: [
      {
        type: 'collect', timer: 200, timerLabel: 'Parcels', // (a barging AI driver needs ~2:00 for the three by road)
        items: [{ lane: [600, -430] }, { lane: [742, -170] }, { lane: [560, 140] }],
        text: 'Collect Dougie\'s parcels.', label: 'Parcel'
      },
      {
        type: 'goto', at: AT.viaductBoat, mode: 'vehicle', radius: 6, stop: true, timer: 140, timerLabel: 'Delivery', // (1.6 km by road from the last parcel)
        text: 'Get the parcels to Dougie\'s boat at the Viaduct.', label: 'Unpaid Invoice',
        say: [[DOUGIE, 'Sweet as! Now leg it to the Viaduct before my flat white goes cold.']],
        modeHint: 'Get a car — those parcels are heavier than they look.'
      }
    ],
    outro: [
      [DOUGIE, 'Absolute scenes. You\'re hired. Unofficially. Officially, I\'ve never met you.']
    ]
  },

  // 3 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'van-life',
    title: 'Van Life',
    giver: DOUGIE,
    requires: ['flat-white-express'],
    blurb: 'Tail a van from Newmarket without being spotted and find out who\'s nicking Dougie\'s shipments.',
    start: AT.newmarket,
    reward: 700,
    call: [[DOUGIE, 'Someone\'s nicking my shipments. Meet me in Newmarket, there\'s a van I want followed.']],
    intro: [
      [DOUGIE, 'That white van on Broadway. It\'s been loading up my beans. Follow it.'],
      [DOUGIE, 'Don\'t get close. They spook easier than a Remuera dog walker.']
    ],
    setup(ctx) {
      const v = ctx.spawnAt('van', 'van', AT.vanStart, { paint: 0xeeeeee, label: 'White Van', locked: true });
      if (v) ctx.protect('van', 'You wrecked the van. Hard to tail a write-off.');
    },
    steps: [
      { type: 'goto', at: 'van', radius: 60, mode: 'vehicle', text: 'Get a car and get eyes on the van on Broadway.', label: 'White van', beacon: false, modeHint: 'You\'ll want a car for this.' },
      {
        type: 'tail', ref: 'van', to: AT.domainDrop, speed: 12, near: 14, far: 115,
        text: 'Follow the van. Keep your distance.',
        say: [[DOUGIE, 'Hang back. Pretend you\'re looking for a park in Newmarket. So, forever.']],
        spottedText: 'They spotted you. Subtle as a seagull at a fish and chip shop.'
      },
      {
        type: 'goto', at: AT.domainLookout, mode: 'foot', radius: 4, hold: 4, holdText: 'Snapping photos…',
        text: 'They\'ve stopped. Get out and photograph the drop on foot.', label: 'Lookout',
        say: [[DOUGIE, 'The Domain? Classy. Get out and grab some photos. Zoom in on faces, not your thumb.']]
      }
    ],
    outro: [
      [DOUGIE, 'Those are the Gull\'s boys. I knew it. That bird\'s been circling my bins for years.']
    ]
  },

  // 4 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'k-road-shuffle',
    title: 'K Road Shuffle',
    giver: MERE,
    requires: ['van-life'],
    blurb: 'Pick up Mere\'s nephews on K Road, lose the cops, and drop them in Freemans Bay.',
    start: AT.kroad,
    reward: 1200,
    call: [[MERE, 'Taxi. My nephews need a ride. Meet me on K Road and don\'t ask questions.']],
    intro: [
      [MERE, 'My nephews have made a… withdrawal. From a pokies bar. Without a card.'],
      [MERE, 'The cops will be on them like gulls on a chip. Pick them up, lose the heat, drop them in Freemans Bay.']
    ],
    steps: [
      {
        type: 'goto', at: AT.kroadPickup, mode: 'vehicle', stop: true, hold: 1.5, holdText: 'The boys pile in…', radius: 6,
        text: 'Pick up the nephews outside the pub on K Road.', label: 'Nephews', modeHint: 'Get a car. They\'re not walking.'
      },
      {
        // (two stars, the fourth job in: three bring roadblocks and the helicopter, a cliff this early on)
        type: 'loseCops', wanted: 2, fallback: 30,
        text: 'Lose the cops. Out of their sight, or through a Spray \'n\' Pray.',
        say: [
          ['Nephew', 'GO GO GO! Why is there a meter running?!'],
          ['Other Nephew', 'Is that a kid\'s seat? Bro.'],
          [MERE, 'Lose the cops, love. And mind the boys\' good jackets.']
        ],
        onEnter: (ctx) => {
          const v = ctx.game.player.vehicle;
          if (v) ctx.adopt('car', v, true);
        }
      },
      {
        type: 'goto', at: AT.freemansDrop, mode: 'vehicle', stop: true, radius: 6,
        text: 'Drop the nephews in Freemans Bay.', label: 'Drop-off',
        onDone: (ctx) => {
          const v = ctx.game.player.vehicle;
          if (v) ctx.passengersOut(v, 2, 1.5);
        }
      }
    ],
    outro: [
      ['Nephew', 'Cheers, uncle. We\'ll never speak of this. Or pay for it.'],
      [MERE, 'Bit of a rush job, but they\'re home. Here\'s your cut.']
    ]
  },

  // 5 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'bridge-dash',
    title: 'Harbour Bridge Dash',
    giver: JASE,
    requires: ['van-life'],
    blurb: 'Race Jase and his mate over the Harbour Bridge to Northcote Point. First across wins.',
    start: AT.westhaven,
    reward: 1500,
    call: [[DOUGIE, 'Mate. I may have bet on you in a street race. Westhaven, tonight. Don\'t make me sell the boat.']],
    intro: [
      [JASE, 'Ay, it\'s the taxi guy! You reckon a cabbie can race? Over the bridge to Northcote Point.'],
      [JASE, 'First one across wins. Dougie bet a lot on you. Like, a lot. He looked sweaty.']
    ],
    setup(ctx) {
      const s = ctx.at(AT.raceStart);
      const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
      const lx = fz, lz = -fx; // (left of the heading)
      ctx.spawnVehicle('r1', 'sedan', s.x + lx * 2.6 - fx * 6, s.z + lz * 2.6 - fz * 6, s.heading, { paint: 0x18e0ff, label: 'Jase\'s Sedan' });
      ctx.spawnVehicle('r2', 'suv', s.x - fx * 14, s.z - fz * 14, s.heading, { paint: 0xff3fa4, label: 'Rival SUV' });
      ctx.vars.start = s;
    },
    steps: [
      {
        type: 'goto', at: (ctx) => ctx.vars.start, mode: 'vehicle', stop: true, radius: 7,
        text: 'Get a car and line up on Westhaven Drive.', label: 'Start line', modeHint: 'You\'ll need a car to race. Any car. Go borrow one.'
      },
      {
        type: 'race', points: BRIDGE_CPS, rivals: ['r1', 'r2'], path: bridgePath, rivalSpeed: 30, radius: 12, mustWin: true,
        text: 'Win the race to Northcote Point!',
        lostText: 'Jase beat you across. "Bro got cooked by a Corolla."'
      }
    ],
    outro: [
      [JASE, 'Nah, that was rigged. My spoiler fell off. It\'s mostly decorative.'],
      [DOUGIE, 'YES! I mean, I never doubted you. Here\'s your share. Of my share. Of the bet.']
    ]
  },

  // 6 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'blue-lights',
    title: 'Blue Lights Special',
    giver: DOUGIE,
    requires: ['k-road-shuffle', 'bridge-dash'],
    blurb: 'Steal a police car from College Hill and deliver it to the container yard.',
    start: AT.britomart,
    reward: 1800,
    claim: ['cop'],
    call: [[DOUGIE, 'Got a cheeky one. Britomart, the café with the tiny chairs. Bring your nerve.']],
    intro: [
      [DOUGIE, 'The Gull\'s mate on the container gate only waves through cop cars.'],
      [DOUGIE, 'So, borrow one from the station on College Hill. Bring it to the yard on Bledisloe Wharf.'],
      [DOUGIE, 'Try not to dent it. It\'s technically evidence.']
    ],
    setup(ctx) {
      ctx.spawnAt('cop', 'police', AT.copShop, { label: 'Police Car' });
      ctx.protect('cop', 'You wrecked the police car. That\'s… several crimes.');
    },
    steps: [
      { type: 'enter', ref: 'cop', text: 'Steal the police car outside the College Hill station.' },
      {
        type: 'loseCops', wanted: 2, mode: 'cop', vehicle: 'cop', vehicleLabel: 'police car', fallback: 20,
        text: 'They noticed. Lose the cops.',
        say: [[DOUGIE, 'Mate, they\'ll notice that. Shake them before you come to the wharf.']]
      },
      {
        type: 'goto', at: AT.bledisloe, mode: 'cop', vehicleLabel: 'police car', stop: true, minHealth: 30, radius: 7,
        text: 'Deliver the police car to the container yard.', label: 'Container yard'
      }
    ],
    outro: [
      [DOUGIE, 'Beautiful. They\'ll be checking the Gull\'s containers for weeks. Paperwork is a weapon, mate.']
    ]
  },

  // 7 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'wharf-rats',
    title: 'Wharf Rats',
    giver: DOUGIE,
    requires: ['blue-lights'],
    blurb: 'Put the Gull\'s three vans out of action at the wharves, past his bat-swinging guards, and stop his foreman.',
    start: AT.ferry,
    reward: 2500,
    call: [[DOUGIE, 'The Gull nicked my whole shipment. Ferry Building. Come angry.']],
    intro: [
      [DOUGIE, 'The Gull\'s got three vans down the wharves full of my imported goods. Well, his goods now.'],
      [DOUGIE, 'Cook their engines. Ram them, give them the bat, whatever. Nobody drinks my beans.']
    ],
    setup(ctx) {
      // (open wharf, reachable on foot and by car from every side: the first spots wedged a van between a shed and
      // the water, where neither the player's car nor their bat could get at it)
      const spots = [[1330, -480], [1660, -420], [1450, -630]];
      spots.forEach(([x, z], i) => {
        const p = ctx.at({ open: [x, z], clearance: 3.2, within: 50 });
        // (50: two good rams, or eight swings of the bat — three vans inside four minutes, guards in the way)
        ctx.spawnVehicle(`van${i}`, 'van', p.x, p.z, (i * 1.7) % (Math.PI * 2), { paint: 0x3a3f46, label: 'Gull Van', locked: true, health: 50 });
        // (two to a van, cricket bats; one of the middle van's pair fights with his fists)
        for (let g = 0; g < 2; g++) ctx.target(`guard${i}${g}`, p.x + (g ? 4 : -4), p.z + 3, { weapon: i === 1 && g === 1 ? 'fist' : 'bat', radius: 6 });
      });
      // a bat of Dougie's, and his old cricket pads
      ctx.giveWeapon('bat');
      ctx.game.player.addArmor?.(60);
    },
    steps: [
      {
        type: 'goto', at: { road: [1400, -400] }, radius: 25, text: 'Head to the wharves.', label: 'The wharves',
        say: [[DOUGIE, 'There\'s a cricket bat under your seat, and my old pads. Don\'t ask where they\'ve been.']]
      },
      {
        type: 'destroy', refs: ['van0', 'van1', 'van2'], timer: 240, timerLabel: 'Before the Gull ships out',
        text: 'Wreck the Gull\'s vans: ram them or give them the bat.', label: 'Gull van',
        say: [[DOUGIE, 'Once the engine\'s cooked they\'re going nowhere. Mind his lads: they play for the Wharf XI.']]
      },
      {
        type: 'eliminate', refs: ['foreman'], stopTimer: true, escape: { x: 1000, z: -330, radius: 25, text: 'The foreman made the gate with the manifest. The Gull will know it was you.' },
        text: 'The Gull\'s foreman is legging it with the manifest. Lay him out before he reaches the gate.', label: 'Foreman',
        say: [[DOUGIE, 'See the bloke in the hi-vis legging it? That\'s the Gull\'s foreman. He\'s got the manifest. Stop him!']],
        onEnter(ctx) {
          // he comes out of the shed by the last van and runs for the Quay Street gate (no fight in him: he just runs)
          const v = ctx.refs.van2 || ctx.refs.van0;
          const t = ctx.target('foreman', v.x + 6, v.z + 6, { weapon: 'fist', hostile: false, pace: 'run', runSpeed: 4.4, health: 90, radius: 4 });
          t.enemy?.goto?.(1000, -330);
        }
      },
      { type: 'loseCops', fallback: 1, text: 'Get clear of the wharves. Lose any heat.' }
    ],
    outro: [
      [DOUGIE, 'Hear that? That\'s the Gull\'s whole supply chain having a little lie-down.'],
      [GULL, 'SQUAWK. You\'ve made an enemy, cabbie. I never forget a face. Or a chip.']
    ]
  },

  // 8 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'maungawhau-uplift',
    title: 'Maungawhau Uplift',
    giver: DOUGIE,
    requires: ['wharf-rats'],
    blurb: 'Fly the helicopter from Aotea Square to the summit of Maungawhau and get Dougie off the mountain.',
    start: AT.aotea,
    reward: 2200,
    call: [[DOUGIE, 'MATE. Help. Aotea Square, there\'s a chopper. Please tell me you can fly.']],
    intro: [
      [DOUGIE, 'The Gull\'s lot chased me up Mt Eden. I\'m hiding behind a tour group.'],
      [DOUGIE, 'Take the chopper on Aotea Square. You drive a cab. Same thing, just more up.']
    ],
    setup(ctx) {
      const heli = ctx.game.vehicles.heroes.helicopter;
      if (heli) {
        ctx.adopt('heli', heli, true);
        // (wrecked earlier and waiting to come home, left somewhere else, or knocked about: back on the pad, repaired,
        // as the job says — unless the player is sitting in it)
        const home = heli.home;
        const away = home && Math.hypot(heli.x - home.x, heli.z - home.z) > 40;
        if (ctx.game.player.vehicle !== heli && (heli.hidden || heli.state !== 'ok' || heli.health < 70 || away)) ctx.game.vehicles.remove(heli);
      }
      ctx.vars.summit = summit();
    },
    steps: [
      { type: 'enter', ref: 'heli', text: 'Get in the helicopter on Aotea Square.' },
      {
        type: 'goto', at: (ctx) => ctx.vars.summit, mode: 'helicopter', land: true, hold: 3, holdText: 'Dougie scrambles aboard…', radius: 30,
        timer: 150, timerLabel: 'Dougie',
        text: 'Fly to the summit of Maungawhau / Mt Eden and land.', label: 'Maungawhau',
        say: [[DOUGIE, 'Hurry! A tourist just asked me to take their photo. I\'m losing my nerve.']]
      },
      {
        type: 'goto', at: AT.heliport, mode: 'helicopter', land: true, radius: 22, stopTimer: true,
        text: 'Fly Dougie to the Mechanics Bay heliport.', label: 'Heliport',
        say: [[DOUGIE, 'GO! Mechanics Bay heliport. And mind the cows. Are there cows? There\'s always cows.']]
      }
    ],
    outro: [
      [DOUGIE, 'I\'ll never complain about Auckland traffic again. That\'s a lie, but it\'s a nice one.']
    ]
  },

  // 9 ---------------------------------------------------------------------------------------------------------------
  {
    id: 'ledger-domain',
    title: 'Ledger Domain',
    giver: MERE,
    requires: ['maungawhau-uplift'],
    blurb: 'Run the Gull\'s accountant off the road in Parnell and bring Mere his ledger.',
    start: AT.parnell,
    reward: 3000,
    call: [[MERE, 'Taxi, love. Come to Parnell. We\'re going to do some accounting.']],
    intro: [
      [MERE, 'The Gull\'s accountant keeps his books in his car. Like an animal. Flash SUV, Parnell Road.'],
      [MERE, 'Run him off the road and bring me that ledger. Gently. With your car.']
    ],
    setup(ctx) {
      ctx.spawnAt('suv', 'suv', AT.accountant, { paint: 0x1d2a3a, label: 'Accountant\'s SUV', locked: true });
    },
    steps: [
      { type: 'goto', at: 'suv', radius: 45, mode: 'vehicle', text: 'Find the accountant\'s SUV on Parnell Road.', label: 'Accountant', beacon: false, modeHint: 'Get a car. A sturdy one.' },
      {
        type: 'chase', ref: 'suv', until: 25, speed: 23,
        text: 'Ram the accountant off the road!',
        say: [['Accountant', 'I\'m just the numbers guy! I don\'t even like boats!']]
      },
      {
        type: 'collect', items: (ctx) => {
          const v = ctx.refs.suv;
          ctx.game.vehicles.setControls(v, null);
          // (he stamps on the brake, jumps out the driver's side and flings the ledger clear of the car)
          v.entity.speed *= 0.2;
          ctx.passengersOut(v, 1, 8);
          const s = Math.sin(v.heading), c = Math.cos(v.heading);
          return [{ open: [v.x - c * 4.5, v.z + s * 4.5], clearance: 0.6 }];
        },
        text: 'Grab the ledger.', label: 'Ledger',
        say: [['Accountant', 'Take it! Take it! I was going to retire to Waiheke!']]
      },
      { type: 'goto', at: AT.meresYard, radius: 6, text: 'Bring the ledger to Mere\'s yard.', label: 'Mere\'s yard' }
    ],
    outro: [
      [MERE, 'Ooh. Columns. I love a column. With this, the Gull is done.']
    ]
  },

  // 10 --------------------------------------------------------------------------------------------------------------
  {
    id: 'last-ferry',
    title: 'Last Ferry',
    giver: MERE,
    requires: ['ledger-domain'],
    blurb: 'Shunt the Gull\'s cash van off Quay Street, grab the money, and make the last ferry with half the force after you.',
    start: AT.skytower,
    reward: 10000,
    call: [[MERE, 'This is it, Taxi. Meet me under the Sky Tower. Bring your good driving.']],
    intro: [
      [MERE, 'The Gull\'s moving everything tonight. Cash van, two escorts, out of the port and along Quay Street.'],
      [DOUGIE, 'Stop the van, grab the cash, catch the last ferry. Simple. Like me.'],
      [MERE, 'Do this and your debt\'s paid. And then some.']
    ],
    setup(ctx) {
      // (Quay Street west of the port, heading west: from [1500, -330] the lanes run east, and the convoy went 600 m the
      // wrong way and round before it ever came past the player — two and a half minutes of waiting)
      ctx.vars.convoyStart = ctx.at({ road: [900, -430], face: [640, -520] });
    },
    steps: [
      {
        type: 'goto', at: AT.quaySt, mode: 'vehicle', radius: 14, text: 'Get a car and wait on Quay Street.', label: 'Quay Street', modeHint: 'Get a car. Something with a bumper.',
        onDone(ctx) {
          // the convoy rolls out of the port
          const s = ctx.vars.convoyStart;
          const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
          const lead = ctx.spawnVehicle('lead', 'suv', s.x + fx * 12, s.z + fz * 12, s.heading, { paint: 0x111111, label: 'Escort', locked: true });
          // (70: a van is heavy, so a ram does it less harm than it does the rammer; three or four good shunts)
          const van = ctx.spawnVehicle('van', 'van', s.x, s.z, s.heading, { paint: 0x2b2f35, label: 'Cash Van', locked: true, health: 70 });
          const tail = ctx.spawnVehicle('tail', 'suv', s.x - fx * 12, s.z - fz * 12, s.heading, { paint: 0x111111, label: 'Escort', locked: true });
          const dest = ctx.at({ road: [-1495, -855] });
          const path = van ? ctx.routeTo(van, dest) : null;
          if (path) {
            for (const [v, sp] of [[lead, 13], [van, 12], [tail, 12.5]]) {
              if (!v) continue;
              // (the escorts barge and ram whoever gets in the way, the player included; the van keeps to its lane)
              ctx.drive(v, { points: ctx.routeTo(v, dest) || path, speed: sp, barge: v !== van, ram: v !== van });
            }
          }
        }
      },
      {
        type: 'destroy', refs: ['van'], escapeRef: 'van', escapeText: 'The convoy got away to the motorway.',
        text: 'Stop the cash van! Ram it until the engine gives out.',
        say: [[MERE, 'There they are. The van in the middle. Shunt it till it stalls, and mind the escorts.']]
      },
      {
        type: 'collect', kind: 'package', label: 'Cash bag',
        items: (ctx) => {
          const v = ctx.refs.van;
          const pts = [];
          for (let i = 0; i < 3; i++) pts.push({ open: [v.x + Math.cos(i * 2.1) * 4, v.z + Math.sin(i * 2.1) * 4], clearance: 0.5 });
          return pts;
        },
        text: 'Grab the cash bags.',
        say: [[MERE, 'Grab the bags, love! Quick!']]
      },
      {
        // four stars: cars ramming, boxing in, roadblocks, the helicopter — and nobody firing a shot: stay out of
        // the handcuffs until the boat is in (kept at three stars or more: the whole force is out tonight)
        type: 'survive', seconds: 60, wanted: 4, keepWanted: 3, timerLabel: 'Ferry due',
        text: 'The Gull called in a favour. Stay out of handcuffs till the ferry\'s in!',
        say: [[GULL, 'SQUAWK! You\'ve ruffled the wrong feathers, cabbie! Every cop in town is coming for you!']]
      },
      {
        type: 'goto', at: AT.ferryPier, radius: 6, mode: 'foot', timer: 150, timerLabel: 'Last ferry',
        text: 'The ferry\'s in! Get to the Ferry Building and on board, on foot, before the cops grab you.', label: 'Last ferry',
        modeHint: 'Ditch the car: it\'s foot passengers only.',
        say: [[DOUGIE, 'Ferry Building, quick! The last boat waits for no one. Except me. I\'m on it.']]
      },
      // (on the ferry and away: the heat stays on the wharf)
      { type: 'wanted', level: 0 }
    ],
    outro: [
      [MERE, 'Debt\'s paid, Taxi. And then some. Go on. Have a holiday.'],
      [DOUGIE, 'See you on the island, legend. First flat white\'s on you.'],
      [GULL, 'squawk…']
    ]
  }
];

export { STORY };
