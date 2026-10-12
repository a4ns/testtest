/*
 * Canvas rendering: glass tiles (pre-rendered per colour), the playfield with
 * ghost/active piece, line-clear shatter + collapse animation, hard-drop
 * trails, particles, the hold/next previews and the block-built logo.
 */
(function (root) {
  'use strict';

  const E = root.TetrisEngine;
  const { COLS, ROWS, HIDDEN_ROWS, VISIBLE_ROWS, SHAPES } = E;

  const EXTRA_TOP = 2; // spawn-zone rows drawn above the field
  const FIRST_ROW = HIDDEN_ROWS - EXTRA_TOP;

  // Apple system colours (dark appearance).
  const COLORS = {
    I: '#64D2FF',
    J: '#0A84FF',
    L: '#FF9F0A',
    O: '#FFD60A',
    S: '#30D158',
    T: '#BF5AF2',
    Z: '#FF453A',
    G: '#A3A3B5',
  };
  const ID_KEY = [null, 'I', 'J', 'L', 'O', 'S', 'T', 'Z', 'G'];

  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')';
  }
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeOutBack = (t) => {
    const c1 = 1.2;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };

  // ---- sprites -----------------------------------------------------------

  function makeTile(hex, s, skin) {
    if (skin === 'crystal') return makeCrystal(hex, s);
    if (skin === 'neon') return makeNeon(hex, s);
    if (skin === 'pearl') return makePearl(hex, s);
    if (skin === 'gilded') return makeGilded(hex, s);
    if (skin === 'bubble') return makeBubble(hex, s);
    if (skin === 'prism') return makePrism(hex, s);
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.05);
    const x = inset;
    const y = inset;
    const w = s - inset * 2;
    const h = w;
    const r = w * 0.27;

    roundRect(g, x, y, w, h, r);
    const body = g.createLinearGradient(x, y, x + w * 0.35, y + h);
    body.addColorStop(0, rgba(mix(rgb, WHITE, 0.4), 0.97));
    body.addColorStop(0.5, rgba(rgb, 0.9));
    body.addColorStop(1, rgba(mix(rgb, BLACK, 0.3), 0.95));
    g.fillStyle = body;
    g.fill();

    g.save();
    roundRect(g, x, y, w, h, r);
    g.clip();
    // Light gathering at the bottom after passing through the glass.
    const cg = g.createRadialGradient(x + w * 0.55, y + h * 1.08, 0, x + w * 0.55, y + h * 1.08, w * 0.85);
    cg.addColorStop(0, rgba(mix(rgb, WHITE, 0.75), 0.65));
    cg.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = cg;
    g.fillRect(x, y, w, h);
    // Top sheen.
    const sh = g.createLinearGradient(0, y, 0, y + h * 0.5);
    sh.addColorStop(0, 'rgba(255,255,255,0.62)');
    sh.addColorStop(1, 'rgba(255,255,255,0.02)');
    roundRect(g, x + w * 0.1, y + h * 0.07, w * 0.8, h * 0.4, r * 0.7);
    g.fillStyle = sh;
    g.fill();
    g.restore();

    // Rim light: bright where light enters (top-left) and exits (bottom-right).
    const lw = Math.max(1, s * 0.045);
    roundRect(g, x + lw / 2, y + lw / 2, w - lw, h - lw, r - lw / 2);
    const rim = g.createLinearGradient(x, y, x + w, y + h);
    rim.addColorStop(0, 'rgba(255,255,255,0.95)');
    rim.addColorStop(0.38, 'rgba(255,255,255,0.2)');
    rim.addColorStop(0.68, 'rgba(255,255,255,0.08)');
    rim.addColorStop(1, 'rgba(255,255,255,0.45)');
    g.lineWidth = lw;
    g.strokeStyle = rim;
    g.stroke();

    const gx = x + w * 0.27;
    const gy = y + h * 0.23;
    const gr = w * 0.13;
    const gl = g.createRadialGradient(gx, gy, 0, gx, gy, gr);
    gl.addColorStop(0, 'rgba(255,255,255,0.95)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
    return c;
  }

  // Crystal: clear cut glass with a table facet and bright bevels.
  function makeCrystal(hex, s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.05);
    const x = inset;
    const y = inset;
    const w = s - inset * 2;
    const r = w * 0.16;
    roundRect(g, x, y, w, w, r);
    const body = g.createLinearGradient(x, y, x + w, y + w);
    body.addColorStop(0, rgba(mix(rgb, WHITE, 0.6), 0.75));
    body.addColorStop(0.5, rgba(rgb, 0.55));
    body.addColorStop(1, rgba(mix(rgb, BLACK, 0.2), 0.75));
    g.fillStyle = body;
    g.fill();
    g.save();
    roundRect(g, x, y, w, w, r);
    g.clip();
    const t = w * 0.22;
    // Bevels: light top/left, shade bottom/right.
    g.fillStyle = 'rgba(255,255,255,0.42)';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + w, y);
    g.lineTo(x + w - t, y + t);
    g.lineTo(x + t, y + t);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + t, y + t);
    g.lineTo(x + t, y + w - t);
    g.lineTo(x, y + w);
    g.closePath();
    g.fill();
    g.fillStyle = rgba(mix(rgb, BLACK, 0.45), 0.35);
    g.beginPath();
    g.moveTo(x + w, y + w);
    g.lineTo(x, y + w);
    g.lineTo(x + t, y + w - t);
    g.lineTo(x + w - t, y + w - t);
    g.closePath();
    g.fill();
    // Table facet with a diagonal flash.
    const flash = g.createLinearGradient(x + t, y + t, x + w - t, y + w - t);
    flash.addColorStop(0, 'rgba(255,255,255,0.35)');
    flash.addColorStop(0.45, 'rgba(255,255,255,0.05)');
    flash.addColorStop(0.55, 'rgba(255,255,255,0.28)');
    flash.addColorStop(1, 'rgba(255,255,255,0.02)');
    g.fillStyle = flash;
    g.fillRect(x + t, y + t, w - 2 * t, w - 2 * t);
    g.restore();
    const lw = Math.max(1, s * 0.04);
    roundRect(g, x + lw / 2, y + lw / 2, w - lw, w - lw, r);
    g.lineWidth = lw;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.stroke();
    return c;
  }

  // Neon: a dark glass core lit by a glowing coloured tube.
  function makeNeon(hex, s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(2, s * 0.12);
    const w = s - inset * 2;
    const r = w * 0.28;
    roundRect(g, inset, inset, w, w, r);
    const core = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, w * 0.7);
    core.addColorStop(0, rgba(mix(rgb, BLACK, 0.55), 0.92));
    core.addColorStop(1, rgba(mix(rgb, BLACK, 0.8), 0.95));
    g.fillStyle = core;
    g.fill();
    g.save();
    g.shadowColor = rgba(rgb, 0.95);
    g.shadowBlur = s * 0.22;
    g.lineWidth = Math.max(1.5, s * 0.08);
    g.strokeStyle = rgba(mix(rgb, WHITE, 0.25), 1);
    roundRect(g, inset, inset, w, w, r);
    g.stroke();
    g.restore();
    g.lineWidth = Math.max(1, s * 0.025);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    roundRect(g, inset + s * 0.02, inset + s * 0.02, w - s * 0.04, w - s * 0.04, r * 0.9);
    g.stroke();
    return c;
  }

  // Pearl: an opaque pastel bead with an iridescent sheen.
  function makePearl(hex, s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.06);
    const w = s - inset * 2;
    const r = w * 0.38;
    roundRect(g, inset, inset, w, w, r);
    const body = g.createRadialGradient(inset + w * 0.35, inset + w * 0.3, 0, s / 2, s / 2, w * 0.75);
    body.addColorStop(0, rgba(mix(rgb, WHITE, 0.85), 1));
    body.addColorStop(0.55, rgba(mix(rgb, WHITE, 0.45), 1));
    body.addColorStop(1, rgba(mix(rgb, BLACK, 0.12), 1));
    g.fillStyle = body;
    g.fill();
    g.save();
    roundRect(g, inset, inset, w, w, r);
    g.clip();
    const iri = g.createLinearGradient(inset, inset + w, inset + w, inset);
    iri.addColorStop(0, 'rgba(255,140,220,0.28)');
    iri.addColorStop(0.5, 'rgba(140,255,240,0.18)');
    iri.addColorStop(1, 'rgba(160,170,255,0.28)');
    g.fillStyle = iri;
    g.fillRect(inset, inset, w, w);
    g.restore();
    const gx = inset + w * 0.32;
    const gy = inset + w * 0.28;
    const gl = g.createRadialGradient(gx, gy, 0, gx, gy, w * 0.22);
    gl.addColorStop(0, 'rgba(255,255,255,0.95)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.fillRect(inset, inset, w, w);
    return c;
  }

  // Gilded: coloured glass set in a polished gold bezel.
  function makeGilded(hex, s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.05);
    const w = s - inset * 2;
    const r = w * 0.22;
    const gold = g.createLinearGradient(inset, inset, inset + w, inset + w);
    gold.addColorStop(0, '#fff6c4');
    gold.addColorStop(0.3, '#f2c14e');
    gold.addColorStop(0.55, '#a8701a');
    gold.addColorStop(0.8, '#f7d77a');
    gold.addColorStop(1, '#8a5a12');
    roundRect(g, inset, inset, w, w, r);
    g.fillStyle = gold;
    g.fill();
    const b = Math.max(1.5, w * 0.14);
    const iw = w - 2 * b;
    roundRect(g, inset + b, inset + b, iw, iw, r * 0.6);
    const body = g.createLinearGradient(inset + b, inset + b, inset + b + iw * 0.4, inset + b + iw);
    body.addColorStop(0, rgba(mix(rgb, WHITE, 0.45), 1));
    body.addColorStop(0.55, rgba(rgb, 1));
    body.addColorStop(1, rgba(mix(rgb, BLACK, 0.35), 1));
    g.fillStyle = body;
    g.fill();
    g.save();
    roundRect(g, inset + b, inset + b, iw, iw, r * 0.6);
    g.clip();
    const sh = g.createLinearGradient(0, inset + b, 0, inset + b + iw * 0.5);
    sh.addColorStop(0, 'rgba(255,255,255,0.55)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sh;
    g.fillRect(inset + b, inset + b, iw, iw * 0.5);
    g.restore();
    const gx = inset + w * 0.24;
    const gy = inset + w * 0.2;
    const gl = g.createRadialGradient(gx, gy, 0, gx, gy, w * 0.16);
    gl.addColorStop(0, 'rgba(255,255,240,1)');
    gl.addColorStop(1, 'rgba(255,255,240,0)');
    g.fillStyle = gl;
    g.fillRect(inset, inset, w, w);
    return c;
  }

  // Bubble: a thin, clear film with an iridescent swirl and a coloured rim.
  function makeBubble(hex, s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.05);
    const w = s - inset * 2;
    const r = w * 0.44;
    roundRect(g, inset, inset, w, w, r);
    const body = g.createRadialGradient(s / 2, s / 2, w * 0.15, s / 2, s / 2, w * 0.62);
    body.addColorStop(0, rgba(rgb, 0.16));
    body.addColorStop(0.75, rgba(rgb, 0.42));
    body.addColorStop(1, rgba(mix(rgb, WHITE, 0.3), 0.85));
    g.fillStyle = body;
    g.fill();
    g.save();
    roundRect(g, inset, inset, w, w, r);
    g.clip();
    const film = g.createLinearGradient(inset, inset + w, inset + w, inset);
    film.addColorStop(0, 'rgba(255,120,200,0.22)');
    film.addColorStop(0.35, 'rgba(255,230,120,0.12)');
    film.addColorStop(0.65, 'rgba(120,255,220,0.2)');
    film.addColorStop(1, 'rgba(140,150,255,0.24)');
    g.fillStyle = film;
    g.fillRect(inset, inset, w, w);
    g.restore();
    const lw = Math.max(1, s * 0.05);
    roundRect(g, inset + lw / 2, inset + lw / 2, w - lw, w - lw, r - lw / 2);
    g.lineWidth = lw;
    g.strokeStyle = rgba(mix(rgb, WHITE, 0.5), 0.95);
    g.stroke();
    // A curved window reflection and a small catchlight.
    g.save();
    g.beginPath();
    g.arc(inset + w * 0.42, inset + w * 0.42, w * 0.3, Math.PI * 1.05, Math.PI * 1.55);
    g.lineWidth = Math.max(1, w * 0.07);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.stroke();
    g.restore();
    const gx = inset + w * 0.72;
    const gy = inset + w * 0.74;
    const gl = g.createRadialGradient(gx, gy, 0, gx, gy, w * 0.08);
    gl.addColorStop(0, 'rgba(255,255,255,0.9)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.fillRect(inset, inset, w, w);
    return c;
  }

  // Prism: glass that splits light, with a spectrum running round its edge.
  function makePrism(hex, s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.05);
    const w = s - inset * 2;
    const r = w * 0.2;
    roundRect(g, inset, inset, w, w, r);
    const body = g.createLinearGradient(inset, inset, inset + w, inset + w);
    body.addColorStop(0, rgba(mix(rgb, WHITE, 0.55), 0.9));
    body.addColorStop(0.5, rgba(rgb, 0.78));
    body.addColorStop(1, rgba(mix(rgb, BLACK, 0.3), 0.9));
    g.fillStyle = body;
    g.fill();
    g.save();
    roundRect(g, inset, inset, w, w, r);
    g.clip();
    // A band of split light crossing the block.
    const band = g.createLinearGradient(inset, inset + w * 0.2, inset + w, inset + w * 0.8);
    const spec = ['255,80,80', '255,200,60', '120,255,120', '80,220,255', '170,110,255'];
    band.addColorStop(0, 'rgba(255,255,255,0)');
    spec.forEach((col, i) => band.addColorStop(0.3 + i * 0.08, 'rgba(' + col + ',0.38)'));
    band.addColorStop(0.75, 'rgba(255,255,255,0)');
    g.fillStyle = band;
    g.fillRect(inset, inset, w, w);
    g.restore();
    const lw = Math.max(1.2, s * 0.06);
    roundRect(g, inset + lw / 2, inset + lw / 2, w - lw, w - lw, r - lw / 2);
    const rim = g.createLinearGradient(inset, inset, inset + w, inset + w);
    rim.addColorStop(0, '#ffffff');
    rim.addColorStop(0.2, '#ff7a7a');
    rim.addColorStop(0.38, '#ffd166');
    rim.addColorStop(0.55, '#7dffa0');
    rim.addColorStop(0.72, '#6ad8ff');
    rim.addColorStop(0.9, '#b48cff');
    rim.addColorStop(1, '#ffffff');
    g.lineWidth = lw;
    g.strokeStyle = rim;
    g.stroke();
    const gx = inset + w * 0.26;
    const gy = inset + w * 0.22;
    const gl = g.createRadialGradient(gx, gy, 0, gx, gy, w * 0.14);
    gl.addColorStop(0, 'rgba(255,255,255,0.95)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.fillRect(inset, inset, w, w);
    return c;
  }

  /** On pale glass, a darker edge keeps light pieces (yellow, cyan) apart
   * from the board by more than hue alone. */
  function outlineTile(c, hex, s) {
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.05);
    const lw = Math.max(1, s * 0.04);
    roundRect(g, inset + lw / 2, inset + lw / 2, s - inset * 2 - lw, s - inset * 2 - lw, (s - inset * 2) * 0.25);
    g.lineWidth = lw;
    g.strokeStyle = rgba(mix(rgb, BLACK, 0.5), 0.55);
    g.stroke();
  }

  function makeGhost(hex, s, light) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const inset = Math.max(1, s * 0.07);
    const w = s - inset * 2;
    const r = w * 0.27;
    roundRect(g, inset, inset, w, w, r);
    g.fillStyle = rgba(light ? mix(rgb, BLACK, 0.2) : rgb, light ? 0.22 : 0.14);
    g.fill();
    const lw = Math.max(1, s * 0.05);
    roundRect(g, inset + lw / 2, inset + lw / 2, w - lw, w - lw, r - lw / 2);
    g.lineWidth = lw;
    g.strokeStyle = rgba(light ? mix(rgb, BLACK, 0.5) : mix(rgb, WHITE, 0.25), light ? 0.9 : 0.6);
    g.stroke();
    return c;
  }

  function makeGlow(hex, s) {
    const size = s * 3;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const rgb = hexToRgb(hex);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, rgba(rgb, 0.42));
    grad.addColorStop(0.45, rgba(rgb, 0.14));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function makeFlash(s) {
    const c = makeCanvas(s, s);
    const g = c.getContext('2d');
    const inset = Math.max(1, s * 0.05);
    roundRect(g, inset, inset, s - inset * 2, s - inset * 2, s * 0.25);
    g.fillStyle = 'rgba(255,255,255,1)';
    g.fill();
    return c;
  }

  class SpriteSet {
    constructor() {
      this.size = 0;
      this.light = null;
      this.skin = 'jelly';
      this.builtSkin = null;
      this.tiles = {};
      this.ghosts = {};
      this.glows = {};
      this.flash = null;
    }
    build(size, light) {
      if (size === this.size && light === this.light && this.skin === this.builtSkin) return;
      this.size = size;
      this.light = light;
      this.builtSkin = this.skin;
      for (const k of Object.keys(COLORS)) {
        this.tiles[k] = makeTile(COLORS[k], size, this.skin);
        if (light) outlineTile(this.tiles[k], COLORS[k], size);
        this.ghosts[k] = makeGhost(COLORS[k], size, light);
        this.glows[k] = makeGlow(COLORS[k], size);
      }
      this.flash = makeFlash(size);
    }
  }

  const sprites = new SpriteSet();

  // ---- playfield -------------------------------------------------------

  const MAX_PARTICLES = 700;
  const CLEAR_MS = 280;
  const COLLAPSE_DELAY = 30;
  const COLLAPSE_MS = 140;

  class BoardRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cell = 24;
      this.dpr = 1;
      this.light = false;
      this.wells = null;
      this.reset();
    }

    reset() {
      this.particles = [];
      this.trails = [];
      this.flashes = [];
      this.clearing = [];
      this.collapse = null;
      this.gameOverAt = 0;
      this.whiteFlash = null;
    }

    resize(cell, dpr, light) {
      this.cell = cell;
      this.dpr = dpr;
      this.light = light;
      const W = COLS * cell;
      const H = (VISIBLE_ROWS + EXTRA_TOP) * cell;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
      sprites.build(Math.round(cell * dpr), light);
      this.wells = this.buildWells();
    }

    buildWells() {
      const c = this.cell;
      const d = this.dpr;
      const cv = makeCanvas(COLS * c * d, VISIBLE_ROWS * c * d);
      const g = cv.getContext('2d');
      g.scale(d, d);
      const inset = Math.max(1, c * 0.09);
      g.fillStyle = this.light ? 'rgba(30,40,90,0.055)' : 'rgba(255,255,255,0.035)';
      for (let y = 0; y < VISIBLE_ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          roundRect(g, x * c + inset, y * c + inset, c - inset * 2, c - inset * 2, c * 0.22);
          g.fill();
        }
      }
      return cv;
    }

    /** Visual position of board row y, offset while rows are collapsing. */
    rowOffset(y, now) {
      const col = this.collapse;
      if (!col) return 0;
      const t = (now - col.start - COLLAPSE_DELAY) / COLLAPSE_MS;
      if (t >= 1) return 0;
      return col.shift[y] * (1 - (t <= 0 ? 0 : easeOutBack(t)));
    }

    // -- event hooks ----------------------------------------------------

    onClear(ev, now, opts) {
      const rows = ev.rows;
      if (!rows.length) return;
      const shift = new Float32Array(ROWS);
      // Keep any collapse still in flight continuous.
      const prev = new Float32Array(ROWS);
      if (this.collapse) for (let y = 0; y < ROWS; y++) prev[y] = this.rowOffset(y, now);
      for (let o = 0; o < ROWS; o++) {
        if (rows.indexOf(o) !== -1) continue;
        let s = 0;
        for (const r of rows) if (r > o) s++;
        shift[o + s] = s + prev[o];
      }
      this.collapse = { start: now, shift };
      const c = this.cell;
      const big = ev.lines >= 4 || ev.tspin !== 'none' || ev.perfectClear;
      rows.forEach((y, i) => {
        const cells = ev.rowCells[i];
        this.clearing.push({ y: y - prev[y], cells, start: now });
        if (!opts.particles) return;
        for (let x = 0; x < COLS; x++) {
          const key = ID_KEY[cells[x]] || 'G';
          const cx = (x + 0.5) * c;
          const cy = (y - FIRST_ROW + 0.5) * c;
          this.shards(cx, cy, key, big ? 4 : 3, (x - 4.5) / 4.5, big ? 1.25 : 1);
        }
        this.sparks(COLS * c * 0.5, (y - FIRST_ROW + 0.5) * c, big ? 26 : 12, COLS * c * 0.5);
      });
      if (ev.perfectClear) this.whiteFlash = { start: now, ms: 650, a: 0.5 };
      else if (big) this.whiteFlash = { start: now, ms: 260, a: 0.18 };
    }

    onHardDrop(ev, now, opts) {
      this.trails.push({ from: ev.fromCells, to: ev.cells, key: ev.piece, start: now });
      if (opts.particles && ev.distance > 1) {
        const c = this.cell;
        let maxY = -1;
        for (const [, y] of ev.cells) maxY = Math.max(maxY, y);
        for (const [x, y] of ev.cells) {
          if (y !== maxY) continue;
          this.sparks((x + 0.5) * c, (y - FIRST_ROW + 1) * c, 3, c * 0.4, true);
        }
      }
    }

    onLock(ev, now) {
      this.flashes.push({ cells: ev.cells, start: now });
    }

    onZenReset(ev, now, opts) {
      const c = this.cell;
      if (opts.particles) {
        let n = 0;
        for (let y = FIRST_ROW; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            const v = ev.board[y][x];
            if (!v || (n++ & 1)) continue;
            this.shards((x + 0.5) * c, (y - FIRST_ROW + 0.5) * c, ID_KEY[v], 2, (x - 4.5) / 4.5, 1.1);
          }
        }
      }
      this.whiteFlash = { start: now, ms: 700, a: 0.45 };
    }

    startGameOver(now) {
      this.gameOverAt = now;
    }

    // -- particles ------------------------------------------------------

    shards(x, y, key, count, bias, power) {
      const c = this.cell;
      for (let i = 0; i < count; i++) {
        this.particles.push({
          kind: 0,
          x: x + (Math.random() - 0.5) * c * 0.6,
          y: y + (Math.random() - 0.5) * c * 0.6,
          vx: (bias * 7 + (Math.random() - 0.5) * 9) * c * 0.6 * power,
          vy: -(2 + Math.random() * 9) * c * power,
          g: c * 30,
          life: 0,
          max: 0.55 + Math.random() * 0.6,
          size: c * (0.2 + Math.random() * 0.3),
          rot: Math.random() * 6.283,
          vr: (Math.random() - 0.5) * 14,
          key,
        });
      }
      this.trimParticles();
    }

    sparks(x, y, count, spread, up) {
      const c = this.cell;
      for (let i = 0; i < count; i++) {
        this.particles.push({
          kind: 1,
          x: x + (Math.random() - 0.5) * spread * 2,
          y: y + (Math.random() - 0.5) * c * 0.4,
          vx: (Math.random() - 0.5) * c * 6,
          vy: up ? -(1 + Math.random() * 4) * c : (Math.random() - 0.7) * c * 8,
          g: c * 8,
          life: 0,
          max: 0.35 + Math.random() * 0.5,
          size: c * (0.04 + Math.random() * 0.07),
          rot: 0,
          vr: 0,
          key: null,
        });
      }
      this.trimParticles();
    }

    trimParticles() {
      if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }

    get busy() {
      return this.particles.length > 0 || this.clearing.length > 0 || this.trails.length > 0 || this.flashes.length > 0;
    }

    // -- drawing --------------------------------------------------------

    render(game, now, dt, opts) {
      const g = this.ctx;
      const c = this.cell;
      const W = COLS * c;
      const H = (VISIBLE_ROWS + EXTRA_TOP) * c;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      g.imageSmoothingEnabled = true;

      if (opts.grid && this.wells) g.drawImage(this.wells, 0, EXTRA_TOP * c, W, VISIBLE_ROWS * c);

      if (!game) return;

      // Locked stack. Game over turns the stack to frosted grey, bottom-up.
      let greyFrom = ROWS + 1;
      if (this.gameOverAt) {
        const p = clamp01((now - this.gameOverAt) / 1000);
        greyFrom = ROWS - Math.ceil(p * (VISIBLE_ROWS + EXTRA_TOP));
      }
      if (this.collapse && now - this.collapse.start > COLLAPSE_DELAY + COLLAPSE_MS) this.collapse = null;
      // During the game-over animation keep the frozen stack inside the glass.
      const firstDrawn = this.gameOverAt ? HIDDEN_ROWS : FIRST_ROW;
      for (let y = firstDrawn; y < ROWS; y++) {
        const row = game.board[y];
        const vy = (y - FIRST_ROW - this.rowOffset(y, now)) * c;
        for (let x = 0; x < COLS; x++) {
          const v = row[x];
          if (!v) continue;
          const key = y >= greyFrom ? 'G' : ID_KEY[v];
          g.drawImage(sprites.tiles[key], x * c, vy, c, c);
        }
      }

      this.drawClearing(g, now);

      const p = game.active;
      if (p) {
        const cells = SHAPES[p.type][p.rot];
        const bottom = Math.max(...cells.map((q) => q[1]));
        // While rows are still settling, whatever rests on the stack moves
        // with the stack, so the ghost never shows inside it.
        const restOffset = (py) => (this.collapse ? this.rowOffset(Math.min(ROWS - 1, py + bottom + 1), now) : 0);
        if (opts.ghost) {
          const gy = game.ghostY();
          if (gy !== p.y) {
            g.globalAlpha = 1;
            const go = restOffset(gy);
            for (const [cx, cy] of cells) {
              const y = gy + cy;
              if (y < FIRST_ROW) continue;
              g.drawImage(sprites.ghosts[p.type], (p.x + cx) * c, (y - FIRST_ROW - go) * c, c, c);
            }
          }
        }
        const po = game.isGrounded() ? restOffset(p.y) : 0;
        this.drawTrails(g, now);
        // Fade slightly while the lock delay runs out.
        let alpha = 1;
        if (game.isGrounded()) alpha = 1 - 0.38 * clamp01(game.lockTimer / game.lockDelay);
        g.globalAlpha = 0.85 * alpha;
        const glow = sprites.glows[p.type];
        for (const [cx, cy] of cells) {
          const y = p.y + cy;
          if (y < FIRST_ROW) continue;
          g.drawImage(glow, (p.x + cx - 1) * c, (y - FIRST_ROW - 1 - po) * c, c * 3, c * 3);
        }
        g.globalAlpha = alpha;
        for (const [cx, cy] of cells) {
          const y = p.y + cy;
          if (y < FIRST_ROW) continue;
          g.drawImage(sprites.tiles[p.type], (p.x + cx) * c, (y - FIRST_ROW - po) * c, c, c);
        }
        g.globalAlpha = 1;
      } else {
        this.drawTrails(g, now);
      }

      this.drawFlashes(g, now);
      this.drawParticles(g, dt);

      if (this.whiteFlash) {
        const t = (now - this.whiteFlash.start) / this.whiteFlash.ms;
        if (t >= 1) this.whiteFlash = null;
        else {
          g.fillStyle = 'rgba(255,255,255,' + this.whiteFlash.a * (1 - easeOutCubic(t)) + ')';
          g.fillRect(0, EXTRA_TOP * c, W, VISIBLE_ROWS * c);
        }
      }
    }

    drawClearing(g, now) {
      if (!this.clearing.length) return;
      const c = this.cell;
      const W = COLS * c;
      this.clearing = this.clearing.filter((r) => now - r.start < CLEAR_MS);
      for (const r of this.clearing) {
        const t = clamp01((now - r.start) / CLEAR_MS);
        const e = easeOutCubic(t);
        const y0 = (r.y - FIRST_ROW) * c;
        // Cells pop, brighten and shrink away.
        const s = 1 - 0.55 * e;
        g.globalAlpha = 1 - e;
        for (let x = 0; x < COLS; x++) {
          const key = ID_KEY[r.cells[x]] || 'G';
          const size = c * s;
          g.drawImage(sprites.tiles[key], x * c + (c - size) / 2, y0 + (c - size) / 2, size, size);
        }
        g.globalAlpha = (1 - t) * 0.85;
        for (let x = 0; x < COLS; x++) {
          const size = c * s;
          g.drawImage(sprites.flash, x * c + (c - size) / 2, y0 + (c - size) / 2, size, size);
        }
        // A horizontal band of light sweeping out from the centre.
        const band = g.createLinearGradient(0, 0, W, 0);
        const spread = 0.15 + 0.85 * e;
        band.addColorStop(0, 'rgba(255,255,255,0)');
        band.addColorStop(Math.max(0, 0.5 - spread / 2), 'rgba(255,255,255,0)');
        band.addColorStop(0.5, 'rgba(255,255,255,' + 0.9 * (1 - t) + ')');
        band.addColorStop(Math.min(1, 0.5 + spread / 2), 'rgba(255,255,255,0)');
        band.addColorStop(1, 'rgba(255,255,255,0)');
        g.globalAlpha = 1;
        g.fillStyle = band;
        const bh = c * (0.25 + 0.5 * (1 - e));
        g.fillRect(0, y0 + (c - bh) / 2, W, bh);
      }
      g.globalAlpha = 1;
    }

    drawTrails(g, now) {
      if (!this.trails.length) return;
      const c = this.cell;
      this.trails = this.trails.filter((t) => now - t.start < 260);
      for (const tr of this.trails) {
        const t = clamp01((now - tr.start) / 260);
        const rgb = hexToRgb(COLORS[tr.key]);
        const cols = {};
        for (const [x, y] of tr.from) cols[x] = Math.min(cols[x] == null ? y : cols[x], y);
        for (const [x, y] of tr.to) {
          const top = Math.max(cols[x], FIRST_ROW);
          const bottom = y + 1;
          if (bottom - top < 1.5) continue;
          const y0 = (top - FIRST_ROW) * c;
          const y1 = (bottom - FIRST_ROW) * c;
          const grad = g.createLinearGradient(0, y0, 0, y1);
          grad.addColorStop(0, rgba(rgb, 0));
          grad.addColorStop(1, rgba(mix(rgb, WHITE, 0.4), 0.42 * (1 - t)));
          g.fillStyle = grad;
          const w = c * (0.7 - 0.3 * t);
          g.fillRect(x * c + (c - w) / 2, y0, w, y1 - y0);
        }
      }
    }

    drawFlashes(g, now) {
      if (!this.flashes.length) return;
      const c = this.cell;
      this.flashes = this.flashes.filter((f) => now - f.start < 200);
      for (const f of this.flashes) {
        const t = clamp01((now - f.start) / 200);
        g.globalAlpha = 0.6 * (1 - t);
        for (const [x, y] of f.cells) {
          if (y < FIRST_ROW) continue;
          g.drawImage(sprites.flash, x * c, (y - FIRST_ROW) * c, c, c);
        }
      }
      g.globalAlpha = 1;
    }

    drawParticles(g, dt) {
      const ps = this.particles;
      if (!ps.length) return;
      const s = Math.min(dt, 50) / 1000;
      let w = 0;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        p.life += s;
        if (p.life >= p.max) continue;
        p.vy += p.g * s;
        p.vx *= 1 - 0.8 * s;
        p.x += p.vx * s;
        p.y += p.vy * s;
        p.rot += p.vr * s;
        ps[w++] = p;
        const k = p.life / p.max;
        if (p.kind === 0) {
          g.globalAlpha = 1 - k * k;
          g.save();
          g.translate(p.x, p.y);
          g.rotate(p.rot);
          g.drawImage(sprites.tiles[p.key], -p.size / 2, -p.size / 2, p.size, p.size);
          g.restore();
        } else {
          g.globalAlpha = (1 - k) * 0.95;
          g.globalCompositeOperation = 'lighter';
          g.fillStyle = '#ffffff';
          g.beginPath();
          g.arc(p.x, p.y, p.size, 0, 6.283);
          g.fill();
          g.globalCompositeOperation = 'source-over';
        }
      }
      ps.length = w;
      g.globalAlpha = 1;
    }
  }

  // ---- previews --------------------------------------------------------

  function pieceBounds(type) {
    const cells = SHAPES[type][0];
    let minX = 9;
    let maxX = -1;
    let minY = 9;
    let maxY = -1;
    for (const [x, y] of cells) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { cells, minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function drawPiece(g, type, cx, cy, cell, alpha, grey) {
    const b = pieceBounds(type);
    const ox = cx - (b.w * cell) / 2;
    const oy = cy - (b.h * cell) / 2;
    g.globalAlpha = alpha;
    const tile = sprites.tiles[grey ? 'G' : type];
    for (const [x, y] of b.cells) g.drawImage(tile, ox + (x - b.minX) * cell, oy + (y - b.minY) * cell, cell, cell);
    g.globalAlpha = 1;
  }

  class PreviewRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.key = '';
    }
    resize(w, h, dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.key = '';
    }
    begin(key) {
      if (key === this.key) return null;
      this.key = key;
      const g = this.ctx;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      return g;
    }
    drawHold(type, used, cell) {
      const g = this.begin('h' + type + used + cell + sprites.size + sprites.builtSkin);
      if (!g || !type) return;
      drawPiece(g, type, this.w / 2, this.h / 2, cell, used ? 0.35 : 1, used);
    }
    drawQueue(queue, count, cell, horizontal) {
      const items = queue.slice(0, count);
      const g = this.begin('q' + items.join('') + cell + horizontal + sprites.size + sprites.builtSkin);
      if (!g) return;
      // The first piece is a little larger.
      const weights = items.map((_, i) => (i === 0 ? 1.25 : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let pos = 0;
      items.forEach((type, i) => {
        const span = ((horizontal ? this.w : this.h) * weights[i]) / total;
        const size = cell * (i === 0 ? 1 : 0.82);
        const alpha = i === 0 ? 1 : 0.92 - i * 0.07;
        if (horizontal) drawPiece(g, type, pos + span / 2, this.h / 2, size, alpha);
        else drawPiece(g, type, this.w / 2, pos + span / 2, size, alpha);
        pos += span;
      });
    }
  }

  // ---- logo ------------------------------------------------------------

  const LOGO_GLYPHS = {
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    E: ['###', '#..', '##.', '#..', '###'],
    R: ['##.', '#.#', '##.', '#.#', '#.#'],
    I: ['###', '.#.', '.#.', '.#.', '###'],
    S: ['###', '#..', '###', '..#', '###'],
  };
  const LOGO_WORD = [
    ['T', 'Z'],
    ['E', 'L'],
    ['T', 'O'],
    ['R', 'S'],
    ['I', 'I'],
    ['S', 'T'],
  ];

  class LogoRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.blocks = [];
      LOGO_WORD.forEach(([ch, key], li) => {
        LOGO_GLYPHS[ch].forEach((row, y) => {
          for (let x = 0; x < 3; x++) {
            if (row[x] === '#') this.blocks.push({ x: li * 4 + x, y, key, delay: li * 85 + (4 - y) * 45 + x * 20 });
          }
        });
      });
      this.cols = LOGO_WORD.length * 4 - 1;
      this.rows = 5;
      this.start = 0;
      this.cell = 0;
    }
    resize(cell, dpr) {
      this.cell = cell;
      this.dpr = dpr;
      const pad = cell * 0.5;
      this.pad = pad;
      const W = this.cols * cell + pad * 2;
      const H = this.rows * cell + pad * 2;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
    }
    replay(now) {
      this.start = now;
    }
    render(now, reduceMotion) {
      const g = this.ctx;
      const c = this.cell;
      if (!c || !sprites.size) return;
      const W = this.cols * c + this.pad * 2;
      const H = this.rows * c + this.pad * 2;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const t0 = now - this.start;
      for (const b of this.blocks) {
        let k = reduceMotion ? 1 : clamp01((t0 - b.delay) / 520);
        if (k <= 0) continue;
        const drop = (1 - easeOutBack(k)) * -6;
        g.globalAlpha = clamp01(k * 3);
        g.drawImage(sprites.tiles[b.key], this.pad + b.x * c, this.pad + (b.y + drop) * c, c, c);
      }
      g.globalAlpha = 1;
      // A slow specular sweep across the glass letters.
      const period = 5200;
      const ph = ((t0 - 1400) % period) / period;
      if (t0 > 1400 && ph < 0.35 && !reduceMotion) {
        const x = -W * 0.3 + (ph / 0.35) * W * 1.6;
        const grad = g.createLinearGradient(x - c * 3, 0, x + c * 3, H);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
      }
    }
  }

  root.TetrisRenderer = {
    COLORS,
    EXTRA_TOP,
    sprites,
    BoardRenderer,
    PreviewRenderer,
    LogoRenderer,
    drawPiece,
    makeTile,
  };
})(window);
