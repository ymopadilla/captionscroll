/**
 * CaptionScroll subscription-tier sync tests.
 *
 * Verifies (against `vite preview` serving the production build, with
 * Supabase and /api/* intercepted so no live backend is needed) that
 * after a Stripe Checkout redirect back to /app:
 *   - /api/verify-session is called with the session id
 *   - the tier is refetched and the header badge updates (Starter / Pro)
 *   - Start Recording becomes ENABLED for Starter/Pro
 *   - Free tier keeps recording locked with the upgrade prompt
 *   - a "checking your plan" loading state shows during the refetch
 *   - a stale in-flight 'free' response can NOT overwrite the new tier
 *   - the checkout params are cleaned from the URL afterwards
 *
 * Run with:  node test/tiersync.mjs   (CHROMIUM_PATH env var optional)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4175;
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

/**
 * Signed-in browser context with a mutable fake backend.
 *
 * `state.dbTier` is what the fake Supabase `users` table returns.
 * `/api/verify-session` (unless overridden) flips dbTier to
 * `state.purchasedTier` and answers like the real handler.
 *
 * Options:
 *   usersDelayFirstMs — delay ONLY the first /rest/v1/users response
 *                       (simulates the mount-time fetch racing the
 *                       post-checkout refetch)
 *   verifyStatus      — HTTP status for /api/verify-session
 *   verifyDelayMs     — delay before verify-session responds
 */
