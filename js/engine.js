/*
 * Liquid Glass Tetris — rules engine.
 *
 * Pure game logic with no DOM access, so it runs in the browser and in Node
 * (for tests). Follows the modern Tetris Guideline: SRS rotation with wall
 * kicks, 7-bag randomizer, hold, 5-piece preview, ghost, 500 ms lock delay
 * with 15 move resets, T-spin (3-corner) detection, back-to-back, combos and
 * perfect-clear bonuses.
 *
 * Coordinates: x grows right, y grows down. The matrix is 10 x 40; the bottom
 * 20 rows are visible and the top 20 are the hidden buffer pieces spawn in.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TetrisEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLS = 10;
  const VISIBLE_ROWS = 20;
  const HIDDEN_ROWS = 20;
  const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;
  const SPAWN_X = 3;
  // Pieces spawn in the two rows just above the visible field (guideline rows
  // 21-22), then immediately drop one row if nothing is in the way.
  const SPAWN_Y = HIDDEN_ROWS - 2;

  const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
  const PIECE_ID = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };
  const ID_PIECE = [null, 'I', 'J', 'L', 'O', 'S', 'T', 'Z'];

  const BASE_SHAPES = {
    I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
    J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
    L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
    O: { size: 4, cells: [[1, 0], [2, 0], [1, 1], [2, 1]] },
    S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
    Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  };

  // Clockwise rotation inside the piece's bounding box (screen coordinates).
  function rotateCW(cells, size) {
    return cells.map(([x, y]) => [size - 1 - y, x]);
  }

  const SHAPES = {};
  for (const type of PIECE_TYPES) {
    const { size, cells } = BASE_SHAPES[type];
    const states = [cells];
    for (let r = 1; r < 4; r++) {
      states.push(type === 'O' ? cells : rotateCW(states[r - 1], size));
    }
    SHAPES[type] = states;
  }

  // SRS kick data as published in the guideline (y points up), flipped to
  // y-down below. Keys are "from>to" with states 0, 1 (R), 2, 3 (L).
  function flipY(table) {
    const out = {};
    for (const key of Object.keys(table)) out[key] = table[key].map(([x, y]) => [x, y === 0 ? 0 : -y]);
    return out;
  }

  const KICKS_JLSTZ = flipY({
    '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  });

  const KICKS_I = flipY({
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  });

  // 180° rotation kicks (the widely used SRS+ table).
  const KICKS_180 = flipY({
    '0>2': [[0, 0], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]],
    '2>0': [[0, 0], [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0]],
    '1>3': [[0, 0], [1, 0], [1, 2], [1, 1], [0, 2], [0, 1]],
    '3>1': [[0, 0], [-1, 0], [-1, 2], [-1, 1], [0, 2], [0, 1]],
  });

  // T-spin corner order: top-left, top-right, bottom-right, bottom-left.
  // "Front" corners are the two on the side the T is pointing at.
  const T_FRONT_CORNERS = [[0, 1], [1, 2], [2, 3], [3, 0]];

  const LINE_POINTS = [0, 100, 300, 500, 800];
  const TSPIN_POINTS = [400, 800, 1200, 1600];
  const TSPIN_MINI_POINTS = [100, 200, 400, 400];
  const PERFECT_CLEAR_POINTS = [0, 800, 1200, 1800, 2000];
  const PERFECT_CLEAR_B2B_TETRIS = 3200;

  const MODES = {
    marathon: { name: 'Marathon', levelUp: true, maxGravityLevel: 20, goalLines: 0, timeLimit: 0, topOut: true },
    sprint: { name: 'Sprint', levelUp: false, fixedLevel: 1, maxGravityLevel: 1, goalLines: 40, timeLimit: 0, topOut: true },
    ultra: { name: 'Ultra', levelUp: true, maxGravityLevel: 20, goalLines: 0, timeLimit: 120000, topOut: true },
    zen: { name: 'Zen', levelUp: true, maxGravityLevel: 5, goalLines: 0, timeLimit: 0, topOut: false },
  };

  /** Milliseconds per row at a level (guideline gravity curve). */
  function msPerRow(level) {
    const l = Math.min(Math.max(level, 1), 20);
    return 1000 * Math.pow(0.8 - (l - 1) * 0.007, l - 1);
  }

  /** Small, fast, seedable PRNG. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 7-bag randomizer: every piece once per bag, in random order. */
  function createBag(rand) {
    let bag = [];
    return function next() {
      if (bag.length === 0) {
        bag = PIECE_TYPES.slice();
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          const tmp = bag[i];
          bag[i] = bag[j];
          bag[j] = tmp;
        }
      }
      return bag.pop();
    };
  }

  function makeBoard() {
    const board = [];
    for (let y = 0; y < ROWS; y++) board.push(new Array(COLS).fill(0));
    return board;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  class Game {
    constructor(options = {}) {
      this.mode = MODES[options.mode] ? options.mode : 'marathon';
      this.rules = MODES[this.mode];
      this.startLevel = this.rules.fixedLevel || clamp(Math.floor(options.startLevel || 1), 1, 20);
      this.seed = (options.seed == null ? Math.floor(Math.random() * 4294967296) : options.seed) >>> 0;
      this.lockDelay = options.lockDelay == null ? 500 : options.lockDelay;
      this.maxLockResets = options.maxLockResets == null ? 15 : options.maxLockResets;
      this.previewCount = clamp(options.previewCount == null ? 5 : options.previewCount, 0, 6);
      this.softDropFactor = options.softDropFactor == null ? 20 : options.softDropFactor;
      this.reset();
    }

    reset() {
      this.rand = mulberry32(this.seed);
      this.nextFromBag = createBag(this.rand);
      this.board = makeBoard();
      this.queue = [];
      this.fillQueue();
      this.active = null;
      this.holdType = null;
      this.holdUsed = false;
      this.score = 0;
      this.lines = 0;
      this.level = this.startLevel;
      this.combo = -1;
      this.b2b = -1;
      this.time = 0;
      this.state = 'ready';
      this.endReason = null;
      this.events = [];
      this.stats = {
        pieces: 0,
        singles: 0,
        doubles: 0,
        triples: 0,
        tetrises: 0,
        tspins: 0,
        tspinMinis: 0,
        tspinSingles: 0,
        tspinDoubles: 0,
        tspinTriples: 0,
        perfectClears: 0,
        maxCombo: 0,
        maxB2B: 0,
        holds: 0,
        zenResets: 0,
      };
      this.gravityAcc = 0;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.lowestY = 0;
      this.lastWasRotation = false;
      this.lastKickTST = false;
    }

    // ---- queries -------------------------------------------------------

    cellsOf(piece, rot = piece.rot, x = piece.x, y = piece.y) {
      return SHAPES[piece.type][rot].map(([cx, cy]) => [x + cx, y + cy]);
    }

    isOccupied(x, y) {
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y < 0) return false;
      return this.board[y][x] !== 0;
    }

    collides(type, rot, x, y) {
      const cells = SHAPES[type][rot];
      for (let i = 0; i < cells.length; i++) {
        if (this.isOccupied(x + cells[i][0], y + cells[i][1])) return true;
      }
      return false;
    }

    isGrounded() {
      const p = this.active;
      return !!p && this.collides(p.type, p.rot, p.x, p.y + 1);
    }

    ghostY() {
      const p = this.active;
      if (!p) return 0;
      let y = p.y;
      while (!this.collides(p.type, p.rot, p.x, y + 1)) y++;
      return y;
    }

    canControl() {
      return this.state === 'playing' && this.active !== null;
    }

    gravityLevel() {
      return Math.min(this.level, this.rules.maxGravityLevel);
    }

    /** Height of the stack in rows, measured from the floor. */
    stackHeight() {
      for (let y = 0; y < ROWS; y++) {
        if (this.board[y].some((v) => v !== 0)) return ROWS - y;
      }
      return 0;
    }

    /** Goal progress for HUDs: remaining lines (sprint) or time (ultra). */
    remainingTime() {
      return this.rules.timeLimit ? Math.max(0, this.rules.timeLimit - this.time) : 0;
    }

    // ---- lifecycle -----------------------------------------------------

    fillQueue() {
      while (this.queue.length < Math.max(this.previewCount, 1) + 1) this.queue.push(this.nextFromBag());
    }

    start() {
      if (this.state !== 'ready') return false;
      this.state = 'playing';
      this.events.push({ type: 'start' });
      this.spawnNext();
      return true;
    }

    spawnNext() {
      const type = this.queue.shift();
      this.fillQueue();
      return this.spawn(type);
    }

    spawn(type) {
      if (this.collides(type, 0, SPAWN_X, SPAWN_Y)) {
        // Block out. Zen mode clears the field and carries on.
        if (!this.topOut('blockout')) return false;
      }
      const piece = { type, rot: 0, x: SPAWN_X, y: SPAWN_Y };
      if (!this.collides(type, 0, piece.x, piece.y + 1)) piece.y += 1;
      this.active = piece;
      this.gravityAcc = 0;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.lowestY = piece.y;
      this.lastWasRotation = false;
      this.lastKickTST = false;
      this.events.push({ type: 'spawn', piece: type });
      return true;
    }

    /** Returns true if play continues (Zen), false if the game ended. */
    topOut(reason) {
      if (!this.rules.topOut) {
        const snapshot = this.board.map((row) => row.slice());
        this.board = makeBoard();
        this.combo = -1;
        this.b2b = -1;
        this.stats.zenResets++;
        this.events.push({ type: 'zenReset', board: snapshot });
        return true;
      }
      this.finish('topout', reason);
      return false;
    }

    finish(result, detail) {
      if (this.state !== 'playing') return;
      this.state = result === 'topout' ? 'over' : 'won';
      this.endReason = result;
      this.active = null;
      this.events.push({ type: 'gameEnd', result, detail: detail || null });
    }

    // ---- per-frame update ---------------------------------------------

    update(dt, softDrop = false) {
      if (this.state !== 'playing') return;
      this.time += dt;
      if (this.rules.timeLimit && this.time >= this.rules.timeLimit) {
        this.time = this.rules.timeLimit;
        this.finish('timeup');
        return;
      }
      if (!this.active) return;

      const gravity = 1 / msPerRow(this.gravityLevel());
      let speed = gravity;
      const soft = !!softDrop;
      if (soft) {
        if (!isFinite(this.softDropFactor)) this.sonicDrop(true);
        else speed = gravity * Math.max(1, this.softDropFactor);
      }

      this.gravityAcc += dt * speed;
      if (this.gravityAcc >= 1) {
        let rows = Math.floor(this.gravityAcc);
        this.gravityAcc -= rows;
        while (rows-- > 0) {
          if (!this.stepDown(soft)) {
            this.gravityAcc = 0;
            break;
          }
        }
      }

      if (this.active && this.isGrounded()) {
        this.lockTimer += dt;
        if (this.lockTimer >= this.lockDelay || this.lockResets >= this.maxLockResets) this.lock();
      }
    }

    // ---- player actions ------------------------------------------------

    stepDown(soft) {
      const p = this.active;
      if (!p || this.collides(p.type, p.rot, p.x, p.y + 1)) return false;
      p.y++;
      this.lastWasRotation = false;
      if (soft) this.score += 1;
      this.trackLowest();
      if (this.isGrounded()) this.events.push({ type: 'land', piece: p.type, soft });
      return true;
    }

    /** Instant soft drop to the floor without locking (infinite soft drop). */
    sonicDrop(soft) {
      const p = this.active;
      if (!p) return 0;
      let d = 0;
      while (!this.collides(p.type, p.rot, p.x, p.y + 1)) {
        p.y++;
        d++;
      }
      if (d > 0) {
        this.lastWasRotation = false;
        if (soft) this.score += d;
        this.trackLowest();
        this.events.push({ type: 'land', piece: p.type, soft: true });
      }
      return d;
    }

    trackLowest() {
      const p = this.active;
      if (p.y > this.lowestY) {
        this.lowestY = p.y;
        this.lockResets = 0;
        this.lockTimer = 0;
      }
    }

    afterManipulation(wasGrounded) {
      const grounded = this.isGrounded();
      this.trackLowest();
      if (wasGrounded || grounded) {
        if (this.lockResets < this.maxLockResets) {
          this.lockTimer = 0;
          this.lockResets++;
        }
      }
      if (grounded && !wasGrounded) this.events.push({ type: 'land', piece: this.active.type, soft: false });
    }

    move(dx) {
      if (!this.canControl()) return false;
      const p = this.active;
      if (this.collides(p.type, p.rot, p.x + dx, p.y)) return false;
      const wasGrounded = this.isGrounded();
      p.x += dx;
      this.lastWasRotation = false;
      this.afterManipulation(wasGrounded);
      this.events.push({ type: 'move', dx });
      return true;
    }

    /** One row of player-driven soft drop (touch drags). */
    softDrop() {
      if (!this.canControl()) return false;
      return this.stepDown(true);
    }

    /** dir: 1 = clockwise, -1 = counter-clockwise, 2 = 180°. */
    rotate(dir) {
      if (!this.canControl()) return false;
      const p = this.active;
      if (p.type === 'O') return false;
      const turn = dir === 2 ? 2 : dir === -1 ? 3 : 1;
      const from = p.rot;
      const to = (from + turn) % 4;
      const table = dir === 2 ? KICKS_180 : p.type === 'I' ? KICKS_I : KICKS_JLSTZ;
      const kicks = table[from + '>' + to];
      const wasGrounded = this.isGrounded();
      for (let i = 0; i < kicks.length; i++) {
        const nx = p.x + kicks[i][0];
        const ny = p.y + kicks[i][1];
        if (!this.collides(p.type, to, nx, ny)) {
          p.x = nx;
          p.y = ny;
          p.rot = to;
          this.lastWasRotation = true;
          this.lastKickTST = dir !== 2 && i === 4;
          this.afterManipulation(wasGrounded);
          this.events.push({ type: 'rotate', dir, kick: i, tspin: this.detectTSpin() });
          return true;
        }
      }
      return false;
    }

    hardDrop() {
      if (!this.canControl()) return false;
      const p = this.active;
      const fromY = p.y;
      while (!this.collides(p.type, p.rot, p.x, p.y + 1)) p.y++;
      const distance = p.y - fromY;
      if (distance > 0) this.lastWasRotation = false;
      this.score += distance * 2;
      this.events.push({
        type: 'hardDrop',
        piece: p.type,
        distance,
        fromCells: this.cellsOf(p, p.rot, p.x, fromY),
        cells: this.cellsOf(p),
      });
      this.lock();
      return true;
    }

    hold() {
      if (!this.canControl() || this.holdUsed) return false;
      const current = this.active.type;
      const swapIn = this.holdType;
      this.active = null;
      this.holdType = current;
      this.holdUsed = true;
      this.stats.holds++;
      this.events.push({ type: 'hold', piece: current });
      if (swapIn) this.spawn(swapIn);
      else this.spawnNext();
      return true;
    }

    // ---- locking & scoring --------------------------------------------

    /** 'none' | 'mini' | 'full' for the active piece in its current spot. */
    detectTSpin() {
      const p = this.active;
      if (!p || p.type !== 'T' || !this.lastWasRotation) return 'none';
      const cx = p.x + 1;
      const cy = p.y + 1;
      const corners = [
        this.isOccupied(cx - 1, cy - 1),
        this.isOccupied(cx + 1, cy - 1),
        this.isOccupied(cx + 1, cy + 1),
        this.isOccupied(cx - 1, cy + 1),
      ];
      const filled = corners.filter(Boolean).length;
      if (filled < 3) return 'none';
      const [a, b] = T_FRONT_CORNERS[p.rot];
      if ((corners[a] && corners[b]) || this.lastKickTST) return 'full';
      return 'mini';
    }

    lock() {
      const p = this.active;
      if (!p) return;
      const tspin = this.detectTSpin();
      const cells = this.cellsOf(p);
      let allHidden = true;
      for (const [x, y] of cells) {
        this.board[y][x] = PIECE_ID[p.type];
        if (y >= HIDDEN_ROWS) allHidden = false;
      }
      this.active = null;
      this.holdUsed = false;
      this.stats.pieces++;
      this.events.push({ type: 'lock', piece: p.type, cells, tspin });

      const fullRows = [];
      for (let y = 0; y < ROWS; y++) {
        if (this.board[y].every((v) => v !== 0)) fullRows.push(y);
      }
      const clearedCells = fullRows.map((y) => this.board[y].slice());
      if (fullRows.length) {
        const keep = this.board.filter((_, y) => fullRows.indexOf(y) === -1);
        while (keep.length < ROWS) keep.unshift(new Array(COLS).fill(0));
        this.board = keep;
      }

      this.applyScore(fullRows, clearedCells, tspin, p.type);

      if (this.state !== 'playing') return;
      if (allHidden && fullRows.length === 0) {
        // Lock out: the piece settled entirely above the visible field.
        if (!this.topOut('lockout')) return;
      }
      if (this.rules.goalLines && this.lines >= this.rules.goalLines) {
        this.finish('cleared');
        return;
      }
      this.spawnNext();
    }

    applyScore(rows, rowCells, tspin, piece) {
      const n = rows.length;
      const level = this.level;
      const s = this.stats;
      let points = 0;
      let difficult = false;

      if (tspin === 'full') {
        points = TSPIN_POINTS[n] * level;
        difficult = n > 0;
        if (n > 0) s.tspins++;
        if (n === 1) s.tspinSingles++;
        else if (n === 2) s.tspinDoubles++;
        else if (n === 3) s.tspinTriples++;
      } else if (tspin === 'mini') {
        points = TSPIN_MINI_POINTS[n] * level;
        difficult = n > 0;
        if (n > 0) s.tspinMinis++;
      } else {
        points = LINE_POINTS[n] * level;
        difficult = n === 4;
        if (n === 1) s.singles++;
        else if (n === 2) s.doubles++;
        else if (n === 3) s.triples++;
        else if (n === 4) s.tetrises++;
      }

      let b2bBonus = false;
      if (n > 0) {
        if (difficult) {
          this.b2b++;
          if (this.b2b >= 1) {
            points = Math.floor(points * 1.5);
            b2bBonus = true;
          }
          s.maxB2B = Math.max(s.maxB2B, this.b2b);
        } else {
          this.b2b = -1;
        }
        this.combo++;
        if (this.combo >= 1) points += 50 * this.combo * level;
        s.maxCombo = Math.max(s.maxCombo, this.combo);
      } else {
        this.combo = -1;
      }

      let perfectClear = false;
      if (n > 0 && this.board.every((row) => row.every((v) => v === 0))) {
        perfectClear = true;
        s.perfectClears++;
        points += (n === 4 && b2bBonus ? PERFECT_CLEAR_B2B_TETRIS : PERFECT_CLEAR_POINTS[n]) * level;
      }

      this.score += points;
      this.lines += n;

      if (n > 0 || tspin !== 'none') {
        this.events.push({
          type: 'clear',
          lines: n,
          rows,
          rowCells,
          tspin,
          piece,
          b2b: b2bBonus,
          b2bCount: this.b2b,
          combo: this.combo,
          perfectClear,
          points,
        });
      }

      if (this.rules.levelUp && n > 0) {
        const newLevel = this.startLevel + Math.floor(this.lines / 10);
        if (newLevel > this.level) {
          this.level = newLevel;
          this.events.push({ type: 'levelUp', level: newLevel });
        }
      }
    }

    drainEvents() {
      const out = this.events;
      this.events = [];
      return out;
    }
  }

  return {
    COLS,
    ROWS,
    VISIBLE_ROWS,
    HIDDEN_ROWS,
    SPAWN_X,
    SPAWN_Y,
    PIECE_TYPES,
    PIECE_ID,
    ID_PIECE,
    SHAPES,
    KICKS_JLSTZ,
    KICKS_I,
    KICKS_180,
    MODES,
    msPerRow,
    mulberry32,
    createBag,
    Game,
  };
});
