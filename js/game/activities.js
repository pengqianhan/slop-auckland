// Side activities (engineer D):
//   Taxi fares — in any taxi, G (interact) goes on duty: a fare waits by the road (blip), stop beside them, drive them
//     where they're going against the meter; fare by distance, a tip for speed and for not crashing, a streak bonus
//     for fares in a row.
//   The export list — eight kinds of car wanted at the Captain Cook wharf crane; deliver one for cash (by its
//     condition), all eight for a bonus.
//   Street races — three checkpoint circuits with bronze / silver / gold times (missions of kind 'race').
//   Challenges — timed rampages: Bumper Cars, Wreck-reation and (with the weapons system) Howzat!, a cricket bat
//     against the traffic.
//   Golden kiwis — 30 hidden collectibles at real places round the city.
//   Pickups placed round the city — health, armour, cash, a couple of cricket bats and bribe stars.
//   game.activities = { taxi, exports, collectibles, interrupt(), progress(), update }

const TAXI = { seek: [35, 140], dest: [380, 1200], base: 12, perKm: 32, speedPar: 8.5, slack: 22, streakBonus: 15, maxTip: 0.6 };
const PASSENGER_LINES = [
  ['Passenger', 'Take me somewhere. Anywhere. Actually, here\'s the address.'],
  ['Passenger', 'Is this one of those cabs where you have to talk? I\'ll pay extra not to.'],
  ['Passenger', 'Step on it! Actually, step on it gently. I\'ve just had a flat white.'],
  ['Passenger', 'Do you take card? No? Cool cool cool.'],
  ['Passenger', 'Last driver took me via Hamilton. Don\'t be that guy.'],
  ['Passenger', 'Is that a seagull in your glovebox? Never mind. Drive.'],
  ['Passenger', 'Sweet as, bro. Chur.'],
  ['Passenger', 'I\'m late for a meeting about being late. Go!']
];
const DROP_LINES = [
  ['Passenger', 'Cheers, driver. Five stars. Well, four. The smell.'],
  ['Passenger', 'Sweet as. Keep the change. There is no change.'],
  ['Passenger', 'That was terrifying. I\'ll be leaving a review.'],
  ['Passenger', 'Chur! You\'re better than the bus. Lower bar, but still.']
];

const EXPORTS = [
  { id: 'sedan', label: 'Sedan', kind: 'sedan', police: false, value: 500 },
  { id: 'suv', label: 'SUV', kind: 'suv', police: false, value: 800 },
  { id: 'minivan', label: 'Minivan', kind: 'minivan', police: false, value: 600 },
  { id: 'pickup', label: 'Ute', kind: 'pickup', police: false, value: 700 },
  { id: 'van', label: 'Van', kind: 'van', police: false, value: 650 },
  { id: 'taxi', label: 'Taxi (not yours)', kind: 'taxi', police: false, value: 450, notHero: true },
  { id: 'police', label: 'Police Car', kind: 'sedan', police: true, value: 1500 },
  { id: 'police-suv', label: 'Police SUV', kind: 'suv', police: true, value: 2000 }
];
const EXPORT_BONUS = 5000;
const EXPORT_AT = { open: [1144, -520], clearance: 3, within: 60 };

const RACES = [
  {
    id: 'race-queen', title: 'Queen Street Grand Prix', blurb: 'A lap of the city centre: Queen Street, Quay Street, back up Albert Street.',
    start: { road: [175, 520], face: [250, 300] },
    points: [[300, 150], [345, -200], [430, -520], [700, -430], [610, -150], [260, -330], [150, 80], [175, 470]]
  },
  {
    id: 'race-ponsonby', title: 'Ponsonby Pursuit', blurb: 'Ponsonby Road to Three Lamps and back by Victoria Park.',
    start: { road: [-1408, 760], face: [-1420, 500] },
    points: [[-1420, 400], [-1580, -60], [-1300, -260], [-1072, -66], [-800, -120], [-900, 300], [-1250, 520], [-1408, 760]]
  },
  {
    id: 'race-domain', title: 'Domain Drift', blurb: 'Parnell, round the Domain, down to Newmarket and back up.',
    start: { road: [1700, 980], face: [1640, 1200] },
    points: [[1600, 1300], [1400, 1550], [1360, 1900], [1383, 2250], [1150, 2100], [1000, 1750], [1100, 1200], [1500, 1000], [1700, 980]]
  }
];

