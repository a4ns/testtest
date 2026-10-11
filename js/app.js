/*
 * App shell: screens, game lifecycle, HUD, effects routing, achievements,
 * settings UI and the frame loop.
 */
(function () {
  'use strict';

  const E = window.TetrisEngine;
  const S = window.TetrisStorage;
  const R = window.TetrisRenderer;
  const WP = window.TetrisWallpaper;
  const Audio = window.TetrisAudio;
  const Lens = window.TetrisLens;

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const firstRun = !S.hasSavedSettings();
  const settings = S.loadSettings();
  if (firstRun) {
    // Lensing re-renders every glass surface as the wallpaper moves; keep it
    // for desktops and pick plain frosted glass on phones and small devices.
    const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
    if (coarse || weak) settings.glass = 'standard';
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) settings.reduceMotion = true;
  }
  const records = S.loadRecords();
  const profile = S.loadProfile();

  const MODE_INFO = {
    marathon: { name: 'Marathon', tint: '#64d2ff' },
    sprint: { name: 'Sprint 40L', tint: '#ff9f0a' },
    ultra: { name: 'Ultra 2:00', tint: '#bf5af2' },
    zen: { name: 'Zen', tint: '#30d158' },
  };

  const els = {
    root: document.documentElement,
    game: $('#game'),
    wallpaper: $('#wallpaper'),
    grain: $('#grain'),
    boardShell: $('#board-shell'),
    boardFrame: $('#board-frame'),
    boardCanvas: $('#board-canvas'),
    holdCanvas: $('#hold-canvas'),
    nextCanvas: $('#next-canvas'),
    logoCanvas: $('#logo-canvas'),
    callouts: $('#callouts'),
    countdown: $('#countdown'),
    modePill: $('#mode-pill'),
    modeName: $('#mode-name'),
    goal: $('#panel-goal'),
    goalValue: $('#goal-value'),
    goalLabel: $('#goal-label'),
    ringFill: $('#ring-fill'),
    st: {
      main: $('#st-main'),
      mainL: $('#st-main-l'),
      a: $('#st-a'),
      aL: $('#st-a-l'),
      b: $('#st-b'),
      bL: $('#st-b-l'),
      c: $('#st-c'),
      cL: $('#st-c-l'),
    },
    touchPad: $('#touch-pad'),
    btnPause: $('#btn-pause'),
    btnFs: $('#btn-fullscreen'),
    toasts: $('#toasts'),
    screens: {
      menu: $('#screen-menu'),
      paused: $('#screen-pause'),
      results: $('#screen-results'),
    },
    modals: {
      settings: $('#screen-settings'),
      help: $('#screen-help'),
      records: $('#screen-records'),
      touchhelp: $('#screen-touchhelp'),
    },
  };

  const app = {
    screen: 'menu',
    modal: null,
    modalReturn: null,
    modalOnClose: null,
    game: null,
    mode: 'marathon',
    cell: 28,
    mini: 20,
    tall: false,
    dpr: 1,
    holdCell: 20,
    nextCell: 20,
    nextCount: 5,
    countdown: null,
    endAt: 0,
    endInfo: null,
    displayScore: 0,
    last: 0,
    shake: { x: 0, y: 0, vx: 0, vy: 0 },
    hud: {},
    resultsShownAt: 0,
    capture: null,
    recordsMode: 'marathon',
    wakeLock: null,
    hardDropping: false,
    coarse: false,
  };

  const board = new R.BoardRenderer(els.boardCanvas);
  const holdView = new R.PreviewRenderer(els.holdCanvas);
  const nextView = new R.PreviewRenderer(els.nextCanvas);
  const logo = new R.LogoRenderer(els.logoCanvas);
  const wall = new WP.Wallpaper(els.wallpaper);

  const input = new window.TetrisInput.Input({
    settings,
    getGame: () => (app.screen === 'playing' ? app.game : null),
    cellPx: () => app.cell,
    handlers: {
      pause: () => togglePause(),
      menuNav: (dir) => spatialNav(dir),
      menuSelect: () => {
        const el = document.activeElement;
        if (el && el !== document.body && el.click) el.click();
        else focusFirst();
      },
      menuBack: () => back(),
      haptic: (p) => haptic(p),
      afterAction: () => flush(),
    },
  });

  // ---------------------------------------------------------------- utils

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const nf = new Intl.NumberFormat('en-US');
  const fmtInt = (n) => nf.format(Math.round(n));
  function fmtTime(ms, cs) {
    ms = Math.max(0, ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor(ms / 1000) % 60;
    let out = m + ':' + String(s).padStart(2, '0');
    if (cs) out += '.' + String(Math.floor(ms / 10) % 100).padStart(2, '0');
    return out;
  }
  function setText(el, key, value) {
    if (app.hud[key] === value) return;
    app.hud[key] = value;
    el.textContent = value;
  }
  function reduceMotion() {
    return settings.reduceMotion || osReduceMotion();
  }
  function osReduceMotion() {
    return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function haptic(pattern) {
    if (!settings.haptics || !app.coarse || !navigator.vibrate) return;
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      /* unsupported */
    }
  }
  function effectsOpts() {
    return { particles: settings.particles && !reduceMotion() };
  }

  // ---------------------------------------------------------- look & feel

  function resolveWallpaper() {
    if (settings.wallpaper !== 'auto' && WP.WALLPAPERS[settings.wallpaper]) return settings.wallpaper;
    const host = els.root.getAttribute('data-theme');
    if (host === 'light') return 'daylight';
    if (host === 'dark') return 'aurora';
    return window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'daylight' : 'aurora';
  }

  function applyLook() {
    const name = resolveWallpaper();
    wall.set(name);
    const light = WP.WALLPAPERS[name].light;
    els.root.setAttribute('data-scheme', light ? 'light' : 'dark');
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', WP.WALLPAPERS[name].base[0]);
    wall.animated = settings.animatedBg && !reduceMotion();
    els.root.setAttribute('data-glass', settings.glass);
    els.root.classList.toggle('reduce-motion', reduceMotion());
    Lens.setEnabled(settings.glass === 'high');
    if (board.light !== light) layout();
  }

  function applyAudio() {
    Audio.setVolumes({ master: settings.master, music: settings.music, sfx: settings.sfx });
    Audio.setTrack(settings.track);
  }

  function makeGrain() {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 160;
      const g = c.getContext('2d');
      const img = g.createImageData(160, 160);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      els.grain.style.backgroundImage = 'url(' + c.toDataURL() + ')';
    } catch (e) {
      /* decorative only */
    }
  }

  // --------------------------------------------------------------- layout

  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  function insets() {
    const cs = getComputedStyle(probe);
    return {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
  }

  function layout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    app.coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    const showPad = app.coarse && settings.touch === 'buttons';
    const tall = vw < 560 || (vw < 900 && vh > vw * 1.15);
    const ins = insets();
    const padX = Math.max(12, ins.left) + Math.max(12, ins.right);
    const padY = Math.max(10, ins.top) + Math.max(10, ins.bottom);
    // Six touch buttons across two clusters must fit the narrowest phones.
    const padSize = Math.round(clamp((vw - padX - 12 - 4 * 10) / 6, 44, 72));
    let cell;
    if (tall) {
      const padH = showPad ? Math.round(padSize * 1.8 + 30) : 0;
      const fixed = 44 + 3 * 8 + 18 + padH;
      const byH = (vh - padY - fixed) / (1.3 + 0.6 + 20.7);
      const byW = (vw - padX) / 10.7;
      cell = Math.floor(Math.min(byH, byW));
    } else {
      const padH = showPad ? Math.round(padSize * 1.8 + 30) : 0;
      const fixed = 44 + 2 * 10 + 12 + padH;
      const byH = (vh - padY - fixed) / (1.3 + 20.7);
      const byW = (vw - padX - 2 * 28 - 4 * 18) / (10.7 + 2 * 3.2);
      cell = Math.floor(Math.min(byH, byW));
    }
    cell = clamp(cell, 10, 44);
    const mini = Math.max(8, Math.round(cell * (tall ? 0.5 : 0.72)));
    const bpad = Math.max(5, Math.round(cell * 0.35));
    app.cell = cell;
    app.mini = mini;
    app.tall = tall;
    app.dpr = dpr;

    const st = els.game.style;
    st.setProperty('--cell', cell + 'px');
    st.setProperty('--mini', mini + 'px');
    st.setProperty('--bpad', bpad + 'px');
    st.setProperty('--board-w', cell * 10 + bpad * 2 + 'px');
    st.setProperty('--side', Math.round(mini * 4.4 + 28) + 'px');
    st.setProperty('--gap', Math.round(clamp(cell * 0.7, 10, 26)) + 'px');
    st.setProperty('--pad-size', padSize + 'px');
    els.game.classList.toggle('tall', tall);
    els.game.classList.toggle('show-pad', showPad);
    els.game.classList.toggle('compact', cell < 18);
    els.goal.hidden = cell < 18;

    const light = els.root.getAttribute('data-scheme') === 'light';
    board.resize(cell, dpr, light);

    app.holdCell = mini;
    app.nextCell = mini;
    if (tall) {
      holdView.resize(Math.round(mini * 4.2), Math.round(mini * 2.6), dpr);
      const holdPanel = Math.round(mini * 4.2) + 38;
      const nextW = Math.max(mini * 4.2, vw - padX - holdPanel - 8 - 38);
      app.nextCount = clamp(Math.floor(nextW / (mini * 3.9)), 1, settings.previews);
      nextView.resize(Math.round(nextW), Math.round(mini * 2.6), dpr);
    } else {
      app.nextCount = settings.previews;
      holdView.resize(Math.round(mini * 4.4), Math.round(mini * 2.8), dpr);
      nextView.resize(Math.round(mini * 4.4), Math.round(mini * (3.3 + 2.7 * (settings.previews - 1))), dpr);
    }

    const logoCell = clamp(Math.floor(Math.min(vw - 48, 560) / 24), 8, 22);
    logo.resize(logoCell, dpr);
    wall.resize();
    app.hud = {};
    $$('.segmented').forEach((s) => positionLens(s));
    Lens.refresh();
  }

  // ------------------------------------------------------- screens/modals

  function updateInert() {
    const blocking = !!app.modal;
    for (const el of Object.values(els.screens)) {
      const open = el.classList.contains('is-open');
      el.inert = !open || blocking;
      el.setAttribute('aria-hidden', String(!open));
      el.classList.toggle('is-behind', open && blocking);
    }
    els.game.classList.toggle('is-behind', blocking);
    for (const [name, el] of Object.entries(els.modals)) {
      el.inert = app.modal !== name;
      el.setAttribute('aria-hidden', String(app.modal !== name));
    }
    els.game.inert = blocking || !(app.screen === 'playing' || app.screen === 'countdown');
  }

  function setScreen(name) {
    app.screen = name;
    els.screens.menu.classList.toggle('is-open', name === 'menu');
    els.screens.paused.classList.toggle('is-open', name === 'paused');
    els.screens.results.classList.toggle('is-open', name === 'results');
    els.game.classList.toggle('is-hidden', name === 'menu');
    Audio.duck(name === 'paused');
    updateInert();
    if (name === 'paused' || name === 'results' || name === 'menu') flushToasts();
    if (name === 'paused') focusLater($('#btn-resume'));
    else if (name === 'results') focusLater($('#btn-res-again'));
    Lens.refresh();
  }

  function focusLater(el) {
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        el.focus({ preventScroll: true });
      } catch (e) {
        el.focus();
      }
    });
  }

  function openModal(id, onClose) {
    const el = els.modals[id];
    if (!el) return;
    if (app.modal) closeModal(true);
    app.modalReturn = document.activeElement;
    app.modalOnClose = onClose || null;
    app.modal = id;
    if (id === 'settings') syncSettingsUI();
    if (id === 'records') renderRecords();
    if (id === 'help') renderHelpKeys();
    el.classList.add('is-open');
    el.scrollTop = 0;
    updateInert();
    requestAnimationFrame(() => {
      $$('.segmented', el).forEach((s) => positionLens(s));
      Lens.refresh();
    });
    focusLater($('[role="tab"][aria-selected="true"]', el) || $('button', el));
    Audio.play('select');
  }

  function closeModal(silent) {
    if (!app.modal) return;
    cancelCapture();
    const el = els.modals[app.modal];
    el.classList.remove('is-open');
    app.modal = null;
    updateInert();
    const cb = app.modalOnClose;
    app.modalOnClose = null;
    if (!silent) Audio.play('back');
    if (app.modalReturn && document.contains(app.modalReturn)) focusLater(app.modalReturn);
    app.modalReturn = null;
    if (cb) cb();
  }

  function back() {
    if (app.modal) closeModal();
    else if (app.screen === 'paused') resume();
    else if (app.screen === 'results') quitToMenu();
  }

  function focusFirst() {
    const scope = app.modal ? els.modals[app.modal] : els.screens[app.screen];
    if (!scope) return;
    const el = $('button:not([disabled])', scope);
    if (el) el.focus();
  }

  // ----------------------------------------------------------------- menu

  function refreshMenu() {
    for (const m of S.MODE_ORDER) {
      const best = S.bestRun(records, m);
      const el = $('[data-best="' + m + '"]');
      if (el) el.textContent = best ? (m === 'sprint' ? fmtTime(best.time, true) : fmtInt(best.score)) : '—';
    }
    const hint = $('#menu-hint');
    if (hint) hint.hidden = app.coarse;
  }

  function quitToMenu() {
    app.game = null;
    app.countdown = null;
    els.countdown.textContent = '';
    els.callouts.textContent = '';
    input.releaseAll();
    board.reset();
    wall.setLevel(1);
    wall.setDanger(0);
    Audio.setLevel(1);
    Audio.duck(false);
    releaseWakeLock();
    refreshMenu();
    setScreen('menu');
    logo.replay(performance.now());
    const card = $('.mode-card[data-mode="' + app.mode + '"]');
    if (card && !app.coarse) focusLater(card);
  }

  // ---------------------------------------------------------- game flow

  function softDropFactor() {
    return settings.sdf >= S.SDF_INFINITE ? Infinity : settings.sdf;
  }

  function startGame(mode) {
    if (app.modal) closeModal(true);
    app.mode = E.MODES[mode] ? mode : 'marathon';
    app.game = new E.Game({
      mode: app.mode,
      startLevel: settings.startLevel,
      previewCount: settings.previews,
      softDropFactor: softDropFactor(),
    });
    app.displayScore = 0;
    app.hud = {};
    app.endInfo = null;
    app.hardDropping = false;
    board.reset();
    els.callouts.textContent = '';
    input.releaseAll();
    configureHud();
    Audio.setLevel(app.game.level);
    wall.setLevel(app.game.level);
    wall.setDanger(0);
    Audio.duck(false);
    Audio.startMusic();
    requestWakeLock();
    $('#pause-mode').textContent = MODE_INFO[app.mode].name;
    $('#btn-quit').lastChild.textContent = app.mode === 'zen' ? 'End session' : 'Main menu';

    const go = () =>
      startCountdown(460, () => {
        if (!app.game) return;
        app.game.start();
        setScreen('playing');
        flush();
      });
    if (app.coarse && settings.touch === 'gestures' && !profile.seenTouchHelp) {
      setScreen('countdown');
      app.countdown = null;
      openModal('touchhelp', () => {
        profile.seenTouchHelp = true;
        S.saveProfile(profile);
        go();
      });
    } else {
      go();
    }
  }

  function restart() {
    startGame(app.mode);
  }

  let countdownToken = 0;
  function startCountdown(stepMs, then) {
    app.countdown = { start: performance.now(), stepMs, n: 99, then };
    countdownToken++;
    setScreen('countdown');
  }

  function updateCountdown(now) {
    const c = app.countdown;
    const n = 3 - Math.floor((now - c.start) / c.stepMs);
    if (n === c.n) return;
    c.n = n;
    if (n >= 1) {
      els.countdown.innerHTML = '<span>' + n + '</span>';
      Audio.play('countdown', n);
    } else {
      els.countdown.innerHTML = '<span class="go">GO</span>';
      Audio.play('countdown', 0);
      app.countdown = null;
      const token = countdownToken;
      setTimeout(() => {
        if (token === countdownToken) els.countdown.textContent = '';
      }, 650);
      c.then();
    }
  }

  function pause() {
    if (app.screen !== 'playing' && app.screen !== 'countdown') return;
    if (app.modal) return;
    input.releaseAll();
    app.countdown = null;
    countdownToken++;
    els.countdown.textContent = '';
    setScreen('paused');
    Audio.play('back');
    releaseWakeLock();
  }

  function resume() {
    if (app.screen !== 'paused' || !app.game) return;
    Audio.play('select');
    requestWakeLock();
    if (app.game.state === 'ready') {
      startCountdown(460, () => {
        if (!app.game) return;
        app.game.start();
        setScreen('playing');
        flush();
      });
    } else {
      startCountdown(300, () => setScreen('playing'));
    }
  }

  function togglePause() {
    if (app.modal) return;
    if (app.screen === 'playing' || app.screen === 'countdown') pause();
    else if (app.screen === 'paused') resume();
  }

  function onGameEnd(ev, now) {
    const g = app.game;
    input.releaseAll();
    app.screen = 'ending';
    updateInert();
    releaseWakeLock();
    const won = ev.result !== 'topout';
    if (ev.result === 'ended') {
      app.endAt = now + 150;
    } else if (won) {
      Audio.play('win');
      callout(ev.result === 'timeup' ? 'TIME!' : 'FINISH', null, 'pc');
      wall.pulse(1.2);
      app.endAt = now + 1600;
    } else {
      board.startGameOver(now);
      Audio.play('gameOver');
      haptic([30, 60, 40]);
      app.endAt = now + 1500;
    }
    app.endInfo = finalizeRun(g, ev);
  }

  function finalizeRun(g, ev) {
    const st = g.stats;
    const run = {
      score: g.score,
      lines: g.lines,
      level: g.level,
      time: Math.round(g.time),
      pieces: st.pieces,
      date: Date.now(),
    };
    const prevBest = S.bestRun(records, g.mode);
    const eligible = g.mode === 'sprint' ? ev.result === 'cleared' : g.score > 0 || g.lines > 0;
    const rank = eligible ? S.addRecord(records, g.mode, run) : 0;

    profile.games += 1;
    profile.lines += g.lines;
    profile.pieces += st.pieces;
    profile.tetrises += st.tetrises;
    profile.tspins += st.tspins + st.tspinMinis;
    profile.perfectClears += st.perfectClears;
    profile.timePlayed += Math.round(g.time);
    profile.bestScore = Math.max(profile.bestScore, g.score);
    S.saveProfile(profile);
    checkAchievements(true, ev);
    return { run, rank, prevBest, result: ev.result, eligible };
  }

  function showResults() {
    const info = app.endInfo;
    const g = app.game;
    if (!info || !g) {
      quitToMenu();
      return;
    }
    const mode = g.mode;
    const st = g.stats;
    $('#res-mode').textContent = MODE_INFO[mode].name;
    let title = 'Game Over';
    if (info.result === 'cleared') title = 'Sprint complete';
    else if (info.result === 'timeup') title = 'Time’s up';
    else if (info.result === 'ended') title = 'Session complete';
    $('#res-title').textContent = title;

    let main;
    let label;
    if (mode === 'sprint') {
      if (info.result === 'cleared') {
        main = fmtTime(g.time, true);
        label = 'time';
      } else {
        main = g.lines + '/40';
        label = 'lines';
      }
    } else {
      main = fmtInt(g.score);
      label = 'points';
    }
    $('#res-main').textContent = main;
    $('#res-main-label').textContent = label;

    const slot = $('#res-badge-slot');
    slot.textContent = '';
    if (info.rank === 1) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.innerHTML = '<svg width="14" height="14" aria-hidden="true"><use href="#i-star"/></svg>';
      b.appendChild(document.createTextNode(info.prevBest ? 'New personal best' : 'First record set'));
      slot.appendChild(b);
    } else if (info.rank > 1) {
      const b = document.createElement('span');
      b.className = 'eyebrow';
      b.style.display = 'block';
      b.style.marginTop = '8px';
      b.textContent = 'Rank #' + info.rank + ' in your top 10';
      slot.appendChild(b);
    }

    const secs = g.time / 1000;
    const pps = secs > 0 ? (st.pieces / secs).toFixed(2) : '0.00';
    const items = [];
    if (mode === 'sprint') {
      items.push(['Lines', g.lines], ['Pieces', st.pieces], ['PPS', pps], ['Tetrises', st.tetrises], ['T-Spins', st.tspins + st.tspinMinis], ['Max combo', Math.max(0, st.maxCombo)]);
    } else {
      items.push(['Lines', g.lines], ['Level', g.level], ['Time', fmtTime(g.time)], ['Tetrises', st.tetrises], ['T-Spins', st.tspins + st.tspinMinis], ['Max combo', Math.max(0, st.maxCombo)]);
    }
    if (st.perfectClears) items.push(['Perfect clears', st.perfectClears]);
    if (mode !== 'sprint') items.push(['Pieces', st.pieces], ['PPS', pps]);
    const dl = $('#res-stats');
    dl.textContent = '';
    for (const [k, v] of items.slice(0, 9)) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = typeof v === 'number' ? fmtInt(v) : v;
      d.append(dt, dd);
      dl.appendChild(d);
    }
    renderBoardList($('#res-board'), mode, info.eligible ? info.run : null, 5);
    setScreen('results');
    app.resultsShownAt = performance.now();
  }

  // ------------------------------------------------------- event routing

  function flush() {
    processEvents(performance.now());
  }

  function processEvents(now) {
    const g = app.game;
    if (!g) return;
    const evs = g.drainEvents();
    if (!evs.length) return;
    const fx = effectsOpts();
    for (const ev of evs) {
      switch (ev.type) {
        case 'move':
          Audio.play('move');
          break;
        case 'rotate':
          Audio.play('rotate', ev.dir, ev.tspin);
          break;
        case 'land':
          Audio.play('land');
          break;
        case 'hardDrop':
          app.hardDropping = true;
          Audio.play('hardDrop', ev.distance);
          board.onHardDrop(ev, now, fx);
          bump(Math.min(1, 0.3 + ev.distance / 18), false);
          haptic(8);
          break;
        case 'lock':
          board.onLock(ev, now);
          if (!app.hardDropping) Audio.play('lock');
          app.hardDropping = false;
          break;
        case 'hold':
          Audio.play('hold');
          break;
        case 'clear':
          onClear(ev, now, fx);
          break;
        case 'levelUp':
          Audio.setLevel(ev.level);
          wall.setLevel(ev.level);
          Audio.play('levelUp');
          callout('LEVEL ' + ev.level, null, 'level');
          wall.pulse(0.7);
          checkAchievements(false);
          break;
        case 'zenReset':
          board.onZenReset(ev, now, fx);
          Audio.play('zenReset');
          callout('FRESH START', null, 'level');
          wall.pulse(1);
          break;
        case 'gameEnd':
          onGameEnd(ev, now);
          break;
      }
    }
  }

  function onClear(ev, now, fx) {
    board.onClear(ev, now, fx);
    Audio.play('clear', ev);
    const special = ev.lines === 4 || (ev.tspin !== 'none' && ev.lines > 0) || ev.perfectClear;
    wall.pulse(0.16 * ev.lines + (ev.tspin !== 'none' ? 0.35 : 0) + (ev.perfectClear ? 1.2 : 0) + Math.max(0, ev.combo) * 0.04);
    if (special) bump(1.5, true);
    if (ev.lines) haptic(special ? [16, 40, 22] : 12);
    clearCallout(ev);
    checkAchievements(false);
  }

  function clearCallout(ev) {
    const n = ev.lines;
    const names = ['', ' SINGLE', ' DOUBLE', ' TRIPLE'];
    let main = '';
    let cls = '';
    if (ev.tspin === 'full') {
      main = 'T-SPIN' + names[n];
      cls = 'tspin';
    } else if (ev.tspin === 'mini') {
      main = 'MINI T-SPIN' + names[Math.min(n, 3)];
      cls = 'tspin';
    } else if (n === 4) {
      main = 'TETRIS';
      cls = 'tetris';
    } else if (n === 3) {
      main = 'TRIPLE';
    } else if (n === 2) {
      main = 'DOUBLE';
    }
    const parts = [];
    if (ev.b2b) parts.push('B2B' + (ev.b2bCount > 1 ? ' ×' + ev.b2bCount : ''));
    if (ev.combo >= 1) parts.push(ev.combo + ' COMBO');
    if (ev.points > 0 && (main || parts.length) && !ev.perfectClear) parts.push('+' + fmtInt(ev.points));
    if (ev.perfectClear) {
      callout('PERFECT CLEAR', '+' + fmtInt(ev.points), 'pc');
    } else if (main || parts.length) {
      callout(main, parts.join('  ·  '), cls);
    }
  }

  function callout(main, sub, cls) {
    const box = els.callouts;
    while (box.children.length >= 2) box.firstChild.remove();
    const el = document.createElement('div');
    el.className = 'callout' + (cls ? ' callout-' + cls : '');
    if (main) {
      const m = document.createElement('div');
      m.className = 'callout-main';
      m.textContent = main;
      el.appendChild(m);
    }
    if (sub) {
      const s = document.createElement('div');
      s.className = 'callout-sub';
      s.textContent = sub;
      el.appendChild(s);
    }
    box.appendChild(el);
    const done = () => el.remove();
    el.addEventListener('animationend', (e) => {
      if (e.target === el) done();
    });
    setTimeout(done, 2200);
  }

  function bump(strength, side) {
    if (!settings.shake || reduceMotion()) return;
    app.shake.vy += strength * 95;
    if (side) app.shake.vx += (Math.random() < 0.5 ? -1 : 1) * strength * 60;
  }

  function updateShake(dt) {
    const s = app.shake;
    const t = Math.min(dt, 34) / 1000;
    const k = 560;
    const c = 24;
    s.vy += (-k * s.y - c * s.vy) * t;
    s.y += s.vy * t;
    s.vx += (-k * s.x - c * s.vx) * t;
    s.x += s.vx * t;
    if (Math.abs(s.y) < 0.02 && Math.abs(s.vy) < 0.05 && Math.abs(s.x) < 0.02 && Math.abs(s.vx) < 0.05) {
      s.x = s.y = s.vx = s.vy = 0;
    }
    const key = s.x.toFixed(2) + ',' + s.y.toFixed(2);
    if (app.hud.shake !== key) {
      app.hud.shake = key;
      els.boardShell.style.transform = s.x || s.y ? 'translate3d(' + s.x.toFixed(2) + 'px,' + s.y.toFixed(2) + 'px,0)' : '';
    }
  }

  // ------------------------------------------------------------- achievements

  function checkAchievements(final, ev) {
    const g = app.game;
    if (!g) return;
    const st = g.stats;
    const got = [];
    const u = (id) => {
      if (!profile.achievements[id]) {
        profile.achievements[id] = Date.now();
        got.push(id);
      }
    };
    if (g.lines >= 1) u('first-line');
    if (st.tetrises >= 1) u('tetris');
    if (st.tspins + st.tspinMinis >= 1) u('tspin');
    if (st.tspinDoubles >= 1) u('tsd');
    if (st.tspinTriples >= 1) u('tst');
    if (st.maxB2B >= 3) u('b2b3');
    if (st.maxCombo >= 5) u('combo5');
    if (st.maxCombo >= 10) u('combo10');
    if (st.perfectClears >= 1) u('pc');
    if (g.mode === 'marathon') {
      if (g.level >= 10) u('level10');
      if (g.level >= 15) u('level15');
      if (g.level >= 20) u('level20');
    }
    if (g.score >= 100000) u('score100k');
    if (g.mode === 'ultra') {
      if (g.score >= 30000) u('ultra30k');
      if (g.score >= 60000) u('ultra60k');
    }
    if (g.mode === 'zen' && g.lines >= 200) u('zen200');
    if (final) {
      if (g.mode === 'sprint' && ev && ev.result === 'cleared') {
        u('sprint');
        if (g.time < 90000) u('sprint90');
        if (g.time < 60000) u('sprint60');
      }
      if (profile.lines >= 1000) u('lines1000');
    }
    if (got.length) {
      S.saveProfile(profile);
      got.forEach((id) => toastAchievement(id));
    }
  }

  // Achievements earned mid-game wait for a pause or the results screen so
  // nothing ever covers the playfield.
  const toastQueue = [];
  function toastAchievement(id) {
    const a = S.ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return;
    if (app.screen === 'playing' || app.screen === 'countdown' || app.screen === 'ending') {
      if (toastQueue.indexOf(id) === -1) toastQueue.push(id);
      return;
    }
    toast('Achievement · ' + a.name, a.desc, 'i-star');
    Audio.play('achievement');
  }
  function flushToasts() {
    const ids = toastQueue.splice(0);
    ids.forEach((id, i) => setTimeout(() => toastAchievement(id), 350 + i * 900));
  }

  function toast(title, body, icon) {
    const t = document.createElement('div');
    t.className = 'toast glass no-lens';
    t.setAttribute('role', 'status');
    t.innerHTML = '<i><svg aria-hidden="true"><use href="#' + icon + '"/></svg></i><span><b></b><small></small></span>';
    $('b', t).textContent = title;
    $('small', t).textContent = body;
    els.toasts.appendChild(t);
    setTimeout(() => {
      t.classList.add('is-leaving');
      setTimeout(() => t.remove(), 420);
    }, 3400);
  }

  // ------------------------------------------------------------------ HUD

  function configureHud() {
    const info = MODE_INFO[app.mode];
    els.modeName.textContent = info.name;
    els.modePill.style.setProperty('--tint', info.tint);
    els.goal.style.setProperty('--tint', info.tint);
    const L = {
      marathon: ['Score', 'Level', 'Lines', 'Time'],
      sprint: ['Time', 'Lines', 'Pieces', 'PPS'],
      ultra: ['Score', 'Time', 'Lines', 'Level'],
      zen: ['Score', 'Level', 'Lines', 'Time'],
    }[app.mode];
    els.st.mainL.textContent = L[0];
    els.st.aL.textContent = L[1];
    els.st.bL.textContent = L[2];
    els.st.cL.textContent = L[3];
    app.hud = {};
  }

  function updateHud(dt) {
    const g = app.game;
    if (!g) return;
    const diff = g.score - app.displayScore;
    app.displayScore = Math.abs(diff) < 1 ? g.score : app.displayScore + diff * Math.min(1, dt / 110);
    const secs = g.time / 1000;
    const pps = secs > 0.5 ? (g.stats.pieces / secs).toFixed(2) : '0.00';
    let main;
    let a;
    let b;
    let c;
    let frac;
    let ringVal;
    let ringLabel;
    switch (g.mode) {
      case 'sprint': {
        main = fmtTime(g.time, true);
        a = Math.min(g.lines, 40) + '/40';
        b = fmtInt(g.stats.pieces);
        c = pps;
        const rem = Math.max(0, 40 - g.lines);
        frac = Math.min(1, g.lines / 40);
        ringVal = String(rem);
        ringLabel = 'Lines left';
        break;
      }
      case 'ultra': {
        const rem = g.remainingTime();
        main = fmtInt(app.displayScore);
        a = fmtTime(Math.ceil(rem / 1000) * 1000);
        b = fmtInt(g.lines);
        c = String(g.level);
        frac = rem / g.rules.timeLimit;
        ringVal = a;
        ringLabel = 'Time left';
        break;
      }
      default: {
        main = fmtInt(app.displayScore);
        a = String(g.level);
        b = fmtInt(g.lines);
        c = fmtTime(g.time);
        const target = (g.level - g.startLevel + 1) * 10;
        const rem = Math.max(0, target - g.lines);
        frac = 1 - rem / 10;
        ringVal = String(rem);
        ringLabel = 'To level ' + (g.level + 1);
      }
    }
    setText(els.st.main, 'main', main);
    setText(els.st.a, 'a', a);
    setText(els.st.b, 'b', b);
    setText(els.st.c, 'c', c);
    setText(els.goalValue, 'rv', ringVal);
    setText(els.goalLabel, 'rl', ringLabel);
    const off = (100 - clamp(frac, 0, 1) * 100).toFixed(1);
    if (app.hud.ring !== off) {
      app.hud.ring = off;
      els.ringFill.setAttribute('stroke-dashoffset', off);
    }

    holdView.drawHold(g.holdType, g.holdUsed, app.holdCell);
    nextView.drawQueue(g.queue, app.nextCount, app.nextCell, app.tall);

    const h = g.state === 'playing' ? g.stackHeight() : 0;
    const danger = h >= 17;
    if (app.hud.danger !== danger) {
      app.hud.danger = danger;
      els.boardFrame.classList.toggle('is-danger', danger);
    }
    wall.setDanger(clamp((h - 13) / 6, 0, 1));
  }

  // ---------------------------------------------------------- frame loop

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = app.last ? now - app.last : 16.7;
    app.last = now;
    dt = clamp(dt, 0, 100);

    input.update(dt);
    if (app.screen === 'countdown' && app.countdown) updateCountdown(now);
    if (app.screen === 'playing' && app.game) app.game.update(dt, input.softHeld);
    processEvents(now);
    if (app.screen === 'ending' && now >= app.endAt) showResults();

    wall.render(now, dt);
    if (app.screen === 'menu') {
      logo.render(now, reduceMotion());
    } else {
      board.render(app.game, now, app.screen === 'paused' ? 0 : dt, { ghost: settings.ghost, grid: settings.grid });
      updateHud(dt);
      updateShake(dt);
    }
  }

  // ------------------------------------------------------------- settings UI

  function rangeText(key, v) {
    switch (key) {
      case 'das':
        return Math.round(v) + ' ms';
      case 'arr':
        return v <= 0 ? 'Instant' : Math.round(v) + ' ms';
      case 'sdf':
        return v >= S.SDF_INFINITE ? 'Instant' : Math.round(v) + '×';
      default:
        return Math.round(v * 100) + '%';
    }
  }

  function paintRange(input) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const v = parseFloat(input.value);
    input.style.setProperty('--p', ((v - min) / (max - min)) * 100 + '%');
    const out = document.getElementById('out-' + input.dataset.setting);
    if (out) out.textContent = rangeText(input.dataset.setting, v);
  }

  function syncSettingsUI() {
    $$('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') {
        el.checked = !!settings[key];
        if (key === 'reduceMotion') {
          const forced = osReduceMotion();
          el.checked = settings.reduceMotion || forced;
          el.disabled = forced;
        }
      } else if (el.type === 'range') {
        el.value = settings[key];
        paintRange(el);
      }
    });
    $$('[data-stepper]').forEach((st) => {
      const out = $('output', st);
      out.textContent = settings[st.dataset.stepper];
    });
    $$('[data-seg]').forEach((seg) => {
      const key = seg.dataset.seg;
      const value = key === 'recordsMode' ? app.recordsMode : settings[key];
      $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
      positionLens(seg);
    });
    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === settings.wallpaper)));
    renderBindings();
  }

  let sfxPreviewAt = 0;
  function commit(key) {
    S.saveSettings(settings);
    switch (key) {
      case 'master':
      case 'music':
      case 'sfx':
        applyAudio();
        if (key !== 'music' && performance.now() - sfxPreviewAt > 180) {
          sfxPreviewAt = performance.now();
          Audio.play('rotate', 1);
        }
        break;
      case 'track':
        applyAudio();
        Audio.ensureMusic();
        break;
      case 'wallpaper':
      case 'glass':
      case 'reduceMotion':
      case 'animatedBg':
        applyLook();
        break;
      case 'touch':
        layout();
        break;
      case 'previews':
        if (app.game) {
          app.game.previewCount = settings.previews;
          app.game.fillQueue();
        }
        layout();
        break;
      case 'sdf':
        if (app.game) app.game.softDropFactor = softDropFactor();
        break;
    }
  }

  function positionLens(seg, animate) {
    const lens = $('.seg-lens', seg);
    const active = $('[aria-selected="true"], [aria-pressed="true"]', seg);
    if (!lens || !active || !active.offsetWidth) return;
    lens.style.width = active.offsetWidth + 'px';
    lens.style.transform = 'translateX(' + active.offsetLeft + 'px)';
    if (animate && !reduceMotion()) {
      lens.classList.remove('squish');
      void lens.offsetWidth;
      lens.classList.add('squish');
    }
  }

  function selectTab(tab) {
    const list = tab.closest('[role="tablist"]');
    $$('[role="tab"]', list).forEach((b) => {
      const on = b === tab;
      b.setAttribute('aria-selected', String(on));
      const panel = document.getElementById(b.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    positionLens(list, true);
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) {
      requestAnimationFrame(() => {
        $$('.segmented', panel).forEach((s) => positionLens(s));
        Lens.refresh();
      });
    }
  }

  function bindSettingsUI() {
    $$('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') {
        el.addEventListener('change', () => {
          settings[key] = el.checked;
          commit(key);
          Audio.play('ui');
        });
      } else if (el.type === 'range') {
        el.addEventListener('input', () => {
          settings[key] = parseFloat(el.value);
          paintRange(el);
          commit(key);
        });
      }
    });

    $$('[data-stepper]').forEach((st) => {
      const key = st.dataset.stepper;
      const min = parseInt(st.dataset.min, 10);
      const max = parseInt(st.dataset.max, 10);
      $$('button', st).forEach((b) => {
        b.addEventListener('click', () => {
          settings[key] = clamp(settings[key] + parseInt(b.dataset.step, 10), min, max);
          $('output', st).textContent = settings[key];
          commit(key);
          Audio.play('ui');
        });
      });
    });

    $$('[data-seg]').forEach((seg) => {
      const key = seg.dataset.seg;
      $$('button', seg).forEach((b) => {
        b.addEventListener('click', () => {
          $$('button', seg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          positionLens(seg, true);
          Audio.play('ui');
          if (key === 'recordsMode') {
            app.recordsMode = b.dataset.value;
            renderRecordList();
            return;
          }
          settings[key] = b.dataset.value;
          commit(key);
        });
      });
    });

    $$('[role="tab"]').forEach((tab) => {
      tab.addEventListener('click', () => {
        selectTab(tab);
        Audio.play('ui');
      });
      tab.addEventListener('focus', () => {
        if (tab.getAttribute('aria-selected') !== 'true' && app.keyboardNav) selectTab(tab);
      });
    });

    const sw = $('#swatches');
    const opts = [['auto', 'Auto']].concat(Object.keys(WP.WALLPAPERS).map((k) => [k, WP.WALLPAPERS[k].name]));
    for (const [value, name] of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.value = value;
      const i = document.createElement('i');
      i.style.setProperty('--sw', swatchBackground(value));
      b.appendChild(i);
      b.appendChild(document.createTextNode(name));
      b.addEventListener('click', () => {
        settings.wallpaper = value;
        $$('.swatch').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        commit('wallpaper');
        Audio.play('ui');
      });
      sw.appendChild(b);
    }

    $('#btn-reset-keys').addEventListener('click', () => {
      settings.bindings = JSON.parse(JSON.stringify(S.DEFAULT_BINDINGS));
      S.saveSettings(settings);
      input.rebuildKeyMap();
      renderBindings();
      Audio.play('select');
    });
  }

  function swatchBackground(name) {
    if (name === 'auto') {
      const d = WP.WALLPAPERS.aurora;
      const l = WP.WALLPAPERS.daylight;
      return 'linear-gradient(135deg, ' + d.blobs[0] + ' 0%, ' + d.base[1] + ' 49%, ' + l.base[0] + ' 51%, ' + l.blobs[1] + ' 100%)';
    }
    const w = WP.WALLPAPERS[name];
    return (
      'radial-gradient(circle at 25% 25%, ' + w.blobs[0] + ', transparent 60%), ' +
      'radial-gradient(circle at 80% 70%, ' + w.blobs[1] + ', transparent 60%), ' +
      'radial-gradient(circle at 30% 85%, ' + w.blobs[3] + ', transparent 55%), ' +
      'linear-gradient(160deg, ' + w.base[0] + ', ' + w.base[1] + ')'
    );
  }

  // -- key bindings

  const KEY_NAMES = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
    MetaLeft: 'L ⌘',
    MetaRight: 'R ⌘',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    CapsLock: 'Caps',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
  };

  function keyName(code) {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
    return code;
  }

  function renderBindings() {
    const box = $('#bindings');
    if (!box) return;
    box.textContent = '';
    for (const action of S.ACTIONS) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('div');
      label.className = 'row-label';
      const span = document.createElement('span');
      span.textContent = S.ACTION_LABELS[action];
      label.appendChild(span);
      const keys = document.createElement('div');
      keys.className = 'keys';
      for (let slot = 0; slot < 2; slot++) {
        const code = settings.bindings[action][slot];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'keycap' + (code ? '' : ' is-empty');
        b.textContent = code ? keyName(code) : 'Add';
        b.setAttribute('aria-label', S.ACTION_LABELS[action] + ', key ' + (slot + 1) + ': ' + (code ? keyName(code) : 'none') + '. Activate to change.');
        b.addEventListener('click', () => startCapture(action, slot, b));
        keys.appendChild(b);
      }
      row.append(label, keys);
      box.appendChild(row);
    }
  }

  function startCapture(action, slot, btn) {
    cancelCapture();
    app.capture = { action, slot, btn };
    btn.classList.add('is-capturing');
    btn.textContent = 'Press a key';
  }

  function cancelCapture() {
    if (!app.capture) return;
    const c = app.capture;
    app.capture = null;
    c.btn.classList.remove('is-capturing');
    renderBindings();
  }

  function handleCapture(e) {
    e.preventDefault();
    e.stopPropagation();
    const c = app.capture;
    if (e.code === 'Escape') {
      cancelCapture();
      return;
    }
    if (S.RESERVED_KEYS.indexOf(e.code) !== -1) {
      c.btn.textContent = 'Reserved';
      return;
    }
    const list = settings.bindings[c.action].slice();
    if (e.code === 'Backspace' || e.code === 'Delete') {
      list.splice(c.slot, 1);
    } else {
      for (const a of S.ACTIONS) settings.bindings[a] = settings.bindings[a].filter((k) => k !== e.code);
      const fresh = settings.bindings[c.action].slice();
      if (c.slot < fresh.length) fresh[c.slot] = e.code;
      else fresh.push(e.code);
      list.length = 0;
      fresh.forEach((k) => list.push(k));
    }
    settings.bindings[c.action] = list.filter(Boolean).slice(0, 2);
    app.capture = null;
    S.saveSettings(settings);
    input.rebuildKeyMap();
    renderBindings();
    Audio.play('select');
    const idx = S.ACTIONS.indexOf(c.action);
    const caps = $$('#bindings .keycap');
    focusLater(caps[idx * 2 + Math.min(c.slot, 1)]);
  }

  // ---------------------------------------------------------- help/records

  function renderHelpKeys() {
    const box = $('#help-keys');
    box.textContent = '';
    const rows = S.ACTIONS.map((a) => [S.ACTION_LABELS[a], settings.bindings[a]]);
    rows.push(['Pause', ['Escape', 'KeyP']], ['Restart (Sprint, Ultra, paused)', ['KeyR']]);
    for (const [label, keys] of rows) {
      const r = document.createElement('div');
      r.className = 'help-row';
      const l = document.createElement('span');
      l.textContent = label;
      const k = document.createElement('span');
      if (!keys.length) {
        const none = document.createElement('kbd');
        none.textContent = '—';
        k.appendChild(none);
      }
      for (const code of keys) {
        const kb = document.createElement('kbd');
        kb.textContent = keyName(code);
        k.appendChild(kb);
      }
      r.append(l, k);
      box.appendChild(r);
    }
  }

  function renderBoardList(list, mode, current, limit) {
    list.textContent = '';
    const runs = (records[mode] || []).slice(0, limit);
    if (!runs.length) {
      const li = document.createElement('li');
      const s = document.createElement('span');
      s.className = 'empty';
      s.textContent = 'No runs yet. Your best ' + (limit === 5 ? 'five' : 'ten') + ' will appear here.';
      li.appendChild(s);
      li.style.display = 'block';
      list.appendChild(li);
      return;
    }
    runs.forEach((run, i) => {
      const li = document.createElement('li');
      if (current && run.date === current.date && run.score === current.score && run.time === current.time) li.className = 'is-current';
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(i + 1);
      const detail = document.createElement('span');
      let date = '';
      try {
        date = new Date(run.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      } catch (e) {
        date = '';
      }
      detail.textContent = mode === 'sprint' ? date + ' · ' + run.pieces + ' pieces' : date + ' · ' + run.lines + ' lines · Lv ' + run.level;
      const val = document.createElement('span');
      val.className = 'num';
      val.textContent = mode === 'sprint' ? fmtTime(run.time, true) : fmtInt(run.score);
      li.append(rank, detail, val);
      list.appendChild(li);
    });
  }

  function renderRecordList() {
    renderBoardList($('#records-list'), app.recordsMode, null, 10);
  }

  function renderRecords() {
    renderRecordList();
    const box = $('#ach-list');
    box.textContent = '';
    let n = 0;
    for (const a of S.ACHIEVEMENTS) {
      const on = !!profile.achievements[a.id];
      if (on) n++;
      const d = document.createElement('div');
      d.className = 'ach' + (on ? ' is-unlocked' : '');
      d.innerHTML = '<i><svg aria-hidden="true"><use href="#i-star"/></svg></i><span><b></b><small></small></span>';
      $('b', d).textContent = a.name;
      $('small', d).textContent = a.desc;
      d.setAttribute('aria-label', a.name + (on ? ', unlocked. ' : ', locked. ') + a.desc);
      box.appendChild(d);
    }
    $('#ach-count').textContent = n + ' of ' + S.ACHIEVEMENTS.length + ' unlocked';
    const life = $('#lifetime');
    life.textContent = '';
    const hours = profile.timePlayed / 3600000;
    const items = [
      ['Games', fmtInt(profile.games)],
      ['Lines', fmtInt(profile.lines)],
      ['Pieces', fmtInt(profile.pieces)],
      ['Tetrises', fmtInt(profile.tetrises)],
      ['T-Spins', fmtInt(profile.tspins)],
      ['Perfect clears', fmtInt(profile.perfectClears)],
      ['Best score', fmtInt(profile.bestScore)],
      ['Time played', hours >= 1 ? hours.toFixed(1) + ' h' : Math.round(profile.timePlayed / 60000) + ' min'],
    ];
    for (const [k, v] of items) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      d.append(dt, dd);
      life.appendChild(d);
    }
  }

  // ------------------------------------------------------- keyboard & nav

  function focusables(scope) {
    return $$('button:not([disabled]), input:not([disabled]), [tabindex="0"]', scope).filter((el) => {
      if (el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function activeScope() {
    if (app.modal) return els.modals[app.modal];
    return els.screens[app.screen] || null;
  }

  function spatialNav(dir) {
    const scope = activeScope();
    if (!scope) return;
    app.keyboardNav = true;
    const items = focusables(scope);
    if (!items.length) return;
    const cur = document.activeElement;
    if (!cur || items.indexOf(cur) === -1) {
      const pick = app.screen === 'menu' && !app.modal ? $('.mode-card[data-mode="' + app.mode + '"]') : items[0];
      (pick || items[0]).focus();
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const q = el.getBoundingClientRect();
      const dx = q.left + q.width / 2 - cx;
      const dy = q.top + q.height / 2 - cy;
      const primary = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      if (primary <= 4) continue;
      const secondary = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = primary + secondary * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus();
      if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest' });
      Audio.play('ui');
    }
    app.keyboardNav = false;
  }

  const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  function navKeys(e) {
    const dir = ARROWS[e.code];
    if (!dir) {
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && (!document.activeElement || document.activeElement === document.body)) {
        e.preventDefault();
        if (app.screen === 'menu' && !app.modal) startGame(app.mode);
        else focusFirst();
      }
      return;
    }
    const t = e.target;
    if (t && t.type === 'range' && (dir === 'left' || dir === 'right')) return;
    e.preventDefault();
    app.keyboardNav = true;
    spatialNav(dir);
  }

  function onKeyDown(e) {
    unlockAudio();
    if (app.capture) {
      handleCapture(e);
      return;
    }
    const k = e.code;
    if (app.modal) {
      if (k === 'Escape') {
        e.preventDefault();
        closeModal();
        return;
      }
      navKeys(e);
      return;
    }
    switch (app.screen) {
      case 'playing':
      case 'countdown':
        if (k === 'Escape' || k === 'KeyP') {
          e.preventDefault();
          if (!e.repeat) pause();
          return;
        }
        if (k === 'KeyR' && !e.repeat && (app.mode === 'sprint' || app.mode === 'ultra')) {
          e.preventDefault();
          restart();
          return;
        }
        if (input.keyDown(e)) flush();
        else if (k === 'Tab') e.preventDefault();
        return;
      case 'ending':
        if (input.keyMap[k]) e.preventDefault();
        return;
      case 'paused':
        if ((k === 'Escape' || k === 'KeyP') && !e.repeat) {
          e.preventDefault();
          resume();
          return;
        }
        if (k === 'KeyR' && !e.repeat) {
          e.preventDefault();
          restart();
          return;
        }
        navKeys(e);
        return;
      case 'results':
        if (performance.now() - app.resultsShownAt < 700) {
          e.preventDefault();
          return;
        }
        if (k === 'KeyR' && !e.repeat) {
          e.preventDefault();
          restart();
          return;
        }
        if (k === 'Escape') {
          e.preventDefault();
          quitToMenu();
          return;
        }
        navKeys(e);
        return;
      case 'menu':
        navKeys(e);
        return;
    }
  }

  function onKeyUp(e) {
    input.keyUp(e);
  }

  // ------------------------------------------------------------- platform

  let audioUnlocked = false;
  function unlockAudio() {
    Audio.unlock();
    if (!audioUnlocked && Audio.ready) {
      audioUnlocked = true;
      applyAudio();
      Audio.ensureMusic();
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !app.wakeLock && document.visibilityState === 'visible') {
        const lock = await navigator.wakeLock.request('screen');
        app.wakeLock = lock;
        lock.addEventListener('release', () => {
          if (app.wakeLock === lock) app.wakeLock = null;
        });
      }
    } catch (e) {
      app.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    const lock = app.wakeLock;
    app.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  function setupFullscreen() {
    const enabled = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    els.btnFs.hidden = !enabled;
    els.btnFs.addEventListener('click', () => {
      const d = document;
      const el = d.documentElement;
      try {
        if (d.fullscreenElement || d.webkitFullscreenElement) {
          (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        } else {
          const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {
        /* not allowed here */
      }
    });
  }

  function setupPointerLight() {
    let pending = false;
    let lx = 0;
    let ly = 0;
    document.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        lx = e.clientX;
        ly = e.clientY;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          els.root.style.setProperty('--lx', lx + 'px');
          els.root.style.setProperty('--ly', ly + 'px');
        });
      },
      { passive: true }
    );
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !$('link[rel="manifest"]')) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    try {
      if (window.top !== window.self) return;
    } catch (e) {
      return;
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ------------------------------------------------------------------ boot

  function bindUI() {
    $$('.mode-card').forEach((card) => {
      card.addEventListener('click', () => {
        unlockAudio();
        Audio.play('select');
        startGame(card.dataset.mode);
      });
      card.addEventListener('focus', () => {
        app.mode = card.dataset.mode;
      });
    });
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.open)));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal()));
    $$('.screen.modal').forEach((m) =>
      m.addEventListener('pointerdown', (e) => {
        if (e.target === m) closeModal();
      })
    );
    els.btnPause.addEventListener('click', () => pause());
    $('#btn-resume').addEventListener('click', () => resume());
    $('#btn-restart').addEventListener('click', () => restart());
    $('#btn-quit').addEventListener('click', () => {
      if (app.mode === 'zen' && app.game && app.game.state === 'playing') {
        app.game.finish('ended');
        flush();
        Audio.duck(false);
      } else {
        quitToMenu();
      }
    });
    $('#btn-res-again').addEventListener('click', () => restart());
    $('#btn-res-menu').addEventListener('click', () => quitToMenu());
    $('#btn-touch-ok').addEventListener('click', () => closeModal());
    $('#btn-touch-buttons').addEventListener('click', () => {
      settings.touch = 'buttons';
      S.saveSettings(settings);
      layout();
      closeModal();
    });

    input.attachButtons(els.touchPad);
    input.attachGestures(els.game);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerdown', () => unlockAudio(), true);
    document.addEventListener('pointerdown', () => (app.keyboardNav = false), true);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        pause();
        input.releaseAll();
        Audio.suspend();
      } else {
        Audio.resume();
        app.last = 0;
        if (app.screen === 'playing' || app.screen === 'countdown') requestWakeLock();
      }
    });
    window.addEventListener('blur', () => {
      input.releaseAll();
      pause();
    });

    let resizeRaf = 0;
    const onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(layout);
    };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    if (window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: light)');
      const onScheme = () => {
        if (settings.wallpaper === 'auto') applyLook();
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      const rm = matchMedia('(prefers-reduced-motion: reduce)');
      if (rm.addEventListener) rm.addEventListener('change', () => applyLook());
    }
    // The artifact host flips data-theme on <html>.
    if (window.MutationObserver) {
      new MutationObserver(() => {
        if (settings.wallpaper === 'auto') applyLook();
      }).observe(els.root, { attributes: true, attributeFilter: ['data-theme'] });
    }

    document.addEventListener('contextmenu', (e) => {
      if (app.screen === 'playing') e.preventDefault();
    });
  }

  function boot() {
    makeGrain();
    applyLook();
    applyAudio();
    bindSettingsUI();
    bindUI();
    setupFullscreen();
    setupPointerLight();
    layout();
    refreshMenu();
    setScreen('menu');
    logo.replay(performance.now());
    registerServiceWorker();
    requestAnimationFrame(frame);
    // Debug/test hook (harmless in production).
    window.__tetris = { app, settings, records, profile, startGame, pause, resume, layout };
  }

  boot();
})();
