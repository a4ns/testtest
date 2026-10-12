/*
 * Liquid Glass compositor (WebGL2).
 *
 * The wallpaper is drawn by two 2D canvases (colour fields + floating glass
 * pieces). With this compositor on, those canvases become textures: one GPU
 * pass draws the wallpaper, then every glass surface that sits directly on it
 * (HUD panels, board frame, menu cards, buttons) is rendered as a rounded
 * slab of glass:
 *   - refraction: the backdrop bends inward near the rim, with slight colour
 *     dispersion, like a thick lens
 *   - frost from the backdrop's mip chain (cheap, smooth blur)
 *   - adaptive tint: each slab samples the brightness under it and dims or
 *     brightens itself to keep text legible
 *   - a thin specular rim whose brightest arc faces the light (pointer, or
 *     device tilt), plus a soft contact shadow
 * The DOM elements keep their content; their CSS glass is switched off while
 * the compositor draws them. Sheets that float over the board keep CSS
 * backdrop-filter, since they need to see the board.
 */
(function (root) {
  'use strict';

  const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uBox;
uniform vec2 uRes;
out vec2 vPx;
void main() {
  vec2 px = uBox.xy + aPos * uBox.zw;
  vPx = px;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
}`;

  const BG_FRAG = `#version 300 es
precision highp float;
in vec2 vPx;
uniform vec2 uRes;
uniform sampler2D uBlob;
uniform sampler2D uFx;
out vec4 o;
void main() {
  vec2 uv = vPx / uRes;
  vec3 c = texture(uBlob, uv).rgb;
  vec4 f = texture(uFx, uv);
  o = vec4(c * (1.0 - f.a) + f.rgb, 1.0);
}`;

  const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vPx;
uniform vec2 uRes;
uniform sampler2D uBg;
out vec4 o;
void main() {
  o = vec4(textureLod(uBg, vec2(vPx.x / uRes.x, 1.0 - vPx.y / uRes.y), 0.0).rgb, 1.0);
}`;

  const GLASS_FRAG = `#version 300 es
precision highp float;
in vec2 vPx;
uniform vec2 uRes;
uniform sampler2D uBg;
uniform vec4 uRect;
uniform float uRadius;
uniform float uOpacity;
uniform float uLod;
uniform float uRefract;
uniform float uBand;
uniform float uDim;
uniform float uTint;
uniform float uGlow;
uniform float uShadow;
uniform float uDanger;
uniform float uLight;
uniform vec2 uLightPos;
uniform float uDpr;
out vec4 o;

float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 bgAt(vec2 px, float lod) {
  vec2 uv = vec2(px.x / uRes.x, 1.0 - px.y / uRes.y);
  vec2 s = exp2(lod) / uRes * 0.8;
  vec3 a = textureLod(uBg, uv, lod).rgb * 0.36;
  a += textureLod(uBg, uv + vec2(s.x, s.y), lod).rgb * 0.16;
  a += textureLod(uBg, uv + vec2(-s.x, s.y), lod).rgb * 0.16;
  a += textureLod(uBg, uv + vec2(s.x, -s.y), lod).rgb * 0.16;
  a += textureLod(uBg, uv + vec2(-s.x, -s.y), lod).rgb * 0.16;
  return a;
}

void main() {
  vec2 c = uRect.xy + uRect.zw * 0.5;
  vec2 hb = uRect.zw * 0.5;
  vec2 p = vPx - c;
  float r = min(uRadius, min(hb.x, hb.y));
  float d = sdBox(p, hb, r);

  if (d > 0.5) {
    // Contact shadow, and a red glow when the board is in danger.
    float ds = sdBox(p - vec2(0.0, 9.0 * uDpr), hb, r);
    float sh = uShadow * (1.0 - smoothstep(-8.0 * uDpr, 28.0 * uDpr, ds));
    float glow = uDanger * 0.55 * (1.0 - smoothstep(0.0, 34.0 * uDpr, d));
    vec4 g = vec4(vec3(1.0, 0.27, 0.22) * glow, glow);
    o = (g + vec4(0.0, 0.0, 0.0, sh) * (1.0 - g.a)) * uOpacity;
    return;
  }

  vec2 e = vec2(1.0, 0.0);
  vec2 n = vec2(sdBox(p + e.xy, hb, r) - sdBox(p - e.xy, hb, r), sdBox(p + e.yx, hb, r) - sdBox(p - e.yx, hb, r));
  n = length(n) > 1e-4 ? normalize(n) : vec2(0.0, -1.0);
  float inside = -d;
  float k = clamp(1.0 - inside / uBand, 0.0, 1.0);
  float lens = k * k * (3.0 - 2.0 * k);

  // Refraction: sample inward near the rim, splitting colours slightly.
  vec2 q = vPx - n * lens * uRefract;
  vec3 col = bgAt(q, uLod);
  if (lens > 0.01) {
    float disp = lens * 1.8 * uDpr;
    col.r = bgAt(q + n * disp, uLod).r;
    col.b = bgAt(q - n * disp, uLod).b;
  }

  // Adaptive tint from the brightness of what is underneath.
  vec3 avg = textureLod(uBg, vec2(c.x / uRes.x, 1.0 - c.y / uRes.y), 5.0).rgb;
  float lum = dot(avg, vec3(0.2126, 0.7152, 0.0722));
  vec3 dimColor = uLight > 0.5 ? vec3(1.0) : vec3(0.03, 0.04, 0.13);
  float dimAmt = uLight > 0.5 ? uDim * mix(1.6, 0.8, smoothstep(0.45, 0.9, lum)) : uDim * mix(0.75, 1.7, smoothstep(0.12, 0.55, lum));
  col = mix(col, dimColor, clamp(dimAmt, 0.0, 0.92));

  // Milky body (stronger at the top) and light caught in the thick edge.
  float vy = clamp((vPx.y - uRect.y) / uRect.w, 0.0, 1.0);
  col = mix(col, vec3(1.0), clamp(uTint * mix(1.3, 0.55, vy) + uGlow * 0.14, 0.0, 1.0));
  col += lens * (0.05 + 0.05 * uLight);

  // Specular rim: a thin line, brightest on the arc facing the light.
  vec2 L = normalize(uLightPos - c + vec2(0.0001, 0.0));
  float facing = dot(n, L);
  float rimW = 1.25 * uDpr;
  float rim = 1.0 - smoothstep(0.0, rimW, inside);
  float spec = 0.2 + 1.0 * pow(max(facing, 0.0), 5.0) + 0.45 * pow(max(-facing, 0.0), 7.0);
  col += rim * spec * (0.85 + uGlow * 0.6);
  float inner = smoothstep(rimW, rimW * 3.0, inside) * (1.0 - smoothstep(rimW * 3.0, rimW * 10.0, inside));
  col += inner * pow(max(facing, 0.0), 3.0) * (0.14 + uGlow * 0.1);
  col = mix(col, vec3(1.0, 0.36, 0.3), uDanger * rim);

  float a = clamp(0.5 - d, 0.0, 1.0) * uOpacity;
  o = vec4(min(col, vec3(1.0)) * a, a);
}`;

  // Material presets (CSS px; scaled by DPR in the shader inputs).
  const MATERIALS = {
    board: { lod: 4.3, refract: 16, band: 28, dim: [0.44, 0.3], tint: [0.04, 0.34], shadow: [0.34, 0.12] },
    panel: { lod: 3.3, refract: 13, band: 22, dim: [0.3, 0.16], tint: [0.08, 0.36], shadow: [0.3, 0.12] },
    card: { lod: 2.6, refract: 18, band: 26, dim: [0.16, 0.08], tint: [0.09, 0.34], shadow: [0.28, 0.12] },
    control: { lod: 1.6, refract: 12, band: 18, dim: [0.08, 0.04], tint: [0.13, 0.42], shadow: [0.22, 0.1] },
  };

  function materialFor(el) {
    if (el.classList.contains('board-frame')) return MATERIALS.board;
    if (el.classList.contains('panel')) return MATERIALS.panel;
    if (el.classList.contains('mode-card') || el.classList.contains('continue')) return MATERIALS.card;
    return MATERIALS.control;
  }

  const state = {
    gl: null,
    canvas: null,
    sources: null,
    supported: false,
    enabled: false,
    dpr: 1,
    W: 0,
    H: 0,
    progs: {},
    texBlob: null,
    texFx: null,
    fbo: null,
    texBg: null,
    vao: null,
    items: [],
    sig: '',
    light: [0, 0],
    lightSet: false,
    scheme: 0,
    needsBg: true,
    onLost: null,
    lost: false,
    losses: 0,
  };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }

  function program(gl, frag, uniforms) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    const u = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
    return { p, u };
  }

  function makeTex(gl, mips) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Software rasterizers (SwiftShader, llvmpipe) can't afford this. */
  function isSoftware(gl) {
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
    } catch (e) {
      return false;
    }
  }

  function init(canvas, sources, opts) {
    state.canvas = canvas;
    state.sources = sources;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    } catch (e) {
      gl = null;
    }
    if (!gl) return false;
    if (isSoftware(gl) && !(opts && opts.allowSoftware)) {
      state.software = true;
      return false;
    }
    if (!setup(gl)) return false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      state.gl = null;
      state.lost = true;
      state.losses++;
      setEnabled(false);
      state.supported = false;
      if (state.onLost) state.onLost();
    });
    // The driver came back: rebuild everything (a GPU that keeps resetting
    // is left on CSS glass for the rest of the session).
    canvas.addEventListener('webglcontextrestored', () => {
      if (state.losses > 2 || !setup(gl)) return;
      state.lost = false;
      if (state.onLost) state.onLost();
    });
    return true;
  }

  function setup(gl) {
    try {
      state.progs.bg = program(gl, BG_FRAG, ['uBox', 'uRes', 'uBlob', 'uFx']);
      state.progs.copy = program(gl, COPY_FRAG, ['uBox', 'uRes', 'uBg']);
      state.progs.glass = program(gl, GLASS_FRAG, [
        'uBox', 'uRes', 'uBg', 'uRect', 'uRadius', 'uOpacity', 'uLod', 'uRefract', 'uBand', 'uDim', 'uTint', 'uGlow', 'uShadow', 'uDanger', 'uLight', 'uLightPos', 'uDpr',
      ]);
    } catch (e) {
      return false;
    }
    state.vao = gl.createVertexArray();
    gl.bindVertexArray(state.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    state.texBlob = makeTex(gl, false);
    state.texFx = makeTex(gl, false);
    state.texBg = makeTex(gl, true);
    state.fbo = gl.createFramebuffer();
    state.gl = gl;
    state.supported = true;
    state.W = state.H = 0;
    state.sig = '';
    state.needsBg = true;
    resize();
    return true;
  }

  function resize() {
    const gl = state.gl;
    if (!gl) return;
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const W = Math.max(2, Math.round(root.innerWidth * dpr));
    const H = Math.max(2, Math.round(root.innerHeight * dpr));
    state.dpr = dpr;
    if (W === state.W && H === state.H) return;
    state.W = W;
    state.H = H;
    state.canvas.width = W;
    state.canvas.height = H;
    gl.bindTexture(gl.TEXTURE_2D, state.texBg);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.texBg, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    state.needsBg = true;
    state.sig = '';
  }

  /** Re-collects the glass surfaces that sit directly on the wallpaper. */
  function refresh() {
    if (!state.enabled) return;
    for (const it of state.items) it.el.classList.remove('gl');
    state.items = [];
    document.querySelectorAll('.glass').forEach((el) => {
      if (el.classList.contains('sheet') || el.classList.contains('toast') || el.classList.contains('no-gl') || el.closest('.sheet')) return;
      const chain = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) chain.push(n);
      const cs = getComputedStyle(el);
      state.items.push({ el, chain, mat: materialFor(el), radius: parseFloat(cs.borderTopLeftRadius) || 0 });
      el.classList.add('gl');
    });
    state.sig = '';
  }

  function setEnabled(on) {
    on = !!on && state.supported;
    if (on === state.enabled) {
      if (on) refresh();
      return;
    }
    state.enabled = on;
    document.documentElement.classList.toggle('gl-on', on);
    if (on) {
      resize();
      refresh();
      state.needsBg = true;
    } else {
      for (const it of state.items) it.el.classList.remove('gl');
      state.items = [];
    }
  }

  function opacityOf(item) {
    let o = 1;
    const chain = item.chain;
    if (getComputedStyle(item.el).visibility === 'hidden') return 0;
    for (let i = 0; i < chain.length; i++) {
      o *= parseFloat(getComputedStyle(chain[i]).opacity);
      if (o < 0.01) return 0;
    }
    return o;
  }

  /**
   * Draws a frame if anything changed. bgChanged: the wallpaper canvases were
   * redrawn. danger: 0..1 pulse for the board frame.
   */
  function render(bgChanged, danger) {
    const gl = state.gl;
    if (!state.enabled || !gl) return;
    const dpr = state.dpr;
    const draw = [];
    let sig = '';
    for (const it of state.items) {
      if (!it.el.isConnected) continue;
      const r = it.el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < -40 || r.top > root.innerHeight + 40) continue;
      const op = opacityOf(it);
      if (op <= 0) continue;
      const glow = it.el.classList.contains('is-pressed') ? 1 : it.el.matches(':hover') ? 0.55 : 0;
      const dz = it.mat === MATERIALS.board ? danger || 0 : 0;
      draw.push({ it, r, op, glow, dz });
      sig += r.left.toFixed(1) + ',' + r.top.toFixed(1) + ',' + r.width.toFixed(1) + ',' + r.height.toFixed(1) + ',' + op.toFixed(3) + ',' + glow + ',' + dz.toFixed(2) + ';';
    }
    sig += state.light[0].toFixed(0) + ',' + state.light[1].toFixed(0) + ',' + state.scheme;
    if (bgChanged) state.needsBg = true;
    if (!state.needsBg && sig === state.sig) return;
    state.sig = sig;

    const W = state.W;
    const H = state.H;
    gl.bindVertexArray(state.vao);
    gl.disable(gl.DEPTH_TEST);

    if (state.needsBg) {
      state.needsBg = false;
      const [blob, fx] = state.sources;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, state.texBlob);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, blob);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, state.texFx);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fx);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      const pb = state.progs.bg;
      gl.useProgram(pb.p);
      gl.uniform4f(pb.u.uBox, 0, 0, W, H);
      gl.uniform2f(pb.u.uRes, W, H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.texBlob);
      gl.uniform1i(pb.u.uBlob, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, state.texFx);
      gl.uniform1i(pb.u.uFx, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.texBg);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    const pc = state.progs.copy;
    gl.useProgram(pc.p);
    gl.uniform4f(pc.u.uBox, 0, 0, W, H);
    gl.uniform2f(pc.u.uRes, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.texBg);
    gl.uniform1i(pc.u.uBg, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pg = state.progs.glass;
    gl.useProgram(pg.p);
    gl.uniform2f(pg.u.uRes, W, H);
    gl.uniform1i(pg.u.uBg, 0);
    gl.uniform1f(pg.u.uDpr, dpr);
    gl.uniform1f(pg.u.uLight, state.scheme);
    const lx = state.lightSet ? state.light[0] : root.innerWidth * 0.28;
    const ly = state.lightSet ? state.light[1] : -root.innerHeight * 0.25;
    gl.uniform2f(pg.u.uLightPos, lx * dpr, ly * dpr);
    const s = state.scheme ? 1 : 0;
    // Biggest surfaces first so smaller ones (and their shadows) sit on top.
    draw.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    for (const dItem of draw) {
      const { it, r, op, glow, dz } = dItem;
      const m = it.mat;
      const pad = 44;
      gl.uniform4f(pg.u.uBox, (r.left - pad) * dpr, (r.top - pad) * dpr, (r.width + pad * 2) * dpr, (r.height + pad * 2) * dpr);
      gl.uniform4f(pg.u.uRect, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr);
      // Rect includes CSS transforms (hover/press scale), so scale the radius too.
      const scale = it.el.offsetWidth ? r.width / it.el.offsetWidth : 1;
      gl.uniform1f(pg.u.uRadius, it.radius * scale * dpr);
      gl.uniform1f(pg.u.uOpacity, op);
      gl.uniform1f(pg.u.uLod, m.lod + Math.log2(dpr));
      gl.uniform1f(pg.u.uRefract, m.refract * dpr);
      gl.uniform1f(pg.u.uBand, Math.min(m.band, Math.min(r.width, r.height) * 0.5) * dpr);
      gl.uniform1f(pg.u.uDim, m.dim[s]);
      gl.uniform1f(pg.u.uTint, m.tint[s]);
      gl.uniform1f(pg.u.uGlow, glow);
      gl.uniform1f(pg.u.uShadow, m.shadow[s]);
      gl.uniform1f(pg.u.uDanger, dz);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  root.TetrisGlass = {
    init,
    resize,
    refresh,
    setEnabled,
    render,
    get supported() {
      return state.supported;
    },
    get software() {
      return !!state.software;
    },
    /** The GPU context was lost and hasn't come back. */
    get lost() {
      return state.lost;
    },
    get enabled() {
      return state.enabled;
    },
    setScheme(light) {
      state.scheme = light ? 1 : 0;
    },
    setLight(x, y) {
      state.light = [x, y];
      state.lightSet = true;
    },
    /** Called when the context is lost and again if it's restored. */
    onContextLost(cb) {
      state.onLost = cb;
    },
    /** For tests: number of surfaces the compositor is drawing. */
    get count() {
      return state.items.length;
    },
  };
})(window);
