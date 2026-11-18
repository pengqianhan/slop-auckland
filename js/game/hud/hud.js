import { getLocationLabel } from '../../city-config.js';
import { GEO } from '../../akl-geodata.js';

// The in-game HUD's widgets (DOM under #game-ui, styled by css/game.css): health & armour hugging the radar, money
// with its delta ticker, wanted stars, what's in hand (fists or the cricket bat), the focus dot, hit markers, damage
// arcs, the arrest meter, the low-health
// vignette, the speedometer, vehicle & place name cards, the objective, subtitles, the mission timer, the help box,
// phone notifications, the context prompt, the radio ticker and world-space markers.
// Every write is dirty-checked; what moves every frame moves by transform; nothing here allocates per frame
// except text that actually changed.

const SVG = 'http://www.w3.org/2000/svg';
const STAR = 'M12 2.4l2.86 6.2 6.74.72-5.04 4.56 1.42 6.66L12 17.1l-5.98 3.44 1.42-6.66L2.4 9.32l6.74-.72z';
const WEAPON_ICONS = {
  fist: '<path d="M21 4.5h15.5a6.5 6.5 0 0 1 6.5 6.5v1.5a6.5 6.5 0 0 1-6.5 6.5H30l-3.4 3H20a2 2 0 0 1-2-2V6.5a2 2 0 0 1 3-2z"/><path d="M11 9h6.5v8.5H11z"/><path d="M24.6 4.8v7.4M30.4 4.8v7.4M36.2 5.2v7M18.4 12.6h9" stroke="#05080f" stroke-width="1.5" fill="none"/>',
  // a cricket bat
  bat: '<path d="M6 7h30l5 3.4h18.4a1.6 1.6 0 0 1 0 3.2H41L36 17H6a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3z"/><path d="M46 10.4v3.2M50 10.4v3.2M54 10.4v3.2" stroke="#05080f" stroke-width="1.2"/>',
  unknown: '<rect x="20" y="7" width="24" height="10" rx="3"/>'
};
const SPEAKER_COLORS = ['#ffcb2e', '#2de2d0', '#ff7aa8', '#9db8ff', '#5cf28c', '#ff9f43', '#c38bff'];
const GEARS = [0, 22, 44, 70, 100, 135]; // km/h where each gear starts
const GEAR_TEXT = ['', 'Gear 1', 'Gear 2', 'Gear 3', 'Gear 4', 'Gear 5', 'Gear 6'];
const LOW_HEALTH = 0.3;
// notification icons by name (text glyphs, no emoji)
const NOTE_ICONS = { phone: '☎︎', cash: '$', money: '$', star: '★', police: '★', mission: '!', home: '⌂', health: '+', kiwi: '✦', race: '⚑' };

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

const fmtMoney = (n) => Math.round(n).toLocaleString('en-NZ');
const fmtTime = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** Splits "F — Enter Taxi" into its key and its words */
function splitPrompt(text) {
  const m = /^(.{1,14}?)\s+[—–-]\s+(.+)$/.exec(text);
  return m ? [m[1], m[2]] : ['', text];
}

