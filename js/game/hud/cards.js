import { fmtMoney } from './hud.js';

// Big moments over the game (DOM under #game-ui, css/game.css): mission passed (the reward counting up, the stats)
// and failed (with the reason), WRECKED when the player dies and NICKED when arrested (the city drains of colour in
// the slow motion), the generic title banner, toasts, the fade to black, cutscene letterbox bars and the flash of
// the wanted level going up or down. Everything is timed in real seconds by update().

const QUIPS = {
  wasted: ['Yeah, nah.', 'Chur. That one hurt.', 'She\'ll be right. Eventually.', 'Bit of a mare, eh.', 'Down to the A&E, bro.'],
  busted: ['Sweet as, officer.', 'Should have taken the ferry.', 'Cuzzie, that was not the plan.', 'Hard out. Nicked.', 'Not even a fush & chup first.'],
  failed: ['Gutted.', 'Botched it, bro.', 'Back to the drawing board, mate.', 'Not your finest hour.'],
  passed: ['Sweet as.', 'Choice, bro.', 'Mean as.', 'Tu meke!', 'Good as gold.']
};
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const humanize = (key) => String(key)
  .replace(/[_-]+/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase());

function statRows(stats) {
  if (!stats) return [];
  if (Array.isArray(stats)) {
    return stats.map((s) => (Array.isArray(s) ? [String(s[0]), s[1]] : [String(s.label ?? s.key ?? ''), s.value]));
  }
  if (typeof stats === 'object') return Object.entries(stats).map(([k, v]) => [humanize(k), v]);
  return [];
}

const fmtStat = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-NZ') : v.toFixed(1);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v ?? '');
};

