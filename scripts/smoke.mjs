// Browser smoke test: serves the game, drives it in headless Chromium,
// fails on any console error / uncaught exception, and saves screenshots.
//
//   node scripts/smoke.mjs [outDir]
//
// Needs Playwright (globally installed is fine: NODE_PATH=$(npm root -g)).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { startServer } from './serve-lib.mjs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  playwright = require(path.join(globalRoot, 'playwright'));
}
const { chromium } = playwright;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, '.smoke'));
fs.mkdirSync(outDir, { recursive: true });

const { url: base, close: closeServer } = await startServer(root);


const problems = [];
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function newPage(opts) {
  const ctx = await browser.newContext(opts);
  // Block external font requests so the test is hermetic.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.googleapis|ERR_FAILED|net::/.test(m.text())) problems.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}\n${e.stack}`));
  return { ctx, page };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(outDir, name + '.png') });

try {
  // ---- desktop ---------------------------------------------------------
  {
    const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(base, { waitUntil: 'load' });
    await sleep(1600);
    await shot(page, '01-menu-desktop');

    await page.click('.mode-card[data-mode="marathon"]');
    await sleep(700);
    await shot(page, '02-countdown');
    await sleep(1400);
    // Play a few pieces.
    const keys = ['ArrowLeft', 'ArrowLeft', 'ArrowUp', 'Space', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'Space', 'KeyC', 'ArrowLeft', 'KeyZ', 'Space', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'Space'];
    for (const k of keys) {
      await page.keyboard.press(k);
      await sleep(90);
    }
    // Build a near-complete board directly and clear a tetris to exercise effects.
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let y = 36; y < 40; y++) for (let x = 0; x < 9; x++) g.board[y][x] = 1 + ((x + y) % 7);
      g.active = { type: 'I', rot: 1, x: 7, y: 20 };
      g.lastWasRotation = false;
    });
    await page.keyboard.press('Space');
    await sleep(140);
    await shot(page, '03-tetris-clear');
    await sleep(900);
    await shot(page, '04-gameplay');

    await page.keyboard.press('Escape');
    await sleep(600);
    await shot(page, '05-pause');
    await page.click('#screen-pause [data-open="settings"]');
    await sleep(600);
    await shot(page, '06-settings');
    for (const tab of ['#tab-controls', '#tab-audio', '#tab-look']) {
      await page.click(tab);
      await sleep(350);
      await shot(page, '06-settings-' + tab.slice(5));
    }
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.click('#btn-resume');
    await sleep(1400);
    // Top out quickly to reach the results screen.
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let y = 18; y < 40; y++) for (let x = 0; x < 10; x++) g.board[y][x] = x === (y % 10) ? 0 : 1 + (x % 7);
    });
    await page.keyboard.press('Space');
    await sleep(2400);
    await shot(page, '07-results');
    const state = await page.evaluate(() => window.__tetris.app.screen);
    if (state !== 'results') problems.push('expected results screen, got ' + state);

    await page.click('#btn-res-menu');
    await sleep(500);
    await page.click('#screen-menu [data-open="records"]');
    await sleep(500);
    await shot(page, '08-records');
    await page.keyboard.press('Escape');
    await page.click('#screen-menu [data-open="help"]');
    await sleep(500);
    await shot(page, '09-help');
    await page.keyboard.press('Escape');
    await sleep(300);

    // Sprint + ultra + zen start without errors.
    for (const mode of ['sprint', 'ultra', 'zen']) {
      await page.click(`.mode-card[data-mode="${mode}"]`);
      await sleep(1700);
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowLeft');
        await page.keyboard.press('Space');
        await sleep(60);
      }
      await sleep(200);
      await shot(page, '10-' + mode);
      await page.keyboard.press('Escape');
      await sleep(400);
      await page.click('#btn-quit');
      await sleep(900);
      if (mode === 'zen') {
        await shot(page, '11-zen-results');
        await page.click('#btn-res-menu');
        await sleep(400);
      }
    }

    // Save & quit a Marathon, then continue it from the menu banner.
    await page.click('.mode-card[data-mode="marathon"]');
    await sleep(1600);
    for (const k of ['ArrowLeft', 'Space', 'ArrowRight', 'Space', 'Space']) {
      await page.keyboard.press(k);
      await sleep(70);
    }
    const before = await page.evaluate(() => window.__tetris.app.game.stats.pieces);
    await page.keyboard.press('Escape');
    await sleep(500);
    await page.click('#btn-quit');
    await sleep(700);
    if (await page.locator('#continue').isHidden()) problems.push('continue banner missing after Save & quit');
    await shot(page, '14-continue-banner');
    await page.click('#btn-continue');
    await sleep(1700);
    const after = await page.evaluate(() => ({ s: window.__tetris.app.screen, p: window.__tetris.app.game.stats.pieces }));
    if (after.s !== 'playing' || after.p !== before) problems.push('continue did not restore the run: ' + JSON.stringify(after) + ' vs ' + before);
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.click('#btn-quit');
    await sleep(500);
    await page.click('#btn-discard');
    await sleep(300);
    if (await page.locator('#continue').isVisible()) problems.push('discard did not hide the banner');

    // Sprint split callout at 10 lines.
    await page.click('.mode-card[data-mode="sprint"]');
    await sleep(1700);
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      g.lines = 9;
      for (let x = 0; x < 6; x++) g.board[39][x] = 2;
      g.active = { type: 'I', rot: 0, x: 6, y: 30 };
    });
    await page.keyboard.press('Space');
    await sleep(250);
    await shot(page, '15-sprint-split');
    const splits = await page.evaluate(() => window.__tetris.app.splits.length);
    if (splits !== 1) problems.push('expected one sprint split, got ' + splits);
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.click('#btn-quit');
    await sleep(500);

    // Daily challenge: same first pieces on two starts.
    await page.click('.mode-card[data-mode="daily"]');
    await sleep(500);
    const q1 = await page.evaluate(() => window.__tetris.app.game.queue.join(''));
    await sleep(1400);
    await shot(page, '16-daily');
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.keyboard.press('KeyR');
    await sleep(200);
    const q2 = await page.evaluate(() => window.__tetris.app.game.queue.join(''));
    if (q1 !== q2) problems.push('daily queue differs between attempts');
    await sleep(900);
    await page.evaluate(() => {
      window.__tetris.app.game.time = 119900;
    });
    await sleep(1800);
    await shot(page, '17-daily-results');
    await page.click('#btn-res-menu');
    await sleep(500);
    await shot(page, '18-menu-after-daily');

    // Light wallpaper.
    await page.evaluate(() => {
      window.__tetris.settings.wallpaper = 'daylight';
    });
    await page.click('#screen-menu [data-open="settings"]');
    await page.click('#tab-look');
    await page.click('.swatch[data-value="daylight"]');
    await sleep(300);
    await page.keyboard.press('Escape');
    await sleep(500);
    await shot(page, '12-menu-light');
    await page.click('.mode-card[data-mode="marathon"]');
    await sleep(2000);
    for (const k of ['ArrowLeft', 'Space', 'ArrowRight', 'ArrowRight', 'Space', 'Space']) {
      await page.keyboard.press(k);
      await sleep(80);
    }
    await shot(page, '13-game-light');
    await ctx.close();
  }

  // ---- phone -----------------------------------------------------------
  {
    const { ctx, page } = await newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    await page.goto(base, { waitUntil: 'load' });
    await sleep(1600);
    await shot(page, '20-menu-phone');
    await page.tap('.mode-card[data-mode="marathon"]');
    await sleep(600);
    await shot(page, '21-touch-help');
    await page.tap('#btn-touch-ok');
    await sleep(1800);
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let y = 34; y < 40; y++) for (let x = 0; x < 10; x++) if ((x + y) % 4) g.board[y][x] = 1 + ((x * 3 + y) % 7);
    });
    await sleep(300);
    await shot(page, '22-game-phone');
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    await page.addInitScript(() => {
      localStorage.setItem('lgtetris.settings.v1', JSON.stringify({ touch: 'buttons' }));
      localStorage.setItem('lgtetris.profile.v1', JSON.stringify({ seenTouchHelp: true }));
    });
    await page.goto(base, { waitUntil: 'load' });
    await sleep(800);
    await page.tap('.mode-card[data-mode="sprint"]');
    await sleep(2000);
    await page.tap('[data-action="left"]');
    await page.tap('[data-action="cw"]');
    await page.tap('[data-action="hard"]');
    await sleep(300);
    await shot(page, '23-game-phone-buttons');
    await ctx.close();
  }
  // ---- dark scheme -----------------------------------------------------
  {
    const { ctx, page } = await newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    await page.goto(base, { waitUntil: 'load' });
    await sleep(1600);
    await shot(page, '30-menu-dark');
    await page.click('.mode-card[data-mode="ultra"]');
    await sleep(700);
    await shot(page, '31-countdown-dark');
    await sleep(1300);
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let y = 33; y < 40; y++) for (let x = 0; x < 10; x++) if (x !== 8 && (x + y) % 5) g.board[y][x] = 1 + ((x * 3 + y) % 7);
      for (let y = 36; y < 40; y++) for (let x = 0; x < 10; x++) g.board[y][x] = x === 8 ? 0 : 1 + ((x + y) % 7);
      g.active = { type: 'I', rot: 1, x: 6, y: 21 };
    });
    await page.keyboard.press('Space');
    await sleep(160);
    await shot(page, '32-clear-dark');
    await sleep(1000);
    await shot(page, '33-game-dark');
    await page.keyboard.press('Escape');
    await sleep(600);
    await shot(page, '34-pause-dark');
    await page.click('#screen-pause [data-open="settings"]');
    await page.click('#tab-look');
    await sleep(500);
    await shot(page, '35-settings-look-dark');
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('lgtetris.profile.v1', JSON.stringify({ seenTouchHelp: true })));
    await page.goto(base, { waitUntil: 'load' });
    await sleep(1500);
    await shot(page, '36-menu-phone-dark');
    await page.tap('.mode-card[data-mode="zen"]');
    await sleep(2000);
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let y = 31; y < 40; y++) for (let x = 0; x < 10; x++) if ((x * 7 + y) % 6) g.board[y][x] = 1 + ((x + 2 * y) % 7);
    });
    await sleep(250);
    await shot(page, '37-game-phone-dark');
    await ctx.close();
  }
} catch (e) {
  problems.push('[harness] ' + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  closeServer();
}

if (problems.length) {
  console.error('SMOKE FAILED:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('smoke ok — screenshots in ' + outDir);
