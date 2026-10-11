'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const { Game, COLS, ROWS, HIDDEN_ROWS, SHAPES, PIECE_TYPES } = E;

/** Game with a board built from strings (bottom rows), '#' = filled. */
function gameWithRows(rows, opts = {}) {
  const g = new Game(Object.assign({ seed: 1 }, opts));
  g.start();
  const start = ROWS - rows.length;
  rows.forEach((line, i) => {
    for (let x = 0; x < COLS; x++) g.board[start + i][x] = line[x] === '#' ? 1 : 0;
  });
  return g;
}

function setActive(g, type, rot, x, y) {
  g.active = { type, rot, x, y };
  g.lastWasRotation = false;
  g.lastKickTST = false;
  g.lowestY = y;
  g.lockResets = 0;
  g.lockTimer = 0;
}

function events(g, type) {
  return g.drainEvents().filter((e) => e.type === type);
}

test('every piece has 4 distinct cells in every rotation state', () => {
  for (const t of PIECE_TYPES) {
    assert.equal(SHAPES[t].length, 4);
    for (const state of SHAPES[t]) {
      assert.equal(state.length, 4);
      assert.equal(new Set(state.map((c) => c.join())).size, 4);
    }
  }
});

test('T rotation states match SRS', () => {
  const sort = (cells) => cells.map((c) => c.join()).sort();
  assert.deepEqual(sort(SHAPES.T[1]), sort([[1, 0], [1, 1], [2, 1], [1, 2]]));
  assert.deepEqual(sort(SHAPES.T[2]), sort([[0, 1], [1, 1], [2, 1], [1, 2]]));
  assert.deepEqual(sort(SHAPES.T[3]), sort([[1, 0], [0, 1], [1, 1], [1, 2]]));
  assert.deepEqual(sort(SHAPES.I[1]), sort([[2, 0], [2, 1], [2, 2], [2, 3]]));
  assert.deepEqual(sort(SHAPES.I[3]), sort([[1, 0], [1, 1], [1, 2], [1, 3]]));
});

test('7-bag deals each piece exactly once per bag', () => {
  const next = E.createBag(E.mulberry32(42));
  for (let bag = 0; bag < 50; bag++) {
    const seen = new Set();
    for (let i = 0; i < 7; i++) seen.add(next());
    assert.equal(seen.size, 7);
  }
});

test('same seed gives the same piece sequence', () => {
  const a = new Game({ seed: 99 });
  const b = new Game({ seed: 99 });
  assert.deepEqual(a.queue, b.queue);
});

test('gravity curve follows the guideline formula', () => {
  assert.equal(E.msPerRow(1), 1000);
  assert.ok(Math.abs(E.msPerRow(2) - 793) < 1);
  assert.ok(E.msPerRow(15) < 10);
  assert.ok(E.msPerRow(20) < 1);
  assert.equal(E.msPerRow(30), E.msPerRow(20));
});

test('pieces spawn centred and drop one row into view', () => {
  const g = new Game({ seed: 3 });
  g.start();
  const p = g.active;
  assert.equal(p.x, 3);
  assert.equal(p.y, HIDDEN_ROWS - 1);
  const cells = g.cellsOf(p);
  assert.ok(cells.some(([, y]) => y >= HIDDEN_ROWS), 'part of the piece is visible');
  const xs = cells.map(([x]) => x);
  if (p.type === 'O') assert.deepEqual([Math.min(...xs), Math.max(...xs)], [4, 5]);
  else if (p.type === 'I') assert.deepEqual([Math.min(...xs), Math.max(...xs)], [3, 6]);
  else assert.deepEqual([Math.min(...xs), Math.max(...xs)], [3, 5]);
});

test('moving stops at the walls', () => {
  const g = gameWithRows([]);
  setActive(g, 'T', 0, 3, 20);
  let n = 0;
  while (g.move(-1)) n++;
  assert.equal(n, 3);
  assert.equal(Math.min(...g.cellsOf(g.active).map((c) => c[0])), 0);
  n = 0;
  while (g.move(1)) n++;
  assert.equal(n, 7);
  assert.equal(Math.max(...g.cellsOf(g.active).map((c) => c[0])), COLS - 1);
});

