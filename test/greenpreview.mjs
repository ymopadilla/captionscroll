/**
 * CaptionScroll live green-screen preview tests.
 *
 * Verifies (against `vite preview` serving the production build, with
 * Supabase mocked and the MediaPipe CDN replaced by a deterministic
 * segmentation stub) that background effects render on the LIVE camera
 * preview — not just in the recording:
 *   - selecting Blur / Solid Color / Custom Image paints the preview
 *     overlay canvas immediately (desktop pane + mobile PIP)
 *   - toggling between effects updates the preview in real time
 *   - toggling Off restores the raw camera (overlay hidden)
 *   - the recording compositor shows the effect from the first frames
 *   - a recorded take decodes to the same background as the preview
 *
 * The stub feeds the compositor a known frame (uniform #3355aa with a
 * #ffcc00 square at the center of the person region) and a fixed elliptical
 * person mask, so background/person pixels are exactly predictable.
 *
 * Run with:  node test/greenpreview.mjs   (CHROMIUM_PATH env var optional)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------
 * Deterministic SelfieSegmentation stub, served in place of the CDN
 * script. Produces:
 *   image: uniform #3355aa, with a 200x200 #ffcc00 square centered at
 *          (640, 360) — inside the person mask, so the "person" pixels
 *          are exactly #ffcc00 where sampled
 *   mask:  opaque ellipse at (640, 446), rx 230 / ry 302 — transparent
 *          elsewhere, matching how the compositor keys the person
 * ------------------------------------------------------------------ */
const SEG_STUB = `
window.SelfieSegmentation = class {
  constructor() { this._cb = null; this._mask = null; this._frame = null; }
  setOptions() {}
  onResults(cb) { this._cb = cb; }
  async send() {
    const w = 1280, h = 720;
    if (!this._mask) {
      const m = document.createElement('canvas');
      m.width = w; m.height = h;
      const mc = m.getContext('2d');
      mc.clearRect(0, 0, w, h);
      mc.fillStyle = '#ffffff';
      mc.beginPath();
      mc.ellipse(w * 0.5, h * 0.62, w * 0.18, h * 0.42, 0, 0, Math.PI * 2);
      mc.fill();
      this._mask = m;
      const f = document.createElement('canvas');
      f.width = w; f.height = h;
      const fc = f.getContext('2d');
      fc.fillStyle = '#3355aa';
      fc.fillRect(0, 0, w, h);
      fc.fillStyle = '#ffcc00';
      fc.fillRect(w / 2 - 100, h / 2 - 100, 200, 200);
      this._frame = f;
    }
    if (this._cb) this._cb({ segmentationMask: this._mask, image: this._frame });
  }
  close() {}
};
`;

// Sample points (canvas pixel space, 1280x720):
//   BG (64,64)     — far outside the person ellipse; 64px in so the
//                    16px background blur has no transparent-edge falloff
//   PERSON (640,430) — inside both the yellow square and the ellipse
const BG = [64, 64];
const PERSON = [640, 430];
const CAMERA_BLUE = [0x33, 0x55, 0xaa];
const PERSON_YELLOW = [0xff, 0xcc, 0x00];
const GS_GREEN = [0x0b, 0x8a, 0x43];
const GS_BLUE = [0x1e, 0x5a, 0xa8];
const GS_RED = [0xc6, 0x28, 0x28];
const UPLOAD_ORANGE = [0xe0, 0x70, 0x20];

const near = (px, rgb, tol = 8) =>
  Array.isArray(px) &&
  px[3] > 200 &&
  Math.abs(px[0] - rgb[0]) <= tol &&
  Math.abs(px[1] - rgb[1]) <= tol &&
  Math.abs(px[2] - rgb[2]) <= tol;

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

/** Poll a canvas pixel until it matches, or time out. Returns last px. */
async function waitForPixel(page, selector, point, rgb, tol = 8, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let px = null;
  while (Date.now() < deadline) {
    px = await samplePixel(page, selector, point);
    if (near(px, rgb, tol)) return px;
    await sleep(120);
  }
  return px;
}

