/**
 * CaptionScroll background gallery tests (headless Chromium, fake camera,
 * MediaPipe CDN replaced with a deterministic segmentation stub — see
 * test/greenpreview.mjs for the stub's pixel contract).
 *
 * Covers the 1.0.0 gallery: 6 presets (Blur, Office, Bokeh, Sunset,
 * Nature, Minimalist) + Solid Color + custom upload (Pro), each preset
 * with a live intensity slider, live preview on the camera feed, and
 * the effect baked into recordings.
 *
 * Run with:  node test/backgrounds-1.0.0.mjs   (CHROMIUM_PATH optional)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4185;
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

/* Deterministic SelfieSegmentation stub (same contract as greenpreview):
   camera frame = uniform #3355aa with a #ffcc00 square in the person
   region; person mask = fixed ellipse. */
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

const BG = [64, 64]; // background sample point (outside the person mask)
const BG_LOW = [64, 656]; // near the bottom — for gradient-depth checks
const PERSON = [640, 430]; // inside the yellow square + the mask
const CAMERA_BLUE = [0x33, 0x55, 0xaa];
const PERSON_YELLOW = [0xff, 0xcc, 0x00];

const near = (px, rgb, tol = 10) =>
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

async function waitForPixel(page, selector, point, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let px = null;
  while (Date.now() < deadline) {
    px = await samplePixel(page, selector, point);
    if (predicate(px)) return px;
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
    if (route.request().url().endsWith('selfie_segmentation.js')) {
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

async function setIntensity(page, value) {
  await openGallery(page);
  await page.$eval(
    '.bg-intensity-slider',
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

const FX = '.camera-pane-feed canvas.camera-fx';

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
  /* ---------- 1. Gallery structure + every preset previews live ---------- */
  console.log('\nDesktop (1440x900, Starter): gallery + all six presets');
  {
    const context = await newAppContext(browser, { dbTier: 'starter' });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });

    await openGallery(page);
    check(
      'gallery shows 8 tiles on Starter (no Custom Image)',
      (await page.locator('.bg-tile').count()) === 8 &&
        (await page.locator('.bg-tile[data-bg="image"]').count()) === 0
    );
    for (const mode of ['off', 'blur', 'office', 'bokeh', 'sunset', 'nature', 'minimalist', 'color']) {
      check(
        `tile present: ${mode}`,
        (await page.locator(`.bg-tile[data-bg="${mode}"]`).count()) === 1
      );
    }
    check(
      'no intensity slider while Off',
      (await page.locator('.bg-intensity').count()) === 0
    );

    // ---- Blur: label maps to px, background stays camera-colored ----
    await pickBackground(page, 'blur');
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    check(
      'blur intensity label reads "Blur: 12px" at default',
      (await page.textContent('.bg-intensity-label')) === 'Blur: 12px'
    );
    const blurBg = await waitForPixel(page, FX, BG, (p) => near(p, CAMERA_BLUE, 14));
    check('blur: live preview background is blurred camera', near(blurBg, CAMERA_BLUE, 14), JSON.stringify(blurBg));
    const blurPerson = await samplePixel(page, FX, PERSON);
    check('blur: person keeps camera pixels', near(blurPerson, PERSON_YELLOW, 14), JSON.stringify(blurPerson));
    await setIntensity(page, 1);
    check(
      'blur slider max → "Blur: 25px"',
      (await page.textContent('.bg-intensity-label')) === 'Blur: 25px'
    );

    // ---- Sunset: canvas gradient with known stops ----
    await pickBackground(page, 'sunset');
    check(
      'sunset intensity label reads "Saturation: 1.00x"',
      (await page.textContent('.bg-intensity-label')) === 'Saturation: 1.00x'
    );
    // Gradient #ff9046 → #ff5e8a → #7a3fd8; at y=64 it's warm orange.
    const sunsetTop = await waitForPixel(
      page,
      FX,
      BG,
      (p) => near(p, [255, 135, 82], 18)
    );
    check('sunset: warm gradient at the top', near(sunsetTop, [255, 135, 82], 18), JSON.stringify(sunsetTop));
    const sunsetLow = await samplePixel(page, FX, BG_LOW);
    check(
      'sunset: purple end of the gradient at the bottom',
      Array.isArray(sunsetLow) && sunsetLow[2] > sunsetLow[1] && sunsetLow[2] > 140,
      JSON.stringify(sunsetLow)
    );
    const sunsetPerson = await samplePixel(page, FX, PERSON);
    check('sunset: person keeps camera pixels', near(sunsetPerson, PERSON_YELLOW, 14), JSON.stringify(sunsetPerson));

    // ---- Minimalist: white→gray; slider deepens the gray ----
    await pickBackground(page, 'minimalist');
    check(
      'minimalist intensity label reads "Depth: 0.55"',
      (await page.textContent('.bg-intensity-label')) === 'Depth: 0.55'
    );
    const minTop = await waitForPixel(page, FX, BG, (p) => near(p, [251, 251, 251], 8));
    check('minimalist: near-white at the top', near(minTop, [251, 251, 251], 8), JSON.stringify(minTop));
    const minLowDefault = await samplePixel(page, FX, BG_LOW);
    await setIntensity(page, 1);
    check(
      'minimalist slider max → "Depth: 1.00"',
      (await page.textContent('.bg-intensity-label')) === 'Depth: 1.00'
    );
    const minLowDeep = await waitForPixel(
      page,
      FX,
      BG_LOW,
      (p) => Array.isArray(p) && p[0] < minLowDefault[0] - 15
    );
    check(
      'depth slider deepens the gray live',
      Array.isArray(minLowDeep) && minLowDeep[0] < minLowDefault[0] - 15,
      `(${JSON.stringify(minLowDefault)} → ${JSON.stringify(minLowDeep)})`
    );

    // ---- Photo presets: office / bokeh / nature ----
    const photoPixels = {};
    for (const [mode, label] of [
      ['office', 'Brightness: 1.00x'],
      ['bokeh', 'Glow: 0.70'],
      ['nature', 'Saturation: 1.00x'],
    ]) {
      await pickBackground(page, mode);
      await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
      check(
        `${mode} intensity label reads "${label}"`,
        (await page.textContent('.bg-intensity-label')) === label
      );
      const px = await waitForPixel(
        page,
        FX,
        BG,
        (p) => Array.isArray(p) && p[3] > 200 && !near(p, CAMERA_BLUE, 14)
      );
      photoPixels[mode] = px;
      check(
        `${mode}: photo replaces the camera background`,
        Array.isArray(px) && px[3] > 200 && !near(px, CAMERA_BLUE, 14),
        JSON.stringify(px)
      );
      const person = await samplePixel(page, FX, PERSON);
      check(
        `${mode}: person keeps camera pixels`,
        near(person, PERSON_YELLOW, 14),
        JSON.stringify(person)
      );
    }
    check(
      'office / bokeh / nature backgrounds are distinct images',
      !near(photoPixels.office, photoPixels.bokeh.slice(0, 3), 12) ||
        !near(photoPixels.office, photoPixels.nature.slice(0, 3), 12)
    );

    // ---- Photo intensity: office brightness slider changes pixels ----
    await pickBackground(page, 'office');
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    const officeDefault = await waitForPixel(
      page,
      FX,
      BG,
      (p) => Array.isArray(p) && p[3] > 200 && !near(p, CAMERA_BLUE, 14)
    );
    await setIntensity(page, 0);
    check(
      'office slider min → "Brightness: 0.50x"',
      (await page.textContent('.bg-intensity-label')) === 'Brightness: 0.50x'
    );
    const officeDark = await waitForPixel(
      page,
      FX,
      BG,
      (p) => Array.isArray(p) && p[0] < officeDefault[0] - 15
    );
    check(
      'brightness slider dims the office preset live',
      Array.isArray(officeDark) && officeDark[0] < officeDefault[0] - 15,
      `(${JSON.stringify(officeDefault)} → ${JSON.stringify(officeDark)})`
    );

    // ---- Off restores the raw camera ----
    await pickBackground(page, 'off');
    await page.waitForFunction(
      () => document.querySelectorAll('.camera-fx.fx-on').length === 0,
      { timeout: 6000 }
    );
    check('Off hides the effect overlay (raw camera preview)', true);

    check('no console errors (Starter gallery)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 2. Recording: preset baked into the take; switch between takes ---------- */
  console.log('\nRecording (1440x900, Pro): sunset take + minimalist take + custom upload');
  {
    const context = await newAppContext(browser, { dbTier: 'pro' });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });

    await openGallery(page);
    check(
      'Pro gallery shows 9 tiles incl. Custom Image',
      (await page.locator('.bg-tile').count()) === 9 &&
        (await page.locator('.bg-tile[data-bg="image"]').count()) === 1
    );

    // Take 1: sunset.
    await pickBackground(page, 'sunset');
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    await waitForPixel(page, FX, BG, (p) => near(p, [255, 135, 82], 18));
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 5000 });
    const recSunset = await waitForPixel(
      page,
      'canvas.compositing-canvas',
      BG,
      (p) => near(p, [255, 135, 82], 18),
      4000
    );
    check(
      'recording compositor shows the sunset background',
      near(recSunset, [255, 135, 82], 18),
      JSON.stringify(recSunset)
    );
    await sleep(1300);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });

    // Take 2: switch preset between takes → new background applies.
    await pickBackground(page, 'minimalist');
    await waitForPixel(page, FX, BG, (p) => near(p, [251, 251, 251], 10));
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge', { timeout: 5000 });
    const recMin = await waitForPixel(
      page,
      'canvas.compositing-canvas',
      BG,
      (p) => near(p, [251, 251, 251], 10),
      4000
    );
    check(
      'next take records the newly selected background',
      near(recMin, [251, 251, 251], 10),
      JSON.stringify(recMin)
    );
    await sleep(1100);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('two takes captured', (await page.locator('.take-chip').count()) === 2);

    // Decode take 1 (sunset) and confirm the background was baked in.
    await page.click('.takes-bar .take-chip >> nth=0 >> .take-preview');
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
      return Array.from(ctx.getImageData(64, 64, 1, 1).data);
    });
    check(
      'SAVED sunset take decodes with the warm gradient background',
      near(takePx, [255, 135, 82], 55),
      JSON.stringify(takePx)
    );

    // Custom upload still works (Pro) — orange PNG generated in-page.
    await pickBackground(page, 'image');
    await page.waitForSelector('.bg-gallery .gs-upload input[type="file"]', {
      state: 'attached',
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
    await page.setInputFiles('.bg-gallery .gs-upload input[type="file"]', {
      name: 'brand.png',
      mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
    });
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    const customBg = await waitForPixel(page, FX, BG, (p) => near(p, [0xe0, 0x70, 0x20], 10));
    check(
      'custom upload previews live (Pro)',
      near(customBg, [0xe0, 0x70, 0x20], 10),
      JSON.stringify(customBg)
    );
    check(
      'upload label shows the file name',
      ((await page.locator('.gs-upload').textContent()) || '').includes('brand.png')
    );

    check('no console errors (Pro recording)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 3. Mobile 375px: bottom-sheet gallery + PIP preview ---------- */
  console.log('\nMobile (375x800, Starter): gallery sheet + PIP preview');
  {
    const context = await newAppContext(browser, {
      dbTier: 'starter',
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    const errors = trackErrors(page);
    await page.goto(BASE + '/app');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });

    await openGallery(page);
    const sheet = await page.locator('.bg-gallery').boundingBox();
    check(
      'gallery fits the phone viewport',
      sheet && sheet.x >= 0 && sheet.x + sheet.width <= 375 + 1,
      `(sheet ${Math.round(sheet?.width)}px at x=${Math.round(sheet?.x)})`
    );
    await pickBackground(page, 'nature');
    await page.waitForSelector('.gs-status.ready', { timeout: 10000 });
    await page.waitForSelector('.camera-pip canvas.camera-fx.fx-on', {
      state: 'visible',
      timeout: 6000,
    });
    check('nature preset previews inside the PIP', true);
    const pipBg = await waitForPixel(
      page,
      '.camera-pip canvas.camera-fx',
      BG,
      (p) => Array.isArray(p) && p[3] > 200 && p[1] > p[2] && !near(p, CAMERA_BLUE, 14)
    );
    check(
      'PIP background is green-ish nature (not the camera)',
      Array.isArray(pipBg) && pipBg[1] > pipBg[2] && !near(pipBg, CAMERA_BLUE, 14),
      JSON.stringify(pipBg)
    );
    await setIntensity(page, 0);
    check(
      'intensity slider works on mobile ("Saturation: 0.50x")',
      (await page.textContent('.bg-intensity-label')) === 'Saturation: 0.50x'
    );
    await pickBackground(page, 'off');
    await page.waitForFunction(
      () => document.querySelectorAll('.camera-fx.fx-on').length === 0,
      { timeout: 6000 }
    );
    check('Off restores the raw PIP camera', true);
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
