/**
 * SpeakScroll smoke tests (headless Chromium, fake camera/mic).
 *
 * Runs against `vite preview` serving the production build. Supabase
 * network calls are intercepted so tiers can be simulated without a
 * live backend. Run with:  node test/smoke.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4173;
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

async function newAppContext(browser, tier) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  await context.addInitScript(
    ([key, session]) => {
      window.localStorage.setItem(key, JSON.stringify(session));
    },
    [`sb-${REF}-auth-token`, FAKE_SESSION]
  );
  // Intercept all Supabase traffic so tests run offline.
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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      });
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
  // Optional override for environments with a preinstalled Chromium.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  /* ---------- 1. Landing page ---------- */
  console.log('\nLanding page');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(BASE + '/');
    check(
      'headline renders',
      (await page.textContent('h1')).includes('Speak Clearly')
    );
    check(
      'CTA links to signup',
      (await page.getAttribute('.hero-cta', 'href')) === '/signup'
    );
    check(
      'four feature cards',
      (await page.locator('.feature-card').count()) === 4
    );
    check(
      'footer shows company',
      (await page.textContent('.site-footer')).includes(
        'Digital Navigation Solutions'
      )
    );
    await page.close();
  }

  /* ---------- 2. Pricing page ---------- */
  console.log('\nPricing page');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(BASE + '/pricing');
    check('three tier cards', (await page.locator('.price-card').count()) === 3);
    check(
      'Most Popular badge',
      (await page.textContent('.price-card.featured .price-badge')) ===
        'Most Popular'
    );
    check(
      'monthly price shown',
      (await page.textContent('.price-card.featured .price-amount')).includes(
        '7.99'
      )
    );
    await page.click('.cycle-toggle button:nth-child(2)');
    check(
      'annual toggle updates price',
      (await page.textContent('.price-card.featured .price-amount')).includes(
        '60'
      )
    );
    check('FAQ present', (await page.locator('.faq-item').count()) >= 4);
    check(
      'comparison table rows',
      (await page.locator('.cmp-table tbody tr').count()) >= 10
    );
    await page.close();
  }

  /* ---------- 3. Auth pages + route protection ---------- */
  console.log('\nAuth pages');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(BASE + '/login');
    check('login form', (await page.locator('#login-email').count()) === 1);
    await page.goto(BASE + '/signup');
    check('signup form', (await page.locator('#signup-email').count()) === 1);
    await page.goto(BASE + '/app');
    await page.waitForURL('**/login', { timeout: 5000 }).catch(() => {});
    check(
      'unauthenticated /app redirects to /login',
      page.url().endsWith('/login')
    );
    await page.close();
  }

  /* ---------- 4. Free tier: locked recording, PIP behavior ---------- */
  console.log('\nFree tier app');
  {
    const context = await newAppContext(browser, 'free');
    const page = await context.newPage();
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    check('tier badge Free', (await page.textContent('.tier-badge')) === 'Free');
    check(
      'record button disabled',
      await page.locator('.record-btn.start').isDisabled()
    );
    check(
      'lock message links to pricing',
      (await page.getAttribute('.record-locked', 'href')) === '/pricing' &&
        (await page.textContent('.record-locked')).includes('Upgrade to Starter')
    );
    check(
      'green screen shows upsell (not select)',
      (await page.locator('.gate-upsell-link').count()) >= 1
    );
    check('no page scroll', await noPageScroll(page));

    // PIP: visible, draggable, hideable with video still mounted.
    const pip = page.locator('.camera-pip');
    check('PIP visible', await pip.isVisible());
    const before = await pip.boundingBox();
    await page.mouse.move(before.x + before.w / 2 || before.x + 60, before.y + 20);
    await page.mouse.move(before.x + 60, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x - 300, before.y + 200, { steps: 8 });
    await page.mouse.up();
    const after = await pip.boundingBox();
    check(
      'PIP drags to a new position',
      Math.abs(after.x - before.x) > 100 && Math.abs(after.y - before.y) > 50,
      `(moved ${Math.round(after.x - before.x)},${Math.round(after.y - before.y)})`
    );

    await page.uncheck('.controls input[type="checkbox"] >> nth=1').catch(() => {});
    // "Show Camera" is the 2nd checkbox (after Mirror Mode).
    const pipHidden = await page
      .locator('.camera-pip.pip-hidden')
      .count();
    check('PIP hides via Show Camera toggle', pipHidden === 1);
    check(
      'video element stays mounted while hidden',
      (await page.locator('.camera-pip video').count()) === 1
    );
    check('no page scroll after drag/hide', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 5. Starter tier: recording works ---------- */
  console.log('\nStarter tier app');
  {
    const context = await newAppContext(browser, 'starter');
    const page = await context.newPage();
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    check(
      'tier badge Starter',
      (await page.textContent('.tier-badge')) === 'Starter'
    );
    check(
      'green screen select visible',
      (await page.locator('.controls select').first().isVisible())
    );
    check(
      'no Custom Image option on Starter',
      !(await page.textContent('.controls')).includes('Custom Image')
    );
    check(
      'no Pro filters on Starter',
      (await page.locator('.pro-filters').count()) === 0
    );

    const startBtn = page.locator('.record-btn.start');
    await page.waitForFunction(
      () => !document.querySelector('.record-btn.start')?.disabled,
      { timeout: 8000 }
    );
    check('record button enabled', !(await startBtn.isDisabled()));
    await startBtn.click();
    await page.waitForSelector('.rec-badge', { timeout: 5000 });
    check('REC badge appears', await page.locator('.rec-badge').isVisible());
    await page.waitForTimeout(2600);
    const timer = await page.textContent('.recording-timer');
    check('timer advances', timer !== '00:00', `(timer=${timer})`);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.download', { timeout: 5000 });
    check(
      'download button appears after stop',
      await page.locator('.record-btn.download').isVisible()
    );
    check(
      'takes bar hidden on Starter',
      (await page.locator('.takes-bar').count()) === 0
    );
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 6. Pro tier: pro tools visible ---------- */
  console.log('\nPro tier app');
  {
    const context = await newAppContext(browser, 'pro');
    const page = await context.newPage();
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    check('tier badge Pro', (await page.textContent('.tier-badge')) === 'Pro');
    check(
      'no Upgrade link for Pro',
      (await page.locator('.upgrade-link').count()) === 0
    );
    check(
      'filters visible',
      (await page.locator('.pro-filters').count()) === 1
    );
    check(
      'speech sync checkbox present',
      (await page.textContent('.controls')).includes('Speech Caption Sync')
    );
    check(
      'Custom Image option present',
      (await page.textContent('.controls')).includes('Custom Image')
    );

    // Record two takes -> takes manager appears.
    await page.waitForFunction(
      () => !document.querySelector('.record-btn.start')?.disabled,
      { timeout: 8000 }
    );
    for (let i = 0; i < 2; i++) {
      await page.click('.record-btn.start');
      await page.waitForTimeout(1500);
      await page.click('.record-btn.stop');
      await page.waitForSelector('.record-btn.download', { timeout: 5000 });
    }
    check(
      'takes manager shows 2 takes',
      (await page.locator('.take-chip').count()) === 2
    );
    check(
      'social export buttons present',
      (await page.locator('.social-btn').count()) >= 4
    );
    check('no page scroll', await noPageScroll(page));
    await context.close();
  }

  /* ---------- 7. Small viewport: everything still fits ---------- */
  console.log('\nSmall viewport (1024x620)');
  {
    const context = await newAppContext(browser, 'starter');
    const page = await context.newPage();
    await page.setViewportSize({ width: 1024, height: 620 });
    await page.goto(BASE + '/app');
    await page.waitForSelector('.stage', { timeout: 8000 });
    check('no page scroll at 1024x620', await noPageScroll(page));
    const controls = await page.locator('.recording-controls').boundingBox();
    check(
      'recording controls end within viewport',
      controls.y + controls.height <= 620 + 1,
      `(bottom=${Math.round(controls.y + controls.height)})`
    );
    await context.close();
  }
} finally {
  await browser.close();
  preview.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failed:', fails.join(' | '));
  process.exit(1);
}