test('hard drop lands on the floor, scores 2 per cell and locks', () => {
  const g = gameWithRows([]);
  setActive(g, 'O', 0, 3, 20);
  g.drainEvents();
  g.hardDrop();
  assert.equal(g.board[ROWS - 1][4], E.PIECE_ID.O);
  assert.equal(g.board[ROWS - 1][5], E.PIECE_ID.O);
  assert.equal(g.board[ROWS - 2][4], E.PIECE_ID.O);
  assert.equal(g.score, 2 * (ROWS - 2 - 20));
  assert.equal(g.stats.pieces, 1);
  assert.ok(g.active, 'next piece spawned');
});

test('single line clear scores 100 x level and shifts the stack down', () => {
  const g = gameWithRows(['......#...', '######....']);
  setActive(g, 'I', 0, 6, 30);
  g.hardDrop(); // I lies in row 39? It lands on row 38 because col 6 is filled at row 38
  // The I spans cols 6-9; col 6 is blocked at the second-to-last row, so it rests above it.
  assert.equal(g.lines, 0);

  const h = gameWithRows(['##........', '######....']);
  setActive(h, 'I', 0, 6, 30);
  const before = h.score;
  h.drainEvents();
  h.hardDrop();
  const clear = h.drainEvents().find((e) => e.type === 'clear');
  assert.ok(clear);
  assert.equal(clear.lines, 1);
  assert.equal(h.lines, 1);
  // The partial row above dropped into the bottom row.
  assert.deepEqual(h.board[ROWS - 1].slice(0, 3), [1, 1, 0]);
  assert.equal(h.score - before - 2 * (ROWS - 1 - 31), 100);
});

test('tetris scores 800, back-to-back tetris scores 1200 plus combo', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push('#########.');
  const g = gameWithRows(rows);
  setActive(g, 'I', 1, 7, 20); // vertical I occupies column 9
  let s0 = g.score;
  g.hardDrop();
  let drop = g.drainEvents().find((e) => e.type === 'hardDrop').distance;
  assert.equal(g.lines, 4);
  assert.equal(g.score - s0 - drop * 2, 800);
  assert.equal(g.stats.tetrises, 1);

  setActive(g, 'I', 1, 7, 20);
  s0 = g.score;
  g.hardDrop();
  const evs = g.drainEvents();
  drop = evs.find((e) => e.type === 'hardDrop').distance;
  const clear = evs.find((e) => e.type === 'clear');
  assert.equal(clear.b2b, true);
  assert.equal(clear.combo, 1);
  // 800 * 1.5 = 1200 back-to-back, + 50 * combo(1) * level(1),
  // + 3200 for a back-to-back tetris perfect clear (the board is now empty).
  assert.equal(clear.perfectClear, true);
  assert.equal(g.score - s0 - drop * 2, 1200 + 50 + 3200);
});

test('perfect clear bonus', () => {
  const g = gameWithRows(['######....']);
  setActive(g, 'I', 0, 6, 30);
  g.hardDrop();
  const clear = g.drainEvents().find((e) => e.type === 'clear');
  assert.equal(clear.perfectClear, true);
  assert.equal(clear.points, 100 + 800);
  assert.equal(g.stats.perfectClears, 1);
});

test('T-spin double via rotation into an overhang slot', () => {
  const g = gameWithRows([
    '...#......', // row 37: overhang above the slot's left corner
    '###...####', // row 38
    '####.#####', // row 39
  ]);
  setActive(g, 'T', 1, 3, 37);
  assert.equal(g.rotate(1), true);
  assert.equal(g.active.rot, 2);
  assert.equal(g.detectTSpin(), 'full');
  g.drainEvents();
  const s0 = g.score;
  g.hardDrop();
  const clear = g.drainEvents().find((e) => e.type === 'clear');
  assert.equal(clear.tspin, 'full');
  assert.equal(clear.lines, 2);
  assert.equal(g.score - s0, 1200);
  assert.equal(g.stats.tspinDoubles, 1);
  // The overhang block fell to the floor.
  assert.equal(g.board[ROWS - 1][3], 1);
});

