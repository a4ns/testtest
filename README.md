# Liquid Glass Tetris

A falling-block puzzle game built from Apple-style Liquid Glass: translucent
slabs with lit rims, specular sheens that follow your pointer, real edge
lensing on Chromium browsers, glass-jewel blocks, and a living wallpaper that
pulses with every clear.

No build step and no dependencies. Open `index.html` in a browser and play.

## Play

- **Daily Challenge** — a new two-minute run every day with the same pieces for everyone; build a streak.
- **Marathon** — endless; gravity speeds up every 10 lines (guideline curve up to level 20). Save & quit any time and continue later.
- **Sprint 40L** — clear 40 lines as fast as you can, with your pace against your best at 10, 20 and 30 lines.
- **Ultra 2:00** — score as much as you can in two minutes.
- **Zen** — no game over; when the stack tops out it shatters and you keep going.

| Action | Keys (remappable) |
| --- | --- |
| Move | ← → |
| Soft drop | ↓ |
| Hard drop | Space |
| Rotate clockwise | ↑, X |
| Rotate counter-clockwise | Z |
| Rotate 180° | A |
| Hold | C, Shift |
| Pause | Esc, P |
| Restart (Sprint/Ultra, pause, results) | R |

**Touch:** drag sideways to move, tap the right/left half to rotate, drag down
to soft drop, flick down to hard drop, flick up to hold. On-screen buttons are
available in Settings → Controls. **Gamepads** work too (D-pad, A/B rotate,
Y 180°, bumpers hold, Start pause).

## What's inside

- **Modern guideline rules:** SRS rotation with full wall-kick tables (plus
  180° kicks), 7-bag randomizer, hold, 1–5 piece preview, ghost piece, 500 ms
  lock delay with 15 move resets, T-spin detection (3-corner rule, mini vs
  full, TST kick upgrade), back-to-back ×1.5, combos, perfect-clear bonuses,
  block-out and lock-out top-outs.
- **Handling settings:** DAS, ARR (down to instant) and soft-drop speed
  (up to instant), with DAS carried between pieces.
- **Zero-delay line clears:** the logic clears instantly; the shatter, light
  sweep and springy collapse are purely visual, so fast play never waits.
- **Sound:** all effects and both soundtracks (the ambient *Glass Garden* and a
  glassy *Korobeiniki*) are synthesized live with the Web Audio API. Combos
  climb a pentatonic scale; the music speeds up with the level.
- **Progression:** personal top-10 per mode, 23 achievements, daily streaks, lifetime stats,
  resumable Marathon/Zen runs, one-key instant retry (R).
- **Layouts** for desktop, portrait phones and landscape phones, with touch gestures or buttons.
- **Installable PWA** with offline support (when served over HTTPS).
- **Accessible:** full keyboard and gamepad navigation, reduced-motion and
  reduced-transparency support, three glass materials (Liquid, Frosted, Solid).

## Develop

```sh
npm test            # rules-engine unit tests (node:test, no dependencies)
npm run serve       # http://localhost:8080
node scripts/smoke.mjs .smoke   # headless-browser smoke test + screenshots (needs Playwright)
node scripts/layout-check.mjs    # no overflow at 13 viewports with worst-case HUD values
npm run build       # dist/liquid-glass-tetris.html, a single self-contained file
```

Code map:

| File | Role |
| --- | --- |
| `js/engine.js` | Pure rules engine (also runs in Node for tests) |
| `js/renderer.js` | Glass tile sprites, playfield, effects, previews, logo |
| `js/wallpaper.js` | Animated wallpaper behind the glass |
| `js/lens.js` | Liquid Glass edge refraction (SVG displacement in `backdrop-filter`) |
| `js/audio.js` | Synthesized sound effects and music |
| `js/input.js` | Keyboard (DAS/ARR), touch gestures and buttons, gamepad |
| `js/storage.js` | Settings, records, achievements (localStorage) |
| `js/app.js` | Screens, game flow, HUD, settings UI, frame loop |
| `css/style.css` | The Liquid Glass design system |

Tetris is a trademark of The Tetris Company. This is an unofficial fan project.
