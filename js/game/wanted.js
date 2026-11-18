// The wanted level: the crimes the game sees happen (bus events, or report() from missions), weighed by who saw
// them, become heat; heat becomes 0-5 stars. The crimes of a caper: carjacking, theft, assault (a punch, the bat),
// knocking someone out, running people down, smashing property, and anything done to the police (the worst of it).
// A crime the police see counts in full at once; one only bystanders see is phoned in a few seconds later, maybe,
// and counts for less; one nobody sees goes unpunished. Running from the police in their sight keeps the heat
// climbing slowly (to four stars at most: five takes going for the officers themselves). While no officer, patrol
// car or the helicopter can see the player the stars flash ("evading"): kept out of sight long enough (longer at more
// stars, quicker away from where they were last seen, quicker still in a different vehicle from the one they were
// last seen in) the heat is lost; being spotted again sets that escape back (by seenSetback for each second in sight)
// rather than to nothing, so a glimpse is a setback and a chase undoes it. A respray (missions), a bribe pickup, an
// arrest or a death clear it too.
// game/police.js creates this and tells it what the police can see (eyes).

// ---- tuning ---------------------------------------------------------------------------------------------------------
const WANTED = {
  heat: [0, 10, 35, 80, 150, 250], // heat at which each star level starts
  heatCap: 330,
  evadeTime: [0, 10, 18, 28, 40, 55], // seconds out of sight that lose each level
  evadeGrace: 2.5, // seconds unseen before the stars flash
  seenSetback: 4, // evade-timer seconds lost per second in their sight (a glimpse sets an escape back, a chase undoes it)
  nearSceneRate: 0.45, // evade-timer speed inside the search area round the last known position...
  farSceneRate: 1.1, // ...and outside it
  heliRate: 0.7, // ...times this while the police helicopter is up
  searchRadius: 45, // + 25 m a star: the search area
  disguiseRate: 1.6, // evade-timer speed in a different vehicle (or on foot) from the one last seen in
  subDecay: 1.2, // heat/s lost below the first star
  floorDecay: 2.5, // heat/s lost towards the current level's floor while evading
  reportChance: 0.4, // per bystander: chance = 1 - (1 - reportChance)^witnesses (at most 6 counted)
  reportShare: 0.75, // a phoned-in crime counts for this share of its heat
  reportDelay: 2, // + up to 3 s: how long a phone call takes
  resistTime: 7, // seconds fleeing the police at one star before it becomes two
  pursuitHeat: [0, 0, 0.5, 0.35, 0.25, 0], // heat/s while in their sight and fleeing (two stars to three in ~90 s)
  pursuitCap: 4 // ...up to the top of this level (five stars only by going for the police)
};

// heat: base heat; min: the least level it brings when the police see it; throttle: seconds between two reports of
// the type; hearing: metres within which the police hear it (no sight needed); always: the police always know (the
// victim is one of them); policeOnly: only counts when the police see it (bystanders don't phone in a dented bumper)
const CRIMES = {
  // (a carjack in front of the police is a star; one only bystanders phone in is not, by itself — the first hour is
  // all carjacks — but two in a row are)
  carjack: { heat: 9, min: 1 },
  'vehicle-theft': { heat: 12 },
  'hit-and-run': { heat: 12, throttle: 0.4 },
  assault: { heat: 14, throttle: 0.3 },
  knockout: { heat: 40, min: 2 }, // (someone laid out cold: a punch, the bat, a car)
  'cop-assault': { heat: 45, min: 2, always: true, throttle: 0.5 },
  'cop-knockout': { heat: 95, min: 3, always: true },
  property: { heat: 5, throttle: 1.2, policeOnly: true },
  'speeding-past-cop': { heat: 12, throttle: 6, policeOnly: true }
};
// (older names a mission script may still report: the same crimes)
const CRIME_ALIASES = { murder: 'knockout', 'cop-murder': 'cop-knockout' };
const PENDING_CAP = 8;
const RESPAWN_GRACE = 8; // s after a respawn in which nothing the player did before counts

