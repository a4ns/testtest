'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal in-memory localStorage for storage.js.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
require('../js/storage.js');
const S = globalThis.TetrisStorage;

test('defaults when nothing is stored', () => {
  mem.clear();
  const s = S.loadSettings();
  assert.equal(s.das, 167);
  assert.deepEqual(s.bindings.hard, ['Space']);
  assert.equal(S.hasSavedSettings(), false);
});

test('out-of-range and wrong-type settings fall back to defaults', () => {
  mem.clear();
  localStorage.setItem(
    'lgtetris.settings.v1',
    JSON.stringify({ das: 'fast', arr: -5, previews: 99, sdf: 30, track: 'jazz', wallpaper: 'sunset', master: 2, startLevel: 3.5, ghost: false })
  );
  const s = S.loadSettings();
  assert.equal(s.das, 167);
  assert.equal(s.arr, 33);
  assert.equal(s.previews, 5);
  assert.equal(s.sdf, 30);
  assert.equal(s.track, 'glass');
  assert.equal(s.wallpaper, 'sunset');
  assert.equal(s.master, 0.8);
  assert.equal(s.startLevel, 1);
  assert.equal(s.ghost, false);
});

test('bindings drop reserved keys and keep at most two keys', () => {
  mem.clear();
  localStorage.setItem('lgtetris.settings.v1', JSON.stringify({ bindings: { hard: ['Escape', 'Space', 'KeyW', 'KeyQ'], left: 'nope' } }));
  const s = S.loadSettings();
  assert.deepEqual(s.bindings.hard, ['Space', 'KeyW']);
  assert.deepEqual(s.bindings.left, ['ArrowLeft']);
});

test('corrupted records are filtered and re-sorted', () => {
  mem.clear();
  const ok = { score: 500, lines: 5, level: 1, time: 1000, pieces: 20, date: 1 };
  localStorage.setItem(
    'lgtetris.records.v1',
    JSON.stringify({ marathon: [{ score: 'x' }, null, { ...ok, score: 100 }, ok, { ...ok, score: NaN }], sprint: 'bad' })
  );
  const r = S.loadRecords();
  assert.equal(r.marathon.length, 2);
  assert.equal(r.marathon[0].score, 500);
  assert.deepEqual(r.sprint, []);
});

test('addRecord ranks by time for sprint and score otherwise', () => {
  mem.clear();
  const r = S.loadRecords();
  const run = (o) => Object.assign({ score: 0, lines: 40, level: 1, time: 60000, pieces: 100, date: 1 }, o);
  assert.equal(S.addRecord(r, 'sprint', run({ time: 70000 })), 1);
  assert.equal(S.addRecord(r, 'sprint', run({ time: 50000 })), 1);
  assert.equal(S.addRecord(r, 'sprint', run({ time: 90000 })), 3);
  assert.equal(S.bestRun(r, 'sprint').time, 50000);
  for (let i = 0; i < 12; i++) S.addRecord(r, 'marathon', run({ score: 1000 + i }));
  assert.equal(r.marathon.length, 10);
  assert.equal(S.addRecord(r, 'marathon', run({ score: 1 })), 0);
  assert.equal(S.loadRecords().marathon[0].score, 1011);
});

test('profile ignores non-finite numbers', () => {
  mem.clear();
  localStorage.setItem('lgtetris.profile.v1', JSON.stringify({ games: 'many', lines: 1e400, tetrises: 3, achievements: [] }));
  const p = S.loadProfile();
  assert.equal(p.games, 0);
  assert.equal(p.lines, 0);
  assert.equal(p.tetrises, 3);
  assert.deepEqual(p.achievements, {});
});

test('storage failures never throw', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.doesNotThrow(() => S.saveSettings(S.loadSettings()));
  assert.equal(S.loadRecords().zen.length, 0);
  globalThis.localStorage = saved;
});

test('daily streak grows on consecutive days and resets after a gap', () => {
  mem.clear();
  let d = S.loadDaily();
  d = S.recordDaily(d, '2026-10-09', 1000);
  assert.equal(d.streak, 1);
  d = S.recordDaily(d, '2026-10-10', 500);
  d = S.recordDaily(d, '2026-10-10', 2500);
  assert.equal(d.streak, 2);
  assert.equal(d.days['2026-10-10'], 2500);
  d = S.recordDaily(d, '2026-10-11', 10);
  assert.equal(d.streak, 3);
  assert.equal(S.liveStreak(d, '2026-10-12'), 3);
  assert.equal(S.liveStreak(d, '2026-10-13'), 0);
  d = S.recordDaily(d, '2026-10-14', 10);
  assert.equal(d.streak, 1);
  assert.equal(S.previousDay('2026-03-01'), '2026-02-28');
  assert.equal(S.previousDay('2026-01-01'), '2025-12-31');
  assert.deepEqual(S.loadDaily().days['2026-10-10'], 2500);
});

test('saved runs round-trip and clear', () => {
  mem.clear();
  assert.equal(S.loadSave('marathon'), null);
  S.writeSave('marathon', { game: { v: 1, mode: 'marathon' }, savedAt: 5 });
  assert.equal(S.loadSave('marathon').savedAt, 5);
  // A save filed under the wrong mode is ignored.
  S.writeSave('zen', { game: { v: 1, mode: 'marathon' }, savedAt: 5 });
  assert.equal(S.loadSave('zen'), null);
  S.clearSave('marathon');
  assert.equal(S.loadSave('marathon'), null);
});

