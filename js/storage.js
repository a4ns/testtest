/*
 * Settings, personal records, lifetime stats and achievements.
 * Everything lives in localStorage; every access is guarded because storage
 * can be unavailable (private windows, blocked site data, sandboxed frames).
 */
(function (root) {
  'use strict';

  const KEYS = {
    settings: 'lgtetris.settings.v1',
    records: 'lgtetris.records.v1',
    profile: 'lgtetris.profile.v1',
  };

  const ACTIONS = ['left', 'right', 'soft', 'hard', 'cw', 'ccw', 'r180', 'hold'];

  const ACTION_LABELS = {
    left: 'Move left',
    right: 'Move right',
    soft: 'Soft drop',
    hard: 'Hard drop',
    cw: 'Rotate clockwise',
    ccw: 'Rotate counter-clockwise',
    r180: 'Rotate 180°',
    hold: 'Hold',
  };

  const DEFAULT_BINDINGS = {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    soft: ['ArrowDown'],
    hard: ['Space'],
    cw: ['ArrowUp', 'KeyX'],
    ccw: ['KeyZ'],
    r180: ['KeyA'],
    hold: ['KeyC', 'ShiftLeft'],
  };

  // Reserved keys that always pause/restart and cannot be bound.
  const RESERVED_KEYS = ['Escape', 'KeyP', 'KeyR', 'Tab', 'Enter'];

  const SDF_INFINITE = 41;

  const DEFAULT_SETTINGS = {
    das: 167,
    arr: 33,
    sdf: 20,
    ghost: true,
    grid: true,
    previews: 5,
    startLevel: 1,
    master: 0.8,
    music: 0.45,
    sfx: 0.8,
    track: 'glass',
    wallpaper: 'auto',
    glass: 'high',
    reduceMotion: false,
    shake: true,
    particles: true,
    animatedBg: true,
    touch: 'gestures',
    haptics: true,
    bindings: DEFAULT_BINDINGS,
  };

  const MODE_ORDER = ['marathon', 'sprint', 'ultra', 'zen'];

  const ACHIEVEMENTS = [
    { id: 'first-line', name: 'First Light', desc: 'Clear your first line.' },
    { id: 'tetris', name: 'Tetris!', desc: 'Clear four lines with one piece.' },
    { id: 'tspin', name: 'Twist', desc: 'Clear a line with a T-Spin.' },
    { id: 'tsd', name: 'Double Twist', desc: 'Land a T-Spin Double.' },
    { id: 'tst', name: 'Triple Twist', desc: 'Land a T-Spin Triple.' },
    { id: 'b2b3', name: 'Chain Reaction', desc: 'Reach Back-to-Back ×3.' },
    { id: 'combo5', name: 'Flow State', desc: 'Reach a 5 combo.' },
    { id: 'combo10', name: 'Unstoppable', desc: 'Reach a 10 combo.' },
    { id: 'pc', name: 'Crystal Clear', desc: 'Empty the whole field with a Perfect Clear.' },
    { id: 'level10', name: 'Momentum', desc: 'Reach level 10 in Marathon.' },
    { id: 'level15', name: 'Velocity', desc: 'Reach level 15 in Marathon.' },
    { id: 'level20', name: 'Terminal Velocity', desc: 'Reach level 20 in Marathon.' },
    { id: 'score100k', name: 'Six Figures', desc: 'Score 100,000 points in one game.' },
    { id: 'sprint', name: 'Sprinter', desc: 'Finish Sprint 40L.' },
    { id: 'sprint90', name: 'Swift', desc: 'Finish Sprint in under 1:30.' },
    { id: 'sprint60', name: 'Lightspeed', desc: 'Finish Sprint in under 1:00.' },
    { id: 'ultra30k', name: 'Ultra 30K', desc: 'Score 30,000 in Ultra.' },
    { id: 'ultra60k', name: 'Ultra 60K', desc: 'Score 60,000 in Ultra.' },
    { id: 'zen200', name: 'Still Water', desc: 'Clear 200 lines in one Zen session.' },
    { id: 'lines1000', name: 'Architect', desc: 'Clear 1,000 lines in total.' },
  ];

  function load(key) {
    try {
      const raw = root.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function save(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function sanitizeBindings(b) {
    const out = {};
    for (const a of ACTIONS) {
      const list = isPlainObject(b) && Array.isArray(b[a]) ? b[a] : DEFAULT_BINDINGS[a];
      out[a] = list.filter((k) => typeof k === 'string' && RESERVED_KEYS.indexOf(k) === -1).slice(0, 2);
    }
    return out;
  }

  function loadSettings() {
    const saved = load(KEYS.settings);
    const s = Object.assign({}, DEFAULT_SETTINGS);
    if (isPlainObject(saved)) {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k === 'bindings') continue;
        if (k in saved && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) s[k] = saved[k];
      }
    }
    s.bindings = sanitizeBindings(saved && saved.bindings);
    return s;
  }

  function hasSavedSettings() {
    try {
      return root.localStorage.getItem(KEYS.settings) !== null;
    } catch (e) {
      return false;
    }
  }

  function saveSettings(s) {
    save(KEYS.settings, s);
  }

  function emptyRecords() {
    const r = {};
    for (const m of MODE_ORDER) r[m] = [];
    return r;
  }

  function loadRecords() {
    const saved = load(KEYS.records);
    const r = emptyRecords();
    if (isPlainObject(saved)) {
      for (const m of MODE_ORDER) if (Array.isArray(saved[m])) r[m] = saved[m].filter(isPlainObject).slice(0, 10);
    }
    return r;
  }

  /** Lower is better for sprint (time), higher is better (score) elsewhere. */
  function compareRuns(mode, a, b) {
    if (mode === 'sprint') return a.time - b.time;
    return b.score - a.score || b.lines - a.lines;
  }

  /** Inserts a run; returns its 1-based rank, or 0 if it didn't place. */
  function addRecord(records, mode, run) {
    const list = records[mode] || (records[mode] = []);
    list.push(run);
    list.sort((a, b) => compareRuns(mode, a, b));
    const rank = list.indexOf(run) + 1;
    records[mode] = list.slice(0, 10);
    save(KEYS.records, records);
    return rank <= 10 ? rank : 0;
  }

  function bestRun(records, mode) {
    const list = records[mode];
    return list && list.length ? list[0] : null;
  }

  function loadProfile() {
    const saved = load(KEYS.profile);
    const p = {
      games: 0,
      lines: 0,
      pieces: 0,
      tetrises: 0,
      tspins: 0,
      perfectClears: 0,
      timePlayed: 0,
      bestScore: 0,
      achievements: {},
      seenTouchHelp: false,
    };
    if (isPlainObject(saved)) {
      for (const k of Object.keys(p)) {
        if (k in saved && typeof saved[k] === typeof p[k]) p[k] = saved[k];
      }
      if (!isPlainObject(p.achievements)) p.achievements = {};
    }
    return p;
  }

  function saveProfile(p) {
    save(KEYS.profile, p);
  }

  root.TetrisStorage = {
    ACTIONS,
    ACTION_LABELS,
    DEFAULT_BINDINGS,
    DEFAULT_SETTINGS,
    RESERVED_KEYS,
    SDF_INFINITE,
    MODE_ORDER,
    ACHIEVEMENTS,
    loadSettings,
    saveSettings,
    hasSavedSettings,
    loadRecords,
    addRecord,
    bestRun,
    compareRuns,
    loadProfile,
    saveProfile,
  };
})(typeof window !== 'undefined' ? window : globalThis);
