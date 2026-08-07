/**
 * CaptionScroll responsive-layout + speed-control tests
 * (headless Chromium, fake camera/mic).
 *
 * Covers:
 *  - Desktop (1920/1440/1024): 50/50 side-by-side split — teleprompter
 *    left, camera pane + recording controls right; floating PIP hidden
 *    but its <video> still mounted (recording compositor source).
 *  - Tablet (800/768) + mobile (480/375): original PIP layout unchanged.
 *  - Live resize across the 1024px breakpoint, including mid-recording.
 *  - Speed slider 0.1x–1.0x + numeric input: bidirectional sync,
 *    validation, localStorage persistence, real scroll-rate at extremes,
 *    recordings at 0.1x / 0.25x / 0.5x / 1.0x.
 *
 * Runs against `vite preview` serving the production build:
 *   node test/layoutspeed.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4179;
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
  { length: 60 },
  (_, i) =>
    `Line ${i + 1}: welcome to the CaptionScroll speed and layout test script.`
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
  // Intercept all Supabase traffic so tests run offline. The catch-all
  // `{}` deliberately leaves user_trials in the "unknown" state — no
  // trial picker, plain pre-trial behavior (see repo test-mock gotcha).
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

/** Set the range slider the way a user drag does (native setter + input). */
async function setSlider(page, value) {
  await page.$eval(
    '#speed-slider',
    (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    String(value)
  );
}

/** scrollTop of the script display. */
async function scriptScrollTop(page) {
  return page.$eval('.script-display', (el) => el.scrollTop);
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
  /* ---------- 1. Desktop split layout at 1920 / 1440 / 1024 ---------- */
  for (const width of [1920, 1440, 1024]) {
    console.log(`\nDesktop split layout (${width}x900)`);
    const context = await newAppContext(browser, 'starter', {
      width,
      height: 900,
    });
    const page = await context.newPage();
    watchConsole(page, `desktop-${width}`);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });

    check('camera pane rendered', (await page.locator('.camera-pane').count()) === 1);
    const prompter = await page.locator('.prompter-pane').boundingBox();
    const camera = await page.locator('.camera-pane').boundingBox();
    check(
      'panes are side-by-side ~50/50',
      prompter && camera &&
        Math.abs(prompter.width - width / 2) < 8 &&
        Math.abs(camera.width - width / 2) < 8 &&
        camera.x >= prompter.x + prompter.width - 2,
      `(prompter ${Math.round(prompter?.width)}px, camera ${Math.round(camera?.width)}px)`
    );
    check(
      'desktop camera feed visible',
      await page.locator('.camera-video-desktop').isVisible()
    );
    const feed = await page.locator('.camera-pane-feed').boundingBox();
    check(
      'camera feed fills most of the pane height',
      feed && camera && feed.height > camera.height * 0.6,
      `(feed ${Math.round(feed?.height)}px of ${Math.round(camera?.height)}px)`
    );
    check(
      'recording controls inside camera pane',
      (await page.locator('.camera-pane .recording-controls').count()) === 1 &&
        (await page.locator('.recording-controls').count()) === 1
    );
    check(
      'floating PIP hidden but video stays mounted',
      (await page.locator('.camera-pip video').count()) === 1 &&
        !(await page.locator('.camera-pip').isVisible())
    );
    check(
      'controls in left pane (speed slider present)',
      (await page.locator('.prompter-pane #speed-slider').count()) === 1
    );
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 2. Tablet keeps the PIP layout (800 / 768) ---------- */
  for (const width of [800, 768]) {
    console.log(`\nTablet PIP layout (${width}x900)`);
    const context = await newAppContext(browser, 'starter', {
      width,
      height: 900,
    });
    const page = await context.newPage();
    watchConsole(page, `tablet-${width}`);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    check('no camera pane', (await page.locator('.camera-pane').count()) === 0);
    check('floating PIP visible', await page.locator('.camera-pip').isVisible());
    const stage = await page.locator('.stage').boundingBox();
    check(
      'stage spans full width',
      stage && Math.abs(stage.width - width) < 4,
      `(stage ${Math.round(stage?.width)}px)`
    );
    check(
      'recording controls full-width below stage',
      (await page.locator('.recording-controls').count()) === 1 &&
        (await page.locator('.camera-pane .recording-controls').count()) === 0
    );
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 3. Mobile PIP layout unchanged (480 / 375) ---------- */
  for (const width of [480, 375]) {
    console.log(`\nMobile PIP layout (${width}x812)`);
    const context = await newAppContext(browser, 'starter', {
      width,
      height: 812,
    });
    const page = await context.newPage();
    watchConsole(page, `mobile-${width}`);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    check('no camera pane', (await page.locator('.camera-pane').count()) === 0);
    check('floating PIP visible', await page.locator('.camera-pip').isVisible());
    check(
      'recording controls reachable',
      await page.locator('.record-btn.start').isVisible()
    );
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 4. Resize across the breakpoint (no stuck states) ---------- */
  console.log('\nBreakpoint transitions (1280 → 800 → 1280), incl. mid-recording');
  {
    const context = await newAppContext(browser, 'starter', {
      width: 1280,
      height: 800,
    });
    const page = await context.newPage();
    watchConsole(page, 'resize');
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('starts in split layout', (await page.locator('.camera-pane').count()) === 1);

    await page.setViewportSize({ width: 800, height: 800 });
    await page.waitForTimeout(300);
    check(
      'shrink → PIP layout',
      (await page.locator('.camera-pane').count()) === 0 &&
        (await page.locator('.camera-pip').isVisible())
    );
    check('no page scroll after shrink', await noPageScroll(page));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    check(
      'grow → split layout again, camera feed live',
      (await page.locator('.camera-pane').count()) === 1 &&
        (await page.locator('.camera-video-desktop').isVisible())
    );

    // Record across a breakpoint change: the PIP <video> keeps feeding
    // the recorder no matter which layout is active.
    await page.fill('.script-input', LONG_SCRIPT);
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 5000 });
    await page.waitForTimeout(800);
    await page.setViewportSize({ width: 800, height: 800 });
    await page.waitForTimeout(1200);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.download', { timeout: 5000 });
    check(
      'recording survives a mid-take breakpoint change',
      await page.locator('.record-btn.download').isVisible()
    );
    await context.close();
  }

  /* ---------- 5. Speed slider + input sync and validation ---------- */
  console.log('\nSpeed controls (slider + input, 1280x800)');
  {
    const context = await newAppContext(browser, 'starter', {
      width: 1280,
      height: 800,
    });
    const page = await context.newPage();
    watchConsole(page, 'speed');
    await page.goto(BASE + '/app');
    await page.waitForSelector('#speed-slider', { timeout: 8000 });

    check(
      'slider range is 0.1–1.0',
      (await page.getAttribute('#speed-slider', 'min')) === '0.1' &&
        (await page.getAttribute('#speed-slider', 'max')) === '1'
    );

    await setSlider(page, 0.35);
    check(
      'slider → input + readout sync',
      (await page.inputValue('.speed-input')) === '0.35' &&
        (await page.textContent('.speed-value')) === '0.35x'
    );

    await page.fill('.speed-input', '0.67');
    check(
      'input → slider + readout sync',
      Math.abs(parseFloat(await page.inputValue('#speed-slider')) - 0.67) < 0.001 &&
        (await page.textContent('.speed-value')) === '0.67x'
    );

    await page.fill('.speed-input', '0.15');
    check('decimal 0.15 accepted', (await page.textContent('.speed-value')) === '0.15x');

    // Out-of-range and non-numeric entries must NOT change the speed.
    await page.fill('.speed-input', '5');
    check('5 (too fast) rejected', (await page.textContent('.speed-value')) === '0.15x');
    await page.fill('.speed-input', '-0.5');
    check('negative rejected', (await page.textContent('.speed-value')) === '0.15x');
    await page.fill('.speed-input', '0.05');
    check('below 0.1 rejected', (await page.textContent('.speed-value')) === '0.15x');
    await page.fill('.speed-input', '');
    await page.keyboard.type('abc');
    check(
      'letters rejected (number input stays non-numeric-free)',
      (await page.textContent('.speed-value')) === '0.15x'
    );
    // Blur snaps the draft text back to the live value.
    await page.click('.script-input');
    check(
      'blur restores input to the active speed',
      (await page.inputValue('.speed-input')) === '0.15'
    );

    // Persistence across reload.
    await page.fill('.speed-input', '0.25');
    await page.waitForTimeout(200);
    await page.reload();
    await page.waitForSelector('#speed-slider', { timeout: 8000 });
    check(
      'speed persists after reload (localStorage)',
      (await page.textContent('.speed-value')) === '0.25x' &&
        (await page.inputValue('.speed-input')) === '0.25'
    );
    await context.close();
  }

  /* ---------- 6. Real scroll rate at the extremes ---------- */
  console.log('\nScroll engine rate (0.1x and 1.0x)');
  {
    const context = await newAppContext(browser, 'starter', {
      width: 1280,
      height: 800,
    });
    const page = await context.newPage();
    watchConsole(page, 'rate');
    await page.goto(BASE + '/app');
    await page.waitForSelector('#speed-slider', { timeout: 8000 });
    await page.fill('.script-input', LONG_SCRIPT);

    const measured = {};
    for (const speed of [0.1, 1.0]) {
      await page.fill('.speed-input', String(speed));
      await page.click('.reset-btn');
      await page.waitForTimeout(100);
      await page.click('.play-pause-btn'); // ▶ Play
      await page.waitForTimeout(2000);
      await page.click('.play-pause-btn'); // ⏸ Pause
      measured[speed] = await scriptScrollTop(page);
      await page.click('.reset-btn');
    }
    // Expected ≈ speed × 40px/s × 2s, with generous timing slack.
    check(
      '0.1x crawls (~8px over 2s) but MOVES',
      measured[0.1] > 3 && measured[0.1] < 20,
      `(moved ${Math.round(measured[0.1])}px)`
    );
    check(
      '1.0x scrolls ~80px over 2s',
      measured[1.0] > 50 && measured[1.0] < 120,
      `(moved ${Math.round(measured[1.0])}px)`
    );
    check(
      'speeds scale proportionally',
      measured[1.0] > measured[0.1] * 5,
      `(${Math.round(measured[0.1])}px vs ${Math.round(measured[1.0])}px)`
    );
    await context.close();
  }

  /* ---------- 7. Recordings at 0.1x / 0.25x / 0.5x / 1.0x ---------- */
  console.log('\nRecording at each checklist speed (Pro, 1440x900)');
  {
    const context = await newAppContext(browser, 'pro', {
      width: 1440,
      height: 900,
    });
    const page = await context.newPage();
    watchConsole(page, 'record-speeds');
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    await page.fill('.script-input', LONG_SCRIPT);

    let takesBefore = 0;
    for (const speed of [0.1, 0.25, 0.5, 1.0]) {
      await page.fill('.speed-input', String(speed));
      await page.click('.reset-btn');
      await page.click('.record-btn.start');
      await page.waitForSelector('.rec-badge', { timeout: 5000 });
      await page.waitForTimeout(1600);
      const moved = await scriptScrollTop(page);
      await page.click('.record-btn.stop');
      await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
      const takes = await page.locator('.take-chip').count();
      check(
        `recorded a take at ${speed}x with auto-scroll (${Math.round(moved)}px)`,
        takes === takesBefore + 1 && moved > 1
      );
      takesBefore = takes;
    }
    check('all four takes kept (Pro)', takesBefore === 4);
    await context.close();
  }

  /* ---------- 8. Console errors ---------- */
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
