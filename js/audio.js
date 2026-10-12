/*
 * Sound design: every effect and both music tracks are synthesized with the
 * Web Audio API, so the game ships with no audio files. The palette is
 * "struck glass": sine partials at inharmonic ratios with a shared reverb.
 */
(function (root) {
  'use strict';

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // [frequency ratio, amplitude, decay scale] — measured-ish wine glass partials.
  const GLASS = [
    [1, 1, 1],
    [2.01, 0.32, 0.6],
    [2.76, 0.26, 0.45],
    [5.4, 0.1, 0.25],
    [8.93, 0.04, 0.15],
  ];
  const PENTA = [0, 2, 4, 7, 9];

  const state = {
    ctx: null,
    n: null,
    noise: null,
    volumes: { master: 0.8, sfx: 0.8, music: 0.6 },
    track: 'glass',
    level: 1,
    wantMusic: false,
    ducked: false,
    lastMove: 0,
  };

  function scaleNote(base, idx) {
    return base + PENTA[idx % 5] + 12 * Math.floor(idx / 5);
  }

  function impulse(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function create() {
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      return false;
    }
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 14;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 2.8, 3);
    reverb.connect(master);

    const sfxDry = ctx.createGain();
    sfxDry.connect(master);
    const sfxWet = ctx.createGain();
    sfxWet.connect(master);
    const sfxSend = ctx.createGain();
    sfxSend.gain.value = 0.28;
    sfxWet.connect(sfxSend);
    sfxSend.connect(reverb);

    const music = ctx.createGain();
    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 18000;
    musicFilter.Q.value = 0.4;
    music.connect(musicFilter);
    musicFilter.connect(master);
    const musicSend = ctx.createGain();
    musicSend.gain.value = 0.42;
    musicFilter.connect(musicSend);
    musicSend.connect(reverb);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    state.ctx = ctx;
    state.noise = noise;
    state.n = { master, sfxDry, sfxWet, music, musicFilter };
    applyVolumes();
    return true;
  }

  function applyVolumes() {
    if (!state.ctx) return;
    const { master, sfxDry, sfxWet, music } = state.n;
    const t = state.ctx.currentTime;
    const v = state.volumes;
    master.gain.setTargetAtTime(v.master * v.master, t, 0.02);
    sfxDry.gain.setTargetAtTime(v.sfx, t, 0.02);
    sfxWet.gain.setTargetAtTime(v.sfx, t, 0.02);
    // Music sits just under the effects rather than far below them.
    music.gain.setTargetAtTime(v.music * v.music * 2, t, 0.05);
  }

  // ---- voices ----------------------------------------------------------

  function glass(freq, t, o) {
    const ctx = state.ctx;
    const dur = o.dur || 0.6;
    const vol = o.vol || 0.08;
    const out = o.out || state.n.sfxWet;
    const nyquist = ctx.sampleRate * 0.42;
    for (let i = 0; i < GLASS.length; i++) {
      const [ratio, amp, dscale] = GLASS[i];
      const f = freq * ratio;
      if (f > nyquist) continue;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const d = Math.max(0.03, dur * dscale);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol * amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + d + 0.02);
    }
  }

  function tone(freq, t, o) {
    const ctx = state.ctx;
    const dur = o.dur || 0.1;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t + dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const attack = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.1, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      g.connect(f);
      node = f;
    }
    osc.connect(g);
    node.connect(o.out || state.n.sfxDry);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(t, o) {
    const ctx = state.ctx;
    const dur = o.dur || 0.1;
    const src = ctx.createBufferSource();
    src.buffer = state.noise;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, t + dur);
    f.Q.value = o.q || 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.1, t + (o.attack || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.out || state.n.sfxDry);
    const offset = Math.random() * Math.max(0, state.noise.duration - dur - 0.1);
    src.start(t, offset, dur + 0.05);
  }

  function pad(notes, t, len, vol, out) {
    const ctx = state.ctx;
    for (const n of notes) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1500;
      f.Q.value = 0.3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + Math.min(1.4, len * 0.4));
      g.gain.setValueAtTime(vol, t + len);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len + 1.8);
      f.connect(g);
      g.connect(out);
      for (const det of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = midi(n);
        osc.detune.value = det;
        osc.connect(f);
        osc.start(t);
        osc.stop(t + len + 1.9);
      }
    }
  }

  // ---- sound effects ---------------------------------------------------

  const SFX = {
    move(t) {
      // Rate-limit so fast auto-repeat doesn't turn into a buzz.
      if (t - state.lastMove < 0.028) return;
      state.lastMove = t;
      tone(1900 + Math.random() * 140, t, { dur: 0.03, vol: 0.035, attack: 0.002 });
    },
    rotate(t, dir, tspin) {
      glass(dir < 0 ? 1318.5 : dir === 2 ? 1760 : 1568, t, { dur: 0.22, vol: 0.05 });
      if (tspin && tspin !== 'none') glass(2637, t + 0.03, { dur: 0.35, vol: 0.035 });
    },
    land(t) {
      tone(190, t, { dur: 0.07, vol: 0.09, slideTo: 110 });
    },
    lock(t) {
      noise(t, { dur: 0.035, vol: 0.06, type: 'highpass', freq: 2500 });
      tone(330, t, { dur: 0.05, vol: 0.04 });
    },
    hardDrop(t, distance) {
      const k = Math.min(1, 0.45 + distance / 30);
      tone(160, t, { dur: 0.22, vol: 0.4 * k, slideTo: 42 });
      noise(t, { dur: 0.09, vol: 0.16 * k, type: 'lowpass', freq: 1400, freqTo: 300 });
      glass(523.25, t + 0.004, { dur: 0.3, vol: 0.035 });
    },
    hold(t) {
      noise(t, { dur: 0.18, vol: 0.09, type: 'bandpass', freq: 500, freqTo: 3200, q: 1.4, attack: 0.04 });
      glass(987.77, t + 0.05, { dur: 0.32, vol: 0.04 });
    },
    clear(t, ev) {
      const combo = Math.max(0, ev.combo);
      const base = scaleNote(72, Math.min(combo, 12));
      const n = ev.lines;
      if (ev.tspin !== 'none') {
        noise(t, { dur: 0.35, vol: 0.08, type: 'bandpass', freq: 800, freqTo: 6000, q: 2, attack: 0.05, out: state.n.sfxWet });
        for (let i = 0; i < 6; i++) glass(midi(base + 12 + (i % 2 ? 7 : 12)), t + i * 0.04, { dur: 0.4, vol: 0.035 });
      }
      if (n === 4) {
        tone(98, t, { dur: 0.6, vol: 0.25, slideTo: 49, type: 'sine' });
        [0, 4, 7, 12, 16].forEach((s, i) => glass(midi(base + s), t + i * 0.03, { dur: 1.6, vol: 0.075 }));
        for (let i = 0; i < 8; i++) glass(midi(scaleNote(base + 12, i)), t + 0.18 + i * 0.045, { dur: 0.8, vol: 0.03 });
      } else if (n > 0) {
        const chord = [[0], [0, 7], [0, 4, 7]][n - 1];
        chord.forEach((s, i) => glass(midi(base + s), t + i * 0.035, { dur: 1.1, vol: 0.08 }));
      }
      if (ev.b2b) glass(midi(base + 24), t + 0.12, { dur: 0.9, vol: 0.04 });
      if (ev.perfectClear) {
        for (let i = 0; i < 15; i++) glass(midi(scaleNote(72, i)), t + 0.2 + i * 0.045, { dur: 1.8, vol: 0.06 });
      }
    },
    levelUp(t) {
      [0, 4, 7, 12, 16, 19].forEach((s, i) => glass(midi(79 + s), t + i * 0.06, { dur: 1.2, vol: 0.06 }));
    },
    gameOver(t) {
      [0, -3, -7, -12, -15].forEach((s, i) => glass(midi(69 + s), t + i * 0.2, { dur: 1.8, vol: 0.08 }));
      tone(110, t, { type: 'triangle', dur: 2.4, vol: 0.1, slideTo: 55, filter: 600 });
    },
    win(t) {
      [0, 4, 7, 12, 7, 12, 16, 24].forEach((s, i) => glass(midi(72 + s), t + i * 0.09, { dur: 1.6, vol: 0.07 }));
    },
    countdown(t, n) {
      glass(n > 0 ? midi(81) : midi(93), t, { dur: n > 0 ? 0.45 : 1.1, vol: n > 0 ? 0.07 : 0.09 });
    },
    ui(t) {
      tone(1400, t, { dur: 0.03, vol: 0.025 });
    },
    select(t) {
      glass(1046.5, t, { dur: 0.3, vol: 0.05 });
    },
    back(t) {
      glass(784, t, { dur: 0.25, vol: 0.04 });
    },
    achievement(t) {
      [0, 7, 12, 16, 19, 24].forEach((s, i) => glass(midi(84 + s), t + i * 0.05, { dur: 1.4, vol: 0.05 }));
    },
    zenReset(t) {
      noise(t, { dur: 1.2, vol: 0.1, type: 'bandpass', freq: 4000, freqTo: 400, q: 0.8, attack: 0.02, out: state.n.sfxWet });
      [12, 7, 4, 0].forEach((s, i) => glass(midi(72 + s), t + i * 0.12, { dur: 1.6, vol: 0.05 }));
    },
  };

  // ---- music -----------------------------------------------------------

  const GARDEN = {
    chords: [
      { bass: 50, pad: [62, 66, 69, 73], arp: [74, 76, 78, 81, 85] },
      { bass: 47, pad: [59, 62, 66, 69], arp: [71, 74, 76, 78, 83] },
      { bass: 43, pad: [55, 59, 62, 66], arp: [74, 78, 79, 81, 86] },
      { bass: 45, pad: [57, 61, 64, 71], arp: [73, 76, 78, 81, 83] },
    ],
    pattern: [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 4, 3, 1, 2, 0, 4],
    stepDur(level) {
      const bpm = 84 + Math.min(level - 1, 14) * 2.4;
      return 30 / bpm;
    },
    play(i, t, level) {
      const out = state.n.music;
      const sd = this.stepDur(level);
      const c = this.chords[Math.floor(i / 16) % 4];
      const s = i % 16;
      if (s === 0) {
        pad(c.pad, t, sd * 16, 0.02, out);
        tone(midi(c.bass), t, { type: 'sine', dur: sd * 7, vol: 0.12, attack: 0.03, out });
        tone(midi(c.bass + 12), t, { type: 'triangle', dur: sd * 4, vol: 0.03, attack: 0.03, out });
      } else if (s === 8) {
        tone(midi(c.bass), t, { type: 'sine', dur: sd * 7, vol: 0.09, attack: 0.03, out });
      }
      const density = Math.min(1, 0.55 + level * 0.04);
      if (Math.random() < density) {
        glass(midi(c.arp[this.pattern[s]]), t, { dur: 1.8, vol: 0.03, out });
      }
      if (Math.random() < 0.07) glass(midi(c.arp[Math.floor(Math.random() * 5)] + 12), t + sd * 0.5, { dur: 2.2, vol: 0.014, out });
      if (level >= 4 && s % 2 === 1) noise(t, { dur: 0.03, vol: 0.016, type: 'highpass', freq: 8000, out });
      if (level >= 8 && s % 4 === 0) tone(110, t, { dur: 0.16, vol: 0.12, slideTo: 42, out });
    },
  };

  // Korobeiniki (Russian folk song, public domain). [midi note | null, eighths]
  const KORO_A = [
    [76, 2], [71, 1], [72, 1], [74, 2], [72, 1], [71, 1],
    [69, 2], [69, 1], [72, 1], [76, 2], [74, 1], [72, 1],
    [71, 3], [72, 1], [74, 2], [76, 2],
    [72, 2], [69, 2], [69, 2], [null, 2],
    [null, 1], [74, 2], [77, 1], [81, 2], [79, 1], [77, 1],
    [76, 3], [72, 1], [76, 2], [74, 1], [72, 1],
    [71, 2], [71, 1], [72, 1], [74, 2], [76, 2],
    [72, 2], [69, 2], [69, 2], [null, 2],
  ];
  const KORO_B = [
    [76, 4], [72, 4], [74, 4], [71, 4], [72, 4], [69, 4], [68, 4], [71, 2], [null, 2],
    [76, 4], [72, 4], [74, 4], [71, 4], [72, 2], [76, 2], [81, 4], [80, 8],
  ];
  // Bass roots per half bar.
  const KORO_BASS_A = [40, 40, 45, 45, 44, 40, 45, 45, 38, 38, 36, 36, 35, 40, 45, 45];
  const KORO_BASS_B = [45, 45, 44, 44, 45, 45, 44, 44, 45, 45, 44, 44, 45, 45, 44, 44];

  function expand(seq) {
    const steps = [];
    for (const [note, len] of seq) {
      steps.push({ note, len });
      for (let i = 1; i < len; i++) steps.push(null);
    }
    return steps;
  }

  const KORO = (function () {
    const a = expand(KORO_A);
    const b = expand(KORO_B);
    const melody = a.concat(a, b, b);
    const bass = [].concat(KORO_BASS_A, KORO_BASS_A, KORO_BASS_B, KORO_BASS_B);
    return { melody, bass };
  })();

  const CLASSIC = {
    stepDur(level) {
      const bpm = 122 + Math.min(level - 1, 15) * 4;
      return 30 / bpm;
    },
    play(i, t, level) {
      const out = state.n.music;
      const sd = this.stepDur(level);
      const idx = i % KORO.melody.length;
      const m = KORO.melody[idx];
      if (m && m.note) {
        const f = midi(m.note);
        const len = sd * m.len * 0.92;
        tone(f, t, { type: 'triangle', dur: len + 0.08, vol: 0.075, attack: 0.008, out, filter: 3200 });
        tone(f * 2, t, { type: 'sine', dur: len * 0.6, vol: 0.018, attack: 0.008, out });
        glass(f * 2, t, { dur: 0.25, vol: 0.016, out });
      }
      const root = KORO.bass[Math.floor(idx / 4)];
      tone(midi(root + (idx % 2 ? 12 : 0)), t, { type: 'triangle', dur: sd * 0.9, vol: 0.075, attack: 0.005, out, filter: 1200 });
      if (level >= 3 && idx % 2 === 1) noise(t, { dur: 0.03, vol: 0.018, type: 'highpass', freq: 8000, out });
      if (level >= 6 && idx % 4 === 0) tone(120, t, { dur: 0.14, vol: 0.13, slideTo: 45, out });
    },
  };

  const TRACKS = { glass: GARDEN, classic: CLASSIC };

  const music = {
    timer: null,
    step: 0,
    next: 0,
    track: null,
    start() {
      this.stop();
      if (!state.ctx || !TRACKS[state.track]) return;
      this.track = TRACKS[state.track];
      this.step = 0;
      this.next = state.ctx.currentTime + 0.08;
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
    },
    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.track = null;
    },
    tick() {
      const ctx = state.ctx;
      if (!ctx || !this.track || ctx.state !== 'running') return;
      const now = ctx.currentTime;
      if (this.next < now - 0.2) this.next = now + 0.05;
      while (this.next < now + 0.16) {
        this.track.play(this.step, this.next, state.level);
        this.next += this.track.stepDur(state.level);
        this.step++;
      }
    },
  };

  // ---- public API ------------------------------------------------------

  const Audio = {
    /** Call from a user gesture; creates/resumes the context. */
    unlock() {
      if (!state.ctx && !create()) return;
      if (state.ctx.state !== 'running') state.ctx.resume().catch(() => {});
      if (state.wantMusic && !music.timer) music.start();
    },
    get ready() {
      return !!state.ctx && state.ctx.state === 'running';
    },
    setVolumes(v) {
      Object.assign(state.volumes, v);
      applyVolumes();
    },
    setTrack(name) {
      if (name === state.track) return;
      state.track = name;
      if (state.wantMusic) this.startMusic();
    },
    setLevel(level) {
      state.level = Math.max(1, level | 0);
    },
    startMusic() {
      state.wantMusic = true;
      if (state.track === 'off') {
        music.stop();
        return;
      }
      if (state.ctx) music.start();
    },
    ensureMusic() {
      state.wantMusic = true;
      if (state.ctx && !music.timer && state.track !== 'off') music.start();
    },
    stopMusic() {
      state.wantMusic = false;
      music.stop();
    },
    /** Muffle music (pause menus). */
    duck(on) {
      if (!state.ctx || state.ducked === on) return;
      state.ducked = on;
      const t = state.ctx.currentTime;
      state.n.musicFilter.frequency.setTargetAtTime(on ? 700 : 18000, t, 0.15);
    },
    suspend() {
      if (state.ctx && state.ctx.state === 'running') state.ctx.suspend().catch(() => {});
    },
    resume() {
      if (state.ctx && state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
    },
    play(name, a, b) {
      const ctx = state.ctx;
      if (!ctx || ctx.state !== 'running' || !SFX[name]) return;
      try {
        SFX[name](ctx.currentTime + 0.004, a, b);
      } catch (e) {
        /* never let audio break the game */
      }
    },
  };

  root.TetrisAudio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