function createCards(game, root, { reducedMotion }) {
  const fade = el('div', 'g-fade', root);
  const letterbox = el('div', 'g-letterbox', root);
  el('div', 'g-lb g-lb-top', letterbox);
  el('div', 'g-lb g-lb-bottom', letterbox);
  const sting = el('div', 'g-sting', root);
  const toast = el('div', 'g-toast', root);
  toast.hidden = true;
  const banner = el('div', 'g-banner', root);
  banner.hidden = true;
  const bannerTitle = el('b', 'g-banner-title', banner);
  const bannerSub = el('span', 'g-banner-sub', banner);

  const card = el('div', 'g-card', root);
  card.hidden = true;
  card.setAttribute('role', 'status');
  const cardKicker = el('div', 'g-card-kicker', card);
  const cardTitle = el('div', 'g-card-title', card);
  const cardBand = el('div', 'g-card-band', card);
  const cardSub = el('div', 'g-card-sub', card);
  const cardReward = el('div', 'g-card-reward', card);
  const cardStats = el('dl', 'g-card-stats', card);
  const cardQuip = el('div', 'g-card-quip', card);
  void cardBand;

  const st = {
    toastLeft: 0,
    bannerLeft: 0,
    cardLeft: 0,
    cardStyle: '',
    cardKey: '',
    cardAt: -10,
    reward: 0,
    rewardShown: 0,
    rewardT: 0,
    deathCard: false
  };

  function showToast(text, seconds = 2.5) {
    if (!text) {
      toast.hidden = true;
      st.toastLeft = 0;
      return;
    }
    toast.textContent = text;
    toast.hidden = false;
    st.toastLeft = seconds;
    // (the individual translate property: the stylesheet's own transform places the toast — centred, or to the side on a
    // phone — and the slide-in adds to it)
    if (!reducedMotion.matches) toast.animate([{ opacity: 0, translate: '0 -8px' }, { opacity: 1, translate: '0 0' }], { duration: 220, easing: 'ease-out' });
  }

  function setFade(to, seconds = 0.6) {
    fade.style.transition = `opacity ${Math.max(0, seconds)}s linear`;
    fade.style.opacity = String(Math.max(0, Math.min(1, to)));
  }

  function setLetterbox(on) {
    letterbox.classList.toggle('is-on', !!on);
  }

  function showBanner(title, sub = '', seconds = 0) {
    if (!title) {
      banner.hidden = true;
      st.bannerLeft = 0;
      return;
    }
    bannerTitle.textContent = title;
    bannerSub.textContent = sub || '';
    bannerSub.hidden = !sub;
    banner.hidden = false;
    st.bannerLeft = seconds > 0 ? seconds : Infinity;
    if (!reducedMotion.matches) banner.animate([{ opacity: 0, letterSpacing: '0.3em' }, { opacity: 1, letterSpacing: '0.04em' }], { duration: 600, easing: 'cubic-bezier(.2,.9,.3,1)' });
  }

  /**
   * The big card. style: 'passed' | 'failed' | 'wasted' | 'busted' | 'title'. opts: { kicker, sub, reward, stats,
   * seconds, quip }. A second call for the same moment within a second (the event and a banner() call for it) is
   * folded into the first.
   */
  function showCard(style, title, opts = {}) {
    const key = `${style}|${title}`;
    const now = performance.now() / 1000;
    if (key === st.cardKey && now - st.cardAt < 1.2 && !card.hidden) {
      if (opts.sub) setCardSub(opts.sub);
      if (opts.reward && !st.reward) startReward(opts.reward);
      if (opts.stats) fillStats(opts.stats);
      return;
    }
    st.cardKey = key;
    st.cardAt = now;
    st.cardStyle = style;
    st.deathCard = style === 'wasted' || style === 'busted';
    card.dataset.style = style;
    cardKicker.textContent = opts.kicker || '';
    cardKicker.hidden = !opts.kicker;
    cardTitle.textContent = title;
    setCardSub(opts.sub || '');
    st.reward = 0;
    cardReward.hidden = true;
    if (opts.reward) startReward(opts.reward);
    fillStats(opts.stats);
    const quip = opts.quip === false ? '' : opts.quip || (QUIPS[style] ? pick(QUIPS[style]) : '');
    cardQuip.textContent = quip;
    cardQuip.hidden = !quip;
    card.hidden = false;
    st.cardLeft = opts.seconds > 0 ? opts.seconds : style === 'passed' ? 6.5 : style === 'failed' ? 5.5 : st.deathCard ? 9 : 4;
    const wasDrained = root.classList.contains('is-drained');
    root.classList.toggle('is-drained', st.deathCard);
    root.classList.toggle('is-busted', style === 'busted');
    // the city drains of colour under WRECKED / NICKED (the post-process grade), and comes back with the next card
    // (a job's failed card after the respawn) or when the card goes
    if (st.deathCard) game.fx?.grade?.set({ desaturate: 0.92, brightness: 0.86, damagePulse: 0 });
    else if (wasDrained) game.fx?.grade?.reset();
    // the title switches on like a neon tube (once, not in reduced motion)
    card.classList.remove('is-in');
    void card.offsetWidth;
    card.classList.add('is-in');
  }

  function setCardSub(text) {
    cardSub.textContent = text || '';
    cardSub.hidden = !text;
  }

  function startReward(amount) {
    st.reward = amount;
    st.rewardShown = reducedMotion.matches ? amount : 0;
    st.rewardT = 0;
    cardReward.hidden = false;
    cardReward.textContent = `+ NZ$${fmtMoney(st.rewardShown)}`;
  }

  function fillStats(stats) {
    const rows = statRows(stats);
    cardStats.replaceChildren();
    for (const [k, v] of rows.slice(0, 6)) {
      const row = el('div', 'g-card-stat', cardStats);
      el('dt', '', row, k);
      el('dd', '', row, fmtStat(v));
    }
    cardStats.hidden = !rows.length;
  }

  function hideCard() {
    const drained = root.classList.contains('is-drained');
    card.hidden = true;
    st.cardLeft = 0;
    st.cardKey = '';
    st.deathCard = false;
    root.classList.remove('is-drained', 'is-busted');
    if (drained) game.fx?.grade?.reset();
  }

  function flashSting(kind) {
    if (reducedMotion.matches) return;
    sting.dataset.kind = kind;
    sting.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: kind === 'up' ? 900 : 700, easing: 'ease-out' });
  }

  function update(realDt) {
    if (st.toastLeft > 0 && (st.toastLeft -= realDt) <= 0) toast.hidden = true;
    if (st.bannerLeft > 0 && st.bannerLeft !== Infinity && (st.bannerLeft -= realDt) <= 0) banner.hidden = true;
    if (!card.hidden) {
      if (st.reward && st.rewardShown < st.reward) {
        st.rewardT += realDt;
        const k = Math.min(1, Math.max(0, (st.rewardT - 0.5) / 1.3));
        const shown = Math.round(st.reward * (1 - (1 - k) ** 3));
        if (shown !== st.rewardShown) {
          st.rewardShown = shown;
          cardReward.textContent = `+ NZ$${fmtMoney(shown)}`;
        }
      }
      if ((st.cardLeft -= realDt) <= 0) hideCard();
    }
  }

  return {
    showToast, setFade, setLetterbox, showBanner, showCard, hideCard, setCardSub, flashSting, update,
    get deathCard() {
      return st.deathCard && !card.hidden;
    },
    get cardStyle() {
      return card.hidden ? '' : st.cardStyle;
    }
  };
}

export { createCards, QUIPS };
