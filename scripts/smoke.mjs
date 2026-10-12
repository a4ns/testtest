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
  // Software WebGL is too slow for real players, so the game skips it; let
  // the smoke test render the Liquid (WebGL) path anyway.
  await ctx.addInitScript(() => localStorage.setItem('lgtetris.debug.forcegl', '1'));
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
    // A brand-new keyboard player sees the controls hint through READY.
    const hint = await page.evaluate(() => {
      const h = document.getElementById('keys-hint');
      return !h.hidden && !h.classList.contains('is-leaving') && h.textContent.length > 0;
    });
    if (!hint) problems.push('keys hint not shown to a new player');
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
    // Compare seeds (the live queue moves as soon as play starts).
    const q1 = await page.evaluate(() => window.__tetris.app.game.seed);
    await sleep(1400);
    await shot(page, '16-daily');
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.keyboard.press('KeyR');
    await sleep(200);
    const q2 = await page.evaluate(() => window.__tetris.app.game.seed);
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
  // ---- progression, confirm, share, pace ---------------------------------
  {
    const { ctx, page } = await newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      // A seasoned player: level 5+ and a Sprint best with per-line times.
      localStorage.setItem('lgtetris.profile.v1', JSON.stringify({ games: 40, lines: 600, tetrises: 30, tspins: 10, achievements: { tetris: 1 } }));
      const lineTimes = Array.from({ length: 40 }, (_, i) => (i + 1) * 1500);
      localStorage.setItem('lgtetris.records.v1', JSON.stringify({ sprint: [{ score: 0, lines: 40, level: 1, time: 60000, pieces: 100, date: 1, lineTimes, splits: [15000, 30000, 45000, 60000] }] }));
    });
    await page.goto(base, { waitUntil: 'load' });
    await sleep(1200);
    const lvl = await page.textContent('#player-level');
    if (!/Level [5-9]/.test(lvl)) problems.push('player level not shown as expected: ' + lvl);
    await shot(page, '40-menu-level');

    // Skins: pick Neon, play a moment, check the sprite set switched.
    await page.click('#screen-menu [data-open="settings"]');
    await page.click('#tab-look');
    await sleep(300);
    await shot(page, '41-skins');
    await page.click('.skin[data-value="neon"]');
    await sleep(200);
    const skin = await page.evaluate(() => window.TetrisRenderer.sprites.skin);
    if (skin !== 'neon') problems.push('skin did not switch: ' + skin);
    if (!(await page.locator('.skin[data-value="pearl"]').isDisabled())) problems.push('pearl should be locked below level 8');
    await page.keyboard.press('Escape');
    await sleep(300);

    // Sprint pace vs the stored best.
    await page.click('.mode-card[data-mode="sprint"]');
    await sleep(1700);
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let x = 0; x < 6; x++) g.board[39][x] = 2;
      g.active = { type: 'I', rot: 0, x: 6, y: 30 };
    });
    await page.keyboard.press('Space');
    await sleep(300);
    const pace = await page.evaluate(() => [document.getElementById('st-c-l').textContent, document.getElementById('st-c').textContent]);
    if (pace[0] !== 'Pace' || !/^[−+]\d/.test(pace[1])) problems.push('sprint pace not shown: ' + pace.join(' '));
    await shot(page, '42-sprint-pace');
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.click('#btn-quit');
    await sleep(500);

    // Marathon: save with progress, then the confirm sheet guards a new start.
    await page.click('.mode-card[data-mode="marathon"]');
    await sleep(1700);
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      g.stats.pieces = 30;
      g.score = 4321;
    });
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.click('#btn-quit');
    await sleep(500);
    await page.click('.mode-card[data-mode="marathon"]');
    await sleep(500);
    if (!(await page.locator('#screen-confirm').evaluate((e) => e.classList.contains('is-open')))) problems.push('confirm sheet did not open');
    await shot(page, '43-confirm');
    await page.click('#btn-confirm-cancel');
    await sleep(1700);
    const cont = await page.evaluate(() => [window.__tetris.app.screen, window.__tetris.app.game && window.__tetris.app.game.score]);
    if (cont[0] !== 'playing' || cont[1] !== 4321) problems.push('"Continue saved run" did not resume: ' + JSON.stringify(cont));

    // Finish via top-out to see XP on results, then share.
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      for (let y = 18; y < 40; y++) for (let x = 0; x < 10; x++) g.board[y][x] = x === y % 10 ? 0 : 1 + (x % 7);
    });
    await page.keyboard.press('Space');
    await sleep(2300);
    const xp = await page.textContent('#res-xp-gain');
    if (!/^\+\d/.test(xp)) problems.push('xp gain missing: ' + xp);
    await page.click('#btn-res-share');
    await sleep(300);
    const note = await page.textContent('#res-share-note');
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (!/Copied/.test(note) || !/Liquid Glass Tetris/.test(clip)) problems.push('share failed: ' + note + ' / ' + clip);
    await shot(page, '44-results-xp');
    await ctx.close();
  }

  // ---- loop 4 regressions ---------------------------------------------
  {
    const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await page.addInitScript(() => {
      // Gesture timing needs real frame rates, not software WebGL.
      localStorage.removeItem('lgtetris.debug.forcegl');
      localStorage.setItem('lgtetris.profile.v1', JSON.stringify({ seenTouchHelp: true }));
      localStorage.setItem('lgtetris.records.v1', JSON.stringify({ marathon: [{ score: 100, lines: 1, level: 1, time: 5000, pieces: 6, date: 1 }] }));
    });
    await page.goto(base, { waitUntil: 'load' });
    await sleep(1200);
    await page.evaluate(() => window.__tetris.startGame('marathon'));
    await sleep(1900);
    // Touch: drag sideways, then flick down at the end -> hard drop.
    const flick = await page.evaluate(async () => {
      const g = window.__tetris.app.game;
      const el = document.getElementById('game');
      const r = document.getElementById('board-shell').getBoundingClientRect();
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const ev = (type, x, y, id = 1) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: id === 1 }));
      const before = g.stats.pieces;
      let x = r.left + r.width / 2;
      const y = r.top + r.height * 0.3;
      ev('pointerdown', x, y);
      for (let i = 0; i < 8; i++) {
        await wait(25);
        x += 14;
        ev('pointermove', x, y);
      }
      await wait(20);
      ev('pointermove', x + 2, y + 40);
      await wait(16);
      ev('pointermove', x + 3, y + 100);
      await wait(16);
      ev('pointerup', x + 3, y + 140);
      await wait(50);
      const dropped = g.stats.pieces - before;
      // Two-finger tap -> 180 (on a T: an O can't rotate).
      g.active = { type: 'T', rot: 0, x: 3, y: 22 };
      const rot0 = g.active.rot;
      const cx = r.left + r.width / 2;
      ev('pointerdown', cx - 30, y, 5);
      await wait(30);
      ev('pointerdown', cx + 30, y, 6);
      await wait(60);
      ev('pointerup', cx + 30, y, 6);
      ev('pointerup', cx - 30, y, 5);
      await wait(30);
      return { dropped, turned: (g.active.rot - rot0 + 4) % 4 };
    });
    if (flick.dropped !== 1) problems.push('drag-then-flick did not hard drop: ' + JSON.stringify(flick));
    if (flick.turned !== 2) problems.push('two-finger tap did not rotate 180: ' + JSON.stringify(flick));
    // Passing the best score mid-run gets a callout.
    const best = await page.evaluate(async () => {
      const g = window.__tetris.app.game;
      g.score = 150;
      g.hardDrop();
      await new Promise((r) => setTimeout(r, 120));
      return document.getElementById('callouts').textContent;
    });
    if (!/NEW BEST/.test(best)) problems.push('no NEW BEST callout: ' + best);
    await shot(page, '50-new-best');
    // Save & quit, then the discard X asks first.
    await page.evaluate(() => {
      const g = window.__tetris.app.game;
      g.stats.pieces = 20;
      window.__tetris.quit();
    });
    await sleep(700);
    await page.tap('#btn-discard');
    await sleep(500);
    if (!(await page.locator('#screen-confirm').evaluate((e) => e.classList.contains('is-open')))) problems.push('discard did not ask for confirmation');
    await page.tap('#btn-confirm-cancel');
    await sleep(400);
    if (await page.locator('#continue').isHidden()) problems.push('cancelled discard still removed the save');
    await ctx.close();
  }
  {
    // Solid glass: primary buttons keep their blue fill.
    const { ctx, page } = await newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('lgtetris.settings.v1', JSON.stringify({ glass: 'low' })));
    await page.goto(base, { waitUntil: 'load' });
    await sleep(900);
    await page.evaluate(() => window.__tetris.startGame('ultra'));
    await sleep(1800);
    await page.keyboard.press('Escape');
    await sleep(700);
    const bg = await page.evaluate(() => getComputedStyle(document.getElementById('btn-resume')).backgroundImage);
    if (!/gradient/.test(bg)) problems.push('solid glass primary button lost its fill: ' + bg);
    await shot(page, '51-solid-pause');
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