test('T-spin credit is lost when the piece moves after rotating', () => {
  const g = gameWithRows([]);
  setActive(g, 'T', 0, 3, 25);
  g.rotate(1);
  assert.equal(g.lastWasRotation, true);
  g.update(1001); // gravity moves it down a row
  assert.equal(g.lastWasRotation, false);
  g.rotate(1);
  g.move(1);
  assert.equal(g.lastWasRotation, false);
});

test('three-corner rule distinguishes mini from full', () => {
  const g = gameWithRows(['#.........', '..........']);
  // T pointing up, centre at (1,39): corners TL(0,38) filled, BL/BR out of bounds (floor).
  setActive(g, 'T', 0, 0, 38);
  g.lastWasRotation = true;
  assert.equal(g.detectTSpin(), 'mini');
  g.lastKickTST = true;
  assert.equal(g.detectTSpin(), 'full', 'TST kick upgrades a mini');
  g.lastKickTST = false;
  g.lastWasRotation = false;
  assert.equal(g.detectTSpin(), 'none', 'needs a rotation as last move');
});

test('I piece kicks off the left wall when rotating', () => {
  const g = gameWithRows([]);
  setActive(g, 'I', 3, -1, 25); // vertical in column 0
  assert.equal(Math.min(...g.cellsOf(g.active).map((c) => c[0])), 0);
  assert.equal(g.rotate(1), true); // L -> 0 needs a kick
  const xs = g.cellsOf(g.active).map((c) => c[0]);
  assert.ok(Math.min(...xs) >= 0);
  assert.equal(g.active.rot, 0);
});

test('O piece does not rotate', () => {
  const g = gameWithRows([]);
  setActive(g, 'O', 0, 3, 25);
  assert.equal(g.rotate(1), false);
});

test('180 rotation works', () => {
  const g = gameWithRows([]);
  setActive(g, 'T', 0, 3, 25);
  assert.equal(g.rotate(2), true);
  assert.equal(g.active.rot, 2);
});

test('gravity drops one row per second at level 1', () => {
  const g = gameWithRows([]);
  setActive(g, 'T', 0, 3, 20);
  g.update(999);
  assert.equal(g.active.y, 20);
  g.update(2);
  assert.equal(g.active.y, 21);
});

test('soft drop is faster and scores 1 per row', () => {
  const g = gameWithRows([], { softDropFactor: 20 });
  setActive(g, 'T', 0, 3, 20);
  g.update(100, true);
  assert.equal(g.active.y, 22);
  assert.equal(g.score, 2);
});

test('lock delay is 500 ms once grounded', () => {
  const g = gameWithRows([]);
  setActive(g, 'T', 0, 3, ROWS - 2);
  assert.equal(g.isGrounded(), true);
  g.update(450);
  assert.ok(g.active && g.active.type === 'T' && g.stats.pieces === 0);
  g.update(60);
  assert.equal(g.stats.pieces, 1);
});

test('moves reset lock delay at most 15 times', () => {
  const g = gameWithRows([]);
  setActive(g, 'T', 0, 3, ROWS - 2);
  let dir = 1;
  for (let i = 0; i < 15; i++) {
    g.update(400);
    assert.equal(g.stats.pieces, 0, `still alive after reset ${i}`);
    if (!g.move(dir)) {
      dir = -dir;
      g.move(dir);
    }
  }
  // Resets are exhausted: the piece locks on the next update.
  g.update(16);
  assert.equal(g.stats.pieces, 1);
});

test('hold swaps pieces once per drop', () => {
  const g = new Game({ seed: 5 });
  g.start();
  const first = g.active.type;
  const second = g.queue[0];
  assert.equal(g.hold(), true);
  assert.equal(g.holdType, first);
  assert.equal(g.active.type, second);
  assert.equal(g.hold(), false, 'cannot hold twice');
  g.hardDrop();
  assert.equal(g.hold(), true);
  assert.equal(g.active.type, first);
});

