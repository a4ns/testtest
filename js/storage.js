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
    daily: 'lgtetris.daily.v1',
    recent: 'lgtetris.recent.v1',
    save: 'lgtetris.save.v1.', // + mode
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
    music: 0.6,
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
    tilt: true,
    skin: 'jelly',
    bindings: DEFAULT_BINDINGS,
  };

  // Block materials; all but the first unlock with player level.
  const SKINS = [
    { id: 'jelly', name: 'Jelly', level: 1 },
    { id: 'crystal', name: 'Crystal', level: 3 },
    { id: 'neon', name: 'Neon', level: 5 },
    { id: 'pearl', name: 'Pearl', level: 8 },
    { id: 'gilded', name: 'Gilded', level: 12 },
    { id: 'bubble', name: 'Bubble', level: 16 },
    { id: 'prism', name: 'Prism', level: 20 },
  ];

  // Glass tiers: a title and ring colour for the player level, so every
  // stretch of levels (including far past 20) has something to reach.
  const TIERS = [
    { level: 1, name: 'Clear', color: '#9fb4ff' },
    { level: 5, name: 'Frost', color: '#7fe9ff' },
    { level: 10, name: 'Crystal', color: '#64d2ff' },
    { level: 15, name: 'Prism', color: '#bf5af2' },
    { level: 20, name: 'Quartz', color: '#ff8fcf' },
    { level: 25, name: 'Sapphire', color: '#0a84ff' },
    { level: 30, name: 'Opal', color: '#7dffd8' },
    { level: 40, name: 'Obsidian', color: '#c2c2d6' },
    { level: 50, name: 'Diamond', color: '#ffffff' },
  ];

  function tierFor(level) {
    let t = TIERS[0];
    for (const x of TIERS) if (level >= x.level) t = x;
    return t;
  }

  /** Experience earned from everything you've done, ever. */
  function playerXP(p) {
    const ach = p && p.achievements ? Object.keys(p.achievements).length : 0;
    const bonus = p && typeof p.bonusXP === 'number' && isFinite(p.bonusXP) ? Math.max(0, p.bonusXP) : 0;
    return Math.round(p.lines * 10 + p.tetrises * 40 + p.tspins * 60 + p.perfectClears * 300 + p.games * 20 + ach * 250 + bonus);
  }

  /** Level n is reached at 250·n·(n−1) XP: 0, 500, 1500, 3000, 5000… */
  function levelInfo(xp) {
    let n = 1;
    while (250 * (n + 1) * n <= xp && n < 999) n++;
    const base = 250 * n * (n - 1);
    const next = 250 * (n + 1) * n;
    return { level: n, xp, base, next, frac: (xp - base) / (next - base) };
  }

  const MODE_ORDER = ['marathon', 'sprint', 'ultra', 'dig', 'zen', 'daily'];
  // Races: the record is the fastest finish rather than the highest score.
  const RACE_MODES = ['sprint', 'dig'];

  // Daily Challenge medals (two minutes, Ultra rules).
  const DAILY_MEDALS = [
    { id: 'bronze', name: 'Bronze', score: 5000 },
    { id: 'silver', name: 'Silver', score: 10000 },
    { id: 'gold', name: 'Gold', score: 20000 },
  ];

  /** The best medal a daily score earns (or null), and the next one to aim for. */
  function dailyMedal(score) {
    let got = null;
    let next = null;
    for (const m of DAILY_MEDALS) {
      if (score >= m.score) got = m;
      else if (!next) next = m;
    }
    return { got, next };
  }

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
    { id: 'marathon150', name: 'Finish Line', desc: 'Clear 150 lines in a Marathon started at level 1.' },
    { id: 'level10', name: 'Momentum', desc: 'Climb 9 levels in one Marathon (1 → 10).' },
    { id: 'level15', name: 'Velocity', desc: 'Climb 14 levels in one Marathon (1 → 15).' },
    { id: 'level20', name: 'Terminal Velocity', desc: 'Climb 19 levels in one Marathon (1 → 20).' },
    { id: 'score100k', name: 'Six Figures', desc: 'Score 100,000 points in one game.' },
    { id: 'sprint', name: 'Sprinter', desc: 'Finish Sprint 40L.' },
    { id: 'sprint90', name: 'Swift', desc: 'Finish Sprint in under 1:30.' },
    { id: 'sprint60', name: 'Lightspeed', desc: 'Finish Sprint in under 1:00.' },
    { id: 'dig', name: 'Excavator', desc: 'Finish a Dig race.' },
    { id: 'dig45', name: 'Bedrock', desc: 'Finish Dig in under 0:45.' },
    { id: 'ultra30k', name: 'Ultra 30K', desc: 'Score 30,000 in Ultra.' },
    { id: 'ultra60k', name: 'Ultra 60K', desc: 'Score 60,000 in Ultra.' },
    { id: 'zen200', name: 'Still Water', desc: 'Clear 200 lines in one Zen session.' },
    { id: 'lines1000', name: 'Architect', desc: 'Clear 1,000 lines in total.' },
    { id: 'daily', name: 'Daily Ritual', desc: 'Finish a Daily Challenge.' },
    { id: 'streak3', name: 'Habit', desc: 'Play the Daily Challenge 3 days in a row.' },
    { id: 'streak7', name: 'Devotion', desc: 'Play the Daily Challenge 7 days in a row.' },
    { id: 'streak30', name: 'Ritual', desc: 'Keep a 30-day Daily Challenge streak.' },
    { id: 'gold', name: 'Gold Standard', desc: 'Win a Gold medal in the Daily Challenge.' },
  ];

  function load(key) {
    try {
      const raw = root.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  let onWriteFail = null;
  function save(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (onWriteFail) onWriteFail(key);
      return false;
    }
  }

  /** False when progress can't be kept (private mode, blocked site data, full). */
  function available() {
    try {
      const k = 'lgtetris.probe';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
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
    const ok = (k) => typeof k === 'string' && /^[A-Za-z0-9]+$/.test(k) && RESERVED_KEYS.indexOf(k) === -1;
    for (const a of ACTIONS) {
      const stored = isPlainObject(b) && Array.isArray(b[a]) ? b[a] : DEFAULT_BINDINGS[a];
      const list = stored.filter(ok).slice(0, 2);
      // An intentionally emptied action stays empty; a corrupted one gets its defaults back.
      out[a] = list.length || !stored.length ? list : DEFAULT_BINDINGS[a].slice();
    }
    return out;
  }

  // Allowed values for everything read back from storage.
  const RANGES = {
    das: [50, 300],
    arr: [0, 100],
    sdf: [5, SDF_INFINITE],
    previews: [1, 5],
    startLevel: [1, 15],
    master: [0, 1],
    music: [0, 1],
    sfx: [0, 1],
  };
  const CHOICES = {
    track: ['glass', 'classic', 'off'],
    wallpaper: ['auto', 'aurora', 'sunset', 'lagoon', 'graphite', 'daylight', 'nebula', 'blossom'],
    glass: ['high', 'standard', 'low'],
    touch: ['gestures', 'buttons'],
    skin: SKINS.map((k) => k.id),
  };

  function validSetting(k, v) {
    if (typeof v !== typeof DEFAULT_SETTINGS[k]) return false;
    if (typeof v === 'number') {
      if (!isFinite(v)) return false;
      const r = RANGES[k];
      return !r || (v >= r[0] && v <= r[1]);
    }
    if (CHOICES[k]) return CHOICES[k].indexOf(v) !== -1;
    return true;
  }

  function loadSettings() {
    const saved = load(KEYS.settings);
    const s = Object.assign({}, DEFAULT_SETTINGS);
    if (isPlainObject(saved)) {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k === 'bindings') continue;
        if (k in saved && validSetting(k, saved[k])) s[k] = saved[k];
      }
    }
    if (s.previews !== Math.round(s.previews)) s.previews = DEFAULT_SETTINGS.previews;
    if (s.startLevel !== Math.round(s.startLevel)) s.startLevel = DEFAULT_SETTINGS.startLevel;
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

  const finite = (v) => typeof v === 'number' && isFinite(v) && v >= 0;

  function validRun(run) {
    if (!isPlainObject(run) || !['score', 'lines', 'level', 'time', 'pieces', 'date'].every((k) => finite(run[k]))) return false;
    // Optional per-line times (Sprint pace); drop them if malformed.
    if ('lineTimes' in run && !(Array.isArray(run.lineTimes) && run.lineTimes.length <= 40 && run.lineTimes.every(finite))) delete run.lineTimes;
    if ('splits' in run && !(Array.isArray(run.splits) && run.splits.every(finite))) delete run.splits;
    return true;
  }

  function loadRecords() {
    const saved = load(KEYS.records);
    const r = emptyRecords();
    if (isPlainObject(saved)) {
      for (const m of MODE_ORDER) {
        if (!Array.isArray(saved[m])) continue;
        r[m] = saved[m].filter(validRun).sort((a, b) => compareRuns(m, a, b)).slice(0, 10);
      }
    }
    return r;
  }

  /** Lower is better for sprint (time), higher is better (score) elsewhere. */
  function compareRuns(mode, a, b) {
    if (RACE_MODES.indexOf(mode) !== -1) return a.time - b.time;
    return b.score - a.score || b.lines - a.lines;
  }

  /** Inserts a run; returns its 1-based rank, or 0 if it didn't place. */
  /** Another tab may have written since we loaded: take its view first. */
  function syncInto(target, fresh) {
    for (const k of Object.keys(target)) if (!(k in fresh)) delete target[k];
    Object.assign(target, fresh);
    return target;
  }

  function addRecord(records, mode, run) {
    syncInto(records, loadRecords());
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
      // Every finished or abandoned run (games counts only XP-earning ones).
      runs: 0,
      motionGranted: false,
      // Daily Challenge rewards: first finish of the day, medals, streak.
      bonusXP: 0,
    };
    if (isPlainObject(saved)) {
      for (const k of Object.keys(p)) {
        if (!(k in saved) || typeof saved[k] !== typeof p[k]) continue;
        if (typeof p[k] === 'number' && !(finite(saved[k]) && saved[k] >= 0)) continue;
        p[k] = saved[k];
      }
      // Only known achievements with a real unlock time count (they're worth XP).
      const ach = {};
      if (isPlainObject(p.achievements)) {
        for (const a of ACHIEVEMENTS) {
          const t = p.achievements[a.id];
          if (finite(t) && t > 0) ach[a.id] = t;
        }
      }
      p.achievements = ach;
    }
    return p;
  }

  function saveProfile(p) {
    return save(KEYS.profile, p);
  }

  /** Re-reads the stored profile into p, applies a change and saves, so two
   * open tabs add to each other's progress instead of overwriting it. */
  function updateProfile(p, change) {
    syncInto(p, loadProfile());
    change(p);
    return save(KEYS.profile, p);
  }

  // ---- resumable runs (Marathon, Zen) ----------------------------------

  function loadSave(mode) {
    const v = load(KEYS.save + mode);
    return isPlainObject(v) && isPlainObject(v.game) && v.game.mode === mode ? v : null;
  }

  function writeSave(mode, data) {
    return save(KEYS.save + mode, data);
  }

  function clearSave(mode) {
    try {
      root.localStorage.removeItem(KEYS.save + mode);
    } catch (e) {
      /* storage unavailable */
    }
  }

  // ---- daily challenge -------------------------------------------------

  function dayKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function previousDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d - 1));
  }

  function loadDaily() {
    const v = load(KEYS.daily);
    const out = { days: {}, streak: 0, lastDay: '', freezes: 0, frozeOn: '' };
    if (isPlainObject(v)) {
      if (finite(v.freezes)) out.freezes = Math.min(MAX_FREEZES, Math.floor(v.freezes));
      if (typeof v.frozeOn === 'string') out.frozeOn = v.frozeOn;
      if (isPlainObject(v.days)) {
        for (const k of Object.keys(v.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && finite(v.days[k])) out.days[k] = v.days[k];
      }
      if (finite(v.streak)) out.streak = Math.floor(v.streak);
      if (typeof v.lastDay === 'string') out.lastDay = v.lastDay;
    }
    return out;
  }

  // A streak freeze is earned every 7 days of streak (up to 2 banked) and
  // covers a single missed day automatically.
  const MAX_FREEZES = 2;

  /** Records a finished daily run; returns the updated daily state. */
  function recordDaily(daily, key, score) {
    daily.days[key] = Math.max(daily.days[key] || 0, score);
    if (daily.lastDay !== key) {
      const yesterday = previousDay(key);
      if (daily.lastDay === yesterday) {
        daily.streak += 1;
      } else if (daily.lastDay === previousDay(yesterday) && daily.freezes > 0) {
        daily.freezes -= 1;
        daily.frozeOn = yesterday;
        daily.streak += 1;
      } else {
        daily.streak = 1;
      }
      daily.lastDay = key;
      if (daily.streak % 7 === 0) daily.freezes = Math.min(MAX_FREEZES, (daily.freezes || 0) + 1);
    }
    // Keep the file small: only the last 60 days.
    const keys = Object.keys(daily.days).sort();
    while (keys.length > 60) delete daily.days[keys.shift()];
    save(KEYS.daily, daily);
    return daily;
  }

  /** The streak still counts if the last daily was today or yesterday, or
   * the day before with a freeze banked to cover the gap. */
  function liveStreak(daily, today) {
    const yesterday = previousDay(today);
    if (daily.lastDay === today || daily.lastDay === yesterday) return daily.streak;
    if (daily.freezes > 0 && daily.lastDay === previousDay(yesterday)) return daily.streak;
    return 0;
  }

  // ---- recent results (for "vs your recent average") -------------------

  function loadRecent() {
    const v = load(KEYS.recent);
    const out = {};
    if (isPlainObject(v)) {
      for (const m of MODE_ORDER) if (Array.isArray(v[m])) out[m] = v[m].filter(finite).slice(-20);
    }
    return out;
  }

  function pushRecent(recent, mode, value) {
    if (!finite(value)) return recent;
    syncInto(recent, loadRecent());
    const list = recent[mode] || (recent[mode] = []);
    list.push(value);
    while (list.length > 20) list.shift();
    save(KEYS.recent, recent);
    return recent;
  }

  root.TetrisStorage = {
    ACTIONS,
    ACTION_LABELS,
    DEFAULT_BINDINGS,
    DEFAULT_SETTINGS,
    RESERVED_KEYS,
    SDF_INFINITE,
    MODE_ORDER,
    RACE_MODES,
    ACHIEVEMENTS,
    SKINS,
    playerXP,
    levelInfo,
    TIERS,
    tierFor,
    available,
    DAILY_MEDALS,
    dailyMedal,
    loadSettings,
    saveSettings,
    hasSavedSettings,
    loadRecords,
    addRecord,
    bestRun,
    compareRuns,
    loadProfile,
    saveProfile,
    updateProfile,
    syncInto,
    KEYS,
    set onWriteFail(cb) {
      onWriteFail = cb;
    },
    loadSave,
    writeSave,
    clearSave,
    dayKey,
    previousDay,
    loadDaily,
    recordDaily,
    liveStreak,
    loadRecent,
    pushRecent,
    MAX_FREEZES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
