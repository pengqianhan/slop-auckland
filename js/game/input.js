import { isTypingInField } from '../city-config.js';

// The game's actions (movement stays in controllers.js): keyboard & mouse, gamepad (fed by gamepad-controls.js) and
// on-screen touch buttons, merged into one state systems read each frame:
//   input.down('aim')   held       input.pressed('fire')   went down this frame       input.released('fire')
//   input.slot          weapon slot key pressed this frame (1..9, 0: 1 fists, 2 the bat), or -1   input.wheel -1 / 0 / +1
// 'fire' swings (fists or the cricket bat), 'aim' is the focus button (square up: the camera over the shoulder).
// Mouse look under pointer lock (a click on the view locks it; Esc releases it and pauses), with drag-to-look as the
// fallback. Every press is also an 'input:action' event ({ action, slot, device }) for the HUD and audio.

const ACTIONS = ['enterExit', 'fire', 'aim', 'weaponNext', 'weaponPrev', 'weaponSlot', 'sprint', 'crouch', 'interact', 'jump', 'pause', 'phone', 'horn'];

const KEYS = {
  enterExit: ['KeyF'],
  weaponNext: ['KeyE'],
  weaponPrev: ['KeyQ'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC'],
  interact: ['KeyG'],
  jump: ['Space'],
  pause: ['KeyP', 'Escape'],
  phone: ['KeyT'],
  horn: ['KeyB']
};
const SLOT_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Digit6: 6, Digit7: 7, Digit8: 8, Digit9: 9, Digit0: 0 };
// Standard gamepad buttons: A 0, B 1, X 2, Y 3, LB 4, RB 5, LT 6, RT 7, Back 8, Start 9, L3 10, R3 11, d-pad 12-15
const PAD = {
  jump: 0, interact: 1, enterExit: 3, weaponPrev: 4, weaponNext: 5, aim: 6, fire: 7, pause: 9, sprint: 10, phone: 15
};
const PAD_ACTIONS = Object.keys(PAD);
const PAD_ON_FOOT_ONLY = new Set(['aim', 'fire', 'weaponPrev', 'weaponNext', 'sprint']);
// (LT & RT drive the car; on foot RT swings, LT squares up, LB & RB switch between fists and the bat)
const LABELS = {
  keyboard: { enterExit: 'F', fire: 'Click', aim: 'Right-click', weaponNext: 'E', weaponPrev: 'Q', sprint: 'Shift', crouch: 'C', interact: 'G', jump: 'Space', pause: 'Esc', phone: 'T', horn: 'B' },
  gamepad: { enterExit: 'Y', fire: 'RT', aim: 'LT', weaponNext: 'RB', weaponPrev: 'LB', sprint: 'L3', crouch: '—', interact: 'B', jump: 'A', pause: 'Start', phone: 'D-pad →', horn: '—' },
  touch: { enterExit: 'Tap ⏏', fire: 'Swing', aim: 'Focus', weaponNext: 'Fists / bat', weaponPrev: 'Fists / bat', sprint: 'Sprint', crouch: '—', interact: 'Use', jump: 'Jump', pause: 'Pause', phone: '—', horn: '—' }
};
const MOUSE_SENSITIVITY = 0.0021; // rad per pixel
const MOUSE_SPIKE = 400; // px: a jump this big in one event is a browser glitch, not the hand

