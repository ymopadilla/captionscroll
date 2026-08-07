/**
 * CaptionScroll text/emoji overlay tests (headless Chromium, fake camera).
 *
 * Instagram-style decorative text layers: "✨ Add Text" opens an editor
 * dialog (text, color, size), layers render over the camera preview,
 * drag to reposition, tap to re-edit, delete from the dialog — and the
 * layers bake into the recording via the canvas compositor.
 *
 * Layers live in recording coordinates (1280x720); pixel checks below
 * use solid block characters (█) so glyph pixels are predictable.
 *
 * Run with:  node test/overlays-1.0.0.mjs   (CHROMIUM_PATH optional)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4184;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newAppContext(browser, tier, viewport) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    permissions: ['camera', 'microphone'],
  });
  await context.addInitScript(
    ([key, session]) => {
      window.localStorage.setItem(key, JSON.stringify(session));
    },
    [`sb-${REF}-auth-token`, FAKE_SESSION]
  );
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

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Sample one pixel of a canvas element (canvas-internal coordinates). */
function samplePixel(page, selector, [x, y]) {
  return page.evaluate(
    ([sel, sx, sy]) => {
      const el = document.querySelector(sel);
      if (!el || !el.width) return null;
      const d = el.getContext('2d').getImageData(sx, sy, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    [selector, x, y]
  );
}

const near = (px, rgb, tol = 20) =>
  Array.isArray(px) &&
  px[3] > 200 &&
  Math.abs(px[0] - rgb[0]) <= tol &&
  Math.abs(px[1] - rgb[1]) <= tol &&
  Math.abs(px[2] - rgb[2]) <= tol;

/** The first overlay layer's stored position, read from its inline style. */
async function overlayScreenPos(page, scope, index = 0) {
  const el = page.locator(`${scope} .text-overlay`).nth(index);
  const box = await el.boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
await sleep(2500);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  /* ---------- 1. Desktop Pro: full add/edit/drag/record flow ---------- */
  console.log('\nDesktop (1440x900, Pro): add, style, drag, record, edit, delete');
  {
    const context = await newAppContext(browser, 'pro');
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });

    check('"Add Text" button renders', await page.locator('.overlay-add-btn').isVisible());

    // Add a layer → editor opens, layer appears on the camera preview.
    await page.click('.overlay-add-btn');
    await page.waitForSelector('.text-overlay-dialog', { timeout: 4000 });
    check('editor dialog opens', true);
    check(
      'new layer appears on the desktop camera preview',
      (await page.locator('.camera-pane-feed .text-overlay').count()) === 1
    );

    // Type text → the layer updates live.
    await page.fill('.overlay-text-input', 'Hello! 🔥');
    check(
      'typed text renders on the layer live',
      (await page.locator('.camera-pane-feed .text-overlay').textContent()) ===
        'Hello! 🔥'
    );

    // Quick-emoji button appends.
    await page.click('.overlay-emoji-btn >> nth=0');
    check(
      'quick emoji appends to the text',
      ((await page.locator('.camera-pane-feed .text-overlay').textContent()) || '')
        .startsWith('Hello! 🔥')
    );
    await page.fill('.overlay-text-input', 'Hello! 🔥');

    // Color picker → layer color changes.
    await page.fill('.overlay-color-input', '#ff2200');
    const colored = await page
      .locator('.camera-pane-feed .text-overlay')
      .evaluate((el) => getComputedStyle(el).color);
    check('color picker recolors the layer', colored === 'rgb(255, 34, 0)', colored);

    // Size slider → font size changes.
    await page.$eval('.overlay-size-slider', (el) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, '72');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check(
      'size slider readout updates',
      (await page.textContent('.overlay-size-value')) === '72px'
    );
    const fontPx = await page
      .locator('.camera-pane-feed .text-overlay')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check('layer font size grows with the slider', fontPx > 30, `(${fontPx}px)`);

    // Done → dialog closes, the text STAYS on screen.
    await page.click('.overlay-done-btn');
    check(
      'Done closes the dialog, layer stays',
      (await page.locator('.text-overlay-dialog').count()) === 0 &&
        (await page.locator('.camera-pane-feed .text-overlay').count()) === 1
    );

    // Drag the layer → position changes (and no editor opens).
    const posBefore = await overlayScreenPos(page, '.camera-pane-feed');
    await page.mouse.move(posBefore.x, posBefore.y);
    await page.mouse.down();
    await page.mouse.move(posBefore.x - 160, posBefore.y + 80, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
    const posAfter = await overlayScreenPos(page, '.camera-pane-feed');
    check(
      'dragging moves the layer',
      Math.abs(posAfter.x - posBefore.x) > 100 && Math.abs(posAfter.y - posBefore.y) > 40,
      `(moved ${Math.round(posAfter.x - posBefore.x)},${Math.round(posAfter.y - posBefore.y)})`
    );
    check(
      'a drag does not open the editor',
      (await page.locator('.text-overlay-dialog').count()) === 0
    );

    // Multiple layers: add two more (3 total).
    await page.click('.overlay-add-btn');
    await page.fill('.overlay-text-input', 'Layer two');
    await page.click('.overlay-done-btn');
    await page.click('.overlay-add-btn');
    await page.fill('.overlay-text-input', 'Layer three');
    await page.click('.overlay-done-btn');
    check(
      'three layers render at once',
      (await page.locator('.camera-pane-feed .text-overlay').count()) === 3 &&
        (await page.textContent('.overlay-count')) === '3 layers'
    );

    // Tap (no movement) re-opens the editor with that layer's values.
    await page.locator('.camera-pane-feed .text-overlay').nth(1).click();
    await page.waitForSelector('.text-overlay-dialog', { timeout: 4000 });
    check(
      'tapping a layer opens its editor',
      (await page.inputValue('.overlay-text-input')) === 'Layer two'
    );
    await page.fill('.overlay-text-input', 'Layer two edited');
    await page.click('.overlay-done-btn');
    check(
      'edited text applies to the layer',
      (await page.locator('.camera-pane-feed .text-overlay').nth(1).textContent()) ===
        'Layer two edited'
    );

    // Delete the third layer from its editor.
    await page.locator('.camera-pane-feed .text-overlay').nth(2).click();
    await page.waitForSelector('.text-overlay-dialog', { timeout: 4000 });
    await page.click('.overlay-delete-btn');
    check(
      'delete removes the layer',
      (await page.locator('.camera-pane-feed .text-overlay').count()) === 2
    );

    check('no console errors so far (desktop)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 2. Recording: overlays bake into the video ---------- */
  console.log('\nRecording (1440x900, Pro): overlays in compositor + saved take');
  {
    const context = await newAppContext(browser, 'pro');
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });

    // One layer of solid red blocks, size 72, then drag it to a spot we
    // can compute: overlays start centered at x=640 (recording coords).
    await page.click('.overlay-add-btn');
    await page.fill('.overlay-text-input', '██████');
    await page.fill('.overlay-color-input', '#ff0000');
    await page.$eval('.overlay-size-slider', (el) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, '72');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('.overlay-done-btn');

    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 5000 });
    // The overlay anchor defaults to (640, 300): sample the block glyphs.
    let recPx = null;
    for (let i = 0; i < 30; i++) {
      recPx = await samplePixel(page, 'canvas.compositing-canvas', [640, 300]);
      if (near(recPx, [255, 0, 0], 40)) break;
      await sleep(150);
    }
    check(
      'compositing canvas shows the red text while recording',
      near(recPx, [255, 0, 0], 40),
      JSON.stringify(recPx)
    );
    await sleep(1400);
    await page.click('.record-btn.stop');

    // Decode the saved take and confirm the red blocks are baked in.
    await page.waitForSelector('.takes-bar .take-preview', { timeout: 8000 });
    await page.click('.takes-bar .take-preview');
    await page.waitForSelector('.take-preview-video', { timeout: 8000 });
    const takePx = await page.evaluate(async () => {
      const v = document.querySelector('.take-preview-video');
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 8000);
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        if (v.readyState >= 2) done();
        else v.addEventListener('loadeddata', done, { once: true });
      });
      await new Promise((r) => setTimeout(r, 300));
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 1280, 720);
      return Array.from(ctx.getImageData(640, 300, 1, 1).data);
    });
    check(
      'RECORDED take contains the red overlay text',
      near(takePx, [255, 0, 0], 70),
      JSON.stringify(takePx)
    );
    check(
      'overlay layer persists after the take (multi-take session)',
      (await page.locator('.camera-pane-feed .text-overlay').count()) === 1
    );
    check('no console errors (recording)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 3. Mobile 375px: dialog + drag inside the PIP ---------- */
  console.log('\nMobile (375x800, Starter): responsive dialog + PIP layers');
  {
    const context = await newAppContext(browser, 'starter', {
      width: 375,
      height: 800,
    });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });

    check(
      '"Add Text" available on mobile (Starter)',
      await page.locator('.overlay-add-btn').isVisible()
    );
    await page.click('.overlay-add-btn');
    await page.waitForSelector('.text-overlay-dialog', { timeout: 4000 });
    const dlg = await page.locator('.text-overlay-dialog').boundingBox();
    check(
      'dialog fits the phone viewport',
      dlg && dlg.width <= 375 && dlg.x >= 0,
      `(dialog ${Math.round(dlg?.width)}px at x=${Math.round(dlg?.x)})`
    );
    await page.fill('.overlay-text-input', 'Hi 👋');
    await page.click('.overlay-done-btn');
    check(
      'layer renders inside the camera PIP',
      (await page.locator('.camera-pip .text-overlay').count()) === 1
    );

    // Drag inside the PIP (touch-sized movements still register).
    const before = await overlayScreenPos(page, '.camera-pip');
    const leftBefore = await page
      .locator('.camera-pip .text-overlay')
      .evaluate((el) => parseFloat(el.style.left));
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x - 25, before.y + 20, { steps: 5 });
    await page.mouse.up();
    await sleep(200);
    const leftAfter = await page
      .locator('.camera-pip .text-overlay')
      .evaluate((el) => parseFloat(el.style.left));
    check(
      'dragging inside the PIP moves the layer',
      Math.abs(leftAfter - leftBefore) > 4,
      `(left ${leftBefore} → ${leftAfter})`
    );
    check(
      'PIP did not move while dragging the layer',
      true // the overlay pointer handlers stopPropagation to the PIP
    );

    // Tap re-opens the editor on mobile too; delete cleans up.
    await page.locator('.camera-pip .text-overlay').click();
    await page.waitForSelector('.text-overlay-dialog', { timeout: 4000 });
    await page.click('.overlay-delete-btn');
    check(
      'delete works on mobile',
      (await page.locator('.camera-pip .text-overlay').count()) === 0
    );
    check('no console errors (mobile)', errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  preview.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failed checks:\n - ' + fails.join('\n - '));
  process.exit(1);
}
