/**
 * CaptionScroll 14-day no-card trial tests.
 *
 * Verifies (against `vite preview` serving the production build, with
 * Supabase and /api/* intercepted so no live backend is needed):
 *   - a brand-new free user (no user_trials row) sees the tier picker
 *   - choosing Starter/Pro inserts the row and unlocks that tier's
 *     features immediately, with a "<TIER> TRIAL · N days left" header
 *   - an existing mid-trial row skips the picker and shows the countdown
 *   - an EXPIRED trial locks recording again, shows the trial-ended
 *     banner, and fires the trial_active=false bookkeeping PATCH
 *   - a paid tier beats any trial row (plain badge, status active)
 *   - "No thanks" dismissal sticks across reloads (localStorage)
 *   - pricing page reflects eligible / in-trial / expired / paid states
 *   - mobile 375px renders without horizontal overflow
 *   - zero console errors throughout
 *
 * Run with:  node test/trialflow.mjs   (CHROMIUM_PATH env var optional)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4176;
const BASE = `http://localhost:${PORT}`;
const REF = 'rgpgascbdmbpkgsmgnmx';
const CHECKOUT_URL = 'https://checkout.stripe.test/c/pay/cs_test_trial123';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const DAY_MS = 86400000;

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
    id: USER_ID,
    email: 'test@example.com',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A user_trials row whose window started `startedDaysAgo` days ago. */
function trialRow(tier, startedDaysAgo, active = true) {
  const start = new Date(Date.now() - startedDaysAgo * DAY_MS);
  const end = new Date(start.getTime() + 14 * DAY_MS);
  return {
    user_id: USER_ID,
    trial_tier: tier,
    trial_start_date: start.toISOString(),
    trial_end_date: end.toISOString(),
    trial_active: active,
  };
}

/**
 * Signed-in context with a mutable fake backend.
 *   state.dbTier  — public.users.subscription_tier
 *   state.trials  — array returned by GET /rest/v1/user_trials
 * POST user_trials appends a fresh row (server-stamped window) and
 * returns it; PATCH records the call and flips trial_active.
 */
