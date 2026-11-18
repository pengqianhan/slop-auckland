// game.stats: the numbers the pause menu and the phone show (knock-outs, distances, cars stolen, missions passed, money
// earned and spent, best wanted level, play time, collectibles...) and the completion percentage. Counted from bus
// events and the player's movement; saved with the game. stat:changed { key, value } on every change (the distance
// and play-time counters only emit when they cross a whole unit, so the event stays cheap).
//   game.stats.get('knockouts')   game.stats.add('taxiFares', 1)   game.stats.set('bestRace-queen', 61.2)   game.stats.all()

const LABELS = {
  playTime: 'Play time',
  missionsPassed: 'Story missions passed',
  missionsFailed: 'Missions failed',
  missionAttempts: 'Mission attempts',
  knockouts: 'People knocked out',
  thugsKnockedOut: 'Thugs knocked out',
  batSwings: 'Bat swings',
  tackles: 'Times tackled',
  carsStolen: 'Cars stolen',
  carjacks: 'Drivers evicted',
  vehiclesWrecked: 'Vehicles wrecked',
  distanceDriven: 'Distance driven (km)',
  distanceWalked: 'Distance on foot (km)',
  distanceFlown: 'Distance flown (km)',
  moneyEarned: 'Money earned',
  moneySpent: 'Money spent',
  bestWanted: 'Highest wanted level',
  timesWanted: 'Times wanted',
  deaths: 'Hospital visits',
  busted: 'Arrests',
  collectibles: 'Golden kiwis found',
  taxiFares: 'Taxi fares',
  taxiBestStreak: 'Best taxi streak',
  exports: 'Cars exported',
  racesWon: 'Race medals',
  rampagesDone: 'Challenges completed',
  safehouses: 'Safehouses owned',
  resprays: 'Resprays',
  pickups: 'Pickups collected'
};

function createStats(game) {
  const values = Object.create(null);
  for (const key of Object.keys(LABELS)) values[key] = 0;
  const changed = { key: '', value: 0 };
  let progressFn = () => 0;

  function emit(key) {
    changed.key = key;
    changed.value = values[key];
    game.emit('stat:changed', changed);
  }

  const stats = {
    LABELS,
    get(key) {
      return values[key] ?? 0;
    },
    add(key, n = 1) {
      if (!(Number.isFinite(n)) || n === 0) return values[key] ?? 0;
      values[key] = (values[key] ?? 0) + n;
      emit(key);
      return values[key];
    },
    set(key, value) {
      if (values[key] === value) return value;
      values[key] = value;
      emit(key);
      return value;
    },
    /** Keeps the larger (or with lower: the smaller, for best times) */
    best(key, value, lower = false) {
      const cur = values[key];
      if (cur === undefined || cur === 0 || (lower ? value < cur : value > cur)) return stats.set(key, value);
      return cur;
    },
    all() {
      return { ...values, progress: stats.progress };
    },
    /** Rows for the stats screen: [{ key, label, value (formatted) }] */
    rows() {
      const rows = [{ key: 'progress', label: 'Completion', value: `${stats.progress.toFixed(1)}%` }];
      for (const [key, label] of Object.entries(LABELS)) {
        let v = values[key] || 0;
        if (key === 'playTime') {
          const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60);
          v = h ? `${h} h ${m} min` : `${m} min`;
        } else if (key.startsWith('distance')) v = (v / 1000).toFixed(1);
        else if (key.startsWith('money')) v = `$${Math.round(v).toLocaleString('en-NZ')}`;
        else if (key === 'collectibles') v = `${v} / 30`;
        else v = String(Math.round(v));
        rows.push({ key, label, value: v });
      }
      return rows;
    },
    /** Completion 0..100 (the missions module supplies how) */
    get progress() {
      return progressFn();
    },
    setProgress(fn) {
      progressFn = fn;
    },
    /** @internal save data */
    toJSON() {
      return { ...values };
    },
    load(data) {
      if (!data || typeof data !== 'object') return;
      for (const [k, v] of Object.entries(data)) if (Number.isFinite(v)) values[RENAMED[k] || k] = v;
      // (counters from the days of guns are not kept)
      for (const k of RETIRED) delete values[k];
    }
  };

  // ---- counted from the bus ----
  // (ped:killed is a knock-out: down and out cold)
  game.on('ped:killed', (e) => {
    if (!e.byPlayer) return;
    stats.add('knockouts');
  });
  game.on('vehicle:jacked', () => stats.add('carjacks'));
  game.on('vehicle:entered', (e) => {
    const v = e.vehicle;
    // a car the player never drove before, that isn't theirs (the hero taxi, bicycle, helicopter)
    if (v && !v.hero && !v._statStolen && v.mode === 'car') {
      v._statStolen = true;
      stats.add('carsStolen');
    }
  });
  game.on('vehicle:wrecked', (e) => {
    if (e.byPlayer) stats.add('vehiclesWrecked');
  });
  game.on('money:changed', (e) => {
    if (e.delta > 0) stats.add('moneyEarned', e.delta);
    else if (e.delta < 0) stats.add('moneySpent', -e.delta);
  });
  game.on('wanted:changed', (e) => {
    if (e.level > (e.prev || 0) && !(e.prev > 0)) stats.add('timesWanted');
    stats.best('bestWanted', e.level);
  });
  game.on('player:died', () => stats.add('deaths'));
  game.on('player:busted', () => stats.add('busted'));
  game.on('pickup:collected', (e) => {
    if (e.kind !== 'collectible' && e.kind !== 'package') stats.add('pickups');
  });
  game.on('melee:swing', (e) => {
    if (e.weaponId === 'bat') stats.add('batSwings');
  });
  game.on('police:tackle', () => stats.add('tackles'));
  game.on('enemy:killed', (e) => {
    if (e?.byPlayer !== false && e?.enemy?.faction !== 'police') stats.add('thugsKnockedOut');
  });

  // ---- distances and play time, from the player's movement each frame ----
  let lastX = NaN, lastZ = NaN, lastMode = '';
  const acc = { distanceDriven: 0, distanceWalked: 0, distanceFlown: 0, playTime: 0 };
  function update(dt, realDt) {
    const player = game.player;
    if (!player) return;
    if (game.state === 'playing' || game.state === 'cutscene') acc.playTime += realDt;
    const p = player.position;
    const mode = player.vehicle ? player.vehicle.mode : 'person';
    if (dt > 0 && player.alive && mode === lastMode && Number.isFinite(lastX)) {
      const d = Math.hypot(p.x - lastX, p.z - lastZ);
      // (a teleport is not a journey)
      if (d < 60 * dt + 1) {
        const key = mode === 'person' ? 'distanceWalked' : mode === 'helicopter' ? 'distanceFlown' : 'distanceDriven';
        acc[key] += d;
      }
    }
    lastX = p.x;
    lastZ = p.z;
    lastMode = mode;
    for (const key in acc) {
      const whole = key === 'playTime' ? 1 : 10;
      if (acc[key] >= whole) {
        const n = Math.floor(acc[key] / whole) * whole;
        acc[key] -= n;
        stats.add(key, n);
      }
    }
  }

  stats.update = update;
  return stats;
}

// saves from before: the same counts under their new names; counters that no longer mean anything are dropped
const RENAMED = { kills: 'knockouts', enemiesKilled: 'thugsKnockedOut', vehiclesDestroyed: 'vehiclesWrecked' };
const RETIRED = ['headshots', 'shotsFired', 'copsKilled', 'kills', 'enemiesKilled', 'vehiclesDestroyed'];

export { createStats, LABELS as STAT_LABELS };
