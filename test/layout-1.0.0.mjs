/**
 * CaptionScroll 1.0.0 layout tests (headless Chromium, fake camera/mic).
 *
 * The 1.0.0 layout: teleprompter stage on top (full width, 50%+ of the
 * viewport on desktop), camera feed + script entry row below it on
 * desktop (≥1024px), and a full-width controls bar fixed to the bottom
 * at every breakpoint. Phones/tablets keep the floating camera PIP,
 * docked to the stage's bottom-right safe zone; while a mobile
 * recording is rolling the controls + script entry hide, the stage
 * expands, and a floating pause button (plus tap-to-pause on the
 * script) pauses the take and brings the controls back.
 *
 * Run with:  node test/layout-1.0.0.mjs   (CHROMIUM_PATH optional)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4183;
const BASE = `http://localhost:${PORT}`;
const REF = 'rgpgascbdmbpkgsmgnmx';

let passed = 0;
let failed = 0;
const fails = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const FAKE_SESSION = {
  access_token: 'fake-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 86400 * 30,
  refresh_token: 'fake-refresh-token',
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  },
};

const LONG_SCRIPT = Array.from(
  { length: 80 },
  (_, i) => `Line ${i + 1}: welcome to the CaptionScroll 1.0.0 layout test script.`
).join('\n');

const consoleErrors = [];

async function newAppContext(browser, tier, viewport) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  await context.addInitScript(
    ([key, session]) => {
      window.localStorage.setItem(key, JSON.stringify(session));
    },
    [`sb-${REF}-auth-token`, FAKE_SESSION]
  );
  // Catch-all {} leaves user_trials "unknown" → plain pre-trial behavior.
  await context.route(`**${REF}.supabase.co/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/rest/v1/users')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ subscription_tier: tier }),
      });
    }
    if (url.includes('/rest/v1/user_scripts')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    if (url.includes('/auth/v1/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_SESSION),
      });
    }
    return route.fulfill({ status: 200, body: '{}' });
  });
  return context;
}

function watchConsole(page, label) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[${label}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => consoleErrors.push(`[${label}] ${err.message}`));
}

async function noPageScroll(page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      document.documentElement.scrollHeight <= window.innerHeight + 1
  );
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  /* ---------- 1. Desktop layout at 1920 / 1440 / 1024 ---------- */
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1024, 800],
  ]) {
    console.log(`\nDesktop layout (${width}x${height})`);
    const context = await newAppContext(browser, 'starter', { width, height });
    const page = await context.newPage();
    watchConsole(page, `desktop-${width}`);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    await page.fill('.script-input', LONG_SCRIPT);

    // Teleprompter on top, full width, 50%+ of the viewport tall.
    const stage = await page.locator('.stage').boundingBox();
    check(
      'stage full width on top',
      stage && Math.abs(stage.width - width) < 4 && stage.y < height * 0.15,
      `(stage ${Math.round(stage?.width)}px wide at y=${Math.round(stage?.y)})`
    );
    check(
      'stage is 50%+ of the viewport height',
      stage && stage.height >= height * 0.5 - 2,
      `(stage ${Math.round(stage?.height)}px of ${height}px)`
    );

    // Camera feed left, script entry right, both below the stage.
    const feed = await page.locator('.camera-pane-feed').boundingBox();
    const entry = await page.locator('.script-input-pane').boundingBox();
    check(
      'camera + script entry row sits below the stage',
      feed && entry &&
        feed.y >= stage.y + stage.height - 2 &&
        Math.abs(entry.y - feed.y) < 4,
      `(feed y=${Math.round(feed?.y)}, entry y=${Math.round(entry?.y)})`
    );
    check(
      'camera left (wider) of the compact script entry',
      feed && entry &&
        entry.x >= feed.x + feed.width - 2 &&
        feed.width > entry.width &&
        entry.width <= 540,
      `(feed ${Math.round(feed?.width)}px, entry ${Math.round(entry?.width)}px)`
    );
    check(
      'desktop camera <video> is live',
      await page
        .locator('.camera-video-desktop')
        .evaluate((v) => v.readyState >= 2 && v.videoWidth > 0)
        .catch(() => false)
    );

    // Full-width controls bar fixed to the bottom.
    const bar = await page.locator('.recording-controls-bar').boundingBox();
    check(
      'controls bar spans the full width at the very bottom',
      bar &&
        Math.abs(bar.width - width) < 4 &&
        Math.abs(bar.y + bar.height - height) < 2 &&
        bar.y >= feed.y + feed.height - 2,
      `(bar ${Math.round(bar?.width)}px, bottom=${Math.round(bar?.y + bar?.height)})`
    );
    check(
      'controls bar holds the main controls AND the recording row',
      (await page.locator('.recording-controls-bar .controls').count()) === 1 &&
        (await page.locator('.recording-controls-bar .recording-controls').count()) === 1
    );

    // Script entry textarea scrolls internally, never the page.
    check(
      'script textarea scrolls internally',
      await page
        .locator('.script-input')
        .evaluate((el) => el.scrollHeight > el.clientHeight)
    );
    // Manual scroll inside the teleprompter must not scroll the page.
    await page.locator('.script-display').hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
    check(
      'manual teleprompter scroll moves the script, not the page',
      (await page.locator('.script-display').evaluate((el) => el.scrollTop)) > 100 &&
        (await noPageScroll(page))
    );
    check('no page scroll', await noPageScroll(page));

    // Auto-scroll works in this layout.
    await page.click('.play-pause-btn'); // ▶ Play
    await page.waitForTimeout(1200);
    const before = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    await page.waitForTimeout(1000);
    const afterPos = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    await page.click('.play-pause-btn'); // ⏸ Pause
    check('auto-scroll advances', afterPos > before, `(${before} → ${afterPos})`);

    await context.close();
  }

  /* ---------- 2. Tablet 800x600 + mobile 375x800 ---------- */
  for (const [width, height] of [
    [800, 600],
    [375, 800],
  ]) {
    console.log(`\nMobile/tablet layout (${width}x${height})`);
    const context = await newAppContext(browser, 'starter', { width, height });
    const page = await context.newPage();
    watchConsole(page, `mobile-${width}`);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    await page.fill('.script-input', LONG_SCRIPT);

    check(
      'no desktop bottom row',
      (await page.locator('.workspace-bottom').count()) === 0
    );
    const stage = await page.locator('.stage').boundingBox();
    check(
      'stage spans the full width',
      stage && Math.abs(stage.width - width) < 4,
      `(stage ${Math.round(stage?.width)}px)`
    );
    // PIP docks to the stage's bottom-right corner by default.
    const pip = await page.locator('.camera-pip').boundingBox();
    check(
      'PIP docked bottom-right of the stage',
      pip &&
        Math.abs(pip.x + pip.width - (stage.x + stage.width - 16)) < 4 &&
        Math.abs(pip.y + pip.height - (stage.y + stage.height - 16)) < 4,
      `(pip bottom-right ${Math.round(pip?.x + pip?.width)},${Math.round(pip?.y + pip?.height)})`
    );
    check(
      'controls bar visible below',
      await page.locator('.recording-controls-bar').isVisible() &&
        (await page.locator('.record-btn.start').isVisible())
    );
    // Script text keeps a safe zone above the PIP (bottom padding).
    check(
      'script display reserves the bottom safe zone',
      (await page
        .locator('.script-display')
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))) >= 120
    );
    // Auto-scroll on mobile.
    await page.click('.play-pause-btn');
    await page.waitForTimeout(1500);
    const moved = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    await page.click('.play-pause-btn');
    check('auto-scroll advances on mobile', moved > 3, `(moved ${moved}px)`);
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 3. Mobile recording: focus mode + pause flows ---------- */
  console.log('\nMobile recording focus (375x800, Starter)');
  {
    const context = await newAppContext(browser, 'starter', {
      width: 375,
      height: 800,
    });
    const page = await context.newPage();
    watchConsole(page, 'mobile-rec');
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    await page.fill('.script-input', LONG_SCRIPT);

    const stageBefore = await page.locator('.stage').boundingBox();
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 5000 });

    check(
      'controls bar hides while the take is rolling',
      !(await page.locator('.recording-controls-bar').isVisible())
    );
    check(
      'script entry hides while the take is rolling',
      !(await page.locator('.script-input').isVisible())
    );
    const stageDuring = await page.locator('.stage').boundingBox();
    check(
      'teleprompter expands to fill the freed space',
      stageDuring.height > stageBefore.height + 100,
      `(${Math.round(stageBefore.height)} → ${Math.round(stageDuring.height)}px)`
    );
    const pip = await page.locator('.camera-pip').boundingBox();
    check(
      'PIP sits in the bottom safe zone while recording',
      pip && pip.y + pip.height >= stageDuring.y + stageDuring.height * 0.72,
      `(pip bottom ${Math.round(pip?.y + pip?.height)})`
    );
    check(
      'floating pause button visible',
      await page.locator('.mobile-pause-button').isVisible()
    );

    // Tap the teleprompter → pause: scroll freezes, controls come back.
    await page.waitForTimeout(900);
    await page.click('.script-display', { position: { x: 150, y: 200 } });
    await page.waitForSelector('.mobile-paused-note', { timeout: 4000 });
    check('tap-to-pause shows the paused note', true);
    check(
      'pausing brings the controls back (Stop is reachable)',
      await page.locator('.record-btn.stop').isVisible()
    );
    const p1 = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    await page.waitForTimeout(800);
    const p2 = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    check('scroll is frozen while paused', Math.abs(p2 - p1) < 1, `(${p1} vs ${p2})`);
    check(
      'REC badge stays on while paused (still recording)',
      await page.locator('.rec-badge').isVisible()
    );

    // Resume from the floating button → focus mode returns.
    await page.click('.mobile-pause-button'); // ▶ Resume
    await page.waitForTimeout(400);
    check(
      'resume hides the controls again',
      !(await page.locator('.recording-controls-bar').isVisible()) &&
        (await page.locator('.mobile-paused-note').count()) === 0
    );
    const r1 = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    await page.waitForTimeout(900);
    const r2 = await page.locator('.script-display').evaluate((el) => el.scrollTop);
    check('scroll resumes after resume', r2 > r1, `(${r1} → ${r2})`);

    // Pause again (button) and stop — layout intact afterwards.
    await page.click('.mobile-pause-button'); // ⏸ Pause
    await page.waitForSelector('.record-btn.stop', { timeout: 4000 });
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.download', { timeout: 5000 });
    check('take saved after pause/resume/stop cycle', true);
    check(
      'controls + script entry restored after stopping',
      (await page.locator('.recording-controls-bar').isVisible()) &&
        (await page.locator('.script-input').isVisible())
    );
    check('no page scroll after the full cycle', await noPageScroll(page));
    check(
      'pause button gone once recording ends',
      (await page.locator('.mobile-pause-button').count()) === 0
    );
    await context.close();
  }

  /* ---------- 4. Desktop recording: controls stay visible ---------- */
  console.log('\nDesktop recording keeps the controls bar (1440x900)');
  {
    const context = await newAppContext(browser, 'starter', {
      width: 1440,
      height: 900,
    });
    const page = await context.newPage();
    watchConsole(page, 'desktop-rec');
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    await page.fill('.script-input', LONG_SCRIPT);
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 5000 });
    check(
      'controls bar stays visible during a desktop take',
      await page.locator('.recording-controls-bar').isVisible()
    );
    check(
      'no floating pause button on desktop',
      (await page.locator('.mobile-pause-button').count()) === 0
    );
    await page.waitForTimeout(1200);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.download', { timeout: 5000 });
    check('desktop take saved', true);
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 5. Console errors ---------- */
  console.log('\nConsole');
  check(
    'zero console errors across all scenarios',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | ')
  );
} finally {
  await browser.close();
  preview.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failed checks:\n - ' + fails.join('\n - '));
  process.exit(1);
}
