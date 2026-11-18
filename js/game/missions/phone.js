// The phone ('phone' action: T / D-pad right): a menu (game.ui.menu) of jobs (GPS to a mission's start, replay a
// passed one), activities (races, challenges, the export list, taxi work), stats, a cab ride to any job for a fee,
// abort, and cheats with ?debug. Without the HUD's menus it points the GPS at the next job instead.

const CAB_FEE = 60;
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

function createPhone(game, { missions, markers }) {
  let open = null;
  const hud = () => typeof game.ui?.menu === 'function';
  const money = () => game.player.money;
  const medal = (b) => (b?.medal ? ` · ${b.medal}` : '');

  function show(spec) {
    close();
    if (!hud()) return null;
    let closed = false;
    const handle = game.ui.menu({
      title: spec.title,
      subtitle: spec.subtitle,
      items: spec.items,
      onClose: () => {
        if (closed) return;
        closed = true;
        if (open === handle) open = null;
        game.emit('phone:closed', {});
      }
    });
    open = handle;
    game.emit('phone:opened', { page: spec.page || 'home' });
    return handle;
  }

  function close() {
    if (!open) return;
    const h = open;
    open = null;
    try {
      h.close?.();
    } catch { /* gone */ }
  }

  const back = (label = 'Back') => ({ label, detail: '', onSelect: () => home() });

  function home() {
    const active = missions.active;
    const items = [
      { label: 'Jobs', detail: 'Story missions', onSelect: () => jobs() },
      { label: 'Side hustles', detail: 'Races, challenges, exports, taxi', onSelect: () => hustles() },
      { label: 'Stats', detail: `${game.stats.progress.toFixed(1)}% complete`, onSelect: () => stats() },
      { label: 'Call a cab', detail: `$${CAB_FEE} to any job`, disabled: !!active || game.wanted?.level > 0, onSelect: () => cab() }
    ];
    if (active) items.push({ label: `Abort: ${active.title}`, detail: 'Walk away from the job', onSelect: () => { missions.abort(); close(); } });
    if (DEBUG) items.push({ label: 'Cheats', detail: '?debug', onSelect: () => cheats() });
    items.push({ label: 'Hang up', detail: '', onSelect: () => close() });
    return show({ title: 'Phone', subtitle: active ? `On a job: ${active.title}` : 'No new messages. Probably for the best.', items });
  }

  function jobs() {
    const items = [];
    for (const m of missions.list().filter((d) => d.kind === 'story')) {
      if (m.done) items.push({ label: `✓ ${m.title}`, detail: `Replay · ${m.giver}`, disabled: missions.isActive, onSelect: () => { close(); missions.replay(m.id); } });
      else if (m.available) items.push({ label: m.title, detail: `${m.giver} — ${m.blurb}`, onSelect: () => { missions.gps(m.id); markers.notice(`GPS set: ${m.title}`, 2); close(); } });
      else items.push({ label: '???', detail: 'Not yet', disabled: true });
    }
    items.push(back());
    return show({ title: 'Jobs', subtitle: 'Select a job to set the GPS.', items, page: 'jobs' });
  }

  function hustles() {
    const acts = game.activities;
    const items = [];
    for (const m of missions.list().filter((d) => d.kind === 'race' || d.kind === 'rampage')) {
      const b = missions.best[m.id];
      items.push({
        label: m.title, detail: `${m.kind === 'race' ? 'Race' : 'Challenge'}${b ? (m.kind === 'race' ? ` · best ${b.time?.toFixed?.(1)} s${medal(b)}` : ' · done') : ''}`,
        disabled: !m.available, onSelect: () => { missions.gps(m.id); close(); }
      });
    }
    if (acts) {
      const left = acts.exportList().filter((x) => !x.done).map((x) => x.label);
      items.push({
        label: 'Export list', detail: left.length ? `Wanted: ${left.join(', ')}` : 'All shipped!', disabled: !left.length,
        onSelect: () => { missions.gps(acts.exportAt.x, acts.exportAt.z); close(); }
      });
      items.push({ label: 'Taxi work', detail: `Get in any taxi and press ${game.input.label('interact')}. Fares: ${game.stats.get('taxiFares')}`, disabled: true });
      items.push({ label: 'Golden kiwis', detail: `${game.stats.get('collectibles')} / 30 found. They're out there.`, disabled: true });
    }
    items.push(back());
    return show({ title: 'Side hustles', subtitle: 'Select one to set the GPS.', items, page: 'hustles' });
  }

  function stats() {
    const rows = game.stats.rows();
    const items = rows.map((r) => ({ label: r.label, detail: r.value, disabled: true }));
    items.push(back());
    return show({ title: 'Stats', subtitle: '', items, page: 'stats' });
  }

  function cab() {
    const items = [];
    for (const m of missions.list().filter((d) => d.available && (!d.done || d.kind !== 'story'))) {
      items.push({
        label: m.title, detail: m.giver, price: CAB_FEE, disabled: money() < CAB_FEE,
        onSelect: () => {
          close();
          if (money() < CAB_FEE) return;
          game.player.addMoney(-CAB_FEE, 'cab');
          missions.travel(m.x, m.z);
        }
      });
    }
    for (const h of game.economy?.ownedList?.() || []) {
      items.push({
        label: h.name, detail: 'Home', price: CAB_FEE, disabled: money() < CAB_FEE,
        onSelect: () => {
          close();
          game.player.addMoney(-CAB_FEE, 'cab');
          missions.travel(h.x, h.z);
        }
      });
    }
    items.push(back());
    return show({ title: 'Call a cab', subtitle: 'Yes, a cabbie calling a cab. Don\'t.', items, page: 'cab' });
  }

  function cheats() {
    const w = game.weapons;
    const items = [
      { label: '+$5,000', onSelect: () => game.player.addMoney(5000, 'cheat') },
      { label: 'Health & armour', onSelect: () => { game.player.heal(100); game.player.addArmor(100); } },
      { label: 'Cricket bat', disabled: !w || w.has('bat'), onSelect: () => w.give('bat') },
      { label: 'Wanted +1', disabled: !game.wanted, onSelect: () => game.wanted.add(1) },
      { label: 'Clear wanted', disabled: !game.wanted, onSelect: () => game.wanted.clear('cheat') },
      { label: 'Skip mission step', disabled: !missions.isActive, onSelect: () => missions.debugSkipStep() },
      { label: 'Pass mission', disabled: !missions.isActive, onSelect: () => { missions.debugPass(); close(); } },
      { label: 'Unlock every job', onSelect: () => missions.debugUnlockAll() },
      back()
    ];
    return show({ title: 'Cheats', subtitle: 'For testing. Obviously.', items, page: 'cheats' });
  }

  // no menus in the HUD yet: the phone just points the GPS at the next job
  function fallback() {
    const next = missions.list().find((m) => m.kind === 'story' && m.available && !m.done);
    if (missions.isActive) markers.notice(`On a job: ${missions.active.title}`, 2.5);
    else if (next) {
      missions.gps(next.id);
      markers.notice(`Phone: ${next.giver} wants you. GPS set: ${next.title}`, 3.5);
    } else markers.notice('Phone: no new jobs.', 2);
  }

  const phone = {
    get isOpen() {
      return !!open;
    },
    open() {
      if (!hud()) return fallback();
      return home();
    },
    close,
    jobs,
    hustles,
    stats,
    cab,
    cheats,
    update() {
      if (!game.input?.pressed('phone')) {
        if (open && (!game.player.alive || game.state === 'dead')) close();
        return;
      }
      if (open) {
        close();
        return;
      }
      if (!game.player.alive || game.state !== 'playing') return;
      if (game.economy?.menuOpen) return;
      phone.open();
    }
  };
  return phone;
}

export { createPhone };
