import { isTypingInField } from '../city-config.js';

// The game's menus (DOM under #game-menus, css/game.css): the title screen over the live city, the pause menu with
// its tabs (the map, jobs, stats, settings, controls), the generic list menu shops & the phone open (ui.menu) and a
// yes / no dialog. One navigator drives whichever is on top from the keyboard (arrows, Enter, Esc, Q / E for tabs),
// a gamepad (d-pad or stick, A, B, LB / RB, polled here so it works while the game is paused) and the pointer.
// Items are real buttons and inputs: tab order and :focus-visible work as on any page.

const GAME_TITLE = 'City of Steals';
const TABS = [
  ['map', 'Map'],
  ['missions', 'Jobs'],
  ['stats', 'Stats'],
  ['settings', 'Settings'],
  ['controls', 'Controls']
];
const PAD = { a: 0, b: 1, lb: 4, rb: 5, up: 12, down: 13, left: 14, right: 15 };

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function button(cls, parent, text, onClick) {
  const b = el('button', cls, parent, text);
  b.type = 'button';
  b.dataset.nav = '';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const supportsPopover = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
function showPop(node) {
  node.hidden = false;
  if (supportsPopover && !node.matches(':popover-open')) {
    try {
      node.showPopover();
    } catch { /* not connected yet */ }
  }
}
function hidePop(node) {
  if (supportsPopover && node.matches(':popover-open')) node.hidePopover();
  node.hidden = true;
}

/** The game's wordmark */
function wordmark(parent, cls = '') {
  const logo = el('div', `g-logo ${cls}`, parent);
  logo.setAttribute('role', 'img');
  logo.setAttribute('aria-label', GAME_TITLE);
  el('span', 'g-logo-city', logo, 'City of');
  el('span', 'g-logo-steals', logo, 'Steals');
  return logo;
}

function createMenus(game, layer, ctx) {
  const { reducedMotion } = ctx;
  const stack = []; // open scopes, topmost last: { node, back(), tabs?, onKey? }
  let cur = null; // the current item of the top scope

  // ---------------------------------------------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------------------------------------------
  const top = () => stack[stack.length - 1] || null;

  function items(scope) {
    const list = scope.node.querySelectorAll('[data-nav]');
    const out = [];
    for (const n of list) {
      if (n.disabled || n.closest('[hidden]') || n.offsetParent === null) continue;
      out.push(n);
    }
    return out;
  }

  function setCurrent(node, focus = true) {
    if (cur && cur !== node) cur.classList.remove('is-cur');
    cur = node || null;
    if (!cur) return;
    cur.classList.add('is-cur');
    if (focus && document.activeElement !== cur) cur.focus({ preventScroll: true });
    cur.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function focusFirst(scope = top()) {
    if (!scope) return;
    const list = items(scope);
    const pref = scope.node.querySelector('[data-nav][data-default]:not([disabled])');
    setCurrent(pref && list.includes(pref) ? pref : list[0] || null);
  }

  // while any menu is up the game's own actions are held back (input.blocked): the menu has the keys and the pad
  const syncBlocked = () => {
    if (game.input) game.input.blocked = stack.length > 0;
  };
  // the menus' sounds (audio plays 'ui-move' / 'ui-select' / 'ui-back' for ui:navigate)
  const navEvent = { action: 'move' };
  const sound = (action) => {
    navEvent.action = action;
    game.emit('ui:navigate', navEvent);
  };

  function push(scope) {
    scope.openedAt = performance.now();
    stack.push(scope);
    if (scope.layered !== false) layer.classList.add('is-open');
    syncPad();
    syncBlocked();
    focusFirst(scope);
  }

  function remove(scope) {
    const i = stack.indexOf(scope);
    if (i < 0) return;
    stack.splice(i, 1);
    syncBlocked();
    if (cur && scope.node.contains(cur)) cur.classList.remove('is-cur');
    cur = null;
    layer.classList.toggle('is-open', stack.some((s) => s.layered !== false));
    const t = top();
    if (t) {
      const remembered = t.last && t.node.contains(t.last) ? t.last : null;
      if (remembered) setCurrent(remembered);
      else focusFirst(t);
    }
    syncPad();
  }

  const rowOf = (n) => n?.closest('[data-row]') || null;

  function move(dir) {
    const scope = top();
    if (!scope) return;
    const list = items(scope);
    if (!list.length) return;
    let i = list.indexOf(cur);
    if (i < 0) {
      setCurrent(list[0]);
      return;
    }
    const row = rowOf(cur);
    // up / down skip the rest of a row; land on the pressed choice of the next row
    let j = i;
    do {
      j = (j + dir + list.length) % list.length;
    } while (j !== i && row && rowOf(list[j]) === row);
    const nextRow = rowOf(list[j]);
    if (nextRow && nextRow !== row) {
      const pressed = nextRow.querySelector('[aria-pressed="true"][data-nav]');
      if (pressed && list.includes(pressed)) j = list.indexOf(pressed);
      else if (dir < 0) j = list.indexOf(nextRow.querySelector('[data-nav]'));
    }
    if (list[j] !== cur) sound('move');
    setCurrent(list[j]);
    scope.last = cur;
  }

  /** Left / right: within a row of choices, a slider's value, or the tabs */
  function side(dir, fromPad) {
    const scope = top();
    if (!scope) return false;
    if (cur?.type === 'range') {
      if (!fromPad) return false; // (the keyboard moves a focused slider itself)
      const step = Number(cur.step) || 1;
      const before = cur.value;
      cur.value = String(Math.min(Number(cur.max), Math.max(Number(cur.min), Number(cur.value) + dir * step)));
      if (cur.value !== before) sound('move');
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const row = rowOf(cur);
    if (row) {
      const list = items(scope).filter((n) => rowOf(n) === row);
      const i = list.indexOf(cur);
      const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
      if (next && next !== cur) {
        sound('move');
        setCurrent(next);
      }
      return true;
    }
    if (scope.tabs) {
      sound('move');
      scope.tabs(dir);
      return true;
    }
    return false;
  }

  function activate() {
    if (!cur || cur.type === 'range') return;
    const scope = top();
    if (scope) scope.last = cur; // (a dialog it opens hands the focus back here)
    cur.click(); // (the click makes the sound, see below)
  }

  function back() {
    const scope = top();
    if (!scope?.back) return;
    sound('back');
    scope.back();
  }

  // a choice made by any means (Enter, A, a click, a tap): select, or a dull "no" for a greyed-out item
  document.addEventListener('click', (e) => {
    const n = e.target instanceof Element ? e.target.closest('[data-nav]') : null;
    if (!n || n.type === 'range' || !stack.some((s) => s.node.contains(n))) return;
    sound(n.getAttribute('aria-disabled') === 'true' ? 'back' : 'select');
  }, { capture: true });

  // keyboard: on the window in the capture phase, after the game's input (which pauses & resumes on Esc / P)
  window.addEventListener('keydown', (e) => {
    const scope = top();
    if (!scope) return;
    if (isTypingInField(e)) {
      if (e.code === 'Escape') e.target.blur?.();
      return;
    }
    // (the key that just opened this menu — Esc or P pausing the game — must not close it again)
    // (nor reach the full map's own Esc, which would close the map the pause menu just opened)
    if (performance.now() - scope.openedAt < 120 && (e.code === 'Escape' || e.code === 'KeyP' || e.code === 'Backspace')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (scope.onKey && scope.onKey(e)) return;
    let handled = true;
    switch (e.code) {
      case 'ArrowUp':
        move(-1);
        break;
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowLeft':
        handled = side(-1, false);
        break;
      case 'ArrowRight':
        handled = side(1, false);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (e.repeat) break;
        if (document.activeElement && document.activeElement !== document.body && scope.node.contains(document.activeElement) && document.activeElement.matches('[data-nav]')) setCurrent(document.activeElement, false);
        activate();
        break;
      case 'Escape':
      case 'Backspace':
        if (!e.repeat) back();
        break;
      case 'KeyQ':
      case 'PageUp':
        if (scope.tabs) scope.tabs(-1);
        else handled = false;
        break;
      case 'KeyE':
      case 'PageDown':
        if (scope.tabs) scope.tabs(1);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  // the pointer: hovering an item makes it the current one
  layer.addEventListener('pointerover', (e) => {
    const n = e.target instanceof Element ? e.target.closest('[data-nav]') : null;
    const scope = top();
    if (!n || !scope || !scope.node.contains(n) || n === cur || e.pointerType === 'touch') return;
    setCurrent(n, false);
    scope.last = n;
  });
  layer.addEventListener('focusin', (e) => {
    const n = e.target instanceof Element ? e.target.closest('[data-nav]') : null;
    const scope = top();
    if (n && scope && scope.node.contains(n) && n !== cur) {
      setCurrent(n, false);
      scope.last = n;
    }
  });

  // gamepad, polled while a menu is up
  const prev = new Uint8Array(17);
  let stickHeld = 0, stickRepeat = 0, stickDir = 0;
  const readPad = () => {
    try {
      const pads = navigator.getGamepads?.() || [];
      for (const p of pads) if (p?.connected && p.mapping === 'standard') return p;
    } catch { /* blocked by permissions policy */ }
    return null;
  };
  function syncPad() {
    const p = readPad();
    for (let i = 0; i < 17; i++) prev[i] = p?.buttons?.[i]?.pressed ? 1 : 0;
    stickDir = 0;
  }
  function pollPad(realDt) {
    const p = readPad();
    if (!p) return;
    const down = (i) => (p.buttons[i]?.pressed ? 1 : 0);
    const edge = (i) => down(i) && !prev[i];
    if (edge(PAD.up)) move(-1);
    if (edge(PAD.down)) move(1);
    if (edge(PAD.left)) side(-1, true);
    if (edge(PAD.right)) side(1, true);
    if (edge(PAD.a)) activate();
    if (edge(PAD.b)) back();
    const scope = top();
    if (scope?.tabs) {
      if (edge(PAD.lb)) scope.tabs(-1);
      if (edge(PAD.rb)) scope.tabs(1);
    }
    for (let i = 0; i < 17; i++) prev[i] = down(i);
    // the left stick, with key-like repeat
    const ay = p.axes?.[1] || 0, ax = p.axes?.[0] || 0;
    const dir = Math.abs(ay) > 0.6 ? (ay > 0 ? 2 : -2) : Math.abs(ax) > 0.6 ? (ax > 0 ? 1 : -1) : 0;
    if (dir !== stickDir) {
      stickDir = dir;
      stickHeld = 0;
      stickRepeat = 0;
      if (dir) stickStep(dir);
    } else if (dir) {
      stickHeld += realDt;
      if (stickHeld > 0.38 && (stickRepeat -= realDt) <= 0) {
        stickRepeat = 0.11;
        stickStep(dir);
      }
    }
    if (ctx.onPadUse) ctx.onPadUse();
  }
  function stickStep(dir) {
    if (dir === 2) move(1);
    else if (dir === -2) move(-1);
    else side(dir, true);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Panels shared by the title screen & the pause menu
  // ---------------------------------------------------------------------------------------------------------------
  function section(parent, title) {
    const s = el('section', 'g-sec', parent);
    if (title) el('h3', 'g-sec-title', s, title);
    return s;
  }

  function choiceRow(parent, label, options, value, onPick) {
    const row = el('div', 'g-field', parent);
    el('span', 'g-field-label', row, label);
    const seg = el('div', 'g-seg', row);
    seg.dataset.row = '';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const btns = options.map(([v, text]) => {
      const b = button('g-seg-btn', seg, text, () => {
        for (const o of btns) o.setAttribute('aria-pressed', String(o === b));
        onPick(v);
      });
      b.setAttribute('aria-pressed', String(v === value));
      return b;
    });
    return row;
  }

  function sliderRow(parent, label, { min, max, step, value, format }, onChange) {
    const row = el('label', 'g-field', parent);
    el('span', 'g-field-label', row, label);
    const wrap = el('span', 'g-range', row);
    const input = el('input', '', wrap);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.dataset.nav = '';
    const out = el('output', 'g-range-val', wrap, format(value));
    const fill = () => wrap.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    fill();
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      fill();
      onChange(v);
    });
    return row;
  }

  function toggleRow(parent, label, value, onChange) {
    const row = el('div', 'g-field', parent);
    el('span', 'g-field-label', row, label);
    const b = button('g-toggle', row, value ? 'On' : 'Off', () => {
      const v = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(v));
      b.textContent = v ? 'On' : 'Off';
      onChange(v);
    });
    b.setAttribute('aria-pressed', String(!!value));
    b.setAttribute('aria-label', label);
    return row;
  }

  function buildSettings(parent) {
    parent.replaceChildren();
    const s = ctx.settings;
    const grid = el('div', 'g-settings', parent);
    const gfx = section(grid, 'Picture');
    choiceRow(gfx, 'Graphics', [['ultra', 'Ultra'], ['high', 'High'], ['medium', 'Medium'], ['auto', 'Auto']], ctx.getQuality(), (v) => ctx.setSetting('quality', v));
    choiceRow(gfx, 'Time of day', [['golden', 'Golden hour'], ['midday', 'Midday'], ['twilight', 'Blue hour'], ['midnight', 'Night']], s.time, (v) => ctx.setSetting('time', v));
    sliderRow(gfx, 'HUD size', { min: 0.8, max: 1.25, step: 0.05, value: s.hudScale, format: (v) => `${Math.round(v * 100)}%` }, (v) => ctx.setSetting('hudScale', v));
    toggleRow(gfx, 'Subtitles', s.subtitles, (v) => ctx.setSetting('subtitles', v));
    const look = section(grid, 'Look & aim');
    sliderRow(look, 'Look sensitivity', { min: 0.3, max: 2.5, step: 0.05, value: s.sensitivity, format: (v) => `${v.toFixed(2)}×` }, (v) => ctx.setSetting('sensitivity', v));
    toggleRow(look, 'Invert look up / down', s.invertY, (v) => ctx.setSetting('invertY', v));
    const snd = section(grid, 'Sound');
    toggleRow(snd, 'Sound', s.sound, (v) => ctx.setSetting('sound', v));
    const pct = (v) => `${Math.round(v * 100)}%`;
    sliderRow(snd, 'Master volume', { min: 0, max: 1, step: 0.05, value: s.master, format: pct }, (v) => ctx.setSetting('master', v));
    sliderRow(snd, 'Effects', { min: 0, max: 1, step: 0.05, value: s.sfx, format: pct }, (v) => ctx.setSetting('sfx', v));
    sliderRow(snd, 'Radio', { min: 0, max: 1, step: 0.05, value: s.music, format: pct }, (v) => ctx.setSetting('music', v));
    if (!ctx.hasVolume()) el('p', 'g-note-small', snd, 'Volume levels apply once the game\'s audio is loaded.');
  }

  function buildControls(parent) {
    parent.replaceChildren();
    const device = game.input?.device === 'touch' ? 'touch' : game.input?.device === 'gamepad' ? 'gamepad' : 'keyboard';
    const wrap = el('div', 'g-controls', parent);
    const head = el('div', 'g-controls-head', wrap);
    const table = el('table', 'g-ctable', wrap);
    const render = (dev) => {
      for (const b of head.children) b.setAttribute('aria-pressed', String(b.dataset.dev === dev));
      table.replaceChildren();
      const tb = el('tbody', '', table);
      for (const [group, rows] of ctx.controlRows(dev)) {
        const gr = el('tr', 'g-ctable-group', tb);
        el('th', '', gr, group).colSpan = 2;
        for (const [action, keys] of rows) {
          const tr = el('tr', '', tb);
          el('td', 'g-ctable-action', tr, action);
          const td = el('td', 'g-ctable-keys', tr);
          for (const k of [].concat(keys)) el('kbd', 'g-kbd', td, k);
        }
      }
    };
    head.dataset.row = '';
    for (const [dev, text] of [['keyboard', 'Keyboard & mouse'], ['gamepad', 'Gamepad'], ['touch', 'Touch']]) {
      const b = button('g-seg-btn', head, text, () => render(dev));
      b.dataset.dev = dev;
    }
    render(device);
  }

  function buildStats(parent) {
    parent.replaceChildren();
    const rows = ctx.statRows();
    const grid = el('div', 'g-stats', parent);
    for (const [label, value, accent] of rows) {
      const tile = el('div', `g-stat${accent ? ' is-accent' : ''}`, grid);
      el('span', 'g-stat-value', tile, value);
      el('span', 'g-stat-label', tile, label);
    }
    if (!rows.length) el('p', 'g-empty', parent, 'No stats yet. Go and make some trouble.');
  }

  function buildMissions(parent) {
    parent.replaceChildren();
    const list = ctx.missionRows();
    const active = game.missions?.active || null;
    const wrap = el('div', 'g-jobs', parent);
    if (active) {
      const now = el('div', 'g-job-active', wrap);
      el('span', 'g-job-kicker', now, 'On the job');
      el('b', 'g-job-title', now, active.title || active.id || 'Job');
      const obj = game.missions?.objective;
      if (obj) el('p', 'g-job-obj', now, obj);
      const abort = button('g-btn g-btn-ghost', now, 'Walk away from this job', () => {
        confirm('Walk away from this job?', 'You lose any progress on it.', () => {
          game.missions?.abort?.();
          buildMissions(parent);
        });
      });
      abort.dataset.default = '';
    }
    if (!list.length) {
      el('p', 'g-empty', wrap, 'No jobs on the board yet. Keep your ear to the ground.');
      return;
    }
    const ul = el('div', 'g-job-list', wrap);
    for (const m of list) {
      const status = m.done ? 'Done' : active && active.id === m.id ? 'Active' : m.available ? 'Available' : 'Locked';
      const b = button(`g-job is-${status.toLowerCase()}`, ul, null, () => {
        if (Number.isFinite(m.x) && Number.isFinite(m.z)) {
          ctx.setWaypoint(m.x, m.z, m.title);
          ctx.toast(`Waypoint set: ${m.title}`);
        }
      });
      el('span', 'g-job-name', b, m.title || m.id);
      el('span', 'g-job-giver', b, m.giver ? `from ${m.giver}` : m.kind || '');
      el('span', 'g-job-status', b, status);
      if (Number.isFinite(m.x)) b.title = 'Set a waypoint to it';
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Title screen
  // ---------------------------------------------------------------------------------------------------------------
  const title = el('div', 'g-title', layer);
  title.hidden = true;
  const titleScrim = el('div', 'g-title-scrim', title);
  void titleScrim;
  const titleMain = el('div', 'g-title-main', title);
  wordmark(titleMain, 'g-logo-big');
  el('p', 'g-title-tag', titleMain, 'Tāmaki Makaurau · a Slop Auckland caper');
  const titleNav = el('nav', 'g-title-menu', titleMain);
  titleNav.setAttribute('aria-label', 'Title menu');
  const titlePanel = el('div', 'g-title-panel', title);
  titlePanel.hidden = true;
  const titlePanelHead = el('div', 'g-title-panel-head', titlePanel);
  const titlePanelBack = button('g-btn g-btn-ghost g-back', titlePanelHead, '← Back', () => closeTitlePanel());
  const titlePanelTitle = el('h2', 'g-title-panel-title', titlePanelHead);
  const titlePanelBody = el('div', 'g-title-panel-body', titlePanel);
  void titlePanelBack;
  const titleFoot = el('footer', 'g-title-foot', title);
  const titleHint = el('span', 'g-title-hint', titleFoot);
  el('span', 'g-title-credit', titleFoot, 'Map data © OpenStreetMap contributors · Elevation LINZ (CC BY 4.0) · after Slop New York');

  const titleScope = { node: title, back: () => (titlePanel.hidden ? null : closeTitlePanel()) };
  const panelScope = { node: titlePanel, back: () => closeTitlePanel() };

  function openTitle({ hasSave }) {
    titleNav.replaceChildren();
    if (hasSave) {
      const c = button('g-title-item', titleNav, 'Continue', () => ctx.startGame(false));
      c.dataset.default = '';
    }
    const ng = button('g-title-item', titleNav, 'New game', () => {
      if (hasSave) confirm('Start a new game?', 'Your saved progress (money, jobs, wanted record) is wiped.', () => ctx.startGame(true));
      else ctx.startGame(false);
    });
    if (!hasSave) ng.dataset.default = '';
    button('g-title-item', titleNav, 'Settings', () => openTitlePanel('Settings', buildSettings));
    button('g-title-item', titleNav, 'Controls', () => openTitlePanel('Controls', buildControls));
    titleHint.textContent = hintText('title');
    title.hidden = false;
    titlePanel.hidden = true;
    titleMain.hidden = false;
    push(titleScope);
  }

  function openTitlePanel(name, build) {
    titlePanelTitle.textContent = name;
    build(titlePanelBody);
    titleMain.hidden = true;
    titlePanel.hidden = false;
    push(panelScope);
  }

  function closeTitlePanel() {
    titlePanel.hidden = true;
    titleMain.hidden = false;
    remove(panelScope);
  }

  function closeTitle() {
    remove(panelScope);
    remove(titleScope);
    title.classList.add('is-leaving');
    setTimeout(() => {
      title.hidden = true;
      title.classList.remove('is-leaving');
    }, reducedMotion.matches ? 0 : 520);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pause menu
  // ---------------------------------------------------------------------------------------------------------------
  const pause = el('div', 'g-pause', layer);
  pause.hidden = true;
  const bar = el('header', 'g-pause-bar', pause);
  wordmark(bar, 'g-logo-small');
  const tabNav = el('nav', 'g-tabs', bar);
  tabNav.setAttribute('role', 'tablist');
  tabNav.dataset.row = '';
  const tabBtns = new Map();
  el('kbd', 'g-kbd g-tab-hint g-tab-hint-l', tabNav, 'Q');
  for (const [id, text] of TABS) {
    const b = button('g-tab', tabNav, text, () => selectTab(id));
    b.setAttribute('role', 'tab');
    tabBtns.set(id, b);
  }
  el('kbd', 'g-kbd g-tab-hint g-tab-hint-r', tabNav, 'E');
  const pauseMeta = el('div', 'g-pause-meta', bar);
  const resumeBtn = button('g-btn g-resume', bar, 'Resume', () => ctx.resume(true));
  void resumeBtn;
  const pauseBody = el('main', 'g-pause-body', pause);
  const panels = new Map();
  for (const [id] of TABS) {
    const p = el('section', `g-panel g-panel-${id}`, pauseBody);
    p.hidden = true;
    p.setAttribute('role', 'tabpanel');
    panels.set(id, p);
  }
  const pauseFoot = el('footer', 'g-pause-foot', pause);
  let tab = 'map';
  let pauseOpen = false;
  const pauseScope = {
    node: pause,
    back: () => ctx.resume(false),
    // (with the map open the game's input leaves P alone)
    onKey: (e) => {
      if (e.code !== 'KeyP' || !ctx.isMapOpen() || e.repeat) return false;
      e.preventDefault();
      e.stopImmediatePropagation();
      ctx.resume(false);
      return true;
    },
    tabs: (dir) => {
      const i = TABS.findIndex(([id]) => id === tab);
      selectTab(TABS[(i + dir + TABS.length) % TABS.length][0]);
      // (Q / E, LB / RB: the highlight goes with the tab, not left on the old one or on an item now hidden)
      setCurrent(tabBtns.get(tab));
      pauseScope.last = cur;
    }
  };

  function selectTab(id) {
    tab = id;
    for (const [tid, b] of tabBtns) {
      b.setAttribute('aria-selected', String(tid === id));
      b.setAttribute('aria-pressed', String(tid === id));
    }
    for (const [tid, p] of panels) p.hidden = tid !== id;
    pause.dataset.tab = id;
    const p = panels.get(id);
    if (id === 'map') {
      p.replaceChildren();
      ctx.openMap();
    } else {
      ctx.closeMap();
      if (id === 'settings') buildSettings(p);
      else if (id === 'controls') buildControls(p);
      else if (id === 'stats') buildStats(p);
      else if (id === 'missions') buildMissions(p);
    }
    pauseFoot.textContent = hintText(id === 'map' ? 'map' : 'pause');
    // the keyboard stays on the tabs after a switch
    const tb = tabBtns.get(id);
    if (cur && rowOf(cur) === tabNav) setCurrent(tb);
  }

  function openPause(which) {
    if (which && !tabBtns.has(which)) which = null;
    if (pauseOpen) {
      if (which && which !== tab) selectTab(which);
      return;
    }
    pauseOpen = true;
    pause.hidden = false;
    pauseMeta.textContent = ctx.pauseMeta();
    tabBtns.get(which || tab).dataset.default = '';
    for (const [tid, b] of tabBtns) if (tid !== (which || tab)) delete b.dataset.default;
    push(pauseScope);
    selectTab(which || tab);
  }

  function closePause() {
    if (!pauseOpen) return;
    pauseOpen = false;
    ctx.closeMap();
    pause.hidden = true;
    remove(pauseScope);
  }

  function refreshTab(which) {
    if (!pauseOpen || tab !== which) return;
    if (which === 'stats') buildStats(panels.get('stats'));
    if (which === 'missions') buildMissions(panels.get('missions'));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Generic list menu (ui.menu): shops, the phone
  // ---------------------------------------------------------------------------------------------------------------
  const list = el('div', 'g-listmenu', document.body);
  list.hidden = true;
  if (supportsPopover) list.setAttribute('popover', 'manual');
  list.setAttribute('role', 'dialog');
  const listHead = el('header', 'g-list-head', list);
  const listTitle = el('h2', 'g-list-title', listHead);
  const listSub = el('p', 'g-list-sub', listHead);
  // (no Esc on a phone: a close button of its own, out of the arrow keys' way)
  const listClose = el('button', 'g-list-close', listHead);
  listClose.type = 'button';
  listClose.setAttribute('aria-label', 'Close');
  listClose.addEventListener('click', () => listHandle?.close());
  const listItems = el('div', 'g-list-items', list);
  listItems.setAttribute('role', 'menu');
  const listFoot = el('footer', 'g-list-foot', list);
  const listMoney = el('span', 'g-list-money', listFoot);
  const listHint = el('span', 'g-list-hint', listFoot);
  let listHandle = null;

  function menu(opts = {}) {
    if (listHandle) listHandle.close();
    let open = true;
    let itemsDef = [];
    const scope = { node: list, back: () => handle.close(), layered: false };
    const handle = {
      get open() {
        return open;
      },
      close() {
        if (!open) return;
        open = false;
        if (listHandle === handle) listHandle = null;
        remove(scope);
        if (!listHandle) hidePop(list);
        try {
          opts.onClose?.(handle);
        } catch (error) {
          console.error('[ui] menu onClose threw:', error);
        }
      },
      setItems(next) {
        itemsDef = Array.isArray(next) ? next : [];
        render();
      },
      refresh() {
        render();
      },
      setTitle(t, s) {
        listTitle.textContent = t || '';
        listSub.textContent = s || '';
        listSub.hidden = !s;
      }
    };
    function render() {
      const keep = cur && list.contains(cur) ? [...listItems.children].indexOf(cur) : 0;
      listItems.replaceChildren();
      const money = game.player?.money ?? Infinity;
      itemsDef.forEach((it, i) => {
        const b = button('g-list-item', listItems, null, () => {
          if (it.disabled) return;
          try {
            it.onSelect?.(it, i, handle);
          } catch (error) {
            console.error('[ui] menu item threw:', error);
          }
          if (open) {
            listMoney.textContent = moneyText();
            render();
          }
        });
        b.setAttribute('role', 'menuitem');
        if (it.disabled) b.setAttribute('aria-disabled', 'true');
        b.classList.toggle('is-disabled', !!it.disabled);
        const main = el('span', 'g-list-label', b, it.label ?? '');
        void main;
        if (Number.isFinite(it.price)) {
          const pr = el('span', 'g-list-price', b, it.price > 0 ? `NZ$${Math.round(it.price).toLocaleString('en-NZ')}` : 'Free');
          if (it.price > money) pr.classList.add('is-dear');
        } else if (it.right != null) {
          el('span', 'g-list-price', b, String(it.right));
        }
        if (it.detail) el('span', 'g-list-item-detail', b, it.detail);
      });
      const next = listItems.children[Math.min(keep, listItems.children.length - 1)];
      if (next && top() === scope) setCurrent(next);
    }
    const moneyText = () => (game.player ? `NZ$${Math.round(game.player.money).toLocaleString('en-NZ')}` : '');
    handle.setTitle(opts.title, opts.subtitle);
    listMoney.textContent = moneyText();
    listHint.textContent = hintText('list');
    itemsDef = Array.isArray(opts.items) ? opts.items : [];
    listHandle = handle;
    showPop(list);
    render();
    push(scope);
    // a mouse under pointer lock could not reach the menu
    game.input?.exitPointerLock?.();
    return handle;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Yes / no
  // ---------------------------------------------------------------------------------------------------------------
  const dlg = el('div', 'g-confirm', document.body);
  dlg.hidden = true;
  if (supportsPopover) dlg.setAttribute('popover', 'manual');
  dlg.setAttribute('role', 'alertdialog');
  const dlgTitle = el('h2', 'g-confirm-title', dlg);
  const dlgText = el('p', 'g-confirm-text', dlg);
  const dlgRow = el('div', 'g-confirm-row', dlg);
  dlgRow.dataset.row = '';
  let dlgYes = null, dlgNo = null;
  const yesBtn = button('g-btn g-btn-danger', dlgRow, 'Yes', () => closeConfirm(true));
  const noBtn = button('g-btn', dlgRow, 'No', () => closeConfirm(false));
  void yesBtn;
  const dlgScope = { node: dlg, back: () => closeConfirm(false) };

  function confirm(question, text, onYes, onNo) {
    dlgTitle.textContent = question;
    dlgText.textContent = text || '';
    dlgText.hidden = !text;
    dlgYes = onYes;
    dlgNo = onNo;
    noBtn.dataset.default = '';
    showPop(dlg);
    push(dlgScope);
  }

  function closeConfirm(yes) {
    hidePop(dlg);
    remove(dlgScope);
    const fn = yes ? dlgYes : dlgNo;
    dlgYes = dlgNo = null;
    fn?.();
  }

  // ---------------------------------------------------------------------------------------------------------------
  function hintText(where) {
    const dev = document.body.classList.contains('touch-enabled') && game.input?.device !== 'gamepad' ? 'touch' : game.input?.device;
    if (dev === 'touch') return where === 'map' ? 'Tap the map to set a waypoint · tap it again to clear it' : '';
    if (dev === 'gamepad') {
      return {
        title: 'D-pad choose · A select · B back',
        pause: 'D-pad choose · A select · LB / RB tabs · B resume',
        map: 'LB / RB tabs · B resume',
        list: 'A choose · B close'
      }[where];
    }
    return {
      title: '↑ ↓ choose · Enter select · Esc back',
      pause: '↑ ↓ choose · Enter select · Q / E tabs · Esc resume',
      map: `Click to set a waypoint, click it again to clear it${ctx.debug ? ' · Shift-click teleports (debug)' : ''} · Q / E tabs · Esc resume`,
      list: '↑ ↓ choose · Enter select · Esc close'
    }[where];
  }

  function update(realDt) {
    if (stack.length) pollPad(realDt);
  }

  return {
    openTitle, closeTitle, openPause, closePause, selectTab, refreshTab, menu, confirm, update, wordmark,
    get titleOpen() {
      return stack.includes(titleScope);
    },
    get pauseOpen() {
      return pauseOpen;
    },
    get tab() {
      return tab;
    },
    get anyOpen() {
      return stack.length > 0;
    },
    get listOpen() {
      return !!listHandle;
    }
  };
}

export { createMenus, GAME_TITLE, wordmark };
