// First-time help: a line in the help box (top left) the first time something happens — the first steps, the first
// car, the cricket bat, the first star, the first shop, the first trip to hospital — once per save. Tips wait their turn:
// they never talk over a marker's prompt or a mission's hint (the help box must be free for a moment first), and one
// that a prompt pushes off the screen straight away comes back later. Texts follow the device in use ({action} key
// caps come from game.input, [X] are literal caps).

const GAP = 0.8; // s the help box must have been free before a tip shows
const MIN_READ = 2.5; // s: a tip replaced sooner than this is shown again later

function byDevice(game, texts) {
  const touch = document.body.classList.contains('touch-enabled') && game.input?.device !== 'gamepad';
  const dev = touch ? 'touch' : game.input?.device === 'gamepad' ? 'gamepad' : 'keyboard';
  return texts[dev] ?? texts.keyboard;
}

const TIPS = {
  walk: (g) => byDevice(g, {
    keyboard: 'Walk with [W][A][S][D], {sprint} to sprint. Click the view to look round with the mouse.',
    gamepad: 'Left stick walks, right stick looks round. Click in {sprint} to sprint.',
    touch: 'Drag the left stick to walk; drag the view to look round.'
  }),
  steal: (g) => byDevice(g, {
    keyboard: 'Walk up to any car and press {enterExit} to get in. If someone is driving it, they get out. Mostly willingly.',
    gamepad: 'Walk up to any car and press {enterExit} to get in. If someone is driving it, they get out. Mostly willingly.',
    touch: 'Walk up to any car and tap ⏏ to get in. If someone is driving it, they get out.'
  }),
  gps: () => 'The yellow line on the radar is your GPS. Walk into a yellow marker to start a job.',
  drive: (g) => byDevice(g, {
    keyboard: 'Drive with [W] and [S], steer with [A] and [D]. [,] and [.] change the radio. {enterExit} gets out.',
    gamepad: '[RT] drives, [LT] brakes and reverses, the left stick steers. {enterExit} gets out.',
    touch: 'The left stick drives and steers. Tap ⏏ to get out.'
  }),
  heli: (g) => byDevice(g, {
    keyboard: 'Fly with [W][A][S][D]; [Space] climbs, [Q] comes down. Set it down gently.',
    gamepad: 'The left stick flies; [RT] climbs, [LT] comes down. Set it down gently.',
    touch: 'The left stick flies. Set it down gently.'
  }),
  weapon: (g) => byDevice(g, {
    keyboard: 'A cricket bat: {fire} swings it. Hold {aim} to square up. {weaponPrev} / {weaponNext}, the wheel or [1] / [2] switch between fists and bat. It dents cars too.',
    gamepad: 'A cricket bat: {fire} swings it, hold {aim} to square up. {weaponPrev} / {weaponNext} switch between fists and bat.',
    touch: 'A cricket bat: Swing swings it. ⇄ switches between fists and bat.'
  }),
  wanted: () => 'Wanted! The police want to arrest you: get out of their sight and stay hidden until the stars stop flashing. Stand still beside an officer and you\'re nicked. A Spray \'n\' Pray respray clears them too, for a price.',
  wanted3: () => 'Three stars: roadblocks, a helicopter, and cars that box you in. Keep moving; a different car, out of their sight, throws them off quicker.',
  tackled: () => 'Tackled! While you\'re down an officer can cuff you — two of them quicker. Get up and keep running.',
  shop: () => 'Sports shops sell a cricket bat and protective padding (armour); food heals. Nobody serves you while you\'re wanted.',
  phone: () => 'Your phone: {phone}. Jobs and the GPS to them, a cab to any job, side hustles, your stats.',
  safehouse: () => 'Mere\'s spare room on Union Street is yours now: save and heal there, and keep a car in its garage.',
  hospital: () => 'Patched up — the hospital keeps a fee. You keep your bat. Retry the job from the prompt, or find its marker again.',
  busted: () => 'Nicked: the police kept your bat and a tenth of your cash. Keep your head down next time.',
  pause: () => '[Esc] pauses: the map (set a waypoint), your jobs, stats and settings.',
  retry: () => 'Missed it? Press {interact} while the prompt shows to try the job again from its start.'
};