/** Text with [KEY] and {action} marks as text & <kbd> nodes */
function richText(parent, text, input) {
  parent.replaceChildren();
  const re = /\[([^\]]{1,14})\]|\{(\w+)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    el('kbd', 'g-kbd', parent, m[1] || input?.label?.(m[2]) || m[2]);
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function createHud(game, root, { reducedMotion }) {
  const last = new Map();
  const write = (key, value, apply) => {
    if (last.get(key) === value) return false;
    last.set(key, value);
    apply(value);
    return true;
  };

  // ---- weapon icon sprite -----------------------------------------------------------------------------------------
  const sprite = svgEl('svg', { class: 'g-sprite', width: 0, height: 0, 'aria-hidden': 'true' }, root);
  const defs = svgEl('defs', {}, sprite);
  for (const [id, body] of Object.entries(WEAPON_ICONS)) {
    const sym = svgEl('symbol', { id: `gw-${id}`, viewBox: '0 0 64 24' }, defs);
    sym.innerHTML = body; // (static markup from this file)
  }
  const starSym = svgEl('symbol', { id: 'g-star', viewBox: '0 0 24 24' }, defs);
  svgEl('path', { d: STAR }, starSym);

  // ---- centre: crosshair, hit marker, damage arcs, markers -----------------------------------------------------
  const vignette = el('div', 'g-vignette', root);
  const hurt = el('div', 'g-hurtflash', root);
  const markers = el('div', 'g-markers', root);
  const markerEls = [];
  for (let i = 0; i < 2; i++) {
    const m = el('div', 'g-marker', markers);
    m.hidden = true;
    const pin = el('div', 'g-marker-pin', m);
    el('span', 'g-marker-chev', pin);
    const dist = el('span', 'g-marker-dist', m);
    markerEls.push({ m, pin, dist, x: -1, y: -1, rot: 0, visible: false, text: '', color: '' });
  }
  // the focus dot: where a swing goes while squared up (the focus button)
  const crosshair = el('div', 'g-ch', root);
  crosshair.hidden = true;
  crosshair.dataset.kind = 'melee';
  el('span', 'g-ch-dot', crosshair);
  const hitmark = el('div', 'g-hit', root);
  for (let i = 0; i < 4; i++) el('span', 'g-hit-arm', hitmark);
  const dmgWrap = el('div', 'g-dmg', root);
  const dmgArcs = [];
  for (let i = 0; i < 4; i++) dmgArcs.push(el('div', 'g-dmg-arc', dmgWrap));
  let dmgNext = 0;

  // ---- the HUD proper (hidden outside play) ----------------------------------------------------------------------
  const hud = el('div', 'g-hud', root);
  const tl = el('div', 'g-corner g-tl', hud);
  const help = el('div', 'g-help', tl);
  help.hidden = true;
  const helpText = el('p', '', help);

  const tc = el('div', 'g-tc', hud);
  const timer = el('div', 'g-timer', tc);
  timer.hidden = true;
  const timerLabel = el('span', 'g-timer-label', timer);
  const timerTime = el('span', 'g-timer-time', timer);
  const radio = el('div', 'g-radio', tc);
  radio.hidden = true;
  el('span', 'g-radio-kicker', radio, 'Radio');
  const radioName = el('b', 'g-radio-name', radio);
  const radioGenre = el('span', 'g-radio-genre', radio);

  const tr = el('div', 'g-corner g-tr', hud);
  const weapon = el('div', 'g-weapon', tr);
  const weaponIcon = svgEl('svg', { class: 'g-weapon-icon', viewBox: '0 0 64 24', 'aria-hidden': 'true' }, weapon);
  const weaponUse = svgEl('use', { href: '#gw-fist' }, weaponIcon);
  const weaponMeta = el('div', 'g-weapon-meta', weapon);
  const weaponName = el('span', 'g-weapon-name', weaponMeta, 'Fists');
  // which of the two (1 / 2: fists / bat): two small pips, the one in hand lit
  const weaponPips = el('span', 'g-weapon-pips', weaponMeta);
  const pipEls = [el('i', '', weaponPips), el('i', '', weaponPips)];
  const trCol = el('div', 'g-trcol', tr);
  const wanted = el('div', 'g-wanted', trCol);
  wanted.setAttribute('aria-label', 'Wanted level 0');
  const starEls = [];
  for (let i = 0; i < 5; i++) {
    const s = svgEl('svg', { class: 'g-star', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, wanted);
    svgEl('use', { href: '#g-star' }, s);
    starEls.push(s);
  }
  // the arrest meter under the stars: fills while an officer has hands on the player (police.js arrestProgress)
  const arrestEl = el('div', 'g-arrest', trCol);
  el('span', 'g-arrest-label', arrestEl, 'Cuffs');
  const arrestBar = el('span', 'g-arrest-bar', arrestEl);
  const arrestFill = el('span', '', arrestBar);
  const money = el('div', 'g-money', trCol);
  el('span', 'g-cur', money, 'NZ$');
  const moneyAmt = el('span', 'g-amt', money, '0');
  const delta = el('div', 'g-delta', trCol);
  const notes = el('div', 'g-notes', hud);

  const bl = el('div', 'g-corner g-bl', hud);
  const radarWrap = el('button', 'g-radar', bl);
  radarWrap.type = 'button';
  radarWrap.setAttribute('aria-label', 'Open the map');
  radarWrap.tabIndex = -1;
  const radarCanvas = el('canvas', 'g-radar-canvas', radarWrap);
  const ring = svgEl('svg', { class: 'g-ring', viewBox: '0 0 200 200', 'aria-hidden': 'true' }, radarWrap);
  const arcPath = (r, a0, a1, cw) => {
    const p = (a) => [100 + r * Math.sin((a * Math.PI) / 180), 100 - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 ${cw ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const healthD = arcPath(93, 194, 346, true);
  const armorD = arcPath(93, 166, 14, false);
  const staminaD = arcPath(86, 152, 208, true);
  svgEl('path', { d: healthD, class: 'g-ring-track', pathLength: 100 }, ring);
  svgEl('path', { d: armorD, class: 'g-ring-track', pathLength: 100 }, ring);
  const healthArc = svgEl('path', { d: healthD, class: 'g-ring-health', pathLength: 100, 'stroke-dasharray': '100 100' }, ring);
  const armorArc = svgEl('path', { d: armorD, class: 'g-ring-armor', pathLength: 100, 'stroke-dasharray': '0 100' }, ring);
  const staminaArc = svgEl('path', { d: staminaD, class: 'g-ring-stamina', pathLength: 100, 'stroke-dasharray': '100 100' }, ring);
  const radarRim = el('span', 'g-radar-rim', radarWrap);
  void radarRim;

  const bc = el('div', 'g-bc', hud);
  const prompt = el('div', 'g-prompt', bc);
  prompt.hidden = true;
  const promptKey = el('kbd', 'g-kbd', prompt);
  const promptText = el('span', '', prompt);
  const sub = el('div', 'g-sub', bc);
  sub.hidden = true;
  const subWho = el('b', 'g-sub-who', sub);
  const subShown = el('span', 'g-sub-text', sub);
  const subRest = el('span', 'g-sub-rest', sub);
  const objective = el('div', 'g-objective', bc);
  objective.hidden = true;
  el('span', 'g-objective-kicker', objective, 'Objective');
  const objectiveText = el('span', 'g-objective-text', objective);

  const br = el('div', 'g-corner g-br', hud);
  const place = el('div', 'g-place', br);
  const placeName = el('div', 'g-place-name', place);
  const placeStreet = el('div', 'g-place-street', place);
  const vehName = el('div', 'g-vehname', br);
  const speedo = el('div', 'g-speedo', br);
  const speedRow = el('div', 'g-speed-row', speedo);
  const speedNum = el('span', 'g-speed', speedRow, '0');
  const speedUnit = el('span', 'g-unit', speedRow, 'km/h');
  const rev = el('div', 'g-rev', speedo);
  const revFill = el('span', 'g-rev-fill', rev);
  const speedMeta = el('div', 'g-speed-meta', speedo);
  const gearEl = el('span', 'g-gear', speedMeta, 'N');
  const vdmg = el('span', 'g-vdmg', speedMeta);
  el('span', 'g-vdmg-label', vdmg, 'Body');
  const vdmgBar = el('span', 'g-vdmg-bar', vdmg);
  const vdmgFill = el('span', '', vdmgBar);

  // ---- state ---------------------------------------------------------------------------------------------------
  const st = {
    forcedCrosshair: false,
    shownMoney: NaN,
    deltaSum: 0,
    deltaLeft: 0,
    helpLeft: 0,
    subLeft: 0,
    subText: '',
    subShownN: 0,
    subReveal: 0,
    timerSeconds: null,
    timerLabel: '',
    radioLeft: 0,
    placeLeft: 0,
    vehLeft: 0,
    locTimer: 0,
    lastPlace: '',
    lastStreet: '',
    speedTimer: 0,
    wantedShowLeft: 0,
    lastLabel: ''
  };

  // ---- API pieces ------------------------------------------------------------------------------------------------
  function setPrompt(text, action) {
    write('prompt', text || '', (t) => {
      prompt.hidden = !t;
      if (!t) return;
      let [key, words] = splitPrompt(t);
      if (!key && action) key = game.input?.label?.(action) || '';
      promptKey.textContent = key;
      promptKey.hidden = !key;
      promptText.textContent = words;
    });
  }

  function setObjective(text) {
    write('objective', text || '', (t) => {
      objective.hidden = !t;
      if (t) {
        objectiveText.textContent = t;
        flash(objective);
      }
    });
  }

  function setSubtitle(who, text, seconds) {
    if (!text) {
      sub.hidden = true;
      st.subLeft = 0;
      return;
    }
    st.subText = String(text);
    st.subLeft = Number.isFinite(seconds) && seconds > 0 ? seconds : Math.min(9, 2.2 + st.subText.length * 0.055);
    st.subShownN = reducedMotion.matches ? st.subText.length : 0;
    st.subReveal = st.subShownN;
    subWho.textContent = who ? `${who}` : '';
    subWho.hidden = !who;
    let h = 0;
    for (const c of String(who || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    subWho.style.color = SPEAKER_COLORS[h % SPEAKER_COLORS.length];
    subShown.textContent = st.subText.slice(0, st.subShownN);
    subRest.textContent = st.subText.slice(st.subShownN);
    sub.hidden = false;
  }

  function setTimer(seconds, label) {
    if (seconds == null || !Number.isFinite(seconds)) {
      st.timerSeconds = null;
      timer.hidden = true;
      last.delete('timer');
      return;
    }
    st.timerSeconds = seconds;
    if (label != null) st.timerLabel = String(label);
    timer.hidden = false;
    write('timerLabel', st.timerLabel, (t) => {
      timerLabel.textContent = t;
      timerLabel.hidden = !t;
    });
  }

  function setHelp(text, seconds = 7) {
    if (!text) {
      help.hidden = true;
      st.helpLeft = 0;
      return;
    }
    st.helpRaw = String(text);
    richText(helpText, st.helpRaw, game.input);
    help.hidden = false;
    st.helpLeft = seconds > 0 ? seconds : Infinity;
    flash(help);
  }

  function notify({ title = '', text = '', icon = '' } = {}) {
    const n = el('div', 'g-note', null);
    // named icons (systems pass 'phone', 'cash'...) as glyphs; anything else is shown as given (a letter or two)
    const glyph = NOTE_ICONS[icon] ?? (icon ? String(icon).slice(0, 2) : (title || '•').slice(0, 1).toUpperCase());
    const ic = el('div', 'g-note-icon', n, glyph);
    void ic;
    const body = el('div', 'g-note-body', n);
    el('b', 'g-note-title', body, title);
    if (text) el('p', 'g-note-text', body, text);
    notes.prepend(n);
    while (notes.children.length > 3) notes.lastElementChild.remove();
    const life = Math.min(9000, 3800 + String(text).length * 45);
    setTimeout(() => {
      n.classList.add('is-leaving');
      setTimeout(() => n.remove(), 400);
    }, life);
    return n;
  }

  function showRadio(station) {
    radioName.textContent = station ? station.name || station.id || 'Radio' : 'Radio off';
    radioGenre.textContent = station?.genre || '';
    radioGenre.hidden = !station?.genre;
    radio.hidden = false;
    radio.classList.toggle('is-off', !station);
    flash(radio);
    st.radioLeft = 3.2;
  }

  function showVehicleName(v) {
    if (!v) return;
    vehName.textContent = v.label || 'Vehicle';
    vehName.classList.add('is-on');
    st.vehLeft = 3.2;
  }

  function hitmarker(kind = 'hit') {
    hitmark.dataset.kind = kind;
    if (reducedMotion.matches) {
      hitmark.style.opacity = '1';
      setTimeout(() => (hitmark.style.opacity = '0'), 160);
      return;
    }
    hitmark.animate(
      [{ opacity: 1, transform: 'translate(-50%, -50%) scale(1.35)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.25 }, { opacity: 0, transform: 'translate(-50%, -50%) scale(1)' }],
      { duration: kind === 'kill' ? 420 : 260, easing: 'ease-out' }
    );
  }

  /** A red arc round the screen's centre towards where the hit came from (world direction the blow travelled) */
  function damageArc(dirX, dirZ, amount) {
    const strength = Math.min(1, 0.35 + (amount || 0) / 40);
    // the red rush from the edges: the post-process grade's when there is one (it fades in update), else a DOM flash
    const grade = game.fx?.grade;
    // (softer when an arc shows where it came from)
    const directional = !!(dirX || dirZ);
    if (grade) grade.damagePulse = Math.max(grade.damagePulse, strength * (directional ? 0.45 : 1));
    else if (!directional) hurt.animate([{ opacity: strength }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
    if (!directional) return;
    const cam = game.engine.cameraSystem;
    const yaw = Math.atan2(cam.currentLookAt.x - cam.currentPos.x, cam.currentLookAt.z - cam.currentPos.z);
    // towards the source, relative to the view; clockwise on screen
    const rel = Math.atan2(-dirX, -dirZ) - yaw;
    const deg = (-rel * 180) / Math.PI;
    const arc = dmgArcs[dmgNext++ % dmgArcs.length];
    arc.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    arc.animate([{ opacity: strength }, { opacity: strength, offset: 0.2 }, { opacity: 0 }], { duration: 1100, easing: 'ease-out' });
  }

  function flash(node) {
    if (reducedMotion.matches) return;
    node.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1)' });
  }

  function moneyDelta(d) {
    if (!d) return;
    st.deltaSum = st.deltaLeft > 0 ? st.deltaSum + d : d;
    st.deltaLeft = 2.6;
    const s = st.deltaSum;
    delta.textContent = `${s > 0 ? '+' : '−'}NZ$${fmtMoney(Math.abs(s))}`;
    delta.dataset.sign = s > 0 ? 'up' : 'down';
    delta.classList.add('is-on');
    if (!reducedMotion.matches) delta.animate([{ transform: 'translateY(-6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220 });
  }

  function weaponPing() {
    if (!reducedMotion.matches) weapon.animate([{ transform: 'scale(1.08)' }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
  }

  // ---- per frame -------------------------------------------------------------------------------------------------
  const proj = { x: 0, y: 0, w: 0, behind: false };
  function project(cam, x, y, z) {
    const m = cam.matrixWorldInverse.elements;
    const p = cam.projectionMatrix.elements;
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const vy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const vz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
    const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    proj.behind = cw <= 0.01;
    const w = Math.abs(cw) < 1e-4 ? 1e-4 : Math.abs(cw);
    proj.x = cx / w;
    proj.y = cy / w;
    return proj;
  }

  /** world markers: targets [{x, y, z, color, label}] (at most two) */
  function updateMarkers(targets, count) {
    const cam = game.engine.cameraSystem?.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const p = game.player?.position;
    for (let i = 0; i < markerEls.length; i++) {
      const me = markerEls[i];
      const t = i < count ? targets[i] : null;
      if (!t || !cam || !p) {
        if (me.visible) {
          me.visible = false;
          me.m.hidden = true;
        }
        continue;
      }
      project(cam, t.x, t.y, t.z);
      let nx = proj.x, ny = proj.y;
      const margin = 44;
      const hw = W / 2 - margin, hh = H / 2 - margin;
      let sx = nx * (W / 2), sy = -ny * (H / 2);
      let onEdge = false;
      if (proj.behind) {
        // behind the camera: along the bottom edge, on the side it is (x/|w| keeps its side)
        sx = Math.max(-hw, Math.min(hw, sx));
        sy = hh;
        onEdge = true;
      } else if (Math.abs(sx) > hw || Math.abs(sy) > hh) {
        const k = Math.max(Math.abs(sx) / hw, Math.abs(sy) / hh);
        sx /= k;
        sy /= k;
        onEdge = true;
      }
      const x = Math.round(W / 2 + sx), y = Math.round(H / 2 + sy);
      const rot = onEdge ? Math.round((Math.atan2(sx, -sy) * 180) / Math.PI) : 180;
      if (!me.visible) {
        me.visible = true;
        me.m.hidden = false;
      }
      if (x !== me.x || y !== me.y) {
        me.x = x;
        me.y = y;
        me.m.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (rot !== me.rot) {
        me.rot = rot;
        me.pin.style.transform = `rotate(${rot}deg)`;
      }
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      const text = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 5) * 5} m`;
      if (text !== me.text) {
        me.text = text;
        me.dist.textContent = text;
      }
      if (t.color !== me.color) {
        me.color = t.color;
        me.m.style.setProperty('--mk', t.color);
      }
      me.m.classList.toggle('is-edge', onEdge);
    }
  }

  // last written values (inline dirty checks: nothing allocated per frame)
  const was = {
    hp: -1, ap: -1, sp: -1, low: null, money: NaN, level: -1, maxLevel: -1, evading: null, wantedShown: null,
    weapon: '', pips: '', weaponShown: null, cross: null, arrest: -1, vehicle: null, speed: -1, rpm: -1,
    gear: '', vhp: -1, vstate: '', vbike: null, timer: -1
  };

  function update(dt, realDt) {
    const p = game.player;
    if (!p) return;

    // health & armour round the radar, stamina under it
    const hp = Math.round((p.health / p.maxHealth) * 200) / 2;
    if (hp !== was.hp) {
      was.hp = hp;
      healthArc.setAttribute('stroke-dasharray', `${hp} 100`);
    }
    const low = p.alive && hp / 100 < LOW_HEALTH;
    if (low !== was.low) {
      was.low = low;
      root.classList.toggle('is-low', low);
    }
    // the picture's grade (post-processing, game.fx.grade): the colour drains and the edges close in at low health,
    // and a hit's red rush fades (WRECKED / NICKED set their own: hud/cards.js)
    const grade = game.fx?.grade;
    if (grade && !root.classList.contains('is-drained')) {
      const k = 1 - Math.exp(-realDt * 1.6);
      const wantSat = low ? 0.5 : 0, wantVig = low ? 0.55 : 0;
      if (Math.abs(grade.desaturate - wantSat) > 0.002) grade.desaturate += (wantSat - grade.desaturate) * k;
      else if (grade.desaturate !== wantSat) grade.desaturate = wantSat;
      if (Math.abs(grade.vignette - wantVig) > 0.002) grade.vignette += (wantVig - grade.vignette) * k;
      else if (grade.vignette !== wantVig) grade.vignette = wantVig;
    }
    if (grade && grade.damagePulse > 0) grade.damagePulse = grade.damagePulse < 0.01 ? 0 : grade.damagePulse * Math.exp(-realDt * 4.5);
    const ap = Math.round((p.armor / p.maxArmor) * 200) / 2;
    if (ap !== was.ap) {
      was.ap = ap;
      armorArc.setAttribute('stroke-dasharray', `${ap} 100`);
      radarWrap.classList.toggle('has-armor', ap > 0);
    }
    const sp = Math.round(p.stamina);
    if (sp !== was.sp) {
      was.sp = sp;
      staminaArc.setAttribute('stroke-dasharray', `${sp} 100`);
      radarWrap.classList.toggle('is-tired', sp < 99);
    }

    // money rolls towards its value
    const target = p.money;
    if (!Number.isFinite(st.shownMoney)) st.shownMoney = target;
    if (st.shownMoney !== target) {
      const diff = target - st.shownMoney;
      st.shownMoney = reducedMotion.matches || Math.abs(diff) < 1 ? target : st.shownMoney + diff * (1 - Math.exp(-realDt * 7));
      if (Math.abs(target - st.shownMoney) < 0.5) st.shownMoney = target;
    }
    const shown = Math.round(st.shownMoney);
    if (shown !== was.money) {
      was.money = shown;
      moneyAmt.textContent = fmtMoney(shown);
    }
    if (st.deltaLeft > 0 && (st.deltaLeft -= realDt) <= 0) delta.classList.remove('is-on');

    // wanted stars (shown while wanted, and a moment after)
    const w = game.wanted;
    const level = w ? Math.max(0, Math.min(5, Math.round(w.level || 0))) : 0;
    if (level > 0) st.wantedShowLeft = 2.5;
    else if (st.wantedShowLeft > 0) st.wantedShowLeft -= realDt;
    if (level !== was.level) {
      was.level = level;
      for (let i = 0; i < 5; i++) starEls[i].classList.toggle('is-on', i < level);
      wanted.setAttribute('aria-label', `Wanted level ${level}`);
    }
    const maxLevel = w ? Math.max(1, Math.min(5, w.maxLevel || 5)) : 5;
    if (maxLevel !== was.maxLevel) {
      was.maxLevel = maxLevel;
      for (let i = 0; i < 5; i++) starEls[i].style.display = i < maxLevel ? '' : 'none';
    }
    const evading = !!(w && w.evading && level > 0);
    if (evading !== was.evading) {
      was.evading = evading;
      wanted.classList.toggle('is-evading', evading);
    }
    const wantedShown = st.wantedShowLeft > 0;
    if (wantedShown !== was.wantedShown) {
      was.wantedShown = wantedShown;
      wanted.classList.toggle('is-shown', wantedShown);
    }

    // what's in hand (on foot): fists or the cricket bat, and which of the two slots
    const wp = game.weapons;
    const def = wp?.current || null;
    const id = wp ? wp.currentId || def?.id || 'fist' : 'fist';
    if (id !== was.weapon) {
      was.weapon = id;
      weaponUse.setAttribute('href', `#gw-${WEAPON_ICONS[id] ? id : 'unknown'}`);
      weaponName.textContent = def?.name || (id === 'fist' ? 'Fists' : id);
      weapon.dataset.kind = id;
      weaponPing();
    }
    const pips = wp ? `${wp.has?.('bat') ? 1 : 0}${id === 'bat' ? 1 : 0}` : '00';
    if (pips !== was.pips) {
      was.pips = pips;
      // (only worth showing once there is a choice: the bat owned)
      weaponPips.hidden = pips[0] !== '1';
      pipEls[0].classList.toggle('is-on', pips[1] !== '1');
      pipEls[1].classList.toggle('is-on', pips[1] === '1');
    }
    const weaponShown = !!(wp && p.onFoot);
    if (weaponShown !== was.weaponShown) {
      was.weaponShown = weaponShown;
      weapon.classList.toggle('is-shown', weaponShown);
    }

    // the focus dot: while squared up on foot (the focus button), or forced by the game
    const live = game.state === 'playing' && p.alive;
    const showCross = st.forcedCrosshair || (live && (wp ? !!wp.crosshair : p.onFoot && p.aiming));
    if (showCross !== was.cross) {
      was.cross = showCross;
      crosshair.hidden = !showCross;
    }

    // the arrest meter: an officer's hands on the player (fills as the cuffs go on)
    const arrest = w && level > 0 && live ? Math.round(Math.max(0, Math.min(1, w.arrestProgress || 0)) * 40) / 40 : 0;
    if (arrest !== was.arrest) {
      was.arrest = arrest;
      arrestEl.classList.toggle('is-on', arrest > 0);
      arrestFill.style.transform = `scaleX(${arrest})`;
    }

    // vehicle: speed, gear, damage
    const v = p.vehicle;
    const vmode = v ? v.mode || 'car' : '';
    if (vmode !== was.vehicle) {
      was.vehicle = vmode;
      root.dataset.vehicle = vmode || 'foot';
      speedo.classList.toggle('is-on', !!vmode);
      speedUnit.textContent = vmode === 'helicopter' ? 'm' : 'km/h';
      st.speedTimer = 0;
    }
    if (v && (st.speedTimer -= realDt) <= 0) {
      st.speedTimer = 0.06;
      const heli = v.mode === 'helicopter';
      const kmh = Math.abs(v.speed || 0) * 3.6;
      const speed = heli ? Math.max(0, Math.round((Number.isFinite(v.y) ? v.y : p.position.y) + GEO.frame.sea)) : Math.round(kmh);
      if (speed !== was.speed) {
        was.speed = speed;
        speedNum.textContent = String(speed);
      }
      let gear = 1;
      while (gear < GEARS.length && kmh >= GEARS[gear]) gear++;
      const lo = GEARS[gear - 1], hi = gear < GEARS.length ? GEARS[gear] : GEARS[GEARS.length - 1] + 40;
      const reverse = (v.speed || 0) < -0.3;
      const rpmRaw = heli ? Math.min(1, kmh / 190) : reverse ? Math.min(1, kmh / 25) : 0.12 + 0.88 * Math.min(1, (kmh - lo) / (hi - lo));
      const rpm = Math.round(rpmRaw * 24) / 24;
      if (rpm !== was.rpm) {
        was.rpm = rpm;
        revFill.style.transform = `scaleX(${rpm})`;
        rev.classList.toggle('is-red', rpm > 0.9);
      }
      const gearText = heli ? 'Altitude' : reverse ? 'Gear R' : kmh < 1 ? 'Gear N' : GEAR_TEXT[gear];
      if (gearText !== was.gear) {
        was.gear = gearText;
        gearEl.textContent = gearText;
      }
      const vhp = v.maxHealth > 0 ? Math.round(Math.max(0, v.health / v.maxHealth) * 40) / 40 : 1;
      if (vhp !== was.vhp) {
        was.vhp = vhp;
        vdmgFill.style.transform = `scaleX(${vhp})`;
      }
      const vstate = v.state || 'ok';
      if (vstate !== was.vstate) {
        was.vstate = vstate;
        vdmg.dataset.state = vstate;
      }
      const vbike = v.mode === 'cyclist';
      if (vbike !== was.vbike) {
        was.vbike = vbike;
        vdmg.classList.toggle('is-hidden', vbike);
      }
    }
    if (st.vehLeft > 0 && (st.vehLeft -= realDt) <= 0) vehName.classList.remove('is-on');

    // where you are: the district when it changes, the street under it (a few times a second)
    if ((st.locTimer -= realDt) <= 0 && game.state === 'playing') {
      st.locTimer = 0.6;
      updatePlace(p.position);
    }
    if (st.placeLeft > 0 && (st.placeLeft -= realDt) <= 0) place.classList.remove('is-on', 'is-street');

    // subtitles typed on
    if (!sub.hidden) {
      if (st.subShownN < st.subText.length) {
        st.subReveal += realDt * 70;
        const n = Math.min(st.subText.length, Math.floor(st.subReveal));
        if (n !== st.subShownN) {
          st.subShownN = n;
          subShown.textContent = st.subText.slice(0, n);
          subRest.textContent = st.subText.slice(n);
        }
      }
      if ((st.subLeft -= realDt) <= 0) sub.hidden = true;
    }

    // the mission timer runs down between the game's updates
    if (st.timerSeconds != null) {
      if (dt > 0) st.timerSeconds = Math.max(0, st.timerSeconds - dt);
      const secs = Math.ceil(st.timerSeconds);
      if (secs !== was.timer) {
        was.timer = secs;
        timerTime.textContent = fmtTime(secs);
        timer.classList.toggle('is-urgent', secs <= 10);
      }
    }
    if (st.helpLeft > 0 && st.helpLeft !== Infinity && (st.helpLeft -= realDt) <= 0) help.hidden = true;
    if (st.radioLeft > 0 && (st.radioLeft -= realDt) <= 0) radio.hidden = true;
  }

  function updatePlace(pos) {
    const label = getLocationLabel(pos.x, pos.z);
    if (label === st.lastLabel) return;
    st.lastLabel = label;
    let placeText = label, streetText = '';
    const split = label.indexOf(' · ');
    if (split >= 0) {
      placeText = label.slice(0, split);
      streetText = label.slice(split + 3).replace(/^near /, '');
    }
    if (placeText && placeText !== st.lastPlace) {
      st.lastPlace = placeText;
      st.lastStreet = streetText;
      placeName.textContent = placeText;
      placeStreet.textContent = streetText;
      placeStreet.hidden = !streetText;
      place.classList.remove('is-street');
      place.classList.add('is-on');
      st.placeLeft = 4.2;
    } else if (streetText !== st.lastStreet) {
      st.lastStreet = streetText;
      placeStreet.textContent = streetText;
      placeStreet.hidden = !streetText;
      if (streetText && st.placeLeft <= 0) {
        place.classList.add('is-on', 'is-street');
        st.placeLeft = 2.6;
      }
    }
  }

  return {
    radarCanvas, radarWrap, hudEl: hud, notes,
    setPrompt, setObjective, setSubtitle, setTimer, setHelp, notify, showRadio, showVehicleName, hitmarker, damageArc,
    moneyDelta, weaponPing, updateMarkers, update,
    set forcedCrosshair(v) {
      st.forcedCrosshair = !!v;
    },
    /** The help box's text as given (null while it is hidden) */
    get helpText() {
      return help.hidden ? null : st.helpRaw;
    },
    get forcedCrosshair() {
      return st.forcedCrosshair;
    },
    pingWanted(up) {
      if (reducedMotion.matches) return;
      wanted.animate(up
        ? [{ transform: 'scale(1.35)', filter: 'brightness(2)' }, { transform: 'none', filter: 'none' }]
        : [{ opacity: 0.3 }, { opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
    }
  };
}

export { createHud, fmtMoney, fmtTime, richText, el };