async function newAppContext(browser, opts = {}) {
  const {
    dbTier = 'free',
    purchasedTier = 'starter',
    purchasedStatus = 'trialing',
    usersDelayFirstMs = 0,
    verifyStatus = 200,
    verifyDelayMs = 0,
    viewport,
  } = opts;

  const state = {
    dbTier,
    usersRequests: 0,
    verifyCalls: [],
  };

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

  await context.route(`**${REF}.supabase.co/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/rest/v1/users')) {
      state.usersRequests += 1;
      const tierNow = state.dbTier; // capture BEFORE any delay (stale read)
      if (state.usersRequests === 1 && usersDelayFirstMs > 0) {
        await sleep(usersDelayFirstMs);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ subscription_tier: tierNow }),
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

  await context.route('**/api/verify-session', async (route) => {
    state.verifyCalls.push(route.request().postDataJSON());
    if (verifyDelayMs > 0) await sleep(verifyDelayMs);
    if (verifyStatus === 200) {
      state.dbTier = purchasedTier; // the server upgraded the user row
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tier: purchasedTier, status: purchasedStatus }),
      });
    }
    return route.fulfill({
      status: verifyStatus,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Could not verify checkout session.' }),
    });
  });

  context.state = state;
  return context;
}

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
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
  /* ---------- 1. Free tier: recording locked ---------- */
  console.log('\nFree tier baseline');
  {
    const context = await newAppContext(browser);
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.tier-badge.tier-free', { timeout: 8000 });
    check('badge shows Free', (await page.textContent('.tier-badge')) === 'Free');
    check(
      'Start Recording disabled on Free',
      await page.locator('.record-btn.start').isDisabled()
    );
    check(
      'locked upsell shown on Free',
      (await page.locator('.record-locked').count()) === 1
    );
    check(
      'upsell links to /pricing',
      (await page.locator('.record-locked').getAttribute('href')) === '/pricing'
    );
    check('no verify calls without checkout params', context.state.verifyCalls.length === 0);
    check('no console errors (Free)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 2. Checkout success → Starter unlocks recording ---------- */
  console.log('\nCheckout redirect → Starter');
  {
    const context = await newAppContext(browser, {
      purchasedTier: 'starter',
      verifyDelayMs: 600, // long enough to observe the loading state
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app?checkout=success&session_id=cs_test_abc123');

    // Loading state while the tier is being confirmed/refetched.
    await page.waitForSelector('.tier-checking', { timeout: 8000 });
    check('"Checking your plan…" shows during refetch', true);
    check(
      'header badge shows spinner (not FREE) while checking',
      (await page.locator('.tier-badge.tier-loading').count()) === 1 &&
        (await page.locator('.tier-badge.tier-free').count()) === 0
    );
    check(
      'Start Recording disabled while checking',
      await page.locator('.record-btn.start').isDisabled()
    );
    check(
      'no locked upsell flash while checking',
      (await page.locator('.record-locked').count()) === 0
    );

    // After verification: Starter badge, recording enabled.
    await page.waitForSelector('.tier-badge.tier-starter', { timeout: 8000 });
    check('badge shows Starter', (await page.textContent('.tier-badge')) === 'Starter');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('Start Recording ENABLED after upgrade', true);
    check(
      'locked upsell gone after upgrade',
      (await page.locator('.record-locked').count()) === 0
    );
    check(
      'success banner mentions Starter',
      ((await page.locator('.app-banner').textContent()) || '').includes('Starter')
    );
    check(
      'verify-session called once with the session id',
      context.state.verifyCalls.length === 1 &&
        context.state.verifyCalls[0]?.sessionId === 'cs_test_abc123',
      JSON.stringify(context.state.verifyCalls)
    );
    await page.waitForURL((u) => !u.search.includes('session_id'), { timeout: 8000 });
    check('checkout params cleaned from URL', !page.url().includes('session_id'));

    // Recording actually works end-to-end (start → REC badge → stop).
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge, .recording-timer.active', { timeout: 8000 });
    check('recording starts (timer active)', true);
    await sleep(1500);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('recording stops cleanly', true);
    check('no console errors (Starter flow)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 3. Checkout success → Pro ---------- */
  console.log('\nCheckout redirect → Pro');
  {
    const context = await newAppContext(browser, {
      purchasedTier: 'pro',
      purchasedStatus: 'active',
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app?checkout=success&session_id=cs_test_pro456');
    await page.waitForSelector('.tier-badge.tier-pro', { timeout: 8000 });
    check('badge shows Pro', (await page.textContent('.tier-badge')) === 'Pro');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('Start Recording ENABLED on Pro', true);
    check(
      'no Upgrade link on Pro',
      (await page.locator('.upgrade-link').count()) === 0
    );
    check('no console errors (Pro flow)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 4. Race: stale mount-time 'free' cannot win ---------- */
  console.log('\nStale-response race');
  {
    const context = await newAppContext(browser, {
      purchasedTier: 'starter',
      usersDelayFirstMs: 2500, // mount fetch (free) resolves LAST
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app?checkout=success&session_id=cs_test_race789');
    await page.waitForSelector('.tier-badge.tier-starter', { timeout: 8000 });
    // Wait past the delayed stale response, then confirm it didn't clobber.
    await sleep(3000);
    check(
      'stale free response did not overwrite Starter',
      (await page.locator('.tier-badge.tier-starter').count()) === 1,
      `badge=${await page.textContent('.tier-badge')}`
    );
    check(
      'Start Recording still enabled after stale response',
      await page.locator('.record-btn.start').isEnabled()
    );
    check('no console errors (race)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 5. verify-session fails but DB was updated (webhook) ---------- */
  console.log('\nVerify fails, webhook already upgraded');
  {
    const context = await newAppContext(browser, {
      dbTier: 'starter', // webhook already wrote the tier
      verifyStatus: 500,
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app?checkout=success&session_id=cs_test_fail000');
    await page.waitForSelector('.tier-badge.tier-starter', { timeout: 8000 });
    check('tier refetched despite verify failure', true);
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('recording unlocked despite verify failure', true);
    check(
      'banner still celebrates the plan',
      ((await page.locator('.app-banner').textContent()) || '').includes('Starter')
    );
    // The intentionally-mocked 500 makes the browser log a network-layer
    // "Failed to load resource" line; only real app errors should fail.
    const appErrors = errors.filter(
      (e) => !/Failed to load resource.*500/.test(e)
    );
    check('no console errors (verify-fail)', appErrors.length === 0, appErrors.join(' | '));
    await context.close();
  }

  /* ---------- 6. Bare checkout_success flag (no session id) ---------- */
  console.log('\nBare checkout_success flag');
  {
    const context = await newAppContext(browser, { dbTier: 'starter' });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app?checkout_success=1');
    await page.waitForSelector('.tier-badge.tier-starter', { timeout: 8000 });
    check('tier refetched from bare flag', true);
    check('no verify call without session id', context.state.verifyCalls.length === 0);
    await page.waitForURL((u) => !u.search.includes('checkout_success'), { timeout: 8000 });
    check('flag cleaned from URL', !page.url().includes('checkout_success'));
    check('no console errors (bare flag)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 7. Mobile 375px ---------- */
  console.log('\nMobile (375×667)');
  {
    const context = await newAppContext(browser, {
      purchasedTier: 'starter',
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app?checkout=success&session_id=cs_test_mob111');
    await page.waitForSelector('.tier-badge.tier-starter', { timeout: 8000 });
    check('mobile: badge shows Starter', true);
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('mobile: Start Recording enabled', true);
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    check('mobile: no horizontal overflow', overflowX);
    check('no console errors (mobile)', errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  preview.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failed:', fails.join(', '));
  process.exit(1);
}
