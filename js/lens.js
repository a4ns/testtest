/*
 * Liquid Glass lensing. Generates a displacement map per glass surface size
 * (a rounded-rect edge band whose vectors point inward) and applies it as an
 * SVG filter inside backdrop-filter, so content behind the glass bends at the
 * rim like a thick lens. Chromium is the only engine that runs SVG filters in
 * backdrop-filter; everywhere else the frosted CSS glass is left untouched.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function detect() {
    try {
      const brands = navigator.userAgentData && navigator.userAgentData.brands;
      if (!brands || !brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))) return false;
      return !!(root.CSS && CSS.supports('backdrop-filter', 'url(#a) blur(2px)'));
    } catch (e) {
      return false;
    }
  }

  const supported = detect();
  const filters = new Map(); // key -> filter id
  const tracked = new Map(); // element -> key
  let enabled = false;
  let defs = null;
  let observer = null;
  let counter = 0;

  function buildMap(w, h, r, band) {
    const s = 0.5; // half-resolution map; the filter scales it up smoothly
    const mw = Math.max(2, Math.ceil(w * s));
    const mh = Math.max(2, Math.ceil(h * s));
    const c = document.createElement('canvas');
    c.width = mw;
    c.height = mh;
    const g = c.getContext('2d');
    const img = g.createImageData(mw, mh);
    const d = img.data;
    const hw = w / 2;
    const hh = h / 2;
    for (let j = 0; j < mh; j++) {
      const y = (j + 0.5) / s;
      for (let i = 0; i < mw; i++) {
        const x = (i + 0.5) / s;
        const dx = x - hw;
        const dy = y - hh;
        const px = Math.abs(dx) - (hw - r);
        const py = Math.abs(dy) - (hh - r);
        let dist;
        let nx;
        let ny;
        if (px > 0 && py > 0) {
          const len = Math.hypot(px, py) || 1;
          dist = r - len;
          nx = (px / len) * Math.sign(dx);
          ny = (py / len) * Math.sign(dy);
        } else if (px > py) {
          dist = r - px;
          nx = Math.sign(dx);
          ny = 0;
        } else {
          dist = r - py;
          nx = 0;
          ny = Math.sign(dy);
        }
        let m = 0;
        if (dist < band) {
          const k = 1 - Math.max(0, dist) / band;
          m = k * k * (3 - 2 * k);
        }
        const o = (j * mw + i) * 4;
        // Sample inward from the rim: content bends toward the centre.
        d[o] = 128 - nx * m * 127;
        d[o + 1] = 128 - ny * m * 127;
        d[o + 2] = 128;
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  function filterFor(w, h, r) {
    const key = w + 'x' + h + 'r' + r;
    if (filters.has(key)) return filters.get(key);
    const band = Math.max(6, Math.min(r * 1.15, Math.min(w, h) * 0.5, 30));
    const scale = Math.round(Math.max(10, Math.min(46, Math.min(w, h) * 0.4)));
    const id = 'lg-lens-' + ++counter;
    const f = document.createElementNS(SVG_NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '0');
    f.setAttribute('y', '0');
    f.setAttribute('width', String(w));
    f.setAttribute('height', String(h));
    f.setAttribute('filterUnits', 'userSpaceOnUse');
    f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const fi = document.createElementNS(SVG_NS, 'feImage');
    fi.setAttribute('href', buildMap(w, h, r, band));
    fi.setAttribute('x', '0');
    fi.setAttribute('y', '0');
    fi.setAttribute('width', String(w));
    fi.setAttribute('height', String(h));
    fi.setAttribute('preserveAspectRatio', 'none');
    fi.setAttribute('result', 'map');
    const dm = document.createElementNS(SVG_NS, 'feDisplacementMap');
    dm.setAttribute('in', 'SourceGraphic');
    dm.setAttribute('in2', 'map');
    dm.setAttribute('scale', String(scale));
    dm.setAttribute('xChannelSelector', 'R');
    dm.setAttribute('yChannelSelector', 'G');
    f.appendChild(fi);
    f.appendChild(dm);
    defs.appendChild(f);
    filters.set(key, id);
    return id;
  }

  function radiusOf(el, w, h) {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return Math.round(Math.min(r, w / 2, h / 2));
  }

  function update(el) {
    if (!enabled) return;
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    if (w < 8 || h < 8) return;
    const r = radiusOf(el, w, h);
    const key = w + 'x' + h + 'r' + r;
    if (tracked.get(el) === key) return;
    tracked.set(el, key);
    const id = filterFor(w, h, r);
    const blur = parseFloat(getComputedStyle(el).getPropertyValue('--blur')) || 20;
    // Less frost than the fallback so the bending stays visible.
    const value = 'url(#' + id + ') blur(' + Math.round(blur * 0.55) + 'px) saturate(1.9) brightness(1.04)';
    el.style.backdropFilter = value;
    el.style.webkitBackdropFilter = value;
  }

  function clear(el) {
    el.style.backdropFilter = '';
    el.style.webkitBackdropFilter = '';
  }

  const Lens = {
    supported,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      on = !!on && supported;
      if (on === enabled) return;
      enabled = on;
      if (!defs) defs = document.getElementById('lens-defs');
      if (!defs) {
        enabled = false;
        return;
      }
      if (!observer && root.ResizeObserver) {
        observer = new ResizeObserver((entries) => {
          for (const e of entries) update(e.target);
        });
      }
      const els = document.querySelectorAll('.glass:not(.no-lens)');
      els.forEach((el) => {
        if (enabled) {
          if (observer) observer.observe(el);
          update(el);
        } else {
          if (observer) observer.unobserve(el);
          tracked.delete(el);
          clear(el);
        }
      });
    },
    /** Re-measure (after a screen opens or the layout changes). */
    refresh() {
      if (!enabled) return;
      document.querySelectorAll('.glass:not(.no-lens)').forEach((el) => {
        if (observer) observer.observe(el);
        update(el);
      });
    },
  };

  root.TetrisLens = Lens;
})(window);
