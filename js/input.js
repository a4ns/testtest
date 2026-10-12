/*
 * Input: keyboard (remappable, DAS/ARR auto-shift), touch gestures, on-screen
 * touch buttons and gamepads. All sources feed the same press/release model,
 * so holding left on the keyboard and a gamepad at once behaves sanely.
 */
(function (root) {
  'use strict';

  const ACTIONS = root.TetrisStorage.ACTIONS;

  // Standard gamepad mapping (Xbox layout names).
  const PAD_MAP = {
    left: [14],
    right: [15],
    soft: [13],
    hard: [12],
    ccw: [0, 2],
    cw: [1],
    r180: [3],
    hold: [4, 5, 6, 7],
  };

  const clampMs = (v) => Math.max(0, Math.min(34, v));

  class Input {
    constructor(opts) {
      this.settings = opts.settings;
      this.getGame = opts.getGame;
      this.cellPx = opts.cellPx;
      this.handlers = opts.handlers || {};
      this.sources = {};
      this.dir = 0;
      this.das = 0;
      this.rep = 0;
      this.softHeld = false;
      this.keyMap = {};
      this.padPrev = {};
      this.padNav = { t: 0, dir: null };
      // Physical keys currently down, in press order. Survives releaseAll so
      // a direction still held across a restart or resume is picked back up.
      this.keysDown = new Set();
      this.lastUpdate = 0;
      this.rebuildKeyMap();
    }

    rebuildKeyMap() {
      this.keyMap = {};
      for (const a of ACTIONS) for (const code of this.settings.bindings[a] || []) this.keyMap[code] = a;
    }

    isHeld(action) {
      const s = this.sources[action];
      return !!s && s.size > 0;
    }

    press(action, src) {
      const set = this.sources[action] || (this.sources[action] = new Set());
      const was = set.size > 0;
      set.add(src);
      if (!was) this.fire(action);
    }

    release(action, src) {
      const set = this.sources[action];
      if (!set || !set.delete(src) || set.size > 0) return;
      if (action === 'left' || action === 'right') {
        const d = action === 'left' ? -1 : 1;
        if (this.dir === d) {
          const other = d === -1 ? 'right' : 'left';
          if (this.isHeld(other)) {
            this.dir = -d;
            this.das = 0;
            this.rep = 0;
          } else {
            this.dir = 0;
          }
        }
      } else if (action === 'soft') {
        this.softHeld = false;
      }
    }

    /** Drops every held action. hard: the keys themselves can't be trusted
     * any more either (focus left the page, so their keyups will be missed). */
    releaseAll(hard) {
      this.sources = {};
      this.dir = 0;
      this.das = 0;
      this.rep = 0;
      this.softHeld = false;
      if (hard) this.keysDown.clear();
      // Gamepad buttons still down count as fresh presses on the next poll.
      for (const k of Object.keys(this.padPrev)) {
        const p = this.padPrev[k];
        for (const a of Object.keys(PAD_MAP)) p[a] = false;
      }
    }

    /** Re-presses the movement keys that are still physically held. */
    reacquire() {
      for (const code of this.keysDown) {
        const action = this.keyMap[code];
        if (action === 'left' || action === 'right' || action === 'soft') this.press(action, 'k:' + code);
      }
    }

    fire(action) {
      const game = this.getGame();
      switch (action) {
        case 'left':
        case 'right': {
          const d = action === 'left' ? -1 : 1;
          this.dir = d;
          // DAS counts from the moment of the press, not from the next frame.
          this.das = this.lastUpdate ? -clampMs(performance.now() - this.lastUpdate) : 0;
          this.rep = 0;
          if (game) game.move(d);
          break;
        }
        case 'soft':
          this.softHeld = true;
          break;
        case 'hard':
          if (game) game.hardDrop();
          break;
        case 'cw':
          if (game) game.rotate(1);
          break;
        case 'ccw':
          if (game) game.rotate(-1);
          break;
        case 'r180':
          if (game) game.rotate(2);
          break;
        case 'hold':
          if (game) game.hold();
          break;
      }
      if (game && this.handlers.afterAction) this.handlers.afterAction();
    }

    /** Auto-shift. Call once per frame with the frame time in ms. */
    update(dt) {
      this.lastUpdate = performance.now();
      this.pollGamepads(dt);
      const game = this.getGame();
      if (!game) {
        // Charge DAS during the countdown so a held direction fires at GO.
        if (this.dir && this.charging()) this.das = Math.min(this.das + dt, this.settings.das);
        return;
      }
      if (!this.dir) return;
      const das = this.settings.das;
      const arr = this.settings.arr;
      const before = this.das;
      this.das += dt;
      if (this.das < das) return;
      if (arr <= 0) {
        let guard = 12;
        while (guard-- > 0 && game.move(this.dir));
        return;
      }
      if (before < das) {
        this.rep = this.das - das;
        game.move(this.dir);
      } else {
        this.rep += dt;
      }
      let guard = 12;
      while (this.rep >= arr && guard-- > 0) {
        this.rep -= arr;
        game.move(this.dir);
      }
      if (this.rep > arr) this.rep = arr;
    }

    // ---- keyboard ------------------------------------------------------

    charging() {
      return !!(this.handlers.canCharge && this.handlers.canCharge());
    }

    /** Tracks physical key state for every keydown, on any screen. */
    noteKey(e) {
      if (!this.keyMap[e.code]) return;
      this.keysDown.delete(e.code);
      this.keysDown.add(e.code);
    }

    keyDown(e) {
      const action = this.keyMap[e.code];
      if (!action) return false;
      this.keysDown.delete(e.code);
      this.keysDown.add(e.code);
      e.preventDefault();
      const src = 'k:' + e.code;
      if (!e.repeat) this.press(action, src);
      // A direction still held across a restart arrives only as auto-repeat
      // events; pick it back up (never for one-shot actions like hard drop).
      else if ((action === 'left' || action === 'right' || action === 'soft') && !this.isHeld(action)) this.press(action, src);
      return true;
    }

    keyUp(e) {
      this.keysDown.delete(e.code);
      const action = this.keyMap[e.code];
      if (!action) return false;
      this.release(action, 'k:' + e.code);
      return true;
    }

    // ---- on-screen buttons ----------------------------------------------

    attachButtons(container) {
      const els = container.querySelectorAll('[data-action]');
      els.forEach((el) => {
        const action = el.getAttribute('data-action');
        const down = (e) => {
          e.preventDefault();
          if (el.setPointerCapture) {
            try {
              el.setPointerCapture(e.pointerId);
            } catch (err) {
              /* ignore */
            }
          }
          el.classList.add('is-pressed');
          this.press(action, 'p:' + e.pointerId);
          if (this.handlers.haptic) this.handlers.haptic(6);
        };
        const up = (e) => {
          el.classList.remove('is-pressed');
          this.release(action, 'p:' + e.pointerId);
        };
        el.addEventListener('pointerdown', down);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('lostpointercapture', up);
        el.addEventListener('contextmenu', (e) => e.preventDefault());
      });
    }

    // ---- gestures --------------------------------------------------------

    attachGestures(el) {
      let tr = null;
      // Displacement over the last ~120 ms decides flicks, so a sideways drag
      // that ends in a downward flick still hard-drops.
      const FLICK_MS = 120;
      const recent = (t, now) => {
        const h = t.hist;
        let i = h.length - 1;
        while (i > 0 && now - h[i - 1].t <= FLICK_MS) i--;
        return h[i];
      };
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || this.settings.touch !== 'gestures') return;
        if (e.target.closest && e.target.closest('button, a, input, .touch-pad')) return;
        if (!this.getGame()) return;
        e.preventDefault();
        if (tr) {
          // A second finger landing with the first: two-finger tap = 180°.
          if (!tr.moved && !tr.second && e.timeStamp - tr.t0 < 250) tr.second = e.pointerId;
          return;
        }
        if (el.setPointerCapture) {
          try {
            el.setPointerCapture(e.pointerId);
          } catch (err) {
            /* ignore */
          }
        }
        tr = {
          id: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          t0: e.timeStamp,
          ax: e.clientX,
          ay: e.clientY,
          hist: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
          moved: false,
          second: null,
        };
      });

      el.addEventListener('pointermove', (e) => {
        if (!tr || e.pointerId !== tr.id) return;
        const game = this.getGame();
        if (!game) return;
        tr.hist.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
        while (tr.hist.length > 2 && e.timeStamp - tr.hist[1].t > FLICK_MS * 2) tr.hist.shift();
        if (tr.second) return;

        const cell = this.cellPx();
        const sens = this.settings.touchSensitivity || 1;
        const stepX = Math.max(12, cell * 0.9) / sens;
        const stepY = Math.max(12, cell * 0.95) / sens;

        let dx = e.clientX - tr.ax;
        while (Math.abs(dx) >= stepX) {
          const d = dx > 0 ? 1 : -1;
          game.move(d);
          tr.ax += d * stepX;
          dx -= d * stepX;
          tr.moved = true;
        }
        // Soft drop while the recent motion is mostly downward.
        const r = recent(tr, e.timeStamp);
        const wdx = Math.abs(e.clientX - r.x);
        const wdy = e.clientY - r.y;
        if (e.clientY < tr.ay) tr.ay = e.clientY;
        if (wdy > wdx * 0.8) {
          let guard = 40;
          while (e.clientY - tr.ay >= stepY && guard-- > 0) {
            game.softDrop();
            tr.ay += stepY;
            tr.moved = true;
          }
        } else if (wdx > wdy) {
          // Sideways again: vertical progress restarts from here.
          tr.ay = e.clientY;
        }
        if (tr.moved && this.handlers.afterAction) this.handlers.afterAction();
      });

      const end = (e) => {
        if (!tr) return;
        if (e.pointerId !== tr.id) return;
        const t = tr;
        tr = null;
        if (e.type !== 'pointerup') return;
        const game = this.getGame();
        if (!game) return;
        const dt = e.timeStamp - t.t0;
        const dx = e.clientX - t.x0;
        const dy = e.clientY - t.y0;
        const r = recent(t, e.timeStamp);
        const span = Math.max(16, e.timeStamp - r.t);
        const fdx = e.clientX - r.x;
        const fdy = e.clientY - r.y;
        const vy = fdy / span;
        if (t.second) {
          if (!t.moved && dt < 450) game.rotate(2);
        } else if (!t.moved && Math.hypot(dx, dy) < 16 && dt < 380) {
          const rect = el.getBoundingClientRect();
          game.rotate(e.clientX < rect.left + rect.width / 2 ? -1 : 1);
        } else if (fdy > 28 && vy > 0.6 && fdy > Math.abs(fdx) * 1.1) {
          game.hardDrop();
        } else if (fdy < -28 && vy < -0.45 && -fdy > Math.abs(fdx) * 1.2) {
          game.hold();
        }
        if (this.handlers.afterAction) this.handlers.afterAction();
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }

    // ---- gamepad ---------------------------------------------------------

    pollGamepads(dt) {
      if (!navigator.getGamepads) return;
      let pads;
      try {
        pads = navigator.getGamepads();
      } catch (e) {
        return;
      }
      // During the countdown the pad behaves as in play (a held direction
      // charges DAS) rather than navigating the hidden menus.
      const inGame = !!this.getGame() || this.charging();
      const menuOk = !inGame && (!this.handlers.menuReady || this.handlers.menuReady());
      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
        const ax = pad.axes[0] || 0;
        const ay = pad.axes[1] || 0;
        const prev = this.padPrev[pad.index] || (this.padPrev[pad.index] = {});
        const now = {};
        for (const a of Object.keys(PAD_MAP)) now[a] = PAD_MAP[a].some(btn);
        now.left = now.left || ax < -0.55;
        now.right = now.right || ax > 0.55;
        now.soft = now.soft || ay > 0.6;
        now.pause = btn(9) || btn(8);
        const src = 'g:' + pad.index;

        if (now.pause && !prev.pause && this.handlers.pause) this.handlers.pause();

        if (inGame) {
          for (const a of Object.keys(PAD_MAP)) {
            if (now[a] && !prev[a]) this.press(a, src);
            else if (!now[a] && prev[a]) this.release(a, src);
          }
        } else {
          for (const a of Object.keys(PAD_MAP)) if (prev[a]) this.release(a, src);
          if (!menuOk) {
            this.padNav.dir = null;
            now.a = btn(0);
            now.b = btn(1);
            this.padPrev[pad.index] = now;
            continue;
          }
          // Menu navigation with repeat.
          const navDir = now.hard || ay < -0.6 ? 'up' : now.soft ? 'down' : now.left ? 'left' : now.right ? 'right' : null;
          if (navDir && navDir !== this.padNav.dir) {
            this.padNav = { dir: navDir, t: 0 };
            if (this.handlers.menuNav) this.handlers.menuNav(navDir);
          } else if (navDir) {
            this.padNav.t += dt;
            if (this.padNav.t > 380) {
              this.padNav.t -= 120;
              if (this.handlers.menuNav) this.handlers.menuNav(navDir);
            }
          } else {
            this.padNav.dir = null;
          }
          if (btn(0) && !prev.a && this.handlers.menuSelect) this.handlers.menuSelect();
          if (btn(1) && !prev.b && this.handlers.menuBack) this.handlers.menuBack();
        }
        now.a = btn(0);
        now.b = btn(1);
        this.padPrev[pad.index] = now;
      }
    }
  }

  root.TetrisInput = { Input };
})(window);