const CHALLENGES = [
  {
    id: 'bumper-cars', title: 'Bumper Cars', blurb: 'Hit 15 different cars in 60 seconds.', start: { road: [1383, 2200] }, reward: 500,
    need: 15, seconds: 60, event: 'vehicle:damaged', mode: 'vehicle',
    // (a traffic car's view or another world vehicle, rammed by the player; the player's own car takes damage too)
    match: (e, game) => {
      const t = e.target;
      if (!e.byPlayer || e.kind !== 'collision' || !t || t === game.player.vehicle) return null;
      return t.type === 'traffic' ? `t${t.id}` : t.type === 'world' ? `w${t.id}` : null;
    }
  },
  {
    id: 'wreck-reation', title: 'Wreck-reation', blurb: 'Wreck 4 vehicles in 2 minutes.', start: { road: [1300, -300] }, reward: 800,
    need: 4, seconds: 120, event: 'vehicle:wrecked', mode: 'any',
    match: (e) => (e.byPlayer ? `x${e.target?.id ?? Math.random()}` : null)
  },
  {
    // (a borrowed bat if you have none, handed back after; any car that comes within reach counts once)
    id: 'howzat', title: 'Howzat!', blurb: 'Dent 8 different cars with a cricket bat in 75 seconds.', start: { kerb: [300, 150] }, reward: 1000,
    need: 8, seconds: 75, event: 'vehicle:damaged', mode: 'foot', weapon: 'bat',
    match: (e) => {
      const t = e.target;
      if (!e.byPlayer || e.kind !== 'melee' || !t) return null;
      return t.type === 'traffic' ? `t${t.id}` : t.type === 'world' ? `w${t.id}` : null;
    },
    enabled: (game) => !!game.weapons?.defs?.bat
  }
];

const KIWIS = [
  [35, -35], [468, 355], [680, 250], [88, 430], [-85, 826], [-180, 1003], [-307, 1116], [-726, -169], [-693, -990], [-422, -846],
  [-247, -873], [300, -1000], [400, -640], [500, -470], [746, -178], [1318, -140], [1202, 1171], [1401, 1300], [1060, 1305], [1880, 1260],
  [1749, 894], [1489, 2350], [1135, 2594], [121, 2634], [-854, 1165], [-1483, 667], [-1604, -120], [-1389, -349], [-1225, -1421], [-1820, -1405]
];
const KIWI_NAMES = [
  'Sky Tower', 'Albert Park rotunda', 'the Clock Tower', 'Aotea Square', 'Myers Park', 'St Kevins Arcade', 'Karanga-a-Hape station',
  'Victoria Park', 'Silo Park', 'Wynyard Pavilion', 'the Viaduct', 'the end of Princes Wharf', 'the Ferry Building', 'Te Komititanga',
  'Emily Place', 'Spark Arena', 'the Domain rotunda', 'the Museum', 'the Wintergardens', 'Holy Trinity', 'Parnell Village',
  'Newmarket station', 'Highwic', 'Tahaki Reserve', 'Western Park', 'the old Ponsonby fire station', 'Three Lamps',
  'Pompallier House', 'Westhaven Marina', 'the bridge climb'
];
const KIWI_REWARD = 100;
const KIWI_ALL = 25000;

// [kind, x, z, value (default: 50 health / armour, 1 bribe)]
const STATIC_PICKUPS = [
  ['health', 560, 140], ['health', -700, -120], ['health', 1150, 1200], ['health', -850, 1130], ['health', 640, 1250],
  ['health', 100, 2600], ['health', -1640, -60], ['health', 1700, 950], ['health', -500, -700], ['health', 1300, 2300],
  ['health', 1450, -420], ['health', 1060, 1310],
  ['armor', -300, 850], ['armor', 1260, -300], ['armor', -1100, -60], ['armor', 300, -850], ['armor', 900, 1900],
  ['armor', -420, 2090], ['armor', 1720, 1520],
  // (a little cash in odd corners: the climb up Maungawhau pays)
  ['cash', -230, 330, 60], ['cash', -650, -1000, 80], ['cash', 150, 3190, 250],
  ['bribe', -260, 1120], ['bribe', 730, -180], ['bribe', -1500, -880], ['bribe', 1200, 560], ['bribe', 1380, 2400], ['bribe', -620, 280]
];
// cricket bats lying about (the only weapon there is: game.weapons refuses anything else)
const BAT_PICKUPS = [[-1500, 700], [1150, -380]];
const RESPAWN = { health: 90, armor: 120, cash: 300, weapon: 180, bribe: 300 };

