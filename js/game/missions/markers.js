// World markers: the places the player walks or drives into (mission starts, shops, garages, safehouses, race
// starts, the export crane...). Each has a blip, a beacon (a light column & ring from game.fx) and a trigger zone.
// fx has 24 beacons for the whole game, so only the nearest few markers hold one at a time (re-assigned a few
// times a second); the rest show as blips only. A marker either fires onEnter as the player arrives (once, re-armed
// after leaving), or offers an action on 'interact' (G / B) with a help line while the player stands in it.
//   markers.add({ x, z, radius, color, kind, label, blip: true, short, when: 'foot'|'vehicle'|'any', maxSpeed,
//     prompt: 'enter the sports shop', onEnter(m), onInteract(m), enabled: () => bool, beacon: true })

const MAX_BEACONS = 7;
const BEACON_RANGE = 260;
const REASSIGN_EVERY = 0.35; // s

function createMarkers(game) {
  const list = [];
  let reassignIn = 0;
  let helpShown = null;

  function help(text) {
    if (text === helpShown) return;
    helpShown = text;
    if (typeof game.ui?.help === 'function') game.ui.help(text, text ? 30 : 0);
    else if (text) game.ui?.toast?.(text, 2.5);
  }

  class Marker {
    constructor(o) {
      Object.assign(this, {
        x: 0, z: 0, y: null, radius: 2.2, color: 0xffc02a, kind: 'mission', label: '', short: false, when: 'any',
        maxSpeed: 4, prompt: null, onEnter: null, onInteract: null, enabled: null, beaconOn: true, beaconHeight: 30,
        blipOn: true, route: false, data: null
      }, o);
      if (o.beacon === false) this.beaconOn = false;
      if (o.blip === false) this.blipOn = false;
      this.beacon = null;
      this.blip = null;
      this.inside = false;
      this.removed = false;
      this.active = true;
      this.refresh();
    }
    get on() {
      return this.active && !this.removed && (!this.enabled || this.enabled(this));
    }
    /** (re)creates or drops its blip after a change of state */
    refresh() {
      const want = this.blipOn && this.on;
      if (want && !this.blip) {
        this.blip = game.blips.add({ x: this.x, z: this.z, kind: this.kind, label: this.label, short: this.short, route: this.route });
      } else if (!want && this.blip) {
        this.blip.remove();
        this.blip = null;
      }
      if (!this.on) this.dropBeacon();
    }
    dropBeacon() {
      if (this.beacon) {
        this.beacon.remove();
        this.beacon = null;
      }
    }
    move(x, z) {
      this.x = x;
      this.z = z;
      this.blip?.set(x, z);
      this.beacon?.set(x, z, this.y ?? undefined);
    }
    remove() {
      if (this.removed) return;
      this.removed = true;
      this.dropBeacon();
      this.blip?.remove();
      this.blip = null;
      const i = list.indexOf(this);
      if (i >= 0) list.splice(i, 1);
      if (this.inside && this.prompt) help(null);
    }
  }

  function reassignBeacons() {
    const p = game.player.position;
    // the nearest markers within range that want one
    const scored = [];
    for (const m of list) {
      if (!m.on || !m.beaconOn) {
        m.dropBeacon();
        continue;
      }
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d > BEACON_RANGE) m.dropBeacon();
      else scored.push([d, m]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < scored.length; i++) {
      const m = scored[i][1];
      if (i >= MAX_BEACONS) m.dropBeacon();
      else if (!m.beacon) m.beacon = game.fx.beacon(m.x, m.z, m.color, { radius: m.radius, height: m.beaconHeight, y: m.y ?? undefined });
    }
  }

  let noticeText = null, noticeLeft = 0;
  const markers = {
    list,
    /** A help line shown while no marker is offering anything (the retry offer...); null clears it */
    ambient: null,
    /** A help line for a few seconds */
    notice(text, seconds = 2.5) {
      noticeText = text;
      noticeLeft = seconds;
    },
    add(o) {
      const m = new Marker(o);
      list.push(m);
      reassignIn = 0;
      return m;
    },
    /** Re-evaluates every marker's enabled() (after a mission ends, money changes...) */
    refresh() {
      for (const m of list) m.refresh();
      reassignIn = 0;
    },
    help,
    update(dt, realDt) {
      const player = game.player;
      if (!player) return;
      if ((reassignIn -= realDt) <= 0) {
        reassignIn = REASSIGN_EVERY;
        for (const m of list) if (!!m.blip !== (m.blipOn && m.on)) m.refresh();
        reassignBeacons();
      }
      const playing = game.state === 'playing' && player.alive;
      const p = player.position;
      const v = player.vehicle;
      const speed = v ? Math.abs(v.speed) : 0;
      let prompting = null;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const dx = p.x - m.x, dz = p.z - m.z;
        const r = m.radius + (v ? 1.2 : 0);
        const inZone = dx * dx + dz * dz < r * r && (m.y === null || Math.abs(p.y - m.y) < 6);
        if (!m.on) {
          // (still tracked while off: a job failed or aborted on its own start marker doesn't start again until the
          // player has stepped out and back in)
          m.inside = inZone;
          continue;
        }
        const modeOk = m.when === 'any' || (m.when === 'foot' ? !v : !!v);
        const ok = inZone && modeOk && speed <= m.maxSpeed && playing;
        if (ok && !m.inside) {
          m.inside = true;
          if (m.onEnter) m.onEnter(m);
        } else if (!inZone) {
          m.inside = false;
        }
        if (ok && m.prompt && m.onInteract && !m.removed) {
          prompting = m;
          if (game.input.pressed('interact')) {
            m.onInteract(m);
            prompting = null;
          }
        }
      }
      if (noticeLeft > 0) noticeLeft -= realDt;
      help(prompting ? `${game.input.label('interact')} — ${prompting.prompt}` : noticeLeft > 0 ? noticeText : markers.ambient);
    }
  };
  return markers;
}

export { createMarkers };
