import { getLocationLabel } from '../city-config.js';
import { createHud } from './hud/hud.js';
import { createCards } from './hud/cards.js';
import { createRadar, GAME_PALETTE, colorOf } from './hud/radar.js';
import { createGps } from './hud/gps.js';
import { createMenus, GAME_TITLE } from './menus.js';
import { createTips } from './hud/tips.js';

// The game's interface, "City of Steals": the HUD (hud/hud.js), the radar & GPS (hud/radar.js, hud/gps.js), the big
// moments (hud/cards.js) and the menus (menus.js), styled by css/game.css, all under #game-ui (the HUD) and
// #game-menus (the title screen & the pause menu, above the full map). It renders by itself from the game's state &
// events (see the API reference in index.js) and publishes game.ui:
//   prompt(text|null, action?)   banner(title|null, sub, { style: 'passed'|'failed'|'wasted'|'busted'|'title', seconds })
//   toast(text, s)   fade(0..1, s)   crosshair(bool: force it on)   objective(text|null)   subtitle(who, text, s)
//   timer(seconds|null, label)   help(text|null, s)   notify({ title, text, icon })   hudVisible(bool)   root
//   menu({ title, subtitle, items: [{ label, detail, price, right, disabled, onSelect(item, i, menu) }], onClose })
//     -> { close(), setItems(items), refresh(), setTitle(t, s), open }  (pauses nothing; onClose runs once however it
//     closes, also when another menu replaces it)
//   confirm(question, text, onYes, onNo)   setWaypoint(x, z, label) / clearWaypoint()   openPause(tab)
//   titleOpen   settings (read-only copy)
// Emits 'ui:title' { open, newGame } when the title screen opens / the player starts, and 'settings:changed'
// { key, value, settings } (audio listens for master / sfx / music; game.audio.setVolume(channel, v) is called too).
// ?debug skips the title screen (?title brings it back) and shows a small fps readout; map Shift-click teleports.

const SETTINGS = { time: 'golden', sensitivity: 1, invertY: false, hudScale: 1, subtitles: true, sound: true, master: 1, sfx: 1, music: 0.8 };
const ARRIVE = 24; // m from a waypoint: it is cleared