function createActivities(game, { places, markers, missions, dialogue }) {
  const say = (who, text) => dialogue.say(who, text);
  const notice = (t, s) => markers.notice(t, s);
  const rand = (a) => a[Math.floor(Math.random() * a.length)];

  // ===================================================================================================================
  // TAXI FARES
  // ===================================================================================================================
  const taxi = {
    onDuty: false, phase: 'off', fare: null, dest: null, blip: null, beacon: null, timeLeft: 0, par: 0, dist: 0, hits: 0,
    streak: 0, seekIn: 0, outFor: 0, offered: false, earned: 0
  };
  const nearPeds = [];

  function taxiVehicle() {
    const v = game.player.vehicle;
    return v && v.kind === 'taxi' && !v.police && v.state !== 'wrecked' ? v : null;
  }

  function clearTaxiMarks() {
    taxi.blip?.remove();
    taxi.beacon?.remove();
    taxi.blip = taxi.beacon = null;
  }

  function setDuty(on, why = '') {
    if (on === taxi.onDuty) return;
    taxi.onDuty = on;
    clearTaxiMarks();
    if (taxi.fare != null && taxi.phase === 'ride') {
      // a passenger left in the cab gets out where they are
      const v = taxiVehicle();
      if (v) game.world.spawnFleeingPed(v.x + Math.cos(v.heading) * 1.8, v.z - Math.sin(v.heading) * 1.8, v.x, v.z, 2);
    }
    taxi.fare = null;
    taxi.dest = null;
    taxi.phase = on ? 'seek' : 'off';
    taxi.seekIn = 0.5;
    game.ui?.timer?.(null);
    game.emit('mission:timer', { seconds: null, label: '' });
    if (on) {
      notice('On duty. Find a fare.', 2.5);
      game.emit('taxi:duty', { on: true });
    } else {
      if (why) notice(why, 3);
      if (taxi.streak > 0) game.stats.best('taxiBestStreak', taxi.streak);
      taxi.streak = 0;
      game.emit('taxi:duty', { on: false });
      game.ui?.objective?.(null);
    }
  }

  function findFare(v) {
    const [rMin, rMax] = TAXI.seek;
    game.world.nearbyPeds(v.x, v.z, rMax, nearPeds);
    const s = Math.sin(v.heading), c = Math.cos(v.heading);
    let best = null, bestScore = -Infinity;
    for (const p of nearPeds) {
      if (p.free || p.fleeing) continue;
      const dx = p.x - v.x, dz = p.z - v.z;
      const d = Math.hypot(dx, dz);
      if (d < rMin) continue;
      // ahead of the cab, on the near side of the road
      const ahead = (dx * s + dz * c) / d;
      const score = ahead * 2 - d / rMax + Math.random() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  function updateTaxi(dt) {
    const v = taxiVehicle();
    // the offer, once per taxi ride
    if (v && !taxi.onDuty && !missions.isActive && !taxi.offered) {
      taxi.offered = true;
      notice(`${game.input.label('interact')} — Go on duty (taxi fares)`, 4);
    }
    if (!v && !taxi.onDuty) taxi.offered = false;
    if (v && !missions.isActive && game.state === 'playing' && game.input.pressed('interact') && !markers.list.some((m) => m.inside && m.prompt)) {
      setDuty(!taxi.onDuty, 'Off duty.');
      return;
    }
    if (!taxi.onDuty) return;
    if (!v) {
      taxi.outFor += dt;
      if (taxi.outFor > (taxi.phase === 'ride' ? 6 : 15)) setDuty(false, taxi.phase === 'ride' ? 'You left your passenger in the cab. They left. Off duty.' : 'Off duty.');
      return;
    }
    taxi.outFor = 0;
    if (!(dt > 0)) return;
    if (taxi.phase === 'seek') {
      if ((taxi.seekIn -= dt) > 0) return;
      taxi.seekIn = 1.5;
      const p = findFare(v);
      if (!p) return;
      taxi.fare = p.id;
      taxi.phase = 'pickup';
      taxi.blip = game.blips.add({ target: p, kind: 'friend', label: 'Fare', route: true });
      taxi.beacon = game.fx.beacon(p.x, p.z, 0x5ec8ff, { radius: 1.2, height: 6 });
      game.ui?.objective?.('Pick up the fare (stop beside them).');
      return;
    }
    if (taxi.phase === 'pickup') {
      const p = game.world.peds[taxi.fare];
      if (!p || !p.active || !p.alive || p.fleeing) {
        clearTaxiMarks();
        taxi.phase = 'seek';
        taxi.seekIn = 1;
        notice(p && !p.alive ? 'You were supposed to pick them up, not run them down.' : 'The fare changed their mind.', 2.5);
        if (p && !p.alive) setDuty(false, 'Off duty. The company would like a word.');
        return;
      }
      taxi.beacon?.set(p.x, p.z);
      const d = Math.hypot(p.x - v.x, p.z - v.z);
      if (d > 230) {
        clearTaxiMarks();
        taxi.phase = 'seek';
        return;
      }
      if (d < 9.5 && Math.abs(v.speed) < 2.5) {
        // in they get
        p.record.placed = false;
        clearTaxiMarks();
        const q = game.world.randomRoadPoint(v.x, v.z, TAXI.dest[0], TAXI.dest[1]);
        const k = q ? places.kerb(q.x, q.z) : places.kerb(v.x + 400, v.z);
        taxi.dest = k;
        taxi.dist = Math.hypot(k.x - v.x, k.z - v.z) * 1.3;
        taxi.par = taxi.dist / TAXI.speedPar + TAXI.slack;
        taxi.timeLeft = taxi.par;
        taxi.hits = 0;
        taxi.phase = 'ride';
        taxi.blip = game.blips.add({ x: k.x, z: k.z, kind: 'destination', label: 'Drop-off', route: true });
        taxi.beacon = game.fx.beacon(k.x, k.z, 0xffd23f, { radius: 4, height: 24 });
        const line = rand(PASSENGER_LINES);
        say(line[0], line[1]);
        game.ui?.objective?.('Take the passenger to their destination.');
        game.emit('taxi:pickup', { x: v.x, z: v.z });
      }
      return;
    }
    if (taxi.phase === 'ride') {
      taxi.timeLeft -= dt;
      game.ui?.timer?.(Math.max(0, Math.ceil(taxi.timeLeft)), 'Fare');
      if (taxi.timeLeft <= 0) {
        game.world.spawnFleeingPed(v.x + Math.cos(v.heading) * 1.8, v.z - Math.sin(v.heading) * 1.8, v.x, v.z, 3);
        say('Passenger', 'Forget it, I\'ll walk. And I\'m not paying!');
        clearTaxiMarks();
        game.ui?.timer?.(null);
        taxi.phase = 'seek';
        taxi.seekIn = 3;
        if (taxi.streak > 0) game.stats.best('taxiBestStreak', taxi.streak);
        taxi.streak = 0;
        return;
      }
      const k = taxi.dest;
      const d = Math.hypot(k.x - v.x, k.z - v.z);
      if (d < 11 && Math.abs(v.speed) < 2.5) {
        const fare = Math.round(TAXI.base + (taxi.dist / 1000) * TAXI.perKm);
        const quick = Math.max(0, taxi.timeLeft / taxi.par);
        const smooth = Math.max(0, 1 - taxi.hits / 4);
        const tip = Math.round(fare * TAXI.maxTip * (quick * 0.5 + smooth * 0.5));
        taxi.streak++;
        const bonus = (taxi.streak - 1) * TAXI.streakBonus;
        const total = fare + tip + bonus;
        game.player.addMoney(total, 'taxi');
        game.stats.add('taxiFares');
        game.stats.best('taxiBestStreak', taxi.streak);
        taxi.earned += total;
        const s = Math.sin(v.heading), c = Math.cos(v.heading);
        game.world.spawnFleeingPed(v.x + c * 1.9, v.z - s * 1.9, v.x - c, v.z + s, 0.4);
        const line = rand(DROP_LINES);
        say(line[0], line[1]);
        notice(`Fare $${fare} · tip $${tip}${bonus ? ` · streak x${taxi.streak} $${bonus}` : ''}`, 3.5);
        game.emit('taxi:fare', { fare, tip, bonus, total, streak: taxi.streak });
        clearTaxiMarks();
        game.ui?.timer?.(null);
        game.ui?.objective?.('Find another fare.');
        taxi.phase = 'seek';
        taxi.seekIn = 2;
      }
    }
  }
  // bumps on the way count against the tip
  game.on('vehicle:damaged', (e) => {
    if (taxi.phase === 'ride' && e.target === game.player.vehicle && e.amount > 3) taxi.hits++;
  });

  // ===================================================================================================================
  // EXPORT LIST
  // ===================================================================================================================
  const exported = new Set();
  const exportAt = missions.resolve(EXPORT_AT);
  let exportBusy = false;
  const exportMarker = markers.add({
    x: exportAt.x, z: exportAt.z, radius: 4.5, color: 0x5ec8ff, kind: 'vehicle', label: 'Export crane', short: false, when: 'vehicle', maxSpeed: 4,
    enabled: () => exported.size < EXPORTS.length && !missions.isActive,
    onEnter: () => tryExport()
  });
  void exportMarker;

  function wantedEntry(v) {
    return EXPORTS.find((x) => !exported.has(x.id) && x.kind === v.kind && x.police === !!v.police && !(x.notHero && v.hero));
  }

  function listText() {
    return EXPORTS.filter((x) => !exported.has(x.id)).map((x) => x.label).join(', ');
  }

  function tryExport() {
    const v = game.player.vehicle;
    if (!v || exportBusy) return;
    const entry = wantedEntry(v);
    if (!entry) {
      notice(EXPORTS.some((x) => x.kind === v.kind && x.police === !!v.police && exported.has(x.id)) ? 'Already shipped one of those. Still wanted: ' + listText() : `Not on the list. Wanted: ${listText()}`, 5);
      return;
    }
    if (game.wanted?.level > 0) {
      notice('The crane driver won\'t touch it with the cops on you.', 3);
      return;
    }
    exportBusy = true;
    const pay = Math.round(entry.value * Math.max(0.25, v.health / 100));
    game.vehicles.exit();
    exported.add(entry.id);
    setTimeout(() => {
      exportBusy = false;
      if (game.player.vehicle !== v) game.vehicles.remove(v);
    }, 1200);
    game.player.addMoney(pay, 'export');
    game.stats.add('exports');
    game.emit('export:delivered', { id: entry.id, label: entry.label, pay });
    if (exported.size === EXPORTS.length) {
      game.player.addMoney(EXPORT_BONUS, 'export');
      notice(`Export list complete! Bonus $${EXPORT_BONUS.toLocaleString('en-NZ')}`, 5);
      game.ui?.notify?.({ title: 'Export list', text: 'All eight shipped. The crane driver salutes you.', icon: 'cash' });
    } else {
      notice(`${entry.label} shipped: $${pay}. Still wanted: ${listText()}`, 5);
    }
    game.save.save();
  }

  // ===================================================================================================================
  // RACES (missions of kind 'race': the mission framework runs them)
  // ===================================================================================================================
  for (const r of RACES) {
    const def = {
      id: r.id, title: r.title, giver: 'Street race', kind: 'race', blurb: r.blurb, start: r.start, repeatable: true, when: 'vehicle',
      reward: 0, requires: ['meter-running'],
      setup(ctx) {
        if (!r.medals) {
          // medal times from the course's length: the streets between the checkpoints either way (one-ways don't
          // stop a racer), or the crow's line plus a third where that's longer (a racer cuts across the Domain's grass,
          // the street map goes round); then the speeds a mission AI driver averages through traffic (~15 m/s) for
          // gold, 12 for silver, 9 for bronze (bronze is the time limit: an average driver must make it)
          let crow = 0, road = 0;
          const pts = [missions.resolve(r.start), ...r.points.map((p) => missions.resolve({ road: p }))];
          for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            crow += Math.hypot(b.x - a.x, b.z - a.z);
            const leg = missions.driving?.routeAny?.(a.x, a.z, b.x, b.z);
            let l = 0;
            if (leg) for (let k = 2; k < leg.length; k += 2) l += Math.hypot(leg[k] - leg[k - 2], leg[k + 1] - leg[k - 1]);
            road += l || Math.hypot(b.x - a.x, b.z - a.z) * 1.33;
          }
          const len = Math.max(crow * 1.33, road * 0.85);
          r.length = len;
          r.medals = [Math.round(len / 15 + 6), Math.round(len / 12 + 10), Math.round(len / 9 + 16)];
          def.steps[0].medals = r.medals;
        }
        ctx.say('Race marshal', `${r.title}. Gold ${fmtTime(r.medals[0])}, silver ${fmtTime(r.medals[1])}, bronze ${fmtTime(r.medals[2])}.`);
      },
      steps: [{ type: 'race', points: r.points.map((p) => ({ road: p })), radius: 11, text: r.title, mode: 'vehicle' }],
      onPass(result) {
        const prev = missions.best[r.id] || null;
        const rank = { gold: 3, silver: 2, bronze: 1 };
        const better = !prev || (rank[result.medal] || 0) > (rank[prev.medal] || 0);
        const faster = !prev || result.time < prev.time;
        const paid = prev?.paid || [];
        // prize money: in full the first time a medal is won, a fifth after that
        const pay = { gold: 500, silver: 300, bronze: 150 }[result.medal] || 0;
        r.bonus = paid.includes(result.medal) ? Math.round(pay * 0.2) : pay;
        missions.best[r.id] = {
          time: Math.min(result.time, prev?.time ?? Infinity),
          medal: better ? result.medal : prev.medal,
          paid: paid.includes(result.medal) ? paid : [...paid, result.medal]
        };
        if (better) game.stats.add('racesWon', (rank[result.medal] || 0) - (rank[prev?.medal] || 0));
        notice(`${(result.medal || '').toUpperCase()} — ${fmtTime(result.time)}${faster && prev ? ' · new best!' : ''}`, 4);
      },
      bonus: () => r.bonus || 0
    };
    missions.register(def);
  }

  // ===================================================================================================================
  // CHALLENGES (rampages)
  // ===================================================================================================================
  for (const c of CHALLENGES) {
    const def = {
      id: c.id, title: c.title, giver: 'Challenge', kind: 'rampage', blurb: c.blurb, start: c.start, repeatable: true, reward: c.reward,
      requires: ['meter-running'], when: c.mode === 'foot' ? 'foot' : c.mode === 'vehicle' ? 'vehicle' : 'any',
      enabled: c.enabled ? () => c.enabled(game) : null,
      setup(ctx) {
        if (c.weapon) {
          ctx.vars.hadWeapon = !!game.weapons?.has?.(c.weapon);
          ctx.giveWeapon(c.weapon);
          game.weapons?.equip?.(c.weapon);
          ctx.track(() => {
            if (!ctx.vars.hadWeapon) game.weapons?.remove?.(c.weapon);
          });
        }
      },
      steps: [{
        enter(ctx, st) {
          st.seen = new Set();
          st.left = c.seconds;
          ctx.on(c.event, (e) => {
            const key = c.match(e, game);
            if (key && !st.seen.has(key)) {
              st.seen.add(key);
              ctx.objective(`${c.blurb} ${st.seen.size}/${c.need}`);
              game.emit('challenge:progress', { id: c.id, count: st.seen.size, need: c.need });
            }
          });
          ctx.objective(`${c.blurb} 0/${c.need}`);
          ctx.flash(c.title.toUpperCase());
        },
        update(ctx, st, dt) {
          st.left -= dt;
          ctx.timer(st.left, c.title);
          if (st.seen.size >= c.need) {
            ctx.result.time = c.seconds - st.left;
            return true;
          }
          if (st.left <= 0) return `Time\'s up: ${st.seen.size}/${c.need}.`;
        },
        exit(ctx) {
          ctx.timer(null);
        },
        skip(ctx, st) {
          for (let i = 0; i < c.need; i++) st.seen.add(`skip${i}`);
        }
      }],
      onPass(result, first) {
        if (first) game.stats.add('rampagesDone');
        const prev = missions.best[c.id];
        if (!prev || result.time < prev.time) missions.best[c.id] = { time: result.time };
      }
    };
    missions.register(def);
  }

  // ===================================================================================================================
  // GOLDEN KIWIS
  // ===================================================================================================================
  const kiwis = KIWIS.map(([x, z], i) => {
    const p = places.findClear(x, z, 25, 0.45);
    return { i, x: p.x, z: p.z, name: KIWI_NAMES[i], got: false, pickup: null };
  });
  function spawnKiwis() {
    for (const k of kiwis) {
      if (k.got || k.pickup) continue;
      k.pickup = game.pickups.spawn('collectible', k.x, k.z, {
        persistent: true, value: KIWI_REWARD, label: 'Golden kiwi',
        onCollect: () => {
          k.got = true;
          k.pickup = null;
          const n = kiwis.filter((q) => q.got).length;
          game.stats.add('collectibles');
          game.player.addMoney(KIWI_REWARD, 'collectible');
          notice(`Golden kiwi ${n}/30 — ${k.name}`, 3);
          game.emit('collectible:found', { index: k.i, count: n, total: kiwis.length, name: k.name });
          if (n === kiwis.length) {
            game.player.addMoney(KIWI_ALL, 'collectible');
            game.ui?.notify?.({ title: 'All 30 golden kiwis!', text: `$${KIWI_ALL.toLocaleString('en-NZ')} — and the eternal respect of the Department of Conservation.`, icon: 'star' });
          }
          game.save.save();
        }
      });
    }
  }
  spawnKiwis();

  // ===================================================================================================================
  // PICKUPS ROUND THE CITY
  // ===================================================================================================================
  for (const [kind, x, z, value] of STATIC_PICKUPS) {
    const p = places.findClear(x, z, 25, 0.45);
    game.pickups.spawn(kind, p.x, p.z, { respawn: RESPAWN[kind], value: value ?? (kind === 'health' ? 50 : kind === 'armor' ? 50 : 1) });
  }
  let weaponsPlaced = false;
  function placeWeapons() {
    const bat = game.weapons?.defs?.bat;
    if (weaponsPlaced || !bat) return;
    weaponsPlaced = true;
    for (const [x, z] of BAT_PICKUPS) {
      const p = places.findClear(x, z, 25, 0.45);
      game.pickups.spawn('weapon', p.x, p.z, { weaponId: 'bat', respawn: RESPAWN.weapon, label: bat.name });
    }
  }

  // ===================================================================================================================
  // SAVE & API
  // ===================================================================================================================
  game.save.register('activities', {
    get: () => ({ exported: [...exported], kiwis: kiwis.filter((k) => k.got).map((k) => k.i) }),
    set: (data) => {
      if (!data) return;
      exported.clear();
      for (const id of data.exported || []) exported.add(id);
      for (const k of kiwis) {
        const got = (data.kiwis || []).includes(k.i);
        if (got && k.pickup) {
          game.pickups.remove(k.pickup);
          k.pickup = null;
        }
        k.got = got;
      }
      spawnKiwis();
    }
  });

  const activities = {
    taxi,
    EXPORTS,
    exported,
    kiwis,
    RACES,
    CHALLENGES,
    setDuty,
    exportList: () => EXPORTS.map((x) => ({ ...x, done: exported.has(x.id) })),
    exportAt,
    /** A mission is starting: the side job stops */
    interrupt() {
      if (taxi.onDuty) setDuty(false, '');
    },
    /** Completion share from activities: races 9, challenges 9, exports 8, taxi 10 */
    progress() {
      let p = 0;
      const rank = { gold: 3, silver: 2, bronze: 1 };
      for (const r of RACES) p += rank[missions.best[r.id]?.medal] || 0;
      for (const c of CHALLENGES) if (missions.isDone(c.id)) p += 3;
      p += exported.size;
      p += Math.min(10, game.stats.get('taxiFares')) * 0.5;
      p += Math.min(10, game.stats.get('taxiBestStreak')) * 0.5;
      return p;
    },
    update(dt, realDt) {
      placeWeapons();
      updateTaxi(dt);
      void realDt;
    }
  };
  return activities;
}

function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export { createActivities, EXPORTS, RACES, CHALLENGES, KIWIS };
