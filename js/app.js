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
  const Glass = window.TetrisGlass;

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const firstRun = !S.hasSavedSettings();
  const settings = S.loadSettings();
  if (firstRun) {
    // Very weak devices start on frosted glass; everyone else gets Liquid,
    // and the governor in the frame loop steps down if a device can't keep up.
    const weak = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2;
    if (weak) settings.glass = 'standard';
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) settings.reduceMotion = true;
  }
  const records = S.loadRecords();
  const profile = S.loadProfile();
  let daily = S.loadDaily();

  const MODE_INFO = {
    marathon: { name: 'Marathon', tint: '#64d2ff' },
    sprint: { name: 'Sprint 40L', tint: '#ff9f0a' },
    ultra: { name: 'Ultra 2:00', tint: '#bf5af2' },
    zen: { name: 'Zen', tint: '#30d158' },
    daily: { name: 'Daily', tint: '#ffb340' },
  };
  // Modes whose runs are saved so they can be continued later.
  const SAVE_MODES = ['marathon', 'zen'];

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
    holdSr: $('#hold-sr'),
    nextSr: $('#next-sr'),
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
      confirm: $('#screen-confirm'),
    },
  };

  const perf = { ema: 16.7, slowMs: 0, warm: 0, degraded: false };

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
    runUnlocks: [],
  };

  const board = new R.BoardRenderer(els.boardCanvas);
  const holdView = new R.PreviewRenderer(els.holdCanvas);
  const nextView = new R.PreviewRenderer(els.nextCanvas);
  const logo = new R.LogoRenderer(els.logoCanvas);
  const wall = new WP.Wallpaper(els.wallpaper, $('#wallpaper-fx'));

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
      canCharge: () => app.screen === 'countdown' && !!app.countdown,
      // Pad presses still being mashed from the last game don't skip the results.
      menuReady: () =>
        !!app.modal || app.screen === 'menu' || app.screen === 'paused' || (app.screen === 'results' && performance.now() - app.resultsShownAt > 600),
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
    if (el.classList.contains('stat-value')) el.style.setProperty('--chars', Math.max(3, value.length));
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
    perf.degraded = false;
    perf.slowMs = 0;
    perf.warm = 0;
    const solidOnly = !!(window.matchMedia && matchMedia('(prefers-reduced-transparency: reduce)').matches);
    let material = settings.glass;
    // Liquid needs WebGL2; without it, fall back to frosted CSS glass.
    if (material === 'high' && (!Glass.supported || solidOnly)) material = solidOnly ? 'low' : 'standard';
    els.root.setAttribute('data-glass', material);
    els.root.classList.toggle('reduce-motion', reduceMotion());
    Glass.setScheme(light);
    Glass.setEnabled(material === 'high');
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
    // Three arrangements: wide (desktop/tablet), tall (portrait phone) and
    // short (landscape phone: HUD and buttons flank a full-height board).
    const short = vh < 560 && vw > vh * 1.2;
    const tall = !short && (vw < 560 || (vw < 900 && vh > vw * 1.15));
    const mode = short ? 'short' : tall ? 'tall' : 'wide';
    const ins = insets();
    const padX = Math.max(12, ins.left) + Math.max(12, ins.right);
    const padY = Math.max(10, ins.top) + Math.max(10, ins.bottom);
    const availW = vw - padX;
    const availH = vh - padY;
    const padGap = availW < 340 ? 6 : 10;
    let padSize;
    let cell;
    let shortSide = 0;
    if (mode === 'short') {
      padSize = Math.round(clamp(availH / 6.8, 44, 64));
      const gap = 12;
      const cluster = showPad ? 3 * padSize + 2 * padGap : 0;
      const byH = availH / (20.7 + 0.8);
      const bySide = (availW - 2 * Math.max(116, cluster) - 2 * gap) / 10.7;
      const byPanels = (availW - 2 * 28 - 2 * gap) / (10.7 + 2 * 0.6 * 4.4);
      cell = Math.floor(Math.min(byH, bySide, byPanels));
      cell = clamp(cell, 10, 44);
      shortSide = Math.floor((availW - (cell * 10.7) - 2 * gap) / 2);
    } else if (mode === 'tall') {
      // Six touch buttons across two clusters must fit the narrowest phones.
      padSize = Math.floor(clamp((availW - 12 - 4 * padGap) / 6, 38, 72));
      const padH = showPad ? Math.round(padSize * 1.8 + 30) : 0;
      const fixed = 44 + 3 * 8 + 18 + padH;
      const byH = (availH - fixed) / (1.3 + 0.6 + 20.7);
      const byW = availW / 10.7;
      cell = Math.floor(Math.min(byH, byW));
    } else {
      padSize = Math.floor(clamp((availW - 12 - 4 * padGap) / 6, 38, 72));
      const padH = showPad ? Math.round(padSize * 1.8 + 30) : 0;
      const fixed = 44 + 2 * 10 + 12 + padH;
      const byH = (availH - fixed) / (1.3 + 20.7);
      const byW = (availW - 2 * 28 - 4 * 18) / (10.7 + 2 * 3.2);
      cell = Math.floor(Math.min(byH, byW));
    }
    cell = clamp(cell, 10, 44);
    const mini = Math.max(8, Math.round(cell * (mode === 'tall' ? 0.5 : mode === 'short' ? 0.6 : 0.72)));
    const bpad = Math.max(5, Math.round(cell * 0.35));
    const side = Math.round(mini * 4.4 + 28);
    app.cell = cell;
    app.mini = mini;
    app.tall = mode === 'tall';
    app.layout = mode;
    app.dpr = dpr;

    const st = els.game.style;
    st.setProperty('--cell', cell + 'px');
    st.setProperty('--mini', mini + 'px');
    st.setProperty('--bpad', bpad + 'px');
    st.setProperty('--board-w', cell * 10 + bpad * 2 + 'px');
    st.setProperty('--side', side + 'px');
    st.setProperty('--gap', Math.round(clamp(cell * 0.7, 10, 26)) + 'px');
    st.setProperty('--pad-size', padSize + 'px');
    st.setProperty('--pad-gap', padGap + 'px');
    els.game.classList.toggle('tall', mode === 'tall');
    els.game.classList.toggle('short', mode === 'short');
    els.game.classList.toggle('narrow', mode === 'tall' && vw < 400);
    els.game.classList.toggle('show-pad', showPad);
    els.game.classList.toggle('compact', mode === 'wide' && cell < 18);
    els.goal.hidden = mode !== 'wide' || cell < 18;

    // Width available to each stat value, so long numbers shrink to fit.
    let fitW;
    if (mode === 'tall') {
      const n = vw < 400 ? 3 : 4;
      const strip = availW - 2 * 44 - 2 * 8 - 24;
      fitW = Math.floor((strip - (n - 1) * 6) / n);
    } else if (mode === 'short') {
      const panelW = Math.min(shortSide, 156);
      st.setProperty('--short-stats-w', panelW + 'px');
      fitW = panelW - 24;
    } else {
      fitW = side - 32;
    }
    st.setProperty('--fit-w', Math.max(40, fitW) + 'px');

    const light = els.root.getAttribute('data-scheme') === 'light';
    board.resize(cell, dpr, light);

    app.holdCell = mini;
    app.nextCell = mini;
    if (mode === 'tall') {
      holdView.resize(Math.round(mini * 4.2), Math.round(mini * 2.6), dpr);
      const holdPanel = Math.round(mini * 4.2) + 38;
      const nextW = Math.max(mini * 4.2, availW - holdPanel - 8 - 38);
      app.nextCount = clamp(Math.floor(nextW / (mini * 3.9)), 1, settings.previews);
      nextView.resize(Math.round(nextW), Math.round(mini * 2.6), dpr);
    } else {
      app.nextCount = mode === 'short' ? Math.min(settings.previews, 3) : settings.previews;
      holdView.resize(Math.round(mini * 4.4), Math.round(mini * 2.8), dpr);
      nextView.resize(Math.round(mini * 4.4), Math.round(mini * (3.3 + 2.7 * (app.nextCount - 1))), dpr);
    }

    const logoCell = clamp(Math.floor(Math.min((Math.min(vw - 48, 560)) / 24, (vh * 0.14) / 5.5)), 6, 22);
    logo.resize(logoCell, dpr);
    wall.resize();
    app.hud = {};
    $$('.segmented').forEach((s) => positionLens(s, false, true));
    Glass.resize();
    Glass.refresh();
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

  // Liquid Glass surfaces grow out of the control that summoned them and
  // melt back into it. A clipping window (rounded, never squashed) travels
  // from the control to the sheet's place while widening to the full sheet.
  const morphTokens = new WeakMap();
  const MORPH_EASE = 'cubic-bezier(0.2, 0.9, 0.25, 1)';
  const MORPH_SPRING = 'cubic-bezier(0.22, 1.18, 0.36, 1)';

  function canMorph(sheet, origin) {
    return !!(sheet && origin && !reduceMotion() && origin.getClientRects().length && origin.getBoundingClientRect().width);
  }

  /** Start/end geometry for a morph between an origin control and a sheet. */
  function morphGeometry(sheet, origin) {
    const to = sheet.getBoundingClientRect();
    const from = origin.getBoundingClientRect();
    const ix = Math.max(0, (to.width - from.width) / 2);
    const iy = Math.max(0, (to.height - from.height) / 2);
    const r0 = Math.min(parseFloat(getComputedStyle(origin).borderTopLeftRadius) || 0, from.width / 2, from.height / 2);
    const R = parseFloat(getComputedStyle(sheet).borderTopLeftRadius) || 0;
    return {
      ok: to.width > 0 && to.height > 0,
      move: 'translate(' + (from.left + from.width / 2 - (to.left + to.width / 2)).toFixed(1) + 'px,' + (from.top + from.height / 2 - (to.top + to.height / 2)).toFixed(1) + 'px)',
      small: 'inset(' + iy.toFixed(1) + 'px ' + ix.toFixed(1) + 'px round ' + r0.toFixed(1) + 'px)',
      // Slightly outside the box so the sheet's shadow isn't clipped.
      full: 'inset(-48px round ' + (R + 48) + 'px)',
    };
  }

  function clearMorph(sheet) {
    sheet.style.transition = 'none';
    sheet.style.transform = '';
    sheet.style.clipPath = '';
    sheet.style.opacity = '';
    void sheet.offsetWidth;
    sheet.style.transition = '';
  }

  function morphOpen(screen, origin) {
    const sheet = screen.firstElementChild;
    if (!canMorph(sheet, origin)) return;
    const token = {};
    morphTokens.set(sheet, token);
    sheet.style.transition = 'none';
    sheet.style.transform = 'none';
    sheet.style.clipPath = 'none';
    const geo = morphGeometry(sheet, origin);
    if (!geo.ok) {
      clearMorph(sheet);
      return;
    }
    sheet.style.transform = geo.move;
    sheet.style.clipPath = geo.small;
    sheet.style.opacity = '0.4';
    void sheet.offsetWidth;
    sheet.style.transition = 'transform 0.6s ' + MORPH_SPRING + ', clip-path 0.55s ' + MORPH_EASE + ', opacity 0.18s ease-out';
    sheet.style.transform = '';
    sheet.style.clipPath = geo.full;
    sheet.style.opacity = '';
    setTimeout(() => {
      if (morphTokens.get(sheet) === token) clearMorph(sheet);
    }, 650);
  }

  function morphClose(screen, origin) {
    const sheet = screen.firstElementChild;
    if (!canMorph(sheet, origin)) return;
    const token = {};
    morphTokens.set(sheet, token);
    const current = sheet.style.transform;
    sheet.style.transition = 'none';
    sheet.style.transform = 'none';
    const geo = morphGeometry(sheet, origin);
    sheet.style.transform = current;
    if (!sheet.style.clipPath) sheet.style.clipPath = geo.full;
    void sheet.offsetWidth;
    sheet.style.transition = 'transform 0.34s ' + MORPH_EASE + ', clip-path 0.34s ' + MORPH_EASE + ', opacity 0.3s ease-in';
    sheet.style.transform = geo.move;
    sheet.style.clipPath = geo.small;
    sheet.style.opacity = '0';
    setTimeout(() => {
      if (morphTokens.get(sheet) === token) clearMorph(sheet);
    }, 400);
  }

  function setScreen(name) {
    const prev = app.screen;
    app.screen = name;
    els.screens.menu.classList.toggle('is-open', name === 'menu');
    els.screens.paused.classList.toggle('is-open', name === 'paused');
    els.screens.results.classList.toggle('is-open', name === 'results');
    els.game.classList.toggle('is-hidden', name === 'menu');
    els.boardShell.classList.toggle('is-veiled', name === 'paused');
    els.game.classList.toggle('is-paused', name === 'paused');
    Audio.duck(name === 'paused');
    updateInert();
    if (toastsBlocked()) dismissToast();
    else setTimeout(pumpToasts, 300);
    if (name === 'results') {
      // The results card lists this run's unlocks; don't repeat them as toasts.
      for (let i = toastQueue.length - 1; i >= 0; i--) if (app.runUnlocks.indexOf(toastQueue[i].id) !== -1) toastQueue.splice(i, 1);
    }
    if (name === 'paused' && prev !== 'paused') morphOpen(els.screens.paused, els.btnPause);
    else if (prev === 'paused' && name !== 'paused') morphClose(els.screens.paused, els.btnPause);
    if (name === 'results' && prev !== 'results') morphOpen(els.screens.results, els.boardShell);
    if (name === 'paused') focusLater($('#btn-resume'));
    else if (name === 'results') focusLater($('#btn-res-again'));
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

  function openModal(id, onClose, origin) {
    const el = els.modals[id];
    if (!el) return;
    if (app.modal) closeModal(true);
    app.modalReturn = document.activeElement;
    app.modalOrigin = origin || null;
    app.modalOnClose = onClose || null;
    app.modal = id;
    if (id === 'settings') syncSettingsUI();
    if (id === 'records') renderRecords();
    if (id === 'help') renderHelpKeys();
    el.classList.add('is-open');
    el.scrollTop = 0;
    updateInert();
    dismissToast();
    morphOpen(el, app.modalOrigin);
    requestAnimationFrame(() => {
      $$('.segmented', el).forEach((s) => positionLens(s));
    });
    focusLater($('[role="tab"][aria-selected="true"]', el) || $('button', el));
    Audio.play('select');
  }

  function closeModal(silent) {
    if (!app.modal) return;
    cancelCapture();
    const el = els.modals[app.modal];
    el.classList.remove('is-open');
    morphClose(el, app.modalOrigin);
    app.modalOrigin = null;
    app.modal = null;
    updateInert();
    const cb = app.modalOnClose;
    app.modalOnClose = null;
    setTimeout(pumpToasts, 400);
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

  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);

  function prettyDay(key) {
    try {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
      return key;
    }
  }

  // ------------------------------------------------------------- progression

  function playerLevel() {
    return S.levelInfo(S.playerXP(profile));
  }

  /** The chosen block material if it's unlocked, otherwise Jelly. */
  function effectiveSkin() {
    const skin = S.SKINS.find((k) => k.id === settings.skin);
    return skin && playerLevel().level >= skin.level ? skin.id : 'jelly';
  }

  function applySkin() {
    const skin = effectiveSkin();
    if (R.sprites.skin === skin) return;
    R.sprites.skin = skin;
    layout();
  }

  function renderPlayer() {
    const info = playerLevel();
    $('#player-level').textContent = 'Level ' + info.level;
    $('#player-xp').textContent = fmtInt(info.xp - info.base) + ' / ' + fmtInt(info.next - info.base) + ' XP';
    $('#player-fill').style.width = (info.frac * 100).toFixed(1) + '%';
    $('#player').setAttribute('aria-label', 'Level ' + info.level + ', ' + fmtInt(info.xp) + ' XP. Open records');
  }

  function renderSkins() {
    const box = $('#skins');
    if (!box) return;
    box.textContent = '';
    const level = playerLevel().level;
    const current = effectiveSkin();
    for (const skin of S.SKINS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'skin';
      b.dataset.value = skin.id;
      const locked = level < skin.level;
      b.disabled = locked;
      b.setAttribute('aria-pressed', String(skin.id === current));
      const cv = document.createElement('canvas');
      cv.width = cv.height = 112;
      const g = cv.getContext('2d');
      const tile = R.makeTile('#BF5AF2', 64, skin.id);
      // A tiny T piece in the chosen material.
      [[24, 16], [8, 48], [40, 48], [72, 48]].forEach(([x, y]) => g.drawImage(tile, x, y + 8, 32, 32));
      b.appendChild(cv);
      const label = document.createElement('span');
      if (locked) {
        label.className = 'lock';
        label.innerHTML = '<svg aria-hidden="true"><use href="#i-lock"/></svg>';
        label.appendChild(document.createTextNode('Level ' + skin.level));
        b.setAttribute('aria-label', skin.name + ' blocks, unlocks at level ' + skin.level);
      } else {
        label.textContent = skin.name;
      }
      b.appendChild(label);
      b.addEventListener('click', () => {
        settings.skin = skin.id;
        $$('.skin', box).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        commit('skin');
        Audio.play('ui');
      });
      box.appendChild(b);
    }
  }

  function refreshMenu() {
    renderPlayer();
    for (const m of S.MODE_ORDER) {
      if (m === 'daily') continue;
      const best = S.bestRun(records, m);
      const el = $('[data-best="' + m + '"]');
      if (el) el.textContent = best ? (m === 'sprint' ? fmtTime(best.time, true) : fmtInt(best.score)) : '—';
    }
    // Daily card: today's date, today's best and the live streak.
    const today = S.dayKey();
    daily = S.loadDaily();
    $('#daily-date').textContent = prettyDay(today);
    const todayBest = daily.days[today];
    $('[data-best="daily"]').textContent = todayBest != null ? fmtInt(todayBest) : 'Not played yet';
    const streak = S.liveStreak(daily, today);
    const label = $('#daily-streak');
    label.textContent = '';
    if (streak > 0) {
      const sEl = document.createElement('span');
      sEl.className = 'streak';
      sEl.innerHTML = '<svg aria-hidden="true"><use href="#i-flame"/></svg>';
      sEl.appendChild(document.createTextNode(streak + '-day streak'));
      label.appendChild(sEl);
    } else {
      label.textContent = 'Today’s best';
    }

    // Continue banner for the most recent saved run.
    const saves = SAVE_MODES.map((m) => ({ m, d: S.loadSave(m) })).filter((x) => {
      if (!x.d) return false;
      // Drop saves that can't be restored (tampered, or from an older build).
      if (!E.Game.restore(x.d.game) || !num(x.d.game.stats && x.d.game.stats.pieces)) {
        S.clearSave(x.m);
        return false;
      }
      return true;
    });
    saves.sort((a, b) => num(b.d.savedAt) - num(a.d.savedAt));
    const banner = $('#continue');
    if (saves.length) {
      const { m, d } = saves[0];
      app.continueMode = m;
      $('#continue-title').textContent = 'Continue ' + MODE_INFO[m].name;
      $('#continue-detail').textContent = 'Level ' + num(d.game.level) + ' · ' + fmtInt(num(d.game.score)) + ' points · ' + fmtTime(num(d.game.time));
      banner.hidden = false;
    } else {
      app.continueMode = null;
      banner.hidden = true;
    }
    const hint = $('#menu-hint');
    if (hint) hint.hidden = app.coarse;
  }

  // ------------------------------------------------------ saves & lifetime

  let lastSaveAt = 0;
  function saveRun(force) {
    const g = app.game;
    if (!g || g.state !== 'playing' || SAVE_MODES.indexOf(g.mode) === -1) return;
    if (!g.stats.pieces) return;
    const now = performance.now();
    if (!force && now - lastSaveAt < 2000) return;
    lastSaveAt = now;
    S.writeSave(g.mode, { game: g.serialize(), savedAt: Date.now(), unlocks: app.runUnlocks.slice() });
  }

  function gameTotals(g) {
    const st = g.stats;
    return { lines: g.lines, time: g.time, pieces: st.pieces, tetrises: st.tetrises, tspins: st.tspins + st.tspinMinis, pcs: st.perfectClears, score: g.score };
  }

  function addLifetime(t) {
    if (!t || (!t.pieces && !t.time)) return;
    // Only a real attempt counts as a game (instant retries don't farm XP).
    if (hasProgress(t.pieces)) profile.games += 1;
    profile.lines += num(t.lines);
    profile.pieces += num(t.pieces);
    profile.tetrises += num(t.tetrises);
    profile.tspins += num(t.tspins);
    profile.perfectClears += num(t.pcs);
    profile.timePlayed += Math.round(num(t.time));
    profile.bestScore = Math.max(profile.bestScore, num(t.score));
    S.saveProfile(profile);
  }

  /** A run left unfinished still counts toward lifetime stats. */
  function abandonCurrent() {
    const g = app.game;
    if (!g || g.state !== 'playing') return;
    if (SAVE_MODES.indexOf(g.mode) !== -1) S.clearSave(g.mode);
    addLifetime(gameTotals(g));
  }

  function discardSave(mode) {
    const d = S.loadSave(mode);
    if (!d) return;
    const gd = d.game || {};
    const st = gd.stats || {};
    addLifetime({ lines: gd.lines, time: gd.time, pieces: st.pieces, tetrises: st.tetrises, tspins: num(st.tspins) + num(st.tspinMinis), pcs: st.perfectClears, score: gd.score });
    S.clearSave(mode);
  }

  function quitToMenu() {
    const g = app.game;
    if (g && g.state === 'playing') {
      if (SAVE_MODES.indexOf(g.mode) !== -1) saveRun(true);
      else addLifetime(gameTotals(g));
    }
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

  /** Shared setup for new, restarted and continued games. */
  function beginGame(g, extra) {
    if (app.modal) closeModal(true);
    app.mode = g.mode;
    app.game = g;
    app.displayScore = g.score;
    app.hud = {};
    app.endInfo = null;
    app.hardDropping = false;
    app.runUnlocks = (extra && extra.unlocks) || [];
    app.xpStart = S.playerXP(profile);
    app.splits = [];
    app.lineTimes = [];
    app.dailyKey = (extra && extra.dailyKey) || null;
    // Sprint pace: compare against the best run's time at every line.
    const pb = g.mode === 'sprint' ? S.bestRun(records, 'sprint') : null;
    app.pbLines = pb && Array.isArray(pb.lineTimes) && pb.lineTimes.length >= 40 ? pb.lineTimes : null;
    board.reset();
    els.callouts.textContent = '';
    input.releaseAll();
    configureHud();
    Audio.setLevel(g.level);
    wall.setLevel(g.level);
    wall.setDanger(0);
    Audio.duck(false);
    Audio.startMusic();
    requestWakeLock();
    $('#pause-mode').textContent = MODE_INFO[g.mode].name + (app.dailyKey ? ' · ' + prettyDay(app.dailyKey) : '');
    $('#btn-quit').lastChild.textContent = g.mode === 'zen' ? 'End session' : g.mode === 'marathon' ? 'Save & quit' : 'Main menu';
  }

  /** quick: a one-beat READY instead of 3-2-1 (instant retries). */
  function startGame(mode, quick) {
    mode = E.MODES[mode] ? mode : 'marathon';
    abandonCurrent();
    if (SAVE_MODES.indexOf(mode) !== -1) discardSave(mode);
    const opts = { mode, startLevel: settings.startLevel, previewCount: settings.previews, softDropFactor: softDropFactor() };
    let dailyKey = null;
    if (mode === 'daily') {
      dailyKey = S.dayKey();
      opts.seed = E.hashSeed('daily:' + dailyKey);
    }
    beginGame(new E.Game(opts), { dailyKey });

    const go = () =>
      startCountdown(
        quick ? 520 : 400,
        () => {
          if (!app.game) return;
          app.game.start();
          setScreen('playing');
          flush();
        },
        quick ? 1 : 3
      );
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

  function continueRun(mode) {
    const data = mode && S.loadSave(mode);
    const g = data && E.Game.restore(data.game, { previewCount: settings.previews, softDropFactor: softDropFactor() });
    if (!g) {
      if (mode) S.clearSave(mode);
      refreshMenu();
      return;
    }
    const unlocks = Array.isArray(data.unlocks) ? data.unlocks.filter((id) => typeof id === 'string') : [];
    beginGame(g, { unlocks });
    startCountdown(400, () => {
      if (app.game === g) setScreen('playing');
    });
  }

  function restart() {
    startGame(app.mode, true);
  }

  // -- confirmation before throwing away a run worth keeping

  let confirmState = null;
  function confirmAction(opts) {
    confirmState = opts;
    $('#confirm-title').textContent = opts.title;
    $('#confirm-body').textContent = opts.body;
    $('#btn-confirm-ok').textContent = opts.ok;
    $('#btn-confirm-cancel').textContent = opts.cancel;
    openModal('confirm', () => {
      confirmState = null;
    }, opts.origin);
  }

  function runSummary(level, score, time) {
    return 'Level ' + num(level) + ' · ' + fmtInt(num(score)) + ' points · ' + fmtTime(num(time));
  }

  /** A run is worth protecting once a few pieces are down. */
  function hasProgress(pieces) {
    return num(pieces) >= 5;
  }

  function requestStart(mode, origin) {
    const save = SAVE_MODES.indexOf(mode) !== -1 && S.loadSave(mode);
    const g = save && save.game;
    if (g && hasProgress(g.stats && g.stats.pieces)) {
      confirmAction({
        title: 'Start a new ' + MODE_INFO[mode].name + '?',
        body: 'Your saved run (' + runSummary(g.level, g.score, g.time) + ') will be lost.',
        ok: 'Start new',
        cancel: 'Continue saved run',
        origin,
        onOk: () => startGame(mode),
        onCancel: () => continueRun(mode),
      });
      return;
    }
    startGame(mode);
  }

  function requestRestart(origin) {
    const g = app.game;
    if (g && g.state === 'playing' && SAVE_MODES.indexOf(g.mode) !== -1 && hasProgress(g.stats.pieces)) {
      confirmAction({
        title: 'Restart this run?',
        body: 'Your progress (' + runSummary(g.level, g.score, g.time) + ') will be lost.',
        ok: 'Restart',
        cancel: 'Keep playing',
        origin,
        onOk: () => restart(),
        onCancel: () => {},
      });
      return;
    }
    restart();
  }

  let countdownToken = 0;
  function startCountdown(stepMs, then, steps) {
    app.countdown = { start: performance.now(), stepMs, steps: steps || 3, n: 99, then };
    countdownToken++;
    setScreen('countdown');
    // Directions still held from the last run (or before pausing) charge now.
    input.reacquire();
  }

  function updateCountdown(now) {
    const c = app.countdown;
    const n = c.steps - Math.floor((now - c.start) / c.stepMs);
    if (n === c.n) return;
    c.n = n;
    if (n >= 1) {
      els.countdown.innerHTML = c.steps === 1 ? '<span class="ready">READY</span>' : '<span>' + n + '</span>';
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
    saveRun(true);
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
      startCountdown(400, () => {
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
      app.endAt = now + 1200;
    } else {
      board.startGameOver(now);
      Audio.play('gameOver');
      haptic([30, 60, 40]);
      app.endAt = now + 1150;
    }
    app.endInfo = finalizeRun(g, ev);
  }

  function finalizeRun(g, ev) {
    const st = g.stats;
    // XP from achievements earned mid-run belongs to this run's gain.
    const xpBefore = typeof app.xpStart === 'number' ? Math.min(app.xpStart, S.playerXP(profile)) : S.playerXP(profile);
    const run = {
      score: g.score,
      lines: g.lines,
      level: g.level,
      time: Math.round(g.time),
      pieces: st.pieces,
      date: Date.now(),
    };
    const prevBest = S.bestRun(records, g.mode);
    if (g.mode === 'sprint' && ev.result === 'cleared') {
      run.splits = app.splits.slice(0, 3).concat([run.time]);
      if (app.lineTimes.length >= 40) run.lineTimes = app.lineTimes.slice(0, 40);
    }
    if (g.mode === 'daily') run.day = app.dailyKey || S.dayKey();
    const eligible = g.mode === 'sprint' ? ev.result === 'cleared' : g.score > 0 || g.lines > 0;
    const rank = eligible ? S.addRecord(records, g.mode, run) : 0;
    if (SAVE_MODES.indexOf(g.mode) !== -1) S.clearSave(g.mode);
    if (g.mode === 'daily' && ev.result !== 'ended') daily = S.recordDaily(S.loadDaily(), run.day, g.score);

    addLifetime(gameTotals(g));
    checkAchievements(true, ev);
    return { run, rank, prevBest, result: ev.result, eligible, xpBefore, xpAfter: S.playerXP(profile) };
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
    $('#res-mode').textContent = MODE_INFO[mode].name + (mode === 'daily' && info.run.day ? ' · ' + prettyDay(info.run.day) : '');
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
      let text = info.prevBest ? 'New personal best' : 'First record set';
      if (mode === 'sprint' && info.prevBest) text += ' · −' + ((info.prevBest.time - info.run.time) / 1000).toFixed(2) + 's';
      b.appendChild(document.createTextNode(text));
      slot.appendChild(b);
    } else if (info.rank > 1) {
      const b = document.createElement('span');
      b.className = 'eyebrow';
      b.style.display = 'block';
      b.style.marginTop = '8px';
      let text = 'Rank #' + info.rank + ' in your top 10';
      if (mode === 'sprint' && info.prevBest) text += ' · +' + ((info.run.time - info.prevBest.time) / 1000).toFixed(2) + 's vs best';
      b.textContent = text;
      slot.appendChild(b);
    }
    if (mode === 'daily' && info.result !== 'ended') {
      const sEl = document.createElement('span');
      sEl.className = 'eyebrow';
      sEl.style.display = 'block';
      sEl.style.marginTop = '8px';
      sEl.textContent = daily.streak > 1 ? daily.streak + '-day streak · come back tomorrow' : 'New pieces tomorrow';
      slot.appendChild(sEl);
    }

    const secs = g.time / 1000;
    const pps = secs > 0 ? (st.pieces / secs).toFixed(2) : '0.00';
    // Core stats always; feats only when they happened (no wall of zeros).
    const items = [];
    if (mode === 'sprint') items.push(['Lines', g.lines], ['Pieces', st.pieces], ['PPS', pps]);
    else items.push(['Lines', g.lines], ['Level', g.level], ['Time', fmtTime(g.time)]);
    const feats = [['Tetrises', st.tetrises], ['T-Spins', st.tspins + st.tspinMinis], ['Max combo', Math.max(0, st.maxCombo)], ['Perfect clears', st.perfectClears], ['Best B2B', Math.max(0, st.maxB2B)]].filter((f) => f[1] > 0);
    items.push(...feats);
    if (mode !== 'sprint') items.push(['PPS', pps], ['Pieces', st.pieces]);
    const dl = $('#res-stats');
    dl.textContent = '';
    for (const [k, v] of items.slice(0, 6)) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = typeof v === 'number' ? fmtInt(v) : v;
      d.append(dt, dd);
      dl.appendChild(d);
    }
    const unlocks = $('#res-unlocks');
    unlocks.textContent = '';
    for (const id of app.runUnlocks) {
      const a = S.ACHIEVEMENTS.find((x) => x.id === id);
      if (!a) continue;
      const chip = document.createElement('span');
      chip.className = 'unlock-chip';
      chip.innerHTML = '<svg aria-hidden="true"><use href="#i-star"/></svg>';
      chip.appendChild(document.createTextNode(a.name));
      chip.title = a.desc;
      unlocks.appendChild(chip);
    }
    // XP gained this run, with level-ups and newly unlocked block materials.
    const before = S.levelInfo(info.xpBefore);
    const after = S.levelInfo(info.xpAfter);
    const gain = info.xpAfter - info.xpBefore;
    let extra = 0;
    if (after.level > before.level) {
      const chip = document.createElement('span');
      chip.className = 'unlock-chip';
      chip.innerHTML = '<svg aria-hidden="true"><use href="#i-star"/></svg>';
      chip.appendChild(document.createTextNode('Level ' + after.level + '!'));
      unlocks.appendChild(chip);
      extra++;
      for (const skin of S.SKINS) {
        if (skin.level > before.level && skin.level <= after.level) {
          const c2 = document.createElement('span');
          c2.className = 'unlock-chip';
          c2.innerHTML = '<svg aria-hidden="true"><use href="#i-sliders"/></svg>';
          c2.appendChild(document.createTextNode('New blocks: ' + skin.name));
          c2.title = 'Choose it in Settings → Look';
          unlocks.appendChild(c2);
        }
      }
    }
    unlocks.hidden = !app.runUnlocks.length && !extra;
    if (app.runUnlocks.length || extra) setTimeout(() => Audio.play('achievement'), 450);
    $('#res-xp-level').textContent = 'Level ' + after.level;
    $('#res-xp-gain').textContent = '+' + fmtInt(gain) + ' XP';
    const fill = $('#res-xp-fill');
    fill.style.transition = 'none';
    fill.style.width = (after.level > before.level ? 0 : before.frac * 100).toFixed(1) + '%';
    void fill.offsetWidth;
    fill.style.transition = '';
    setTimeout(() => {
      fill.style.width = (after.frac * 100).toFixed(1) + '%';
    }, 350);
    $('#res-share-note').textContent = '';
    applySkin();
    renderBoardList($('#res-board'), mode, info.eligible ? info.run : null, 5);
    setScreen('results');
    app.resultsShownAt = performance.now();
  }

  function shareText() {
    const info = app.endInfo;
    const g = app.game;
    if (!info || !g) return '';
    const mode = MODE_INFO[g.mode].name + (g.mode === 'daily' && info.run.day ? ' · ' + prettyDay(info.run.day) : '');
    let main;
    if (g.mode === 'sprint') main = info.result === 'cleared' ? '40 lines in ' + fmtTime(g.time, true) : g.lines + '/40 lines';
    else main = fmtInt(g.score) + ' points · ' + g.lines + ' lines';
    const out = ['Liquid Glass Tetris · ' + mode, main];
    const st = g.stats;
    const feats = [];
    if (st.tetrises) feats.push(st.tetrises + ' Tetris' + (st.tetrises > 1 ? 'es' : ''));
    if (st.tspins + st.tspinMinis) feats.push(st.tspins + st.tspinMinis + ' T-Spin' + (st.tspins + st.tspinMinis > 1 ? 's' : ''));
    if (st.perfectClears) feats.push(st.perfectClears + ' Perfect Clear' + (st.perfectClears > 1 ? 's' : ''));
    if (feats.length) out.push(feats.join(' · '));
    if (g.mode === 'daily' && daily.streak > 1) out.push(daily.streak + '-day streak');
    return out.join('\n');
  }

  /** Share sheet on phones, clipboard elsewhere, selectable text as a last resort. */
  async function shareResult() {
    const text = shareText();
    const note = $('#res-share-note');
    if (!text) return;
    if (navigator.share && app.coarse) {
      try {
        await navigator.share({ text });
        note.textContent = 'Shared';
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied to clipboard';
      Audio.play('select');
    } catch (e) {
      note.textContent = '';
      const field = document.createElement('input');
      field.readOnly = true;
      field.value = text.replace(/\n/g, ' · ');
      field.setAttribute('aria-label', 'Result text');
      note.appendChild(field);
      field.focus();
      field.select();
    }
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
          saveRun(false);
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
    sprintSplits();
    checkAchievements(false);
  }

  /** Sprint pace: at 10, 20 and 30 lines compare against the best run. */
  function sprintSplits() {
    const g = app.game;
    if (!g || g.mode !== 'sprint') return;
    while (app.lineTimes.length < Math.min(40, g.lines)) app.lineTimes.push(Math.round(g.time));
    while (app.splits.length < 3 && g.lines >= (app.splits.length + 1) * 10) {
      const idx = app.splits.length;
      const t = Math.round(g.time);
      app.splits.push(t);
      const pb = S.bestRun(records, 'sprint');
      const ref = pb && Array.isArray(pb.splits) ? pb.splits[idx] : null;
      const title = (idx + 1) * 10 + ' LINES';
      if (typeof ref === 'number' && isFinite(ref)) {
        const d = t - ref;
        callout(title, (d <= 0 ? '−' : '+') + (Math.abs(d) / 1000).toFixed(2) + 's vs best', 'split ' + (d <= 0 ? 'ahead' : 'behind'));
      } else {
        callout(title, fmtTime(t, true), 'split');
      }
    }
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
      m.style.setProperty('--chars', Math.max(6, main.length));
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
      if (g.mode === 'daily' && ev && ev.result !== 'ended') {
        u('daily');
        if (daily.streak >= 3) u('streak3');
        if (daily.streak >= 7) u('streak7');
      }
    }
    if (got.length) {
      S.saveProfile(profile);
      got.forEach((id) => toastAchievement(id));
    }
  }

  // Toasts appear one at a time and only when nothing important is on screen:
  // never over play, a modal or the results card (which lists the run's
  // unlocks itself).
  const toastQueue = [];
  let toastEl = null;

  function toastAchievement(id) {
    const a = S.ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return;
    if (app.runUnlocks.indexOf(id) === -1) app.runUnlocks.push(id);
    toastQueue.push({ id, title: 'Achievement · ' + a.name, body: a.desc, icon: 'i-star', sound: 'achievement' });
    pumpToasts();
  }

  function toastsBlocked() {
    return app.screen !== 'menu' || !!app.modal;
  }

  function pumpToasts() {
    if (toastEl || !toastQueue.length || toastsBlocked()) return;
    const item = toastQueue.shift();
    const t = document.createElement('div');
    t.className = 'toast glass no-lens';
    t.innerHTML = '<i><svg aria-hidden="true"><use href="#' + item.icon + '"/></svg></i><span><b></b><small></small></span>';
    $('b', t).textContent = item.title;
    $('small', t).textContent = item.body;
    els.toasts.appendChild(t);
    toastEl = t;
    if (item.sound) Audio.play(item.sound);
    t._timer = setTimeout(() => dismissToast(t), 3200);
  }

  function dismissToast(t) {
    t = t || toastEl;
    if (!t) return;
    clearTimeout(t._timer);
    t.classList.add('is-leaving');
    setTimeout(() => {
      t.remove();
      if (toastEl === t) toastEl = null;
      setTimeout(pumpToasts, 200);
    }, 360);
  }

  // ------------------------------------------------------------------ HUD

  function configureHud() {
    const info = MODE_INFO[app.mode];
    els.modeName.textContent = info.name + (app.dailyKey ? ' · ' + prettyDay(app.dailyKey) : '');
    els.modePill.style.setProperty('--tint', info.tint);
    els.goal.style.setProperty('--tint', info.tint);
    const L = {
      marathon: ['Score', 'Level', 'Lines', 'Time'],
      sprint: ['Time', 'Lines', 'Pieces', 'PPS'],
      ultra: ['Score', 'Time', 'Lines', 'Level'],
      zen: ['Score', 'Level', 'Lines', 'Time'],
      daily: ['Score', 'Time', 'Lines', 'Level'],
    }[app.mode];
    els.st.mainL.textContent = L[0];
    els.st.aL.textContent = L[1];
    els.st.bL.textContent = L[2];
    els.st.cL.textContent = L[3];
    els.st.c.classList.remove('is-ahead', 'is-behind');
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
    let pace = null;
    switch (g.mode) {
      case 'sprint': {
        main = fmtTime(g.time, true);
        a = Math.min(g.lines, 40) + '/40';
        b = fmtInt(g.stats.pieces);
        c = pps;
        pace = null;
        if (app.pbLines && app.lineTimes.length) {
          const n = app.lineTimes.length;
          pace = app.lineTimes[n - 1] - app.pbLines[n - 1];
          c = (pace <= 0 ? '−' : '+') + (Math.abs(pace) / 1000).toFixed(2);
        }
        const rem = Math.max(0, 40 - g.lines);
        frac = Math.min(1, g.lines / 40);
        ringVal = String(rem);
        ringLabel = 'Lines left';
        break;
      }
      case 'ultra':
      case 'daily': {
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
    if (g.mode === 'sprint') {
      setText(els.st.cL, 'cL', pace === null ? 'PPS' : 'Pace');
      const cls = pace === null ? '' : pace <= 0 ? 'ahead' : 'behind';
      if (app.hud.paceCls !== cls) {
        app.hud.paceCls = cls;
        els.st.c.classList.toggle('is-ahead', cls === 'ahead');
        els.st.c.classList.toggle('is-behind', cls === 'behind');
      }
    }
    setText(els.goalValue, 'rv', ringVal);
    setText(els.goalLabel, 'rl', ringLabel);
    const off = (100 - clamp(frac, 0, 1) * 100).toFixed(1);
    if (app.hud.ring !== off) {
      app.hud.ring = off;
      els.ringFill.setAttribute('stroke-dashoffset', off);
    }

    holdView.drawHold(g.holdType, g.holdUsed, app.holdCell);
    nextView.drawQueue(g.queue, app.nextCount, app.nextCell, app.tall);
    // Screen readers get the pieces as text (read on demand, not announced).
    setText(els.holdSr, 'holdSr', g.holdType ? g.holdType + ' piece' + (g.holdUsed ? ', used' : '') : 'Empty');
    setText(els.nextSr, 'nextSr', g.queue.slice(0, app.nextCount).join(', '));

    const h = g.state === 'playing' ? g.stackHeight() : 0;
    const danger = h >= 17;
    if (app.hud.danger !== danger) {
      app.hud.danger = danger;
      els.boardFrame.classList.toggle('is-danger', danger);
    }
    wall.setDanger(clamp((h - 13) / 6, 0, 1));
  }

  // ---------------------------------------------------------- frame loop

  /** If the glass can't hold ~36 fps for a couple of seconds, quietly step
   * the material down (Liquid → Frosted → Solid) for this session. */
  function governFrameRate(dt) {
    const material = els.root.getAttribute('data-glass');
    if (material === 'low' || document.hidden || app.forceGL) return;
    // Ignore the first second after start-up or a change of material.
    perf.warm += dt;
    if (perf.warm < 1000) return;
    perf.ema = perf.ema * 0.9 + dt * 0.1;
    perf.slowMs = perf.ema > 28 ? perf.slowMs + dt : Math.max(0, perf.slowMs - dt * 0.5);
    if (perf.slowMs < 2500) return;
    perf.slowMs = 0;
    perf.warm = 0;
    perf.ema = 16.7;
    perf.degraded = true;
    if (material === 'high') {
      Glass.setEnabled(false);
      els.root.setAttribute('data-glass', 'standard');
    } else {
      els.root.setAttribute('data-glass', 'low');
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = app.last ? now - app.last : 16.7;
    app.last = now;
    dt = clamp(dt, 0, 100);

    input.update(dt);
    if (app.screen === 'countdown' && app.countdown) updateCountdown(now);
    if (app.screen === 'playing' && app.game) app.game.update(dt, input.softHeld);
    governFrameRate(dt);
    processEvents(now);
    if (app.screen === 'ending' && now >= app.endAt) showResults();

    const bgDrawn = wall.render(now, dt);
    if (app.screen === 'menu') {
      logo.render(now, reduceMotion());
    } else {
      board.render(app.game, now, app.screen === 'paused' ? 0 : dt, { ghost: settings.ghost, grid: settings.grid });
      updateHud(dt);
      updateShake(dt);
    }
    // Last, after all DOM writes: the compositor reads element positions.
    const danger = app.screen !== 'menu' && app.hud.danger ? 0.55 + 0.45 * Math.sin(now / 210) : 0;
    Glass.render(bgDrawn, danger);
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
      // The material shown is the one actually in use.
      const value = key === 'recordsMode' ? app.recordsMode : key === 'glass' ? els.root.getAttribute('data-glass') || settings.glass : settings[key];
      $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
      positionLens(seg);
    });
    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === settings.wallpaper)));
    refreshGlassUI();
    renderBindings();
    renderSkins();
  }

  function refreshGlassUI() {
    const note = $('#glass-note');
    if (note) note.textContent = glassNote();
    const seg = $('[data-seg="glass"]');
    if (!seg) return;
    const used = els.root.getAttribute('data-glass') || settings.glass;
    $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === used)));
    positionLens(seg);
  }

  function glassNote() {
    const used = els.root.getAttribute('data-glass');
    const solidOnly = !!(window.matchMedia && matchMedia('(prefers-reduced-transparency: reduce)').matches);
    if (used !== settings.glass) {
      if (solidOnly) return 'Solid, because Reduce Transparency is on in your system settings';
      if (perf.degraded) return 'Lowered automatically to keep play smooth. Pick a material to try again.';
      if (settings.glass === 'high' && Glass.software) return 'Liquid needs GPU acceleration, which is off here, so Frosted is used';
      if (settings.glass === 'high' && Glass.lost) return 'The graphics driver reset, so Frosted is used. Pick Liquid to try again.';
      if (settings.glass === 'high') return 'Liquid needs WebGL 2, so Frosted is used';
    }
    if (used === 'high') return 'Real refraction and light, rendered on the GPU';
    if (used === 'standard') return 'Blurred glass, lighter on the GPU';
    return 'Opaque surfaces: best legibility and battery life';
  }

  /** Brings the menu up to date when the day changes (daily card, streak). */
  function scheduleMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    setTimeout(() => {
      if (app.screen === 'menu' && !app.modal) refreshMenu();
      scheduleMidnight();
    }, Math.min(next - now, 6 * 3600 * 1000));
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
        refreshGlassUI();
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
      case 'skin':
        applySkin();
        break;
    }
  }

  /** Moves the glass "lens" under the selected segment. The first placement
   * (and layout changes) jump straight there instead of sliding from 0. */
  function positionLens(seg, animate, instant) {
    const lens = $('.seg-lens', seg);
    const active = $('[aria-selected="true"], [aria-pressed="true"]', seg);
    if (!lens || !active || !active.offsetWidth) return;
    const jump = instant || !lens.dataset.placed;
    if (jump) lens.style.transition = 'none';
    lens.style.width = active.offsetWidth + 'px';
    lens.style.transform = 'translateX(' + active.offsetLeft + 'px)';
    lens.dataset.placed = '1';
    if (jump) {
      void lens.offsetWidth;
      lens.style.transition = '';
      return;
    }
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
      b.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(b.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    positionLens(list, true);
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) {
      requestAnimationFrame(() => {
        $$('.segmented', panel).forEach((s) => positionLens(s));
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
    $('#bind-note').textContent = '';
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
    let moved = null;
    if (e.code === 'Backspace' || e.code === 'Delete') {
      list.splice(c.slot, 1);
    } else {
      // A key does one thing: taking it from another action says so.
      moved = S.ACTIONS.find((a) => a !== c.action && settings.bindings[a].indexOf(e.code) !== -1) || null;
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
    $('#bind-note').textContent = moved ? keyName(e.code) + ' moved from ' + S.ACTION_LABELS[moved] + (settings.bindings[moved].length ? '' : ', which now has no key') + '.' : '';
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
    const seg = $('[data-seg="recordsMode"]');
    if (seg) $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === app.recordsMode)));
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
    const lvl = playerLevel();
    const items = [
      ['Player level', String(lvl.level)],
      ['Total XP', fmtInt(lvl.xp)],
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
        if (app.screen === 'menu' && !app.modal) requestStart(app.mode);
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
    input.noteKey(e);
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
        // The run is already saved; R skips straight to the next attempt.
        if (k === 'KeyR' && !e.repeat) {
          e.preventDefault();
          restart();
          return;
        }
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
          requestRestart($('#btn-restart'));
          return;
        }
        navKeys(e);
        return;
      case 'results':
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
        // Swallow keys still being mashed from the last game for a moment.
        if (performance.now() - app.resultsShownAt < 600) {
          e.preventDefault();
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
          Glass.setLight(lx, ly);
        });
      },
      { passive: true }
    );
  }

  /** On Android, tilting the phone moves the specular light across the glass. */
  function setupTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!app.coarse || !DOE || typeof DOE.requestPermission === 'function') return;
    let pending = false;
    let gx = 0;
    let gy = 0;
    window.addEventListener('deviceorientation', (e) => {
      if (e.beta == null || e.gamma == null || reduceMotion()) return;
      gx = clamp(e.gamma / 40, -1, 1);
      gy = clamp((e.beta - 45) / 40, -1, 1);
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const tx = Math.round((0.5 + gx * 0.6) * window.innerWidth);
        const ty = Math.round((0.15 + gy * 0.5) * window.innerHeight);
        els.root.style.setProperty('--lx', tx + 'px');
        els.root.style.setProperty('--ly', ty + 'px');
        Glass.setLight(tx, ty);
      });
    });
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
        requestStart(card.dataset.mode, card);
      });
      card.addEventListener('focus', () => {
        app.mode = card.dataset.mode;
      });
    });
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.open, null, b)));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal()));
    $$('.screen.modal').forEach((m) =>
      m.addEventListener('pointerdown', (e) => {
        if (e.target === m) closeModal();
      })
    );
    els.btnPause.addEventListener('click', () => pause());
    $('#btn-resume').addEventListener('click', () => resume());
    $('#btn-restart').addEventListener('click', (e) => requestRestart(e.currentTarget));
    $('#btn-confirm-ok').addEventListener('click', () => {
      const st = confirmState;
      confirmState = null;
      closeModal(true);
      if (st) st.onOk();
    });
    $('#btn-confirm-cancel').addEventListener('click', () => {
      const st = confirmState;
      confirmState = null;
      closeModal(true);
      if (st) st.onCancel();
    });
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
    $('#btn-res-share').addEventListener('click', () => shareResult());
    $('#btn-continue').addEventListener('click', () => {
      unlockAudio();
      Audio.play('select');
      continueRun(app.continueMode);
    });
    $('#btn-discard').addEventListener('click', (e) => {
      const mode = app.continueMode;
      const done = () => {
        if (mode) discardSave(mode);
        Audio.play('back');
        refreshMenu();
        focusLater($('.mode-card[data-mode="' + app.mode + '"]'));
      };
      const save = mode && S.loadSave(mode);
      const g = save && save.game;
      if (g && hasProgress(g.stats && g.stats.pieces)) {
        confirmAction({
          title: 'Discard saved ' + MODE_INFO[mode].name + '?',
          body: 'This run (' + runSummary(g.level, g.score, g.time) + ') will be lost.',
          ok: 'Discard',
          cancel: 'Keep it',
          origin: e.currentTarget,
          onOk: done,
          onCancel: () => {},
        });
        return;
      }
      done();
    });
    window.addEventListener('pagehide', () => saveRun(true));
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
        saveRun(true);
        pause();
        input.releaseAll(true);
        Audio.suspend();
      } else {
        Audio.resume();
        app.last = 0;
        if (app.screen === 'playing' || app.screen === 'countdown') requestWakeLock();
        if (app.screen === 'menu' && !app.modal) refreshMenu();
      }
    });
    window.addEventListener('blur', () => {
      input.releaseAll(true);
      pause();
    });
    scheduleMidnight();

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
      const rt = matchMedia('(prefers-reduced-transparency: reduce)');
      if (rt.addEventListener) rt.addEventListener('change', () => applyLook());
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
    let forceGL = false;
    try {
      forceGL = localStorage.getItem('lgtetris.debug.forcegl') === '1';
    } catch (e) {
      forceGL = false;
    }
    // Debug: lets headless tests (software WebGL) exercise the Liquid path.
    app.forceGL = forceGL;
    Glass.init($('#glass-gl'), [els.wallpaper, $('#wallpaper-fx')], { allowSoftware: forceGL });
    Glass.onContextLost(() => applyLook());
    applyLook();
    applyAudio();
    bindSettingsUI();
    bindUI();
    setupFullscreen();
    setupPointerLight();
    layout();
    applySkin();
    setupTilt();
    refreshMenu();
    setScreen('menu');
    logo.replay(performance.now());
    if (!S.available()) {
      toastQueue.push({ id: 'storage', title: 'Progress won’t be saved', body: 'This browser window is blocking storage, so records and settings reset when you leave.', icon: 'i-lock' });
      setTimeout(pumpToasts, 900);
    }
    registerServiceWorker();
    requestAnimationFrame(frame);
    // Debug/test hook (harmless in production).
    window.__tetris = { app, settings, records, profile, startGame, pause, resume, layout, quit: quitToMenu };
  }

  boot();
})();