// a tip still worth saying when its turn comes (else it waits for the next time: the first flight after a crash...)
const STILL = {
  drive: (g) => g.player?.vehicle?.mode === 'car',
  heli: (g) => g.player?.vehicle?.mode === 'helicopter',
  weapon: (g) => !!g.player?.onFoot,
  tackled: (g) => g.wanted?.level > 0,
  wanted: (g) => g.wanted?.level > 0,
  wanted3: (g) => g.wanted?.level >= 3,
  walk: (g) => !!g.player?.onFoot,
  steal: (g) => !!g.player?.onFoot
};

function createTips(game, { hud }) {
  const seen = new Set();
  const queue = [];
  let current = null; // { id, text, shownFor }
  let free = 0;

  game.save?.register('tips', {
    get: () => [...seen],
    set: (data) => {
      if (Array.isArray(data)) for (const id of data) if (typeof id === 'string') seen.add(id);
    }
  });

  /** Queues a tip by id (once per save); front: before the others */
  function tip(id, front = false) {
    if (!TIPS[id] || seen.has(id) || queue.includes(id) || current?.id === id) return;
    if (front) queue.unshift(id);
    else queue.push(id);
  }

  // (events at load — weapons given back from the save — are not "firsts")
  const live = () => game.frame > 30;
  const on = (type, fn) => game.on(type, (e) => {
    if (live()) fn(e);
  });
  on('vehicle:entered', (e) => {
    const v = e?.vehicle;
    if (!v) return;
    if (v.mode === 'helicopter') tip('heli', true);
    else if (v.mode === 'car') tip('drive', true);
  });
  on('weapon:pickup', (e) => {
    if (e?.weaponId === 'bat') tip('weapon', true);
  });
  on('police:tackle', () => tip('tackled', true));
  on('wanted:changed', (e) => {
    if (e?.level >= 1) tip('wanted', true);
    if (e?.level >= 3) tip('wanted3');
  });
  on('shop:opened', (e) => {
    if (e?.type === 'sports' || e?.type === 'food') tip('shop', true);
  });
  on('mission:passed', (e) => {
    if (e?.id === 'meter-running') tip('safehouse');
    tip('phone');
    tip('pause');
  });
  on('mission:failed', (e) => {
    if (e?.code !== 'aborted') tip('retry');
  });
  on('player:respawned', (e) => tip(e?.at === 'police' ? 'busted' : 'hospital', true));

  return {
    tip,
    seen,
    /** The first steps of a new game */
    intro() {
      tip('walk');
      tip('steal');
      tip('gps');
    },
    update(realDt) {
      const playing = game.state === 'playing' || (game.state === 'cutscene' && !game.letterbox);
      if (current) {
        current.shownFor += realDt;
        // pushed off by a prompt or a hint before it could be read: again later
        if (hud.helpText !== current.text) {
          if (current.shownFor < MIN_READ) {
            seen.delete(current.id);
            queue.unshift(current.id);
          }
          current = null;
          free = 0;
        }
        return;
      }
      if (hud.helpText) {
        free = 0;
        return;
      }
      if (!queue.length || !playing || !game.player?.alive) return;
      if ((free += realDt) < GAP) return;
      // (out of date by now: dropped, to come back the next time it happens)
      while (queue.length && STILL[queue[0]] && !STILL[queue[0]](game)) queue.shift();
      if (!queue.length) return;
      const id = queue.shift();
      const text = TIPS[id](game);
      seen.add(id);
      hud.setHelp(text, Math.min(9, 4 + text.length * 0.045));
      current = { id, text, shownFor: 0 };
    }
  };
}

export { createTips, TIPS };
