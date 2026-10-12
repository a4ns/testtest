/*
 * Living wallpaper behind the glass: luminous colour fields and slowly
 * drifting tetromino silhouettes, drawn to a small canvas and scaled up by
 * CSS (the upscale is the blur). Reacts to play: pulses on clears, shifts hue
 * with the level and warms up when the stack is in danger.
 */
(function (root) {
  'use strict';

  const WALLPAPERS = {
    aurora: {
      name: 'Aurora',
      light: false,
      base: ['#070a1f', '#140a33'],
      blobs: ['#4b2bff', '#00c2ff', '#ff2bd1', '#16f2a5', '#7a3dff'],
      ink: '#ffffff',
    },
    sunset: {
      name: 'Sunset',
      light: false,
      base: ['#1a0716', '#2b0a1d'],
      blobs: ['#ff6a3d', '#ff2e7e', '#ffb63d', '#9b2bff', '#ff4d4d'],
      ink: '#ffffff',
    },
    lagoon: {
      name: 'Lagoon',
      light: false,
      base: ['#02121f', '#032433'],
      blobs: ['#00a6ff', '#00ffd0', '#2b5dff', '#6f5cff', '#00ff95'],
      ink: '#ffffff',
    },
    graphite: {
      name: 'Graphite',
      light: false,
      base: ['#0a0a0d', '#15151b'],
      blobs: ['#4a4a5c', '#2f3b52', '#5b4a6e', '#3a4f5a', '#6a6a7e'],
      ink: '#ffffff',
    },
    daylight: {
      name: 'Daylight',
      light: true,
      base: ['#dfe7fb', '#f3e6f7'],
      blobs: ['#6f9bff', '#ff8fcf', '#7fe9ff', '#ffc96b', '#a98bff'],
      ink: '#3a4a8a',
    },
  };

  const SHAPES = [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
  ];

  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  const hsla = (h, s, l, a) => 'hsla(' + (((h % 360) + 360) % 360).toFixed(1) + ',' + s.toFixed(1) + '%,' + l.toFixed(1) + '%,' + a + ')';

  function seeded(i) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  class Wallpaper {
    constructor(canvas, fxCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      // A second, sharper layer holds the floating glass pieces, so the lensing
      // and blur of the UI glass above have crisp edges to bend.
      this.fx = fxCanvas || null;
      this.fxCtx = fxCanvas ? fxCanvas.getContext('2d') : null;
      this.sprites = [];
      this.scale = 0.16;
      this.energy = 0;
      this.danger = 0;
      this.dangerTarget = 0;
      this.hue = 0;
      this.hueTarget = 0;
      this.animated = true;
      this.lastDraw = 0;
      this.set('aurora');
      this.blobs = [];
      for (let i = 0; i < 5; i++) {
        this.blobs.push({
          x: 0.15 + seeded(i) * 0.7,
          y: 0.15 + seeded(i + 10) * 0.7,
          r: 0.38 + seeded(i + 20) * 0.3,
          ax: 0.12 + seeded(i + 30) * 0.18,
          ay: 0.1 + seeded(i + 40) * 0.16,
          sp: 0.00004 + seeded(i + 50) * 0.00006,
          ph: seeded(i + 60) * 6.28,
        });
      }
      this.floaters = [];
      for (let i = 0; i < 7; i++) {
        this.floaters.push({
          shape: SHAPES[i % 7],
          x: 0.06 + seeded(i + 70) * 0.88,
          y: seeded(i + 80),
          size: 0.045 + seeded(i + 90) * 0.05,
          rot: seeded(i + 100) * 6.28,
          vr: (seeded(i + 110) - 0.5) * 0.0001,
          vy: 0.000007 + seeded(i + 120) * 0.000009,
          c: i % 5,
        });
      }
      this.buildSprites();
    }

    /** Pre-renders each floating piece as a sheet of clear glass. */
    buildSprites() {
      if (!this.fx || !this.fx.width) return;
      const M = Math.max(this.fx.width, this.fx.height);
      const light = this.theme.light;
      this.sprites = this.floaters.map((f) => {
        const cs = Math.max(8, f.size * M);
        const xs = f.shape.map((c) => c[0]);
        const ys = f.shape.map((c) => c[1]);
        const cols = Math.max(...xs) + 1;
        const rows = Math.max(...ys) + 1;
        const pad = cs * 0.2;
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(cols * cs + pad * 2);
        cv.height = Math.ceil(rows * cs + pad * 2);
        const g = cv.getContext('2d');
        const [h, sat, l] = this.blobHsl[f.c];
        const inset = cs * 0.05;
        const w = cs - inset * 2;
        const r = w * 0.24;
        const lw = Math.max(1, cs * 0.028);
        for (const [x, y] of f.shape) {
          const x0 = pad + x * cs + inset;
          const y0 = pad + y * cs + inset;
          rrect(g, x0, y0, w, w, r);
          const body = g.createLinearGradient(x0, y0, x0 + w * 0.4, y0 + w);
          if (light) {
            body.addColorStop(0, 'rgba(255,255,255,0.62)');
            body.addColorStop(1, hsla(h, sat, Math.min(92, l + 12), 0.28));
          } else {
            body.addColorStop(0, hsla(h, sat, Math.min(90, l + 28), 0.3));
            body.addColorStop(1, hsla(h, sat, l, 0.07));
          }
          g.fillStyle = body;
          g.fill();
          const rim = g.createLinearGradient(x0, y0, x0 + w, y0 + w);
          rim.addColorStop(0, 'rgba(255,255,255,' + (light ? 0.95 : 0.75) + ')');
          rim.addColorStop(0.45, 'rgba(255,255,255,0.08)');
          rim.addColorStop(1, 'rgba(255,255,255,' + (light ? 0.6 : 0.35) + ')');
          rrect(g, x0 + lw / 2, y0 + lw / 2, w - lw, w - lw, r - lw / 2);
          g.lineWidth = lw;
          g.strokeStyle = rim;
          g.stroke();
          const sh = g.createLinearGradient(0, y0, 0, y0 + w * 0.5);
          sh.addColorStop(0, 'rgba(255,255,255,' + (light ? 0.5 : 0.22) + ')');
          sh.addColorStop(1, 'rgba(255,255,255,0)');
          rrect(g, x0 + w * 0.1, y0 + w * 0.07, w * 0.8, w * 0.38, r * 0.7);
          g.fillStyle = sh;
          g.fill();
        }
        return cv;
      });
    }

    set(name) {
      const w = WALLPAPERS[name] || WALLPAPERS.aurora;
      this.name = name;
      this.theme = w;
      this.baseHsl = w.base.map(hexToHsl);
      this.blobHsl = w.blobs.map(hexToHsl);
      this.dirty = true;
      if (this.floaters) this.buildSprites();
    }

    resize() {
      const w = Math.max(16, Math.round(root.innerWidth * this.scale));
      const h = Math.max(16, Math.round(root.innerHeight * this.scale));
      if (w !== this.canvas.width || h !== this.canvas.height) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.fx) {
        const k = Math.min(1, 1500 / Math.max(root.innerWidth, root.innerHeight));
        const fw = Math.max(16, Math.round(root.innerWidth * k));
        const fh = Math.max(16, Math.round(root.innerHeight * k));
        if (fw !== this.fx.width || fh !== this.fx.height) {
          this.fx.width = fw;
          this.fx.height = fh;
          this.buildSprites();
        }
      }
      this.dirty = true;
    }

    pulse(amount) {
      this.energy = Math.min(1.6, this.energy + amount);
    }

    setLevel(level) {
      this.hueTarget = (level - 1) * 14;
    }

    setDanger(v) {
      this.dangerTarget = v;
    }

    render(now, dt) {
      const settled = this.energy < 0.002 && Math.abs(this.hue - this.hueTarget) < 0.05 && Math.abs(this.danger - this.dangerTarget) < 0.002;
      if (!this.animated && settled && !this.dirty) return false;
      // Ambient motion is slow; 30 fps is plenty and halves the glass re-blur cost.
      if (this.animated && settled && !this.dirty && now - this.lastDraw < 33) return false;
      const elapsed = this.lastDraw ? now - this.lastDraw : dt;
      this.lastDraw = now;
      this.dirty = false;

      const s = Math.min(Math.max(elapsed, 0), 100) / 1000;
      this.energy *= Math.exp(-s * 2.2);
      this.hue += (this.hueTarget - this.hue) * Math.min(1, s * 1.2);
      this.danger += (this.dangerTarget - this.danger) * Math.min(1, s * 2);

      const g = this.ctx;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const M = Math.max(W, H);
      const t = this.animated ? now : 0;
      const light = this.theme.light;
      const hue = this.hue;

      const [b0, b1] = this.baseHsl;
      const base = g.createLinearGradient(0, 0, W * 0.4, H);
      base.addColorStop(0, hsla(b0[0] + hue, b0[1], b0[2], 1));
      base.addColorStop(1, hsla(b1[0] + hue, b1[1], b1[2], 1));
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.fillStyle = base;
      g.fillRect(0, 0, W, H);

      g.globalCompositeOperation = light ? 'source-over' : 'lighter';
      const boost = 1 + this.energy * 0.35;
      this.blobs.forEach((b, i) => {
        const x = (b.x + Math.sin(t * b.sp + b.ph) * b.ax) * W;
        const y = (b.y + Math.cos(t * b.sp * 1.3 + b.ph) * b.ay) * H;
        const r = b.r * M * boost;
        const c = this.blobHsl[i % this.blobHsl.length];
        const a = light ? 0.55 : 0.5;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, hsla(c[0] + hue, c[1], c[2], a));
        grad.addColorStop(0.55, hsla(c[0] + hue, c[1], c[2], a * 0.35));
        grad.addColorStop(1, hsla(c[0] + hue, c[1], c[2], 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      });

      if (this.danger > 0.01) {
        const grad = g.createRadialGradient(W / 2, 0, 0, W / 2, 0, M * 0.8);
        grad.addColorStop(0, 'rgba(255,40,60,' + 0.45 * this.danger + ')');
        grad.addColorStop(1, 'rgba(255,40,60,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }

      if (this.energy > 0.01) {
        g.globalCompositeOperation = light ? 'source-over' : 'lighter';
        const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, M * 0.7);
        grad.addColorStop(0, 'rgba(255,255,255,' + 0.18 * Math.min(1, this.energy) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      g.globalCompositeOperation = 'source-over';
      this.renderFx(t);
      return true;
    }

    renderFx(t) {
      const g = this.fxCtx;
      if (!g || !this.sprites.length) return;
      const W = this.fx.width;
      const H = this.fx.height;
      g.clearRect(0, 0, W, H);
      this.floaters.forEach((f, i) => {
        const sp = this.sprites[i];
        if (!sp) return;
        const span = 1 + (sp.height * 1.6) / H;
        const yy = ((((f.y - t * f.vy) % span) + span) % span) - sp.height / H * 0.8;
        g.save();
        g.translate(f.x * W, yy * H);
        g.rotate(f.rot + t * f.vr);
        g.drawImage(sp, -sp.width / 2, -sp.height / 2);
        g.restore();
      });
    }
  }

  function rrect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  root.TetrisWallpaper = { Wallpaper, WALLPAPERS };
})(window);
