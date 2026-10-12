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
  S.writeSave('marathon', { game: { v: 1 }, savedAt: 5 });
  assert.equal(S.loadSave('marathon').savedAt, 5);
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
  assert.deepEqual(S.SKINS.map((s) => s.level), [1, 3, 5, 8]);
});
