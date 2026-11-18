// The economy: places to spend money and the money lying about. Shops are markers in the world, with menus through
// game.ui.menu (or, while the HUD has no menus, the most useful thing bought automatically):
//   sports shops (the cricket bat at its game.weapons.defs price, and protective padding: armour), respray garages
//   (drive in: repaired, repainted, wanted level cleared — unless the police saw you go in at three stars or more),
//   food (health for dollars), and safehouses to buy (a save point that heals you, with a garage that keeps the car
//   you leave in it). People knocked out (and thugs) drop cash. A new game starts nearly broke. Also persists what the
//   player carries (asked of game.weapons on save, given back on load: only what game.weapons allows comes back).
//   game.economy = { shops, safehouses, owned(id), buy(id), openShop(id), menu(spec), update }

const START_MONEY = 150;
const RESPRAY_COST = 150;
// protective padding (armour): a light set and the full kit
const PADDING = [
  { label: 'Shin pads & thigh guard', detail: '+40 armour', price: 120, amount: 40 },
  { label: 'The full kit', detail: 'Pads, helmet, the lot: +100 armour', price: 300, amount: 100 }
];
const FOOD = [
  { label: 'Mince & cheese pie', detail: '+25 health', price: 6, heal: 25 },
  { label: 'Fish & chips', detail: '+60 health', price: 14, heal: 60 },
  { label: 'The Full Hāngī', detail: 'Full health', price: 25, heal: 100 }
];
const PAINTS = [0xb3202a, 0x1f4fa0, 0x2a8a4a, 0xe8e2d0, 0x111111, 0xf2b630, 0x6b2fa0, 0xd8d8d8, 0x8a5a2a, 0x2fb0c0];

const SHOPS = [
  { id: 'sports-kroad', type: 'sports', name: 'Howzat Sports', at: { kerb: [-190, 1003] } },
  { id: 'sports-newmarket', type: 'sports', name: 'The Twelfth Man', at: { kerb: [1240, 2230] } },
  { id: 'spray-newton', type: 'spray', name: 'Spray \'n\' Pray', at: { lane: [-420, 2070] } },
  { id: 'spray-mechanics', type: 'spray', name: 'Spray \'n\' Pray', at: { lane: [1500, -120] } },
  { id: 'spray-ponsonby', type: 'spray', name: 'Spray \'n\' Pray', at: { lane: [-1222, -49] } },
  { id: 'food-queen', type: 'food', name: 'Pie Hard', at: { kerb: [175, 280] } },
  { id: 'food-kroad', type: 'food', name: 'The Hungry Kūmara', at: { kerb: [-60, 1024] } },
  { id: 'food-ponsonby', type: 'food', name: 'Flat White Lies', at: { kerb: [-1420, 700] } }
];
const SAFEHOUSES = [
  { id: 'spare-room', name: 'Mere\'s Spare Room', price: 0, requires: 'meter-running', at: { kerb: [-640, 300] }, garage: { lane: [-650, 320] } },
  { id: 'ponsonby-villa', name: 'Ponsonby Villa', price: 6000, at: { kerb: [-1700, 560] }, garage: { lane: [-1690, 575] } },
  { id: 'parnell-loft', name: 'Parnell Loft', price: 12000, at: { kerb: [1830, 1180] }, garage: { lane: [1820, 1200] } },
  { id: 'wynyard-penthouse', name: 'Wynyard Penthouse', price: 30000, at: { kerb: [-560, -620] }, garage: { lane: [-540, -640] } }
];
const BLIP_KIND = { sports: 'shop-sports', spray: 'shop-spray', food: 'shop-food' };
const COLOR = { sports: 0xff8f3f, spray: 0x4fd6c4, food: 0xffb35c, safehouse: 0x7ee081 };

