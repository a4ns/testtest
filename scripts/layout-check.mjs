// Layout regression check: plays each mode at many viewports with worst-case
// HUD values and fails if anything spills off-screen or out of its panel.
//
//   node scripts/layout-check.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { startServer } from './serve-lib.mjs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const outDir = path.resolve(process.argv[2] || '.smoke/layout');
fs.mkdirSync(outDir, { recursive: true });
const { url, close } = await startServer();

const VIEWPORTS = [
  [320, 568, true],
  [360, 780, true],
  [390, 844, true],
  [430, 932, true],
  [667, 375, true],
  [844, 390, true],
  [932, 430, true],
  [768, 1024, true],
  [1024, 768, false],
  [1280, 720, false],
  [1366, 768, false],
  [1440, 900, false],
  [1920, 1080, false],
];

const failures = [];
const browser = await pw.chromium.launch();
for (const [w, h, touch] of VIEWPORTS) {
  for (const controls of touch ? ['gestures', 'buttons'] : ['keys']) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => failures.push(`${w}x${h} pageerror ${e.message}`));
    await page.addInitScript((c) => {
      localStorage.setItem('lgtetris.settings.v1', JSON.stringify({ touch: c === 'buttons' ? 'buttons' : 'gestures' }));
      localStorage.setItem('lgtetris.profile.v1', JSON.stringify({ seenTouchHelp: true }));
    }, controls);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    for (const mode of ['sprint', 'marathon', 'ultra']) {
      await page.evaluate((m) => window.__tetris.startGame(m), mode);
      await page.waitForTimeout(1900);
      await page.evaluate(() => {
        const g = window.__tetris.app.game;
        g.score = 1234567;
        g.lines = g.mode === 'sprint' ? 37 : 999;
        g.level = g.mode === 'sprint' ? 1 : 20;
        g.time = g.mode === 'ultra' ? 61000 : 754560;
        g.stats.pieces = 1234;
        g.holdType = 'I';
        window.__tetris.app.displayScore = g.score;
      });
      await page.waitForTimeout(150);
      const issues = await page.evaluate(() => {
        const out = [];
        const vw = innerWidth;
        const vh = innerHeight;
        const game = document.getElementById('game');
        for (const el of game.querySelectorAll('.area-pause, .area-fs, .mode-pill, .panel, .board-shell, .pad-btn')) {
          const r = el.getBoundingClientRect();
          if (!r.width || getComputedStyle(el).display === 'none') continue;
          if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
            out.push(`${el.className.split(' ').slice(-1)[0] || el.id} off-screen ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
          }
        }
        for (const v of game.querySelectorAll('.stat-value')) {
          const panel = v.closest('.panel');
          const stat = v.closest('.stat');
          if (getComputedStyle(stat).display === 'none') continue;
          const r = v.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          const width = v.scrollWidth;
          if (r.left + width > p.right - 2 || r.left < p.left) out.push(`stat "${v.textContent}" overflows panel (${Math.round(r.left + width)} > ${Math.round(p.right)})`);
        }
        const panels = [...game.querySelectorAll('.panel, .board-shell')].filter((e) => e.getBoundingClientRect().width && getComputedStyle(e).display !== 'none');
        for (let i = 0; i < panels.length; i++) {
          for (let j = i + 1; j < panels.length; j++) {
            const a = panels[i].getBoundingClientRect();
            const b = panels[j].getBoundingClientRect();
            const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ix > 2 && iy > 2) out.push(`overlap ${panels[i].className.split(' ').pop()} / ${panels[j].className.split(' ').pop()}`);
          }
        }
        return out;
      });
      for (const i of issues) failures.push(`${w}x${h} ${controls} ${mode}: ${i}`);
      await page.screenshot({ path: path.join(outDir, `${w}x${h}-${controls}-${mode}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__tetris.quit && window.__tetris.quit());
    }
    await ctx.close();
  }
}
await browser.close();
close();
if (failures.length) {
  console.error('LAYOUT FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('layout ok — ' + VIEWPORTS.length + ' viewports; screenshots in ' + outDir);