test('corrupted bindings fall back to defaults, emptied ones stay empty', () => {
  mem.clear();
  localStorage.setItem('lgtetris.settings.v1', JSON.stringify({ bindings: { left: [1, 2, 'Escape'], hold: [] } }));
  const s = S.loadSettings();
  assert.deepEqual(s.bindings.left, ['ArrowLeft']);
  assert.deepEqual(s.bindings.hold, []);
});

test('player levels follow the triangular XP curve', () => {
  assert.equal(S.levelInfo(0).level, 1);
  assert.equal(S.levelInfo(499).level, 1);
  assert.equal(S.levelInfo(500).level, 2);
  assert.equal(S.levelInfo(1500).level, 3);
  assert.equal(S.levelInfo(2999).level, 3);
  const l = S.levelInfo(2000);
  assert.equal(l.base, 1500);
  assert.equal(l.next, 3000);
  assert.ok(Math.abs(l.frac - 1 / 3) < 1e-9);
  const p = { lines: 10, tetrises: 1, tspins: 1, perfectClears: 0, games: 2, achievements: { a: 1, b: 2 } };
  assert.equal(S.playerXP(p), 100 + 40 + 60 + 40 + 500);
  assert.deepEqual(S.SKINS.map((s) => s.level), [1, 3, 5, 8, 12, 16, 20]);
});

test('profile keeps only known achievements and non-negative stats', () => {
  mem.clear();
  localStorage.setItem(
    'lgtetris.profile.v1',
    JSON.stringify({ lines: -50, games: 3, achievements: { tetris: 1700000000000, fake1: 1, fake2: 2, pc: 'yes' } })
  );
  const p = S.loadProfile();
  assert.deepEqual(Object.keys(p.achievements), ['tetris']);
  assert.equal(p.lines, 0);
  assert.equal(p.games, 3);
});

test('storage availability probe', () => {
  mem.clear();
  assert.equal(S.available(), true);
});

test('daily medals', () => {
  assert.equal(S.dailyMedal(0).got, null);
  assert.equal(S.dailyMedal(0).next.id, 'bronze');
  assert.equal(S.dailyMedal(12000).got.id, 'silver');
  assert.equal(S.dailyMedal(12000).next.id, 'gold');
  assert.equal(S.dailyMedal(99999).next, null);
});

test('a banked streak freeze covers one missed day', () => {
  mem.clear();
  let d = S.loadDaily();
  // Seven days in a row earns a freeze.
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  for (const k of days) d = S.recordDaily(d, k, 1000);
  assert.equal(d.streak, 7);
  assert.equal(d.freezes, 1);
  // Missing the 8th: still alive on the 9th, and playing then uses the freeze.
  assert.equal(S.liveStreak(d, '2026-10-09'), 7);
  d = S.recordDaily(d, '2026-10-09', 1000);
  assert.equal(d.streak, 8);
  assert.equal(d.freezes, 0);
  assert.equal(d.frozeOn, '2026-10-08');
  // A second gap with no freeze resets it.
  assert.equal(S.liveStreak(d, '2026-10-11'), 0);
  d = S.recordDaily(d, '2026-10-11', 1000);
  assert.equal(d.streak, 1);
});

test('recent results keep the last twenty per mode', () => {
  mem.clear();
  let r = S.loadRecent();
  for (let i = 0; i < 25; i++) r = S.pushRecent(r, 'ultra', i);
  assert.equal(S.loadRecent().ultra.length, 20);
  assert.equal(S.loadRecent().ultra[0], 5);
});

test('daily bonus XP counts toward the player level', () => {
  const p = { lines: 0, tetrises: 0, tspins: 0, perfectClears: 0, games: 0, achievements: {}, bonusXP: 350 };
  assert.equal(S.playerXP(p), 350);
});

test('two banked freezes cover a two-day absence', () => {
  mem.clear();
  let d = S.loadDaily();
  for (let i = 1; i <= 14; i++) d = S.recordDaily(d, '2026-09-' + String(i).padStart(2, '0'), 500);
  assert.equal(d.streak, 14);
  assert.equal(d.freezes, 2);
  // Missed the 15th and 16th: still alive on the 17th, and playing uses both.
  assert.equal(S.liveStreak(d, '2026-09-17'), 14);
  d = S.recordDaily(d, '2026-09-17', 500);
  assert.equal(d.streak, 15);
  assert.equal(d.freezes, 0);
  assert.equal(d.covered, 2);
  assert.deepEqual(d.frozenDays.slice().sort(), ['2026-09-15', '2026-09-16']);
  // Three days away with no freezes left: gone.
  assert.equal(S.liveStreak(d, '2026-09-21'), 0);
});

test('daily variants are deterministic and scale medal targets', () => {
  assert.equal(S.dailyVariant('2026-10-13').id, S.dailyVariant('2026-10-13').id);
  const ids = new Set();
  for (let d = 1; d <= 28; d++) ids.add(S.dailyVariant('2026-02-' + String(d).padStart(2, '0')).id);
  assert.ok(ids.size >= 3);
  const fastDay = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].find((k) => S.dailyVariant(k).id === 'fast');
  if (fastDay) assert.ok(S.dailyMedals(fastDay)[2].score > S.DAILY_MEDALS[2].score);
  assert.equal(S.dailyMedal(12000).got.id, 'silver');
});
