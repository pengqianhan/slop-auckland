// Blips: the points of interest the HUD draws on the radar and the full map (missions, objectives, shops, enemies,
// races...). This module only keeps the data; the HUD reads game.blips.list every frame and listens to
// 'blips:changed' to rebuild whatever it caches (icons, the GPS route). A blip may follow a live target (anything
// with x / z, or a WorldVehicle / ped view): its position is refreshed here every frame, without an event.
//   const b = game.blips.add({ x, z, kind: 'objective', label: 'The van', target: van, route: true });
//   b.set(x, z); b.visible = false; b.remove();
// kind: 'mission' 'objective' 'destination' 'enemy' 'police' 'shop-sports' 'shop-spray' 'shop-food' 'safehouse'
//   'hospital' 'pickup' 'race' 'collectible' 'vehicle' 'friend'
// route: the HUD draws a GPS route to it. short: a short-range blip (only drawn on the radar when near).

const COLORS = {
  mission: '#ffd23f',
  objective: '#ffd23f',
  destination: '#ffd23f',
  enemy: '#ff4a4a',
  police: '#4a8dff',
  'shop-sports': '#ff8f3f',
  'shop-spray': '#4fd6c4',
  'shop-food': '#ffb35c',
  safehouse: '#7ee081',
  hospital: '#ff6b8b',
  pickup: '#9be564',
  race: '#c58cff',
  collectible: '#ffe066',
  vehicle: '#5ec8ff',
  friend: '#5ec8ff'
};

function createBlips(game) {
  const list = [];
  let nextId = 1;
  let dirty = false;
  const changed = { list, reason: '' };

  function markChanged(reason) {
    dirty = true;
    changed.reason = reason;
  }

  class Blip {
    constructor(opts) {
      this.id = nextId++;
      this.kind = opts.kind || 'objective';
      this.color = opts.color || COLORS[this.kind] || '#ffffff';
      this.label = opts.label || '';
      this.x = opts.x ?? opts.target?.x ?? 0;
      this.z = opts.z ?? opts.target?.z ?? 0;
      this.target = opts.target || null;
      this.radius = opts.radius || 0; // > 0: an area (search zone), drawn as a circle
      this.route = !!opts.route;
      this.short = !!opts.short;
      this.icon = opts.icon || null;
      this.priority = opts.priority || 0;
      this.removed = false;
      this._visible = opts.visible ?? true;
    }
    set(x, z) {
      this.x = x;
      this.z = z;
      return this;
    }
    get visible() {
      return this._visible;
    }
    set visible(v) {
      v = !!v;
      if (v === this._visible) return;
      this._visible = v;
      markChanged('visible');
    }
    setRoute(on) {
      on = !!on;
      if (on === this.route) return this;
      this.route = on;
      markChanged('route');
      return this;
    }
    setLabel(label) {
      if (label !== this.label) {
        this.label = label;
        markChanged('label');
      }
      return this;
    }
    remove() {
      if (this.removed) return;
      this.removed = true;
      const i = list.indexOf(this);
      if (i >= 0) list.splice(i, 1);
      markChanged('removed');
    }
  }

  const blips = {
    COLORS,
    list,
    /** opts: { x, z, kind, color, label, target, radius, route, short, visible, icon, priority } */
    add(opts = {}) {
      const b = new Blip(opts);
      list.push(b);
      markChanged('added');
      return b;
    },
    /** The blip the GPS should lead to: the last added visible one with route on (missions add theirs last) */
    get routed() {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].route && list[i]._visible) return list[i];
      return null;
    },
    update() {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const t = b.target;
        if (!t) continue;
        // a WorldVehicle or a view carries x / z; an entity carries position
        if (Number.isFinite(t.x)) {
          b.x = t.x;
          b.z = t.z;
        } else if (t.position) {
          b.x = t.position.x;
          b.z = t.position.z;
        }
      }
      if (dirty) {
        dirty = false;
        game.emit('blips:changed', changed);
      }
    }
  };
  return blips;
}

export { createBlips, COLORS as BLIP_COLORS };