async function newAppContext(browser, opts = {}) {
  const { dbTier = 'starter', viewport } = opts;

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

  await context.route('**cdn.jsdelivr.net/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('selfie_segmentation.js')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: SEG_STUB,
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  await context.route(`**${REF}.supabase.co/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/rest/v1/users')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ subscription_tier: dbTier }),
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

/* The old mode/color <select>s became the background gallery popover. */
async function openGallery(page) {
  if ((await page.locator('.bg-gallery').count()) === 0) {
    await page.click('.bg-gallery-toggle');
    await page.waitForSelector('.bg-gallery', { timeout: 4000 });
  }
}

async function pickBackground(page, mode) {
  await openGallery(page);
  await page.click(`.bg-tile[data-bg="${mode}"]`);
}

async function pickSwatch(page, value) {
  await openGallery(page);
  await page.click(`.bg-swatch[data-color="${value}"]`);
}

/** Open /app, wait for the tier badge + camera, ready for effect tests. */
async function openApp(page, tierClass) {
  await page.goto(BASE + '/app');
  await page.waitForSelector(`.tier-badge.${tierClass}`, { timeout: 8000 });
  await page.waitForSelector('.bg-gallery-toggle', { timeout: 8000 });
  // Camera ready = Start Recording enabled (paid tiers only).
  await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
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
  /* ---------- 1. Desktop Starter: blur + solid colors preview live ---------- */
  console.log('\nDesktop (1440x900, Starter): live blur + solid color preview');
  {
    const context = await newAppContext(browser, { dbTier: 'starter' });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await openApp(page, 'tier-starter');

    check(
      'no effect selected → overlay hidden (raw camera preview)',
      (await page.locator('.camera-fx.fx-on').count()) === 0
    );

    // --- Blur ---
    await pickBackground(page, 'blur');
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    check('gs status shows "on" after selecting Blur', true);
    await page.waitForSelector('.camera-pane-feed canvas.camera-fx.fx-on', {
      state: 'visible',
      timeout: 6000,
    });
    check('desktop pane overlay canvas visible for Blur', true);
    check(
      'both preview overlays exist (PIP + desktop pane)',
      (await page.locator('canvas.camera-fx').count()) === 2
    );
    // Blur of the uniform #3355aa background is still #3355aa at (64,64).
    const blurBg = await waitForPixel(
      page,
      '.camera-pane-feed canvas.camera-fx',
      BG,
      CAMERA_BLUE,
      14
    );
    check(
      'Blur: background region shows blurred camera on the LIVE preview',
      near(blurBg, CAMERA_BLUE, 14),
      JSON.stringify(blurBg)
    );
    const blurPerson = await waitForPixel(
      page,
      '.camera-pane-feed canvas.camera-fx',
      PERSON,
      PERSON_YELLOW,
      14
    );
    check(
      'Blur: person region shows the camera (not blurred away)',
      near(blurPerson, PERSON_YELLOW, 14),
      JSON.stringify(blurPerson)
    );

    // --- Solid colors: Green, Blue, Red — preview updates on each pick ---
    await pickBackground(page, 'color');
    for (const [label, value, rgb] of [
      ['Green', '#0b8a43', GS_GREEN],
      ['Blue', '#1e5aa8', GS_BLUE],
      ['Red', '#c62828', GS_RED],
    ]) {
      await pickSwatch(page, value);
      const bg = await waitForPixel(page, '.camera-pane-feed canvas.camera-fx', BG, rgb);
      check(
        `Solid ${label}: LIVE preview background turns ${label.toLowerCase()}`,
        near(bg, rgb),
        JSON.stringify(bg)
      );
      const person = await samplePixel(page, '.camera-pane-feed canvas.camera-fx', PERSON);
      check(
        `Solid ${label}: person still shows camera pixels`,
        near(person, PERSON_YELLOW, 14),
        JSON.stringify(person)
      );
    }

    // --- Toggle Off → raw camera back; on again → preview returns ---
    await pickBackground(page, 'off');
    await page.waitForFunction(
      () => document.querySelectorAll('.camera-fx.fx-on').length === 0,
      { timeout: 6000 }
    );
    check('toggle Off hides the overlay (raw camera again)', true);
    check(
      'raw desktop <video> still present under the overlay',
      (await page.locator('.camera-video-desktop').count()) === 1
    );
    await pickBackground(page, 'blur');
    await page.waitForSelector('.camera-pane-feed canvas.camera-fx.fx-on', {
      state: 'visible',
      timeout: 6000,
    });
    check('re-enabling an effect brings the live preview back', true);

    // --- Start recording with Blur selected: effect applied from the start ---
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 8000 });
    const recBg = await waitForPixel(page, 'canvas.compositing-canvas', BG, CAMERA_BLUE, 14, 3000);
    check(
      'recording compositor shows the blur background immediately',
      near(recBg, CAMERA_BLUE, 14),
      JSON.stringify(recBg)
    );
    check(
      'preview overlay still live while recording',
      (await page.locator('.camera-pane-feed canvas.camera-fx.fx-on').count()) === 1
    );
    await sleep(1200);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.download', { timeout: 8000 });
    check('blur recording produces a downloadable take', true);

    check('no console errors (desktop Starter)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 2. Desktop Pro: custom image + recording matches preview ---------- */
  console.log('\nDesktop (1440x900, Pro): custom image preview + recording match');
  {
    const context = await newAppContext(browser, { dbTier: 'pro' });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await openApp(page, 'tier-pro');

    // Upload a solid-orange background (generated in-page for a real PNG).
    await pickBackground(page, 'image');
    await page.waitForSelector('.gs-upload input[type="file"]', {
      state: 'attached', // the input itself is visually hidden by CSS
      timeout: 6000,
    });
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 8;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e07020';
      ctx.fillRect(0, 0, 8, 8);
      return c.toDataURL('image/png');
    });
    await page.setInputFiles('.gs-upload input[type="file"]', {
      name: 'sunset.png',
      mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
    });
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    const imgBg = await waitForPixel(page, '.camera-pane-feed canvas.camera-fx', BG, UPLOAD_ORANGE);
    check(
      'Custom image: LIVE preview background shows the uploaded image',
      near(imgBg, UPLOAD_ORANGE),
      JSON.stringify(imgBg)
    );
    const imgPerson = await samplePixel(page, '.camera-pane-feed canvas.camera-fx', PERSON);
    check(
      'Custom image: person still shows camera pixels',
      near(imgPerson, PERSON_YELLOW, 14),
      JSON.stringify(imgPerson)
    );
    check(
      'upload label shows the file name',
      ((await page.locator('.gs-upload').textContent()) || '').includes('sunset.png')
    );

    // Switch to Solid Red, record, and verify the SAVED take matches.
    await pickBackground(page, 'color');
    await pickSwatch(page, '#c62828');
    const preBg = await waitForPixel(page, '.camera-pane-feed canvas.camera-fx', BG, GS_RED);
    check('switching image → Solid Red updates the preview', near(preBg, GS_RED), JSON.stringify(preBg));

    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 8000 });
    const recBg = await waitForPixel(page, 'canvas.compositing-canvas', BG, GS_RED, 8, 3000);
    check(
      'recording compositor shows the red background immediately',
      near(recBg, GS_RED),
      JSON.stringify(recBg)
    );
    await sleep(1500);
    await page.click('.record-btn.stop');

    // Decode the take (Pro takes bar → Preview) and sample its pixels.
    await page.waitForSelector('.takes-bar .take-preview', { timeout: 8000 });
    await page.click('.takes-bar .take-preview');
    await page.waitForSelector('.take-preview-video', { timeout: 8000 });
    const takePx = await page.evaluate(
      async ([bg, person]) => {
        const v = document.querySelector('.take-preview-video');
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('take decode timeout')), 8000);
          const done = () => {
            clearTimeout(t);
            resolve();
          };
          if (v.readyState >= 2) done();
          else v.addEventListener('loadeddata', done, { once: true });
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300)); // let a frame paint
        const c = document.createElement('canvas');
        c.width = 1280;
        c.height = 720;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 1280, 720);
        const at = ([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        return { bg: at(bg), person: at(person) };
      },
      [BG, PERSON]
    );
    check(
      'RECORDED take background matches the preview (red)',
      near(takePx.bg, GS_RED, 45),
      JSON.stringify(takePx.bg)
    );
    check(
      'RECORDED take person region matches the preview (camera pixels)',
      near(takePx.person, PERSON_YELLOW, 60),
      JSON.stringify(takePx.person)
    );

    check('no console errors (desktop Pro)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 3. Mobile 375px: live preview in the camera PIP ---------- */
  console.log('\nMobile (375x800, Starter): live preview inside the PIP');
  {
    const context = await newAppContext(browser, {
      dbTier: 'starter',
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await openApp(page, 'tier-starter');

    check(
      'mobile: camera pane not rendered (PIP layout)',
      (await page.locator('.camera-pane').count()) === 0
    );
    check(
      'mobile: exactly one overlay canvas (inside the PIP)',
      (await page.locator('canvas.camera-fx').count()) === 1
    );

    await pickBackground(page, 'color');
    await pickSwatch(page, '#0b8a43');
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    await page.waitForSelector('.camera-pip canvas.camera-fx.fx-on', {
      state: 'visible',
      timeout: 6000,
    });
    check('mobile: PIP overlay canvas visible for Solid Green', true);
    const pipBg = await waitForPixel(page, '.camera-pip canvas.camera-fx', BG, GS_GREEN);
    check(
      'mobile: PIP preview background turns green',
      near(pipBg, GS_GREEN),
      JSON.stringify(pipBg)
    );
    const pipPerson = await samplePixel(page, '.camera-pip canvas.camera-fx', PERSON);
    check(
      'mobile: PIP person region shows camera pixels',
      near(pipPerson, PERSON_YELLOW, 14),
      JSON.stringify(pipPerson)
    );

    await pickBackground(page, 'off');
    await page.waitForFunction(
      () => document.querySelectorAll('.camera-fx.fx-on').length === 0,
      { timeout: 6000 }
    );
    check('mobile: toggle Off restores the raw PIP camera', true);

    check(
      'mobile: single PIP video untouched (compositor frame source)',
      (await page.locator('.camera-pip video').count()) === 1
    );
    check('no console errors (mobile)', errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  preview.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failing checks:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