function createEconomy(game, { places, markers, missions }) {
  const owned = new Set();
  const garages = new Map(); // safehouse id -> { kind, paint, police, health } | vehicle
  let menuOpen = null;
  let menuState = null;
  const hud = () => typeof game.ui?.menu === 'function';
  const money = () => game.player.money;
  const toast = (t, s = 2.5) => (typeof game.ui?.notify === 'function' ? game.ui.notify({ title: '', text: t, icon: 'cash' }) : game.ui?.toast?.(t, s));

  // ---- menus (game.ui.menu, or the first useful item chosen for you) ----
  function menu(spec, replacing = false) {
    closeMenu(replacing);
    if (!hud()) {
      const pick = spec.items.find((i) => i.auto && !i.disabled) || null;
      if (pick) pick.onSelect?.();
      else markers.notice(`${spec.title}: nothing you can afford.`, 2.5);
      spec.onClose?.();
      return null;
    }
    // (inside a shop the world goes on, but the player is out of harm's way and the controls are the menu's: a hold,
    // the cutscene state without the letterbox; only a hold this menu began is let go of when it closes — a mission
    // running meanwhile must not leave the player frozen)
    const held = !!spec.hold && (game.state === 'playing' || (replacing && heldByMenu));
    if (held && game.state === 'playing') game.setState('cutscene', { letterbox: false });
    heldByMenu = held;
    let closing = false;
    const handle = game.ui.menu({
      title: spec.title,
      subtitle: spec.subtitle,
      items: spec.items.map((i) => ({
        label: i.label, detail: i.detail, price: i.price, disabled: !!i.disabled,
        onSelect: () => {
          i.onSelect?.();
          // (a shop stays open after a purchase, its prices and stock brought up to date)
          if (spec.refresh && menuOpen === handle) {
            const again = spec.refresh();
            if (again) menu(again, true);
          }
        }
      })),
      onClose: () => {
        if (closing) return;
        closing = true;
        if (menuOpen === handle) menuOpen = null;
        if (silentClose) return;
        releaseHold();
        game.emit('shop:closed', {});
        spec.onClose?.();
      }
    });
    menuOpen = handle;
    menuState = spec;
    return handle;
  }

  let silentClose = false;
  let heldByMenu = false;
  function releaseHold() {
    if (!heldByMenu) return;
    heldByMenu = false;
    if (game.state === 'cutscene' && !game.letterbox) game.setState('playing');
  }
  /** Closes the open menu (replacing: another opens straight after, so the state and the event stay put) */
  function closeMenu(replacing = false) {
    if (!menuOpen) return;
    const h = menuOpen;
    menuOpen = null;
    silentClose = replacing;
    try {
      h.close?.();
    } catch { /* already gone */ }
    silentClose = false;
    if (replacing) return;
    releaseHold();
  }

  function spend(price, reason) {
    if (money() < price) {
      markers.notice('Not enough cash.', 2);
      game.audio?.play?.('ui-back');
      return false;
    }
    game.player.addMoney(-price, reason);
    return true;
  }

  // ---- sports shop: the cricket bat, and padding (armour) ----
  function sportsMenu(shop) {
    const w = game.weapons;
    const items = [];
    const p = game.player;
    const bat = w?.defs?.bat;
    if (bat) {
      const has = !!w.has?.('bat');
      items.push({
        label: bat.name, detail: has ? 'You\'ve got one. One\'s plenty.' : 'Willow. Swings like a dream, dents like a nightmare', price: bat.price,
        disabled: has || money() < bat.price, auto: false,
        onSelect: () => spend(bat.price, 'bat') && w.give('bat')
      });
    }
    for (const pad of PADDING) {
      items.push({
        label: pad.label, detail: pad.detail, price: pad.price, disabled: p.armor >= p.maxArmor || money() < pad.price,
        auto: pad.amount >= 100 && p.armor < 50 && money() >= pad.price,
        onSelect: () => spend(pad.price, 'armour') && p.addArmor(pad.amount)
      });
    }
    return {
      title: shop.name, subtitle: 'Everything for the gentleman\'s game. No questions asked.', items, hold: true,
      refresh: () => sportsMenu(shop)
    };
  }

  // ---- food ----
  function foodMenu(shop) {
    const p = game.player;
    const items = FOOD.map((f) => ({
      label: f.label, detail: f.detail, price: f.price, disabled: money() < f.price || p.health >= p.maxHealth,
      auto: p.health < p.maxHealth && money() >= f.price && f.heal >= p.maxHealth - p.health - 5,
      onSelect: () => {
        if (spend(f.price, 'food')) {
          p.heal(f.heal);
          game.audio?.play?.('pickup-health');
        }
      }
    }));
    // (no HUD menu: the cheapest that covers it, else the biggest affordable)
    if (!items.some((i) => i.auto)) {
      const afford = items.filter((i) => !i.disabled);
      if (afford.length) afford[afford.length - 1].auto = true;
    }
    return { title: shop.name, subtitle: 'Hot food, cold service.', items, hold: true, refresh: () => foodMenu(shop) };
  }

  // ---- respray: drive in ----
  function respray(shop) {
    const v = game.player.vehicle;
    if (!v || v.mode !== 'car') return;
    const w = game.wanted;
    if (w && w.level >= 3 && w.seen) {
      markers.notice('They saw you come in. Not touching that car with the cops outside.', 3);
      return;
    }
    if (v.police) {
      markers.notice('A cop car? Get that thing out of my garage.', 3);
      return;
    }
    const cost = v.hero ? Math.round(RESPRAY_COST * 0.6) : RESPRAY_COST;
    if (!spend(cost, 'respray')) return;
    game.ui?.fade?.(1, 0.3);
    // (a hold behind the fade; let go of afterwards even mid-mission: a respray is the classic way to lose the cops)
    const held = game.state === 'playing';
    if (held) game.setState('cutscene', { letterbox: false });
    setTimeout(() => {
      game.vehicles.repair(v);
      if (v.record && !v.hero) {
        const hex = PAINTS[Math.floor(Math.random() * PAINTS.length)];
        const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
        // (linear paint, as traffic stores it)
        v.record.paint[0] = Math.fround(r ** 2.2);
        v.record.paint[1] = Math.fround(g ** 2.2);
        v.record.paint[2] = Math.fround(b ** 2.2);
      }
      game.wanted?.clear?.('respray');
      game.stats.add('resprays');
      game.emit('vehicle:resprayed', { vehicle: v, cost });
      game.ui?.fade?.(0, 0.5);
      if (held && game.state === 'cutscene' && !game.letterbox) game.setState('playing');
      markers.notice(`${shop.name}: good as new. Your secret's safe. $${cost}`, 3);
    }, 900);
  }

  function openShop(id) {
    const shop = SHOPS.find((s) => s.id === id);
    if (!shop) return null;
    // (not while wanted at all: inside a shop the world holds still, the police with it)
    if (shop.type !== 'spray' && game.wanted?.level >= 1) {
      markers.notice('Closed. "Not with the cops outside, mate."', 2.5);
      return null;
    }
    game.emit('shop:opened', { shop: shop.id, type: shop.type, name: shop.name });
    if (shop.type === 'sports') return menu(sportsMenu(shop));
    if (shop.type === 'food') return menu(foodMenu(shop));
    return null;
  }

  for (const shop of SHOPS) {
    const p = missions.resolve(shop.at);
    shop.x = p.x;
    shop.z = p.z;
    shop.marker = markers.add({
      x: p.x, z: p.z, radius: shop.type === 'spray' ? 3.4 : 1.6, color: COLOR[shop.type], kind: BLIP_KIND[shop.type], label: shop.name,
      short: true, when: shop.type === 'spray' ? 'vehicle' : 'foot', maxSpeed: shop.type === 'spray' ? 7 : 4, beaconHeight: 6,
      prompt: shop.type === 'spray' ? null : `Enter ${shop.name}`,
      onInteract: shop.type === 'spray' ? null : () => openShop(shop.id),
      onEnter: shop.type === 'spray' ? () => {
        game.emit('shop:opened', { shop: shop.id, type: 'spray', name: shop.name });
        respray(shop);
        game.emit('shop:closed', {});
      } : null
    });
  }

  // ---- safehouses ----
  for (const house of SAFEHOUSES) {
    const p = missions.resolve(house.at);
    house.x = p.x;
    house.z = p.z;
    const g = missions.resolve(house.garage);
    house.gx = g.x;
    house.gz = g.z;
    house.gh = g.heading;
    house.marker = markers.add({
      x: p.x, z: p.z, radius: 1.6, color: COLOR.safehouse, kind: 'safehouse', label: house.name, short: true, when: 'foot', beaconHeight: 6,
      enabled: () => !house.requires || missions.isDone(house.requires) || owned.has(house.id),
      prompt: house.price && !owned.has(house.id) ? `Buy ${house.name} — $${house.price.toLocaleString('en-NZ')}` : `${house.name}`,
      onInteract: () => houseInteract(house)
    });
  }

  function refreshHouse(house) {
    house.marker.prompt = owned.has(house.id) ? house.name : `Buy ${house.name} — $${house.price.toLocaleString('en-NZ')}`;
    house.marker.blip?.setLabel?.(owned.has(house.id) ? `${house.name} (yours)` : house.name);
  }

  function buyHouse(house) {
    if (owned.has(house.id)) return true;
    if (house.price > 0 && !spend(house.price, 'property')) return false;
    owned.add(house.id);
    if (house.price > 0) game.stats.add('safehouses');
    refreshHouse(house);
    game.emit('safehouse:bought', { id: house.id, name: house.name });
    markers.notice(`${house.name} is yours. Save here, heal here, park a car in the garage.`, 4);
    game.save.save();
    return true;
  }

  function rest(house) {
    const p = game.player;
    p.heal(p.maxHealth);
    game.save.save();
    game.emit('safehouse:saved', { id: house.id });
    markers.notice('Game saved. Feeling better.', 2.5);
  }

  function houseInteract(house) {
    if (!owned.has(house.id)) {
      if (!house.price) return buyHouse(house);
      return menu({
        title: house.name, subtitle: 'Property values only go up. Probably.', hold: true,
        items: [
          { label: 'Buy', detail: 'Save point, full heal, a garage', price: house.price, disabled: money() < house.price, auto: money() >= house.price, onSelect: () => { buyHouse(house); closeMenu(); } },
          { label: 'Just looking', detail: '', onSelect: () => closeMenu() }
        ]
      });
    }
    if (game.wanted?.level > 0) {
      markers.notice('Lose the cops before you lead them home.', 2.5);
      return null;
    }
    return menu({
      title: house.name, subtitle: 'Home sweet hideout.', hold: true,
      items: [
        { label: 'Save game', detail: 'And a lie-down: full health', auto: true, onSelect: () => { rest(house); closeMenu(); } },
        { label: 'Leave', detail: '', onSelect: () => closeMenu() }
      ]
    });
  }

  // garages: a car left in an owned safehouse's garage spot is kept there (saved, and put back on loading)
  let garageCheck = 0;
  function updateGarages(realDt) {
    if ((garageCheck -= realDt) > 0) return;
    garageCheck = 1.5;
    for (const house of SAFEHOUSES) {
      if (!owned.has(house.id)) continue;
      const slot = garages.get(house.id);
      if (slot && slot.vehicle) {
        const v = slot.vehicle;
        if (v.hidden || v.state === 'wrecked' || Math.hypot(v.x - house.gx, v.z - house.gz) > 9) {
          v.persistent = false;
          garages.delete(house.id);
        }
        continue;
      }
      const v = game.vehicles.nearest(house.gx, house.gz, 5, (c) => c.mode === 'car' && !c.hero && c.state !== 'wrecked' && c !== game.vehicles.current && !c.locked);
      if (v) {
        v.persistent = true;
        garages.set(house.id, { vehicle: v });
      }
    }
  }

  function garageData() {
    const out = {};
    for (const [id, slot] of garages) {
      const v = slot.vehicle;
      if (!v || v.hidden || v.state === 'wrecked') continue;
      out[id] = { kind: v.kind, police: !!v.police, health: Math.max(50, v.health), paint: v.record ? Array.from(v.record.paint) : null, x: v.x, z: v.z, heading: v.heading };
    }
    return out;
  }

  function restoreGarages(data) {
    for (const [id, g] of Object.entries(data || {})) {
      const house = SAFEHOUSES.find((h) => h.id === id);
      if (!house || !owned.has(id) || !g?.kind) continue;
      const x = Number.isFinite(g.x) ? g.x : house.gx, z = Number.isFinite(g.z) ? g.z : house.gz;
      const v = game.vehicles.spawn(g.police ? (g.kind === 'suv' ? 'police-suv' : 'police') : g.kind, x, z, Number.isFinite(g.heading) ? g.heading : house.gh, { persistent: true, health: g.health });
      if (!v) continue;
      if (g.paint && v.record) for (let k = 0; k < 3; k++) v.record.paint[k] = g.paint[k];
      garages.set(id, { vehicle: v });
    }
  }

  // ---- cash from the knocked out (a wallet, a thug's roll) ----
  let lastDropX = NaN, lastDropZ = NaN, lastDropAt = -Infinity;
  function drop(x, z, amount) {
    if (Math.hypot(x - lastDropX, z - lastDropZ) < 1.2 && game.time - lastDropAt < 0.6) return;
    lastDropX = x;
    lastDropZ = z;
    lastDropAt = game.time;
    game.pickups.dropCash(x, z, amount);
  }
  game.on('ped:killed', (e) => {
    if (!e.byPlayer || Math.random() > 0.55) return;
    drop(e.x, e.z, 5 + Math.floor(Math.random() * 41));
  });
  game.on('enemy:killed', (e) => {
    const x = e?.x ?? e?.enemy?.x, z = e?.z ?? e?.enemy?.z;
    if (!Number.isFinite(x) || !Number.isFinite(z) || e.byPlayer === false) return;
    drop(x, z, 20 + Math.floor(Math.random() * 61));
  });

  // ---- a new game starts nearly broke ----
  // (a "New game" from the title keeps a save with only the settings in it: no player in it is a new game too)
  if (!game.save.read?.()?.data?.player) game.player.money = START_MONEY;

  // ---- save: property, garages, what the player carries (fists and maybe the bat) ----
  let pendingGarages = null;
  game.save.register('economy', {
    get: () => {
      const w = game.weapons;
      let weapons = null;
      if (w && typeof w.owned === 'function') {
        weapons = {};
        for (const id of w.owned()) {
          const a = w.ammo?.(id);
          weapons[id] = a ? (a.mag || 0) + (a.reserve || 0) : 0;
        }
      }
      return { owned: [...owned], garages: garageData(), weapons };
    },
    set: (data) => {
      if (!data) return;
      owned.clear();
      for (const id of data.owned || []) if (SAFEHOUSES.some((h) => h.id === id)) owned.add(id);
      for (const h of SAFEHOUSES) refreshHouse(h);
      pendingGarages = data.garages || null;
      // (an older save may list guns here: game.weapons has no such thing and refuses them)
      const w = game.weapons;
      if (w && data.weapons) {
        for (const id of Object.keys(data.weapons)) {
          if (!w.defs?.[id] || id === 'fist' || w.has?.(id)) continue;
          try {
            w.give(id);
          } catch (e) {
            console.warn('[economy] could not give back', id, e);
          }
        }
      }
    }
  });

  const economy = {
    SHOPS,
    SAFEHOUSES,
    START_MONEY,
    owned: (id) => owned.has(id),
    ownedList: () => SAFEHOUSES.filter((h) => owned.has(h.id)),
    buy: (id) => {
      const h = SAFEHOUSES.find((s) => s.id === id);
      return h ? buyHouse(h) : false;
    },
    openShop,
    menu,
    closeMenu,
    get menuOpen() {
      return !!menuOpen;
    },
    update(dt, realDt) {
      if (pendingGarages && game.frame > 2) {
        restoreGarages(pendingGarages);
        pendingGarages = null;
      }
      updateGarages(realDt);
      // the free room comes with the first job
      const spare = SAFEHOUSES[0];
      if (!owned.has(spare.id) && missions.isDone(spare.requires)) {
        owned.add(spare.id);
        refreshHouse(spare);
      }
      // a menu closes if the player is dragged away from it (death, arrest)
      if (menuOpen && !game.player.alive) closeMenu();
    }
  };
  return economy;
}

export { createEconomy, SHOPS, SAFEHOUSES };