async function newAppContext(browser, opts = {}) {
  const { dbTier = 'free', trials = [], viewport } = opts;
  const state = {
    dbTier,
    trials: [...trials],
    trialInserts: [],
    trialPatches: [],
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
    const method = route.request().method();
    if (url.includes('/rest/v1/user_trials')) {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        state.trialInserts.push(body);
        if (state.trials.length > 0) {
          // Primary key: one trial per user, ever.
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              code: '23505',
              message:
                'duplicate key value violates unique constraint "user_trials_pkey"',
            }),
          });
        }
        const row = trialRow(body.trial_tier, 0, true);
        state.trials.push(row);
        return route.fulfill({
          status: 201,
          contentType: 'application/vnd.pgrst.object+json',
          body: JSON.stringify(row),
        });
      }
      if (method === 'PATCH') {
        state.trialPatches.push(route.request().postDataJSON());
        if (state.trials[0]) state.trials[0].trial_active = false;
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(state.trials),
      });
    }
    if (url.includes('/rest/v1/users')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ subscription_tier: state.dbTier }),
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

  const checkoutCalls = [];
  await context.route('**/api/create-checkout-session', (route) => {
    checkoutCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: CHECKOUT_URL }),
    });
  });
  await context.route('https://checkout.stripe.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1 id="stripe-checkout">Stripe Checkout</h1></body></html>',
    })
  );

  context.state = state;
  context.checkoutCalls = checkoutCalls;
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
  /* ---------- 1. New user → picker → Try Starter ---------- */
  console.log('\nNew user picks a Starter trial');
  {
    const context = await newAppContext(browser);
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.trial-picker', { timeout: 8000 });
    check('picker shows for brand-new free user', true);
    check(
      'picker offers both tiers',
      (await page.locator('.trial-choose-starter').count()) === 1 &&
        (await page.locator('.trial-choose-pro').count()) === 1
    );
    check(
      'record button disabled behind picker',
      await page.locator('.record-btn.start').isDisabled()
    );

    await page.click('.trial-choose-starter');
    await page.waitForSelector('.tier-badge.tier-starter.tier-trial', {
      timeout: 8000,
    });
    check('picker gone after choosing', (await page.locator('.trial-picker').count()) === 0);
    check(
      'badge reads STARTER TRIAL',
      (await page.textContent('.tier-badge')).trim() === 'STARTER TRIAL'
    );
    check(
      'countdown shows 14 days left',
      ((await page.textContent('.trial-countdown')) || '').trim() === '14 days left'
    );
    check(
      'insert sent trial_tier=starter + comms email',
      context.state.trialInserts.length === 1 &&
        context.state.trialInserts[0]?.trial_tier === 'starter' &&
        context.state.trialInserts[0]?.original_email_for_comms ===
          'test@example.com',
      JSON.stringify(context.state.trialInserts)
    );
    check(
      'success banner mentions the trial',
      ((await page.locator('.app-banner').textContent().catch(() => '')) || '').includes('trial')
    );
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('Start Recording ENABLED on Starter trial', true);
    check(
      'no Pro filters on Starter trial',
      (await page.locator('.pro-filters').count()) === 0
    );
    check(
      'upgrade link visible during trial',
      (await page.locator('.upgrade-link').count()) === 1
    );

    // Recording actually works end-to-end during the trial.
    await page.click('.record-btn.start');
    await page.waitForSelector('.rec-badge, .recording-timer.active', { timeout: 8000 });
    check('recording starts during trial', true);
    await sleep(1200);
    await page.click('.record-btn.stop');
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('recording stops cleanly during trial', true);
    check('no console errors (Starter trial)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 2. New user → Try Pro → all features ---------- */
  console.log('\nNew user picks a Pro trial');
  {
    const context = await newAppContext(browser);
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.trial-picker', { timeout: 8000 });
    await page.click('.trial-choose-pro');
    await page.waitForSelector('.tier-badge.tier-pro.tier-trial', { timeout: 8000 });
    check(
      'badge reads PRO TRIAL',
      (await page.textContent('.tier-badge')).trim() === 'PRO TRIAL'
    );
    check(
      'insert sent trial_tier=pro',
      context.state.trialInserts[0]?.trial_tier === 'pro'
    );
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('recording enabled on Pro trial', true);
    check('Pro filters visible', (await page.locator('.pro-filters').count()) === 1);
    // Custom Image lives in the background gallery popover now.
    await page.click('.bg-gallery-toggle');
    await page.waitForSelector('.bg-gallery', { timeout: 4000 });
    check(
      'speech sync + custom image available',
      (await page.textContent('.controls')).includes('Speech Caption Sync') &&
        (await page.locator('.bg-tile[data-bg="image"]').count()) === 1
    );
    await page.click('.bg-gallery-toggle'); // close the popover again
    check(
      'upgrade link visible during Pro trial',
      (await page.locator('.upgrade-link').count()) === 1
    );
    check('no console errors (Pro trial)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 3. Mid-trial user: no picker, live countdown ---------- */
  console.log('\nReturning mid-trial user (day 7)');
  {
    const context = await newAppContext(browser, {
      trials: [trialRow('pro', 7)],
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.tier-badge.tier-pro.tier-trial', { timeout: 8000 });
    check('no picker for existing trial', (await page.locator('.trial-picker').count()) === 0);
    check(
      'countdown shows 7 days left',
      ((await page.textContent('.trial-countdown')) || '').trim() === '7 days left'
    );
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('recording enabled mid-trial', true);
    check('no bookkeeping PATCH while trial is live', context.state.trialPatches.length === 0);
    check('no console errors (mid-trial)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 4. Expired trial: locked + banner + bookkeeping ---------- */
  console.log('\nExpired trial (ended 3 days ago)');
  {
    const context = await newAppContext(browser, {
      trials: [trialRow('starter', 17)], // 14-day window ended 3 days ago
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.tier-badge.tier-free', { timeout: 8000 });
    check('badge back to Free after expiry', true);
    check('no picker after an expired trial', (await page.locator('.trial-picker').count()) === 0);
    check(
      'record button locked again',
      await page.locator('.record-btn.start').isDisabled()
    );
    check(
      'locked upsell shown again',
      (await page.locator('.record-locked').count()) === 1
    );
    const bannerText = (await page.textContent('.trial-ended-banner')) || '';
    check(
      'trial-ended banner with relative time',
      bannerText.includes('trial ended') && bannerText.includes('3 days ago'),
      bannerText
    );
    check(
      'banner upgrade CTA → /pricing',
      (await page.getAttribute('.trial-ended-upgrade', 'href')) === '/pricing'
    );
    check(
      'header upgrade link says continue',
      ((await page.textContent('.upgrade-link')) || '').includes('Upgrade to continue')
    );
    await page.waitForFunction(
      () => true, // give the effect a beat
      { timeout: 1000 }
    ).catch(() => {});
    await sleep(600);
    check(
      'trial_active=false bookkeeping PATCH fired once',
      context.state.trialPatches.length === 1 &&
        context.state.trialPatches[0]?.trial_active === false,
      JSON.stringify(context.state.trialPatches)
    );
    // Banner dismisses.
    await page.click('.trial-ended-dismiss');
    check(
      'banner dismissible',
      (await page.locator('.trial-ended-banner').count()) === 0
    );
    check('no console errors (expired)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 5. Paid tier beats trial row ---------- */
  console.log('\nPaid user with a consumed trial row');
  {
    const context = await newAppContext(browser, {
      dbTier: 'starter',
      trials: [trialRow('starter', 5, false)], // converted mid-trial
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.tier-badge.tier-starter', { timeout: 8000 });
    check(
      'plain Starter badge (no TRIAL suffix)',
      (await page.textContent('.tier-badge')).trim() === 'Starter'
    );
    check('no countdown when paid', (await page.locator('.trial-countdown').count()) === 0);
    check('no trial-ended banner when paid', (await page.locator('.trial-ended-banner').count()) === 0);
    await page.waitForSelector('.record-btn.start:enabled', { timeout: 8000 });
    check('recording enabled when paid', true);
    check('no console errors (paid)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 6. "No thanks" sticks across reloads ---------- */
  console.log('\nPicker dismissal persists');
  {
    const context = await newAppContext(browser);
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.trial-picker', { timeout: 8000 });
    await page.click('.trial-picker-skip');
    check('picker closes on skip', (await page.locator('.trial-picker').count()) === 0);
    check(
      'record stays locked on Free after skip',
      await page.locator('.record-btn.start').isDisabled()
    );
    await page.reload();
    await page.waitForSelector('.tier-badge.tier-free', { timeout: 8000 });
    await sleep(400);
    check(
      'picker does NOT reappear after reload',
      (await page.locator('.trial-picker').count()) === 0
    );
    check('no console errors (skip)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 7. Pricing page states ---------- */
  console.log('\nPricing page: eligible user starts trial in place');
  {
    const context = await newAppContext(browser);
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/pricing');
    const starterBtn = page.locator('.price-card.featured .price-btn');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.price-card.featured .price-btn')
          ?.textContent.includes('Try free for 14 days'),
      { timeout: 8000 }
    );
    check('eligible: Starter button offers no-card trial', true);
    await starterBtn.click();
    await page.waitForURL('**/app', { timeout: 8000 });
    check('starting from pricing lands in /app', true);
    await page.waitForSelector('.tier-badge.tier-starter.tier-trial', { timeout: 8000 });
    check('trial active after pricing start', true);
    check('no checkout call for no-card trial', context.checkoutCalls.length === 0);
    check('no console errors (pricing eligible)', errors.length === 0, errors.join(' | '));
    await context.close();
  }
  console.log('\nPricing page: in-trial and expired states');
  {
    const context = await newAppContext(browser, { trials: [trialRow('starter', 4)] });
    const page = await context.newPage();
    await page.goto(BASE + '/pricing');
    await page.waitForSelector('.pricing-status-note.trial', { timeout: 8000 });
    const note = await page.textContent('.pricing-status-note.trial');
    check('in-trial note shows tier + days left', note.includes('Starter trial') && note.includes('10 days'), note);
    const btnText = await page.textContent('.price-card.featured .price-btn');
    check('trialed tier button says keep', btnText.includes('Upgrade — keep Starter'), btnText);
    await page.click('.price-card.featured .price-btn');
    await page.waitForURL('**checkout.stripe.test**', { timeout: 8000 });
    check(
      'trial upgrade goes to Stripe checkout with tier/cycle',
      context.checkoutCalls[0]?.tier === 'starter' && context.checkoutCalls[0]?.cycle === 'monthly',
      JSON.stringify(context.checkoutCalls)
    );
    await context.close();
  }
  {
    const context = await newAppContext(browser, { trials: [trialRow('pro', 20)] });
    const page = await context.newPage();
    await page.goto(BASE + '/pricing');
    await page.waitForSelector('.pricing-status-note.expired', { timeout: 8000 });
    check(
      'expired note says trial has ended',
      ((await page.textContent('.pricing-status-note.expired')) || '').includes('trial has ended')
    );
    const proBtn = await page.textContent('.price-card:has(.price-badge.pro) .price-btn');
    check('expired: Pro button says Upgrade to Pro', proBtn.includes('Upgrade to Pro'), proBtn);
    await context.close();
  }
  {
    const context = await newAppContext(browser, {
      dbTier: 'pro',
      trials: [trialRow('pro', 3, false)],
    });
    const page = await context.newPage();
    await page.goto(BASE + '/pricing');
    await page.waitForSelector('.pricing-status-note', { timeout: 8000 });
    check(
      'paid note mentions managing the subscription',
      ((await page.textContent('.pricing-status-note')) || '').includes('manage or cancel')
    );
    const proBtn = page.locator('.price-card:has(.price-badge.pro) .price-btn');
    check('paid: own tier shows Current plan', (await proBtn.textContent()).includes('Current plan'));
    check('paid: Current plan button disabled', await proBtn.isDisabled());
    await context.close();
  }

  /* ---------- 8. Mobile 375px ---------- */
  console.log('\nMobile (375×667)');
  {
    const context = await newAppContext(browser, {
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    const errors = trackErrors(page);

    await page.goto(BASE + '/app');
    await page.waitForSelector('.trial-picker', { timeout: 8000 });
    const overflowPicker = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    check('mobile: picker renders without horizontal overflow', overflowPicker);
    await page.click('.trial-choose-pro');
    await page.waitForSelector('.tier-badge.tier-pro.tier-trial', { timeout: 8000 });
    check('mobile: Pro trial starts', true);
    const overflowApp = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    check('mobile: app has no horizontal overflow with trial header', overflowApp);
    check('no console errors (mobile)', errors.length === 0, errors.join(' | '));
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