test('block out ends a marathon game', () => {
  const g = new Game({ seed: 1 });
  g.start();
  // Fill the spawn area so the next piece cannot appear.
  for (let y = HIDDEN_ROWS - 2; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) g.board[y][x] = (x + y) % 2 ? 1 : 0;
  }
  for (let x = 3; x < 7; x++) {
    g.board[HIDDEN_ROWS - 2][x] = 1;
    g.board[HIDDEN_ROWS - 1][x] = 1;
  }
  g.active = null;
  g.spawnNext();
  assert.equal(g.state, 'over');
  assert.equal(g.endReason, 'topout');
});

test('zen mode clears the field instead of ending', () => {
  const g = new Game({ seed: 1, mode: 'zen' });
  g.start();
  for (let x = 0; x < COLS; x++) {
    g.board[HIDDEN_ROWS - 2][x] = x === 0 ? 0 : 1;
    g.board[HIDDEN_ROWS - 1][x] = x === 0 ? 0 : 1;
  }
  g.active = null;
  g.drainEvents();
  g.spawnNext();
  assert.equal(g.state, 'playing');
  assert.ok(g.active);
  assert.equal(g.drainEvents()[0].type, 'zenReset');
  assert.equal(g.stackHeight(), 0);
});

test('sprint finishes at 40 lines', () => {
  const g = new Game({ seed: 1, mode: 'sprint' });
  g.start();
  g.lines = 39;
  for (let x = 0; x < 6; x++) g.board[ROWS - 1][x] = 1;
  setActive(g, 'I', 0, 6, 30);
  g.hardDrop();
  assert.equal(g.state, 'won');
  assert.equal(g.endReason, 'cleared');
});

test('ultra ends when the clock runs out', () => {
  const g = new Game({ seed: 1, mode: 'ultra' });
  g.start();
  g.time = 119500;
  g.update(400);
  assert.equal(g.state, 'playing');
  g.update(200);
  assert.equal(g.state, 'won');
  assert.equal(g.endReason, 'timeup');
  assert.equal(g.time, 120000);
});

test('level rises every 10 lines from the start level', () => {
  const g = new Game({ seed: 1, startLevel: 3 });
  g.start();
  g.lines = 9;
  for (let x = 0; x < 6; x++) g.board[ROWS - 1][x] = 1;
  setActive(g, 'I', 0, 6, 30);
  g.drainEvents();
  g.hardDrop();
  assert.equal(g.level, 4);
  assert.ok(g.drainEvents().some((e) => e.type === 'levelUp' && e.level === 4));
});

test('combo counter grows with consecutive clears and resets on a miss', () => {
  const g = gameWithRows(['#.........', '########..', '########..', '########..', '########..']);
  setActive(g, 'O', 0, 7, 30);
  g.hardDrop();
  let clear = g.drainEvents().find((e) => e.type === 'clear');
  assert.equal(clear.lines, 2);
  assert.equal(clear.combo, 0);
  setActive(g, 'O', 0, 7, 30);
  g.hardDrop();
  clear = g.drainEvents().find((e) => e.type === 'clear');
  assert.equal(clear.combo, 1);
  assert.equal(clear.points, 300 + 50);
  setActive(g, 'O', 0, 3, 30);
  g.hardDrop();
  assert.equal(g.combo, -1);
  assert.equal(g.stats.maxCombo, 1);
});

test('a random game played with hard drops always keeps a valid board', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = new Game({ seed });
    g.start();
    const rand = E.mulberry32(seed * 7);
    let guard = 0;
    while (g.state === 'playing' && guard++ < 2000) {
      const r = rand();
      if (r < 0.3) g.move(-1);
      else if (r < 0.6) g.move(1);
      else if (r < 0.75) g.rotate(1);
      else if (r < 0.8) g.rotate(-1);
      else if (r < 0.82) g.hold();
      else g.hardDrop();
      g.update(16, rand() < 0.1);
      for (const row of g.board) assert.equal(row.length, COLS);
      assert.equal(g.board.length, ROWS);
      if (g.active) assert.equal(g.collides(g.active.type, g.active.rot, g.active.x, g.active.y), false);
    }
    assert.ok(g.stats.pieces > 5);
  }
});