function createUI(game) {
  const params = new URLSearchParams(location.search);
  const debug = params.has('debug');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.body.classList.add('akl-game');
  document.title = `${GAME_TITLE} · Slop Auckland`;
  if (debug) document.body.classList.add('akl-debug');
  const engine = game.engine || {};
  const mapSystem = engine.mapSystem || null;
  const cameraSystem = engine.cameraSystem;

  const root = document.createElement('div');
  root.id = 'game-ui';
  root.dataset.state = game.state;
  root.dataset.vehicle = 'foot';
  document.body.appendChild(root);
  const layer = document.createElement('div');
  layer.id = 'game-menus';
  document.body.appendChild(layer);

  const hud = createHud(game, root, { reducedMotion });
  const cards = createCards(game, root, { reducedMotion });
  const gps = createGps(game);
  const extraBlips = []; // the waypoint, when there is no game.blips to hold it
  const radar = createRadar(game, { canvas: hud.radarCanvas, mapSystem, gps, extraBlips: () => extraBlips });
  const tips = createTips(game, { hud });

  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'g-touch-pause';
  pauseBtn.setAttribute('aria-label', 'Pause');
  pauseBtn.addEventListener('click', () => {
    if (game.state === 'playing') game.pause();
  });
  root.appendChild(pauseBtn);
  const debugEl = document.createElement('div');
  debugEl.className = 'g-debug';
  root.appendChild(debugEl);
  debugEl.hidden = !debug;

  // ---- settings (saved with the game) ----------------------------------------------------------------------------
  const settings = { ...SETTINGS };
  let timeApplied = false;
  const clickData = (attr, value) => {
    const b = document.querySelector(`[data-${attr}="${value}"]`);
    if (b && !b.classList.contains('active')) b.click();
  };
  const getQuality = () => document.querySelector('[data-quality].active')?.dataset.quality || 'ultra';
  const cam = cameraSystem;
  if (cam && typeof cam.addLook === 'function') {
    // Invert Y for the player's own looking (mouse, stick, touch drags reach the camera here), not for the game's
    // own camera moves (recoil and the like go through game.camera.addLook)
    const rawAddLook = cam.addLook.bind(cam);
    cam.addLook = (dYaw, dPitch) => rawAddLook(dYaw, settings.invertY ? -dPitch : dPitch);
    if (game.camera) game.camera.addLook = rawAddLook;
  }
  function apply(key, initial = false) {
    const v = settings[key];
    switch (key) {
      case 'time':
        if (timeApplied || !initial) clickData('time', v);
        break;
      case 'sensitivity':
        if (game.input) game.input.sensitivity = v;
        break;
      case 'hudScale':
        root.style.setProperty('--hud-scale', String(v));
        break;
      case 'sound':
        // (switching sound on needs a click: only a saved "off" is applied on load)
        if (engine.audioSystem && (!initial || !v) && engine.audioSystem.enabled !== v) engine.audioSystem.setEnabled(v);
        break;
      case 'master':
      case 'sfx':
      case 'music':
        game.audio?.setVolume?.(key, v);
        break;
    }
    game.emit('settings:changed', { key, value: v, settings });
  }
  function setSetting(key, value) {
    if (key === 'quality') {
      clickData('quality', value);
      return;
    }
    if (!(key in settings)) return;
    settings[key] = value;
    apply(key);
    clearTimeout(setSetting.saveTimer);
    setSetting.saveTimer = setTimeout(() => game.save?.save(), 400);
  }
  game.save?.register('settings', {
    get: () => ({ ...settings }),
    set: (data) => {
      if (!data || typeof data !== 'object') return;
      for (const k of Object.keys(SETTINGS)) if (typeof data[k] === typeof SETTINGS[k]) settings[k] = data[k];
      for (const k of Object.keys(SETTINGS)) apply(k, true);
    }
  });
  for (const k of Object.keys(SETTINGS)) apply(k, true);

  // ---- waypoint & route ------------------------------------------------------------------------------------------
  let waypoint = null;
  function setWaypoint(x, z, label = 'Waypoint') {
    clearWaypoint();
    if (game.blips?.add) {
      waypoint = game.blips.add({ x, z, kind: 'destination', label, route: true });
    }
    if (!waypoint) {
      waypoint = { x, z, kind: 'destination', label, route: true, visible: true, remove: () => {} };
      extraBlips.push(waypoint);
    }
    game.emit('ui:waypoint', { x, z, set: true });
  }
  function clearWaypoint() {
    if (!waypoint) return;
    const i = extraBlips.indexOf(waypoint);
    if (i >= 0) extraBlips.splice(i, 1);
    else waypoint.remove?.();
    waypoint = null;
    game.emit('ui:waypoint', { set: false });
  }
  const blipXZ = (b) => (b.target && Number.isFinite(b.target.x) ? b.target : b);

  // the newest visible blip with a route gets the GPS; an objective blip gets a marker too
  function pickRouteBlip() {
    let best = null;
    const list = game.blips?.list;
    if (list) for (let i = 0; i < list.length; i++) if (list[i] && list[i].route && list[i].visible !== false) best = list[i];
    for (let i = 0; i < extraBlips.length; i++) if (extraBlips[i].route && extraBlips[i].visible !== false) best = extraBlips[i];
    return best;
  }
  function pickObjectiveBlip(not) {
    const list = game.blips?.list;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b && b !== not && b.visible !== false && b.kind === 'objective') return b;
    }
    return null;
  }
  const far = (b) => {
    const q = blipXZ(b), p = game.player.position;
    return Math.hypot(q.x - p.x, q.z - p.z) > 7;
  };
  const markerTargets = [{ x: 0, y: 0, z: 0, color: '', gx: NaN, gz: NaN, gy: 0 }, { x: 0, y: 0, z: 0, color: '', gx: NaN, gz: NaN, gy: 0 }];
  function fillMarker(slot, b) {
    const p = blipXZ(b);
    const t = markerTargets[slot];
    t.x = p.x;
    t.z = p.z;
    const y = b.target && Number.isFinite(b.target.y) ? b.target.y : Number.isFinite(b.y) ? b.y : NaN;
    if (Number.isFinite(y)) {
      t.y = y + 2.2;
    } else {
      if (Math.abs(t.gx - p.x) > 2 || Math.abs(t.gz - p.z) > 2 || !Number.isFinite(t.gx)) {
        t.gx = p.x;
        t.gz = p.z;
        t.gy = game.world?.groundHeight?.(p.x, p.z) ?? 0;
      }
      t.y = t.gy + 2.6;
    }
    t.color = colorOf(b);
  }

  // ---- the map (pause menu's Map tab) ----------------------------------------------------------------------------
  let mapSwitching = false;
  let nextTab = null;
  const setMap = (open) => {
    if (!mapSystem || mapSystem.isFullMapOpen === open) return;
    mapSwitching = true;
    try {
      mapSystem.toggleFullMap(open);
    } finally {
      mapSwitching = false;
    }
  };
  if (mapSystem) {
    mapSystem.palette = GAME_PALETTE;
    mapSystem.minimapEnabled = false;
    mapSystem.waypoint = null;
    mapSystem.pickHint = 'Click to set a waypoint';
    mapSystem.drawOverlay = (ctx, v) => radar.drawMapOverlay(ctx, v);
    mapSystem.onPick = (x, z, e) => {
      if (debug && e?.shiftKey && mapSystem.onTeleport) {
        mapSystem.onTeleport(x, z);
        toast('Teleported (debug)');
        return;
      }
      if (waypoint) {
        const p = blipXZ(waypoint);
        const near = 16 / Math.max(0.01, mapSystem.viewZoom || 0.2);
        if (Math.hypot(p.x - x, p.z - z) < Math.max(18, near)) {
          clearWaypoint();
          return;
        }
      }
      setWaypoint(x, z, getLocationLabel(x, z).split(' · ').pop() || 'Waypoint');
    };
    mapSystem.toggleListeners.push((open) => {
      if (mapSwitching) return;
      if (menus.titleOpen || game.state === 'cutscene' || game.state === 'dead') {
        if (open) setTimeout(() => setMap(false), 0);
        return;
      }
      if (open) {
        if (game.state === 'playing') {
          nextTab = 'map';
          game.pause();
        } else if (menus.pauseOpen && menus.tab !== 'map') {
          menus.selectTab('map');
        }
      } else if (menus.pauseOpen && menus.tab === 'map') {
        resume(false);
      }
    });
  }
  hud.radarWrap.addEventListener('click', () => {
    if (game.state === 'playing') {
      nextTab = 'map';
      game.pause();
    }
  });

  function resume(fromClick) {
    menus.closePause();
    game.resume();
    if (fromClick && game.input && game.input.device !== 'touch' && !document.body.classList.contains('touch-enabled')) game.input.requestPointerLock();
  }

  // ---- menus -------------------------------------------------------------------------------------------------------
  const labelFor = (device, action) => {
    const input = game.input;
    if (!input) return '';
    const prev = input.device;
    input.device = device;
    const l = input.label(action);
    input.device = prev;
    return l;
  };
  function controlRows(dev) {
    const L = (a) => labelFor(dev, a);
    const keep = (rows) => rows.filter(([, k]) => k && k !== '—' && (!Array.isArray(k) || k.length));
    if (dev === 'gamepad') {
      return [
        ['On foot', keep([['Move', 'Left stick'], ['Look', 'Right stick'], ['Sprint', L('sprint')], ['Jump', L('jump')], ['Swing (fists / bat)', L('fire')], ['Focus (square up)', L('aim')], ['Fists / bat', [L('weaponPrev'), L('weaponNext')]], ['Get in / out, carjack', L('enterExit')], ['Interact', L('interact')]])],
        ['Driving', [['Accelerate', 'RT'], ['Brake / reverse', 'LT'], ['Steer', 'Left stick'], ['Look round', 'Right stick'], ['Get out', L('enterExit')]]],
        ['Game', keep([['Pause', L('pause')], ['Map', 'Back'], ['Phone', L('phone')], ['Camera', 'D-pad ←']])]
      ];
    }
    if (dev === 'touch') {
      return [
        ['On foot', [['Move', 'Left joystick'], ['Look', 'Drag the view'], ['Zoom', 'Pinch'], ['Sprint', 'Run'], ['Swing (fists / bat)', 'Swing'], ['Focus (square up)', 'Focus'], ['Fists / bat', '⇄'], ['Get in / out', '⏏']]],
        ['Driving', [['Drive & steer', 'Left joystick'], ['Get out', '⏏']]],
        ['Game', [['Pause', '❚❚'], ['Map', 'Tap the radar']]]
      ];
    }
    return [
      ['On foot', keep([['Move', ['W', 'A', 'S', 'D']], ['Look', 'Mouse (click the view)'], ['Sprint', L('sprint')], ['Jump', L('jump')], ['Crouch', L('crouch')], ['Swing (fists / bat)', L('fire')], ['Focus (square up)', L('aim')], ['Fists / bat', [L('weaponPrev'), L('weaponNext'), 'Wheel', '1', '2']], ['Get in / out, carjack', L('enterExit')], ['Interact, buy', L('interact')]])],
      ['Driving', keep([['Drive / reverse', ['W', 'S']], ['Steer', ['A', 'D']], ['Horn', L('horn')], ['Radio station', [',', '.']], ['Get out', L('enterExit')]])],
      ['Game', keep([['Pause', ['Esc', 'P']], ['Map', 'M'], ['Phone', L('phone')], ['Hide the HUD', 'H'], ['Sound on / off', 'N']])]
    ];
  }
  function statRows() {
    const rows = [];
    const p = game.player;
    if (p) rows.push(['Cash', `NZ$${Math.round(p.money).toLocaleString('en-NZ')}`, true]);
    let all = null;
    try {
      all = game.stats?.all?.();
    } catch { /* not ready */ }
    const entries = Array.isArray(all) ? all.map((s) => (Array.isArray(s) ? s : [s.label ?? s.key, s.value])) : all && typeof all === 'object' ? Object.entries(all) : [];
    for (const [k, v] of entries) {
      const label = String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
      rows.push([label, statValue(String(k), v)]);
    }
    if (!entries.some(([k]) => /time|play/i.test(k))) {
      const t = Math.round(game.time);
      rows.push(['Time on the streets (this session)', `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`]);
    }
    if (game.wanted) rows.push(['Wanted level', `${game.wanted.level || 0} / ${game.wanted.maxLevel || 5}`]);
    return rows;
  }
  // numbers by what they count: times as h m s, distances in m / km, money in NZ$, progress in %
  function statValue(key, v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
    if (/(time|duration)$/i.test(key)) {
      const t = Math.round(v);
      return t >= 3600 ? `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
    }
    if (/distance/i.test(key)) return v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`;
    if (/money|cash|earned|spent/i.test(key)) return `NZ$${Math.round(v).toLocaleString('en-NZ')}`;
    if (/progress|percent/i.test(key)) return `${Math.round(v <= 1 ? v * 100 : v)}%`;
    return Number.isInteger(v) ? v.toLocaleString('en-NZ') : v.toFixed(1);
  }
  function missionRows() {
    try {
      return game.missions?.list?.() || [];
    } catch {
      return [];
    }
  }
  function pauseMeta() {
    const p = game.player?.position;
    const where = p ? getLocationLabel(p.x, p.z).split(' · ')[0] : '';
    const money = game.player ? `NZ$${Math.round(game.player.money).toLocaleString('en-NZ')}` : '';
    return [where, money].filter(Boolean).join('  ·  ');
  }

  const menus = createMenus(game, layer, {
    reducedMotion, debug, settings, setSetting, getQuality, controlRows, statRows, missionRows, pauseMeta,
    hasVolume: () => typeof game.audio?.setVolume === 'function',
    setWaypoint: (x, z, label) => setWaypoint(x, z, label),
    toast: (t) => toast(t),
    resume,
    startGame,
    openMap: () => {
      setMap(true);
      const hint = document.getElementById('fullmap-hover-info');
      if (hint) hint.textContent = document.body.classList.contains('touch-enabled') ? 'Tap to set a waypoint · Drag to pan · + / − to zoom' : 'Click to set a waypoint · Drag to pan · Scroll to zoom';
    },
    closeMap: () => setMap(false),
    isMapOpen: () => !!mapSystem?.isFullMapOpen
  });

  // ---- title screen ----------------------------------------------------------------------------------------------
  let skipTitle = (debug && !params.has('title')) || params.has('notitle') || params.get('show') === 'fx';
  try {
    if (sessionStorage.getItem('akl-skip-title')) {
      sessionStorage.removeItem('akl-skip-title');
      skipTitle = true;
    }
  } catch { /* storage unavailable */ }
  const savedAtStart = !!game.save?.read?.()?.data?.player;
  let titlePending = !skipTitle;
  let firstFrame = true;
  let introTips = !savedAtStart;

  function openTitle() {
    root.classList.add('is-title');
    game.setState('cutscene');
    cameraSystem?.setCameraPreset?.('drone', true);
    menus.openTitle({ hasSave: !!game.save?.read?.()?.data?.player });
    game.emit('ui:title', { open: true });
  }

  function startGame(newGame) {
    if (newGame) {
      // a clean save that keeps the settings, then the page again (every system starts from nothing)
      const keep = { ...settings };
      try {
        game.save.enabled = false;
        game.save.clear();
        localStorage.setItem(game.save.key, JSON.stringify({ version: game.save.version, savedAt: Date.now(), versions: { settings: 1 }, data: { settings: keep } }));
        sessionStorage.setItem('akl-skip-title', '1');
        sessionStorage.setItem('akl-new-game', '1');
      } catch { /* storage unavailable: the reload simply loads what there is */ }
      cards.setFade(1, 0.4);
      setTimeout(() => location.reload(), 420);
      return;
    }
    menus.closeTitle();
    cards.setFade(1, reducedMotion.matches ? 0 : 0.35);
    const pointer = game.input && !document.body.classList.contains('touch-enabled');
    if (pointer) game.input.requestPointerLock();
    setTimeout(() => {
      root.classList.remove('is-title');
      cameraSystem?.resetForTeleport?.();
      game.setState('playing');
      cards.setFade(0, 0.8);
      game.emit('ui:title', { open: false, newGame: !savedAtStart });
      if (introTips) showIntroTips();
    }, reducedMotion.matches ? 0 : 380);
  }

  function showIntroTips() {
    introTips = false;
    tips.intro();
  }
  try {
    if (sessionStorage.getItem('akl-new-game')) {
      sessionStorage.removeItem('akl-new-game');
      introTips = true;
      setTimeout(() => {
        game.emit('ui:title', { open: false, newGame: true });
        // (the title screen is skipped after a New game's reload, so its start isn't what queues the first tips)
        if (introTips) showIntroTips();
      }, 0);
    }
  } catch { /* storage unavailable */ }

  // ---- events ------------------------------------------------------------------------------------------------------
  const on = (type, fn) => game.on(type, fn);
  let presetAtPause = null;
  let failAfterRespawn = null; // { title, reason } of a job lost to a death or an arrest
  on('state', ({ state, prev }) => {
    // (a hold — a shop's menu, a respray — is the cutscene state without the bars: the HUD stays up)
    root.dataset.state = state === 'cutscene' && !game.letterbox ? 'hold' : state;
    if (state === 'paused' && !menus.titleOpen) {
      presetAtPause = cameraSystem?.activePresetId || null;
      menus.openPause(nextTab || menus.tab);
      nextTab = null;
    } else if (prev === 'paused') {
      menus.closePause();
      setMap(false);
      // (the pad's d-pad and V still switch cameras behind the menu: back to the one you played with)
      if (presetAtPause && cameraSystem && cameraSystem.activePresetId !== presetAtPause) cameraSystem.setCameraPreset(presetAtPause, true);
      presetAtPause = null;
    }
    cards.setLetterbox(state === 'cutscene' && game.letterbox && !menus.titleOpen && !root.classList.contains('is-title'));
  });
  on('player:damaged', (e) => hud.damageArc(e.dirX, e.dirZ, e.amount + e.armorDamage));
  on('player:died', () => {
    hud.setPrompt(null);
    cards.showCard('wasted', 'Wrecked', { sub: '' });
  });
  on('player:busted', () => {
    hud.setPrompt(null);
    cards.showCard('busted', 'Nicked', { sub: '' });
  });
  on('player:respawned', (e) => {
    // a job lost to the death or the arrest: its card follows WRECKED / NICKED, once back on the feet
    if (failAfterRespawn) {
      const f = failAfterRespawn;
      failAfterRespawn = null;
      cards.showCard('failed', 'Mission failed', { kicker: f.title, sub: f.reason || '' });
    }
    const police = e.at === 'police';
    hud.notify({
      title: e.place || (police ? 'Police station' : 'Hospital'),
      text: e.cost ? `${police ? 'Bail & paperwork' : 'Patched up'}: NZ$${Number(e.cost).toLocaleString('en-NZ')}.` : police ? 'Released with a stern word.' : 'Patched up on the house.',
      icon: police ? '!' : '+'
    });
  });
  on('money:changed', (e) => hud.moneyDelta(e.delta));
  // the player's ride is on its last legs: say so (at nothing left the engine dies and it's a wreck)
  on('vehicle:damaged', (e) => {
    const v = game.player?.vehicle;
    if (!v || e?.target !== v || v.mode === 'cyclist' || v.state === 'wrecked') return;
    if (v.health > 40) v._lastLegsTold = false; // (mended since)
    else if (v.health <= 25 && !v._lastLegsTold) {
      v._lastLegsTold = true;
      hud.setHelp('The engine\'s on its last legs: one more big hit and it\'s cooked. A Spray \'n\' Pray fixes it.', 4.5);
    }
  });
  on('vehicle:entered', (e) => hud.showVehicleName(e.vehicle));
  on('wanted:changed', (e) => {
    const up = (e.level || 0) > (e.prev || 0);
    hud.pingWanted(up);
    cards.flashSting(up ? 'up' : 'down');
  });
  on('wanted:cleared', (e) => {
    if (e?.reason === 'evaded' || e?.reason === 'evade' || e?.reason === 'lost') toast('Lost the cops. Sweet as.');
  });
  on('combat:hitmarker', (e) => hud.hitmarker(e?.kind || 'hit'));
  on('weapon:pickup', (e) => {
    const name = game.weapons?.defs?.[e?.weaponId]?.name || e?.weaponId;
    if (name) toast(`Picked up: ${name}`);
  });
  on('mission:started', (e) => {
    cards.showBanner(e?.title || 'New job', e?.giver ? `A job for ${e.giver}` : '', 3.6);
  });
  on('mission:objective', (e) => hud.setObjective(e?.text || null));
  on('mission:passed', (e) => {
    hud.setObjective(null);
    hud.setTimer(null);
    cards.showCard('passed', 'Mission passed', { kicker: e?.title, reward: e?.reward, stats: passStats(e?.stats) });
  });
  // the card's stats as a player reads them: times as m:ss, places as 1st / 2nd, medals named, nothing internal
  function passStats(stats) {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return stats;
    const rows = [];
    for (const [k, v] of Object.entries(stats)) {
      if (k === 'replay' || v == null || v === false) continue;
      if (k === 'time' && Number.isFinite(v)) rows.push(['Time', `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}.${Math.floor((v % 1) * 10)}`]);
      else if (k === 'place' && Number.isFinite(v)) rows.push(['Place', v === 1 ? '1st' : v === 2 ? '2nd' : v === 3 ? '3rd' : `${v}th`]);
      else if (k === 'medal' && typeof v === 'string') rows.push(['Medal', v.charAt(0).toUpperCase() + v.slice(1)]);
      else rows.push([String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), v]);
    }
    if (stats.replay) rows.push(['Replay', 'Reward × 0.2']);
    return rows;
  }
  on('mission:failed', (e) => {
    hud.setObjective(null);
    hud.setTimer(null);
    // walked away from it: no fanfare
    if (e?.code === 'aborted') {
      toast(`Job dropped: ${e?.title || 'mission'}`);
      return;
    }
    // dead or arrested: WRECKED / NICKED has the screen; the failed card waits for the respawn
    if (game.state === 'dead' || e?.code === 'died' || e?.code === 'busted') {
      failAfterRespawn = { title: e?.title, reason: e?.reason };
      return;
    }
    cards.showCard('failed', 'Mission failed', { kicker: e?.title, sub: e?.reason || '' });
  });
  on('mission:timer', (e) => hud.setTimer(e?.seconds ?? null, e?.label));
  on('mission:available', (e) => {
    const m = missionRows().find((x) => x.id === e?.id);
    hud.notify({ title: m?.giver || 'New job', text: m ? `New job: ${m.title}` : 'Check the map for the new marker.', icon: 'phone' });
  });
  on('dialogue', (e) => ui.subtitle(e?.who, e?.text, e?.seconds));
  on('radio:changed', (e) => hud.showRadio(e?.station || null));
  on('stat:changed', () => menus.refreshTab('stats'));
  on('pickup:collected', (e) => {
    // (cash shows on the money counter, a weapon in its own toast from weapon:pickup)
    if (!e || e.kind === 'money' || e.kind === 'cash' || e.kind === 'weapon') return;
    const kind = String(e.kind || 'pickup').replace(/[-_]/g, ' ');
    // (a mission's package says what it is; health and armour say how much)
    const value = e.kind !== 'package' && Number.isFinite(e.value) && e.value ? ` +${e.value}` : '';
    toast(`${e.pickup?.label || `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`}${value}`);
  });

  // ---- the API -----------------------------------------------------------------------------------------------------
  let hudWanted = true;
  function toast(text, seconds = 2.5) {
    cards.showToast(text, seconds);
  }
  const titleCase = (s) => String(s).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

  const ui = {
    root,
    menus: layer,
    /** The context prompt ("F — Enter Taxi"), or null; the key before " — " shows as a key cap */
    prompt(text, action) {
      hud.setPrompt(text, action);
    },
    /** A big centred title (style 'title' or none), or one of the big cards; null clears the banner (and a death card) */
    banner(title, sub = '', opts = null) {
      if (!title) {
        cards.showBanner(null);
        if (cards.deathCard) cards.hideCard();
        return;
      }
      const style = opts?.style;
      if (style === 'passed' || style === 'failed' || style === 'wasted' || style === 'busted') {
        cards.showCard(style, title, { sub, seconds: opts?.seconds });
        return;
      }
      if (!style && cards.deathCard) {
        // (the foundation's death & arrest banner: a caption under WRECKED / NICKED)
        cards.setCardSub(`${titleCase(title)}${sub ? ` · ${sub}` : ''}`);
        return;
      }
      // (a styled title goes by itself; an unstyled banner stays until banner(null), as it always did)
      cards.showBanner(title, sub, opts?.seconds || (style === 'title' ? 4 : 0));
    },
    toast,
    fade(to, seconds = 0.6) {
      cards.setFade(to, seconds);
    },
    /** Forces the crosshair on (true) or back to "while aiming" (false) */
    crosshair(show) {
      hud.forcedCrosshair = !!show;
    },
    objective(text) {
      hud.setObjective(text || null);
    },
    subtitle(who, text, seconds) {
      if (!settings.subtitles && text) return;
      hud.setSubtitle(who, text, seconds);
    },
    timer(seconds, label) {
      hud.setTimer(seconds, label);
    },
    help(text, seconds = 7) {
      hud.setHelp(text, seconds);
    },
    notify(opts) {
      return hud.notify(opts || {});
    },
    /** A first-time tip by id (hud/tips.js), shown once per save when the help box is free */
    tip(id) {
      tips.tip(id);
    },
    menu(opts) {
      return menus.menu(opts);
    },
    confirm(question, text, onYes, onNo) {
      menus.confirm(question, text, onYes, onNo);
    },
    hudVisible(show) {
      hudWanted = !!show;
      root.classList.toggle('is-hidden', !hudWanted);
    },
    setWaypoint,
    clearWaypoint,
    openPause(tab) {
      if (game.state === 'playing') {
        nextTab = tab || null;
        game.pause();
      } else if (menus.pauseOpen && tab) {
        menus.selectTab(tab);
      }
    },
    get titleOpen() {
      return menus.titleOpen;
    },
    get settings() {
      return { ...settings };
    },
    get waypoint() {
      return waypoint;
    },
    title: GAME_TITLE,

    update(dt, elapsed, realDt) {
      if (firstFrame) {
        firstFrame = false;
        // main.js picks its own time of day & camera after creating the game: ours go on top now
        timeApplied = true;
        apply('time', false);
        if (titlePending) {
          titlePending = false;
          openTitle();
        }
      }
      const state = game.state;
      const title = root.classList.contains('is-title');
      hud.update(dt, realDt);
      cards.update(realDt);
      menus.update(realDt);
      if (!title) tips.update(realDt);
      const routeBlip = pickRouteBlip();
      if (routeBlip !== gps.route.blip) gps.setTarget(routeBlip, routeBlip ? colorOf(routeBlip) : null);
      gps.update(realDt);

      // the radar: every other frame while it shows; ground tiles warm up behind the title screen
      if (title) {
        if (game.frame % 2 === 0) radar.prefetch();
      } else if (state === 'playing' && hudWanted && (game.frame & 1) === 0) {
        radar.draw(realDt * 2, performance.now());
      }

      // world markers: the routed blip and an objective (none when standing on it)
      let count = 0;
      if (state === 'playing' && hudWanted && !title && game.player) {
        const r = gps.route.blip;
        if (r && r.visible !== false && far(r)) fillMarker(count++, r);
        const o = pickObjectiveBlip(r);
        if (o && far(o)) fillMarker(count++, o);
      }
      hud.updateMarkers(markerTargets, count);

      // the waypoint is reached
      if (waypoint && game.frame % 15 === 0 && game.player && state === 'playing') {
        const p = game.player.position, w = blipXZ(waypoint);
        if (Math.hypot(p.x - w.x, p.z - w.z) < ARRIVE) {
          clearWaypoint();
          toast('You have arrived');
        }
      }

      if (debug && game.frame % 30 === 0) {
        const fps = document.getElementById('hud-fps')?.textContent || '';
        const q = document.getElementById('hud-quality')?.textContent || '';
        debugEl.textContent = `${fps} fps · ${q}`;
      }
    }
  };
  return ui;
}

export { createUI };