function createWanted(game, eyes) {
  const world = game.world;
  let level = 0;
  let heat = 0;
  let evading = false;
  let evadeTimer = 0;
  let enabled = true;
  let lastSeenAt = -Infinity;
  let lastSeenVehicle = 0; // vehicle id the player was last seen in (0: on foot)
  let disguised = false;
  let resist = 0;
  let graceUntil = -Infinity;
  const lastAt = Object.create(null); // crime type -> game.time of its last report
  for (const k in CRIMES) lastAt[k] = -Infinity;
  const pending = Array.from({ length: PENDING_CAP }, () => ({ active: false, at: 0, amount: 0, min: 0, cap: 5, x: 0, z: 0 }));
  const crimeEvent = { type: '', x: 0, z: 0, severity: 1, witnessed: false };
  const lastKnown = { x: 0, z: 0, at: -Infinity };

  const vehicleKey = () => game.player?.vehicle?.id || 0;
  const levelFor = (h) => {
    let n = 0;
    for (let i = 1; i < WANTED.heat.length; i++) if (h >= WANTED.heat[i]) n = i;
    return n;
  };

  function setLevel(next, reason = '') {
    next = Math.max(0, Math.min(WANTED.heat.length - 1, next | 0));
    if (next === level) return;
    const prev = level;
    level = next;
    if (prev === 0) {
      // a fresh chase: nobody has seen the player yet (the stars flash until the police arrive and spot them)
      evadeTimer = 0;
      resist = 0;
      lastSeenVehicle = vehicleKey();
      disguised = false;
    }
    if (next > prev) evadeTimer = 0;
    game.emit('wanted:changed', { level, prev, reason });
    if (level === 0) {
      if (evading) {
        evading = false;
        game.emit('wanted:evading', { evading: false });
      }
    }
  }

  function addHeat(amount, minLevel = 0, capLevel = 5) {
    if (!enabled || !(amount > 0)) return;
    // (a capped crime adds heat only up to the top of its cap level, and never takes any away)
    const top = capLevel < 5 ? Math.max(heat, WANTED.heat[capLevel + 1] - 0.5) : WANTED.heatCap;
    heat = Math.min(WANTED.heatCap, top, heat + amount);
    let next = levelFor(heat);
    if (minLevel > next) {
      next = minLevel;
      heat = Math.max(heat, WANTED.heat[minLevel]);
    }
    if (next > level) setLevel(next, 'crime');
  }

  function noteLastKnown(x, z) {
    lastKnown.x = x;
    lastKnown.z = z;
    lastKnown.at = game.time;
  }

  /**
   * A crime: type (see CRIMES), opts { x, z (default: the player), severity (heat multiplier, 1), witnesses (bystanders,
   * default counted), police (true/false: override whether the police saw it), policeOnly (bystanders' calls don't
   * count) }. Emits 'crime'. Returns whether anyone who matters saw it.
   */
  function report(type, opts = null) {
    if (!enabled || !game.player?.alive || game.state === 'dead') return false;
    type = CRIME_ALIASES[type] || type;
    // (a car the player set rolling can still knock someone down after they respawn: a fresh
    // start is a fresh start)
    if (game.time < graceUntil) return false;
    const def = CRIMES[type] || CRIMES.assault;
    const now = game.time;
    if (def.throttle && now - (lastAt[type] ?? -Infinity) < def.throttle) return false;
    lastAt[type] = now;
    const p = game.player.position;
    const x = opts?.x ?? p.x, z = opts?.z ?? p.z;
    const severity = opts?.severity ?? 1;
    // who saw it: the police (in sight, or in earshot of a loud one; once wanted and in their sight, everything)
    // (eyes.witness: 2 an officer saw it happen, 1 one heard it, 0 neither)
    let police = opts?.police;
    let saw = !!police;
    if (police === undefined) {
      if (level > 0 && eyes.seesPlayer) {
        police = saw = true;
      } else {
        const w = eyes.witness(x, z, def.hearing || 0);
        saw = w === 2;
        police = !!def.always || w > 0;
      }
    }
    const amount = def.heat * severity;
    let witnessed = police;
    if (police) {
      addHeat(amount, def.min || 0, def.cap ? def.cap[1] : 5);
      noteLastKnown(x, z);
      // (they saw who did it: no flashing stars until they actually lose sight)
      if (saw) lastSeenAt = now;
    } else if (!def.policeOnly && !opts?.policeOnly) {
      const w = Math.min(6, Math.max(0, opts?.witnesses ?? world.witnesses(x, z, 30)));
      if (w > 0 && Math.random() < 1 - (1 - WANTED.reportChance) ** w) {
        witnessed = true;
        schedule(amount * WANTED.reportShare, def.min ? def.min - 1 : 0, x, z, def.cap ? def.cap[0] : 5);
      }
    }
    crimeEvent.type = type;
    crimeEvent.x = x;
    crimeEvent.z = z;
    crimeEvent.severity = severity;
    crimeEvent.witnessed = witnessed;
    game.emit('crime', crimeEvent);
    return witnessed;
  }

  // A bystander's phone call: the heat arrives a few seconds later, and the police go to where it happened
  function schedule(amount, minLevel, x, z, capLevel = 5) {
    let slot = pending[0];
    for (let i = 0; i < PENDING_CAP; i++) {
      if (!pending[i].active) {
        slot = pending[i];
        break;
      }
      if (pending[i].at < slot.at) slot = pending[i];
    }
    slot.active = true;
    slot.at = game.time + WANTED.reportDelay + Math.random() * 3;
    slot.amount = amount;
    slot.min = minLevel;
    slot.cap = capLevel;
    slot.x = x;
    slot.z = z;
  }

  function set(n) {
    n = Math.max(0, Math.min(WANTED.heat.length - 1, n | 0));
    if (n === 0) {
      clear('set');
      return;
    }
    heat = WANTED.heat[n] + 1;
    // (whoever raised it knows where the player is: the police start from here, the stars solid for a moment)
    const p = game.player?.position;
    if (p) noteLastKnown(p.x, p.z);
    lastSeenAt = game.time;
    setLevel(n, 'set');
  }

  function clear(reason = 'cleared') {
    for (let i = 0; i < PENDING_CAP; i++) pending[i].active = false;
    heat = 0;
    evadeTimer = 0;
    resist = 0;
    disguised = false;
    if (level === 0) return;
    setLevel(0, reason);
    game.emit('wanted:cleared', { reason });
  }

  function update(dt) {
    if (!(dt > 0)) return; // (a NaN would stick in the heat for good)
    const now = game.time;
    // phoned-in crimes arriving
    for (let i = 0; i < PENDING_CAP; i++) {
      const r = pending[i];
      if (!r.active || now < r.at) continue;
      r.active = false;
      if (!enabled || !game.player?.alive) continue;
      const before = level;
      addHeat(r.amount, r.min, r.cap ?? 5);
      if (before === 0 || !eyes.seesPlayer) noteLastKnown(r.x, r.z);
    }
    if (level === 0) {
      heat = Math.max(0, heat - WANTED.subDecay * dt);
      return;
    }
    const p = game.player.position;
    const seen = eyes.seesPlayer && game.player.alive;
    if (seen) {
      lastSeenAt = now;
      noteLastKnown(p.x, p.z);
      lastSeenVehicle = vehicleKey();
      disguised = false;
      evadeTimer = Math.max(0, evadeTimer - dt * WANTED.seenSetback);
    }
    const nowEvading = now - lastSeenAt > WANTED.evadeGrace;
    if (nowEvading !== evading) {
      evading = nowEvading;
      game.emit('wanted:evading', { evading });
    }
    if (evading) {
      if (vehicleKey() !== lastSeenVehicle) disguised = true;
      const away = Math.hypot(p.x - lastKnown.x, p.z - lastKnown.z) > WANTED.searchRadius + 25 * level;
      let rate = away ? WANTED.farSceneRate : WANTED.nearSceneRate;
      if (disguised) rate *= WANTED.disguiseRate;
      if (eyes.heliUp) rate *= WANTED.heliRate;
      evadeTimer += dt * rate;
      heat = Math.max(WANTED.heat[level], heat - WANTED.floorDecay * dt);
      if (evadeTimer >= WANTED.evadeTime[level]) {
        clear('evaded');
        return;
      }
    }
    // running from them in their sight: the heat climbs slowly (to four stars at most)
    const fleeing = seen && eyes.nearestUnit < 90 && eyes.playerSpeed > (game.player.vehicle ? 12 : 4.5);
    if (fleeing && level >= 2 && level < WANTED.pursuitCap && WANTED.pursuitHeat[level] > 0) {
      heat = Math.min(WANTED.heat[WANTED.pursuitCap + 1] - 0.5, heat + WANTED.pursuitHeat[level] * dt);
      const next = levelFor(heat);
      if (next > level) setLevel(next, 'pursuit');
    }
    // one star and running from the officers who have come for them: two
    if (level === 1 && seen && eyes.nearestUnit < 45 && eyes.playerSpeed > (game.player.vehicle ? 12 : 4.5)) {
      resist += dt;
      if (resist > WANTED.resistTime) {
        resist = 0;
        set(2);
      }
    } else {
      resist = Math.max(0, resist - dt * 0.5);
    }
  }

  // ---- crimes from the world's events -------------------------------------------------------------------------------
  game.on('vehicle:jacked', (e) => {
    const v = e.vehicle;
    // dragging a constable out of a patrol car is assaulting a police officer
    if (v?.police) report('cop-assault', { x: e.x, z: e.z, witnesses: e.witnesses });
    else report('carjack', { x: e.x, z: e.z, witnesses: e.witnesses });
  });
  game.on('vehicle:entered', (e) => {
    const v = e.vehicle;
    if (!e.carjacked && v?.police && !v.hero) report('vehicle-theft', { x: e.x, z: e.z, witnesses: e.witnesses, severity: 2.5 });
  });
  // Thugs (game.combat's people of other factions: gangs, guards): bystanders don't ring the police about a scuffle
  // with them, though the police still mind if they see it. (combat.js has already let go of an enemy by
  // the time ped:killed arrives here, so its enemy:killed is noted first.)
  let deadEnemyPed = -1;
  game.on('enemy:killed', (e) => {
    deadEnemyPed = e.enemy && e.enemy.faction !== 'police' ? e.enemy.pedId : -1;
  });
  const criminal = (ped) => !!ped && (ped.id === deadEnemyPed || (game.combat?.factionOfPed?.(ped.id) ?? 'police') !== 'police');
  game.on('ped:hit', (e) => {
    if (!e.byPlayer || e.health <= 0) return; // (a killing blow: ped:killed follows)
    if (eyes.isCop(e.ped)) report('cop-assault', { x: e.x, z: e.z });
    else if (criminal(e.ped)) report('assault', { x: e.x, z: e.z, severity: 0.5, policeOnly: true });
    else report(e.kind === 'vehicle' ? 'hit-and-run' : 'assault', { x: e.x, z: e.z, witnesses: e.witnesses });
  });
  // (ped:killed is a knock-out: the person is down and out, not dead)
  game.on('ped:killed', (e) => {
    if (!e.byPlayer) return;
    if (eyes.isCop(e.ped)) report('cop-knockout', { x: e.x, z: e.z });
    else if (criminal(e.ped)) report('knockout', { x: e.x, z: e.z, severity: 0.5, policeOnly: true });
    else if (e.kind === 'vehicle') report('hit-and-run', { x: e.x, z: e.z, witnesses: e.witnesses, severity: 2.5 });
    else report('knockout', { x: e.x, z: e.z, witnesses: e.witnesses });
    deadEnemyPed = -1;
  });
  game.on('vehicle:damaged', (e) => {
    if (!e.byPlayer) return;
    const t = e.target;
    const cop = !!t?.police;
    if (e.kind === 'collision') {
      if (cop) {
        // into a patrol car: noticed at once; in a chase (they ram too) only a little more heat
        if (level === 0) report('property', { x: e.x, z: e.z, severity: 3, police: true });
        else if (Math.abs(game.player?.vehicle?.speed || 0) > Math.abs(t.speed || 0) + 2) report('cop-assault', { x: e.x, z: e.z, severity: 0.15 });
      } else if (e.amount > 6 && !t?.crimeFree) {
        report('property', { x: e.x, z: e.z });
      }
    } else {
      // a bat to the bodywork
      if (cop) report('cop-assault', { x: e.x, z: e.z, severity: 0.5 });
      else if (!t?.crimeFree) report('property', { x: e.x, z: e.z, severity: 1.5 });
    }
  });
  game.on('player:died', () => clear('died'));
  game.on('player:busted', () => clear('busted'));
  game.on('player:respawned', () => {
    graceUntil = game.time + RESPAWN_GRACE;
    clear('respawn');
  });

  const wanted = {
    get level() {
      return level;
    },
    get heat() {
      return heat;
    },
    maxLevel: WANTED.heat.length - 1,
    get evading() {
      return evading;
    },
    get evadeProgress() {
      return level > 0 ? Math.min(1, evadeTimer / WANTED.evadeTime[level]) : 0;
    },
    get enabled() {
      return enabled;
    },
    set enabled(on) {
      enabled = !!on;
      if (!enabled) clear('disabled');
    },
    /** The police can see the player now */
    get seen() {
      return level > 0 && eyes.seesPlayer;
    },
    /** In a different vehicle (or on foot) from the one last seen in, while out of sight */
    get disguised() {
      return disguised;
    },
    /** Where the police last saw (or were told) the player was: { x, z, at } */
    lastKnown,
    /** 0..1 while an officer is arresting the player (police.js) */
    arrestProgress: 0,
    /** how many officers have hands on the player while arresting (police.js; more is quicker) */
    arrestOfficers: 0,
    report,
    add: (stars = 1) => set(level + Math.max(0, stars | 0)),
    set,
    clear,
    /** A bribe: one star less */
    bribe: () => {
      if (level <= 1) clear('bribe');
      else set(level - 1);
    },
    CRIMES,
    TUNING: WANTED
  };
  return { wanted, update };
}

export { createWanted, WANTED, CRIMES };