function createInput(game, { canvas, cameraSystem, controllerManager, getMapOpen = () => false }) {
  const held = { keyboard: {}, mouse: {}, pad: {}, touch: {} };
  const edges = {};
  const releases = {};
  for (const a of ACTIONS) {
    edges[a] = releases[a] = false;
    for (const src of Object.values(held)) src[a] = false;
  }
  const codeAction = new Map();
  const bindings = {};
  for (const [action, codes] of Object.entries(KEYS)) bindings[action] = codes.slice();
  const rebuild = () => {
    codeAction.clear();
    for (const [action, codes] of Object.entries(bindings)) for (const c of codes) codeAction.set(c, action);
  };
  rebuild();
  const pressedCodes = new Set();
  const actionEvent = { action: '', slot: -1, device: 'keyboard' };
  // every action with edges to clear each frame: the built-in ones and any a system adds with bind() (the radio's)
  const allActions = ACTIONS.slice();
  const ensureAction = (action) => {
    if (allActions.includes(action)) return;
    allActions.push(action);
    edges[action] = releases[action] = false;
    for (const src of Object.values(held)) src[action] = false;
  };
  // (a menu on screen — the pause menu, a shop, the phone — takes the keys and the pad: only pause & phone get
  // through to the game, so B closing a shop isn't also "interact", nor Space choosing an item a jump)
  const PASS_WHEN_BLOCKED = new Set(['pause', 'phone']);

  const input = {
    ACTIONS,
    device: 'keyboard',
    slot: -1,
    wheel: 0,
    pointerLocked: false,
    enabled: true,
    sensitivity: 1,
    /** true while a menu has the controls (menus.js sets it); game actions other than pause & phone are ignored */
    blocked: false,

    down(action) {
      return held.keyboard[action] || held.mouse[action] || held.pad[action] || held.touch[action] || false;
    },
    pressed(action) {
      return edges[action] || false;
    },
    released(action) {
      return releases[action] || false;
    },
    /** The key / button to show for an action on the current device */
    label(action) {
      return LABELS[input.device]?.[action] ?? LABELS.keyboard[action] ?? action;
    },
    /** Rebind an action's keys (KeyboardEvent.code values) */
    bind(action, codes) {
      ensureAction(action);
      bindings[action] = Array.isArray(codes) ? codes.slice() : [codes];
      rebuild();
    },
    /** Swallows this frame's press of an action (whoever handled it first) */
    consume(action) {
      if (Object.hasOwn(edges, action)) edges[action] = false;
    },
    requestPointerLock() {
      if (!canvas.requestPointerLock || document.pointerLockElement === canvas) return;
      try {
        const p = canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => { lockUnavailable = true; });
        // some embedded views neither lock nor report an error
        setTimeout(() => { if (document.pointerLockElement !== canvas) lockUnavailable = true; }, 600);
      } catch { lockUnavailable = true; /* not allowed here (no gesture, or an embedded frame) */ }
    },
    exitPointerLock() {
      if (document.pointerLockElement !== canvas) return;
      intentionalUnlock = true;
      document.exitPointerLock?.();
    },
    /** Clears every held action (focus lost, map opened) */
    reset() {
      pressedCodes.clear();
      for (const src of Object.values(held)) for (const a of allActions) src[a] = false;
    },
    /** @internal start of game.update: nothing yet */
    begin() {
      if (input.pointerLocked && getMapOpen()) input.exitPointerLock();
    },
    /** @internal end of game.update: edges are one frame long */
    end() {
      for (let i = 0; i < allActions.length; i++) {
        edges[allActions[i]] = false;
        releases[allActions[i]] = false;
      }
      input.slot = -1;
      input.wheel = 0;
    },
    /** @internal gamepad-controls.js hands over the pad every frame (pressed: buttons; edge(i) / held(i)) */
    applyPad(pad, pressed, edge, isHeld) {
      const onFoot = !game.player || game.player.onFoot;
      let any = false;
      for (let k = 0; k < PAD_ACTIONS.length; k++) {
        const action = PAD_ACTIONS[k];
        const index = PAD[action];
        // (a menu polls the pad itself: its A / B / shoulders are the menu's)
        const allowed = (!PAD_ON_FOOT_ONLY.has(action) || onFoot) && (!input.blocked || PASS_WHEN_BLOCKED.has(action));
        const down = allowed && isHeld(index);
        if (!down && held.pad[action]) releases[action] = true;
        held.pad[action] = down;
        if (allowed && edge(index)) {
          any = true;
          if (action === 'pause') {
            if (!getMapOpen() && (game.state === 'playing' || game.state === 'paused')) game.togglePause();
          }
          press(action, 'gamepad');
        }
      }
      if (any) input.device = 'gamepad';
    },
    /** @internal the pad is gone or suppressed */
    clearPad() {
      for (const a of ACTIONS) held.pad[a] = false;
    }
  };

  function press(action, device, slot = -1) {
    if (input.blocked && !PASS_WHEN_BLOCKED.has(action)) return;
    edges[action] = true;
    input.device = device;
    actionEvent.action = action;
    actionEvent.slot = slot;
    actionEvent.device = device;
    game.emit('input:action', actionEvent);
  }

  function setHeld(src, action, down, device, slot = -1) {
    if (down && !src[action]) press(action, device, slot);
    else if (!down && src[action]) releases[action] = true;
    src[action] = down;
  }

  // ---- keyboard ----
  let intentionalUnlock = false;
  window.addEventListener('keydown', (e) => {
    if (!input.enabled || isTypingInField(e)) return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (e.repeat) return;
      // (the map and the popovers close on Esc themselves)
      if (getMapOpen() || document.querySelector?.(':popover-open')) return;
      if (game.state === 'playing' || game.state === 'paused') {
        game.togglePause();
        press('pause', 'keyboard');
      }
      return;
    }
    if (Object.hasOwn(SLOT_KEYS, e.code)) {
      if (!e.repeat && !input.blocked) {
        input.slot = SLOT_KEYS[e.code];
        press('weaponSlot', 'keyboard', input.slot);
      }
      return;
    }
    const action = codeAction.get(e.code);
    if (!action) return;
    if (action === 'sprint' || action === 'jump') input.device = 'keyboard';
    pressedCodes.add(e.code);
    if (!e.repeat) setHeld(held.keyboard, action, true, 'keyboard');
  }, { capture: true });
  window.addEventListener('keyup', (e) => {
    const action = codeAction.get(e.code);
    pressedCodes.delete(e.code);
    if (!action) return;
    // another key still held for the same action keeps it held
    if (bindings[action].some((c) => pressedCodes.has(c))) return;
    setHeld(held.keyboard, action, false, 'keyboard');
  }, { capture: true });
  window.addEventListener('blur', () => input.reset());

  // ---- mouse: look, swing (left), focus (right), fists / bat on the wheel ----
  let downX = 0, downY = 0;
  let lockUnavailable = false;
  canvas.addEventListener('mousedown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
    if (!input.enabled || game.state !== 'playing') return;
    if (e.button === 2) {
      setHeld(held.mouse, 'aim', true, 'keyboard');
      input.requestPointerLock();
    } else if (e.button === 0 && !input.pointerLocked && !input.blocked && (held.mouse.aim || lockUnavailable)) {
      // no pointer lock (an embedded view that refuses it, or the lock hasn't landed yet): the left button still
      // swings — while squared up, or always once the lock has proved unavailable
      setHeld(held.mouse, 'fire', true, 'keyboard');
    }
  });
  document.addEventListener('pointerlockerror', () => { lockUnavailable = true; });
  canvas.addEventListener('click', (e) => {
    if (!input.enabled || e.button !== 0 || input.pointerLocked) return;
    // a click (not the end of a drag-to-look) locks the pointer for mouse look; it also resumes a pause
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    // (a shop or the phone is up: the mouse is for its items, so the view doesn't grab the pointer)
    if (input.blocked && game.state !== 'paused') return;
    if (game.state === 'paused') game.resume();
    if (game.state === 'playing' && !getMapOpen()) input.requestPointerLock();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mousedown', (e) => {
    if (!input.pointerLocked) return;
    if (e.button === 0) setHeld(held.mouse, 'fire', true, 'keyboard');
    else if (e.button === 2) setHeld(held.mouse, 'aim', true, 'keyboard');
  }, { capture: true });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) setHeld(held.mouse, 'fire', false, 'keyboard');
    else if (e.button === 2) setHeld(held.mouse, 'aim', false, 'keyboard');
  }, { capture: true });
  window.addEventListener('mousemove', (e) => {
    if (!input.pointerLocked || game.state !== 'playing') return;
    const dx = e.movementX || 0, dy = e.movementY || 0;
    if (Math.abs(dx) > MOUSE_SPIKE || Math.abs(dy) > MOUSE_SPIKE) return;
    const sens = MOUSE_SENSITIVITY * input.sensitivity * (cameraSystem.aiming ? 0.72 : 1);
    cameraSystem.addLook(-dx * sens, dy * sens);
  });
  window.addEventListener('wheel', (e) => {
    // on foot under pointer lock the wheel switches between fists and the bat (otherwise it zooms the camera)
    if (!input.pointerLocked || !game.player?.onFoot || game.state !== 'playing') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (Math.abs(e.deltaY) < 1) return;
    input.wheel = e.deltaY > 0 ? 1 : -1;
    press(e.deltaY > 0 ? 'weaponNext' : 'weaponPrev', 'keyboard');
  }, { capture: true, passive: false });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    const wasLocked = input.pointerLocked;
    input.pointerLocked = locked;
    if (locked) lockUnavailable = false;
    if (!locked) {
      held.mouse.fire = held.mouse.aim = false;
      // Esc released it (browsers swallow that keypress): pause, unless we let go on purpose
      if (wasLocked && !intentionalUnlock && game.state === 'playing') game.pause();
    }
    intentionalUnlock = false;
    game.emit('input:pointerlock', { locked });
  });
  // a hidden tab pauses (and a pause lets go of the pointer)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      input.reset();
      if (game.state === 'playing') game.pause();
    }
  });
  // a pause (or a cutscene) hands the pointer back; dying keeps it (the respawn follows by itself)
  game.on('state', ({ state }) => {
    if (state === 'paused' || state === 'cutscene') input.exitPointerLock();
    if (state !== 'playing') held.mouse.fire = held.mouse.aim = false;
  });

  // ---- touch: buttons in the game's UI layer, shown on touch screens ----
  function buildTouch(root) {
    const pad = document.createElement('div');
    pad.className = 'game-touch';
    const make = (action, label, mode = 'hold') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `game-touch-btn game-touch-${action}`;
      b.textContent = label;
      b.setAttribute('aria-label', label);
      let toggled = false;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (mode === 'toggle') {
          toggled = !toggled;
          b.classList.toggle('is-on', toggled);
          setHeld(held.touch, action, toggled, 'touch');
        } else {
          setHeld(held.touch, action, true, 'touch');
        }
      });
      const up = () => {
        if (mode !== 'toggle') setHeld(held.touch, action, false, 'touch');
      };
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(type, up);
      pad.appendChild(b);
    };
    make('enterExit', '⏏');
    make('fire', 'Swing');
    make('aim', 'Focus', 'toggle');
    make('weaponNext', '⇄');
    make('sprint', 'Run', 'toggle');
    root.appendChild(pad);
  }

  // on foot, Q / E / C are the game's (fists / bat, crouch): they no longer lift or lower the person
  controllerManager.reservedCodes = new Set(['KeyE', 'KeyQ', 'KeyC']);

  input.buildTouch = buildTouch;
  return input;
}

export { createInput, ACTIONS as INPUT_ACTIONS };
