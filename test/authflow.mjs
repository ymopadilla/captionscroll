/**
 * CaptionScroll auth-redirect + pricing/checkout flow tests.
 *
 * Verifies (against `vite preview` serving the production build, with
 * Supabase and /api/* intercepted so no live backend is needed):
 *   - signup/login land on /app
 *   - signed-in users are redirected off /, /login, /signup
 *   - Free "Get Started" behavior for signed-out vs signed-in users
 *   - trial buttons send { tier, cycle } and redirect to Stripe checkout
 *
 * Run with:  node test/authflow.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4174;
const BASE = `http://localhost:${PORT}`;
const REF = 'rgpgascbdmbpkgsmgnmx';
const CHECKOUT_URL = 'https://checkout.stripe.test/c/pay/cs_test_fake123';

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

/**
 * New browser context. `signedIn` seeds the persisted Supabase session.
 * Records POST bodies sent to /api/create-checkout-session in
 * `ctx.checkoutCalls` and serves a fake Stripe-hosted checkout page.
 */
async function newContext(browser, { signedIn = false, viewport } = {}) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  if (signedIn) {
    await context.addInitScript(
      ([key, session]) => {
        window.localStorage.setItem(key, JSON.stringify(session));
      },
      [`sb-${REF}-auth-token`, FAKE_SESSION]
    );
  }
  // Supabase offline mocks (same approach as smoke.mjs).
  await context.route(`**${REF}.supabase.co/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/rest/v1/users')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ subscription_tier: 'free' }),
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
  // Serverless checkout endpoint mock.
  const checkoutCalls = [];
  await context.route('**/api/create-checkout-session', (route) => {
    checkoutCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: CHECKOUT_URL }),
    });
  });
  // Fake Stripe-hosted checkout destination.
  await context.route('https://checkout.stripe.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1 id="stripe-checkout">Stripe Checkout</h1></body></html>',
    })
  );
  context.checkoutCalls = checkoutCalls;
  return context;
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
  /* ---------- 1. Signed OUT: public pages render normally ---------- */
  console.log('\nSigned out: public pages');
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(BASE + '/');
    await page.waitForSelector('.hero-cta');
    check('landing renders (no redirect)', page.url() === BASE + '/');

    await page.goto(BASE + '/login');
    check('login form shows', (await page.locator('#login-email').count()) === 1);
    await page.goto(BASE + '/signup');
    check('signup form shows', (await page.locator('#signup-email').count()) === 1);

    await page.goto(BASE + '/pricing');
    const freeBtn = page.locator('.price-card:not(.featured) .price-btn').first();
    check('Free button says Get Started', (await freeBtn.textContent()).trim() === 'Get Started');
    check('Free button links to /signup', (await freeBtn.getAttribute('href')) === '/signup');

    // Trial button while signed out -> signup with plan intent.
    await page.click('.price-card.featured .price-btn');
    await page.waitForURL('**/signup?plan=starter&cycle=monthly');
    check('trial button (signed out) → signup with plan intent', true);
    check('no console errors on public pages', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 2. Login lands on /app ---------- */
  console.log('\nLogin flow');
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(BASE + '/login');
    await page.fill('#login-email', 'test@example.com');
    await page.fill('#login-password', 'password123');
    await page.click('.auth-submit');
    await page.waitForURL('**/app', { timeout: 8000 });
    check('login redirects to /app', page.url().endsWith('/app'));
    await page.waitForSelector('.stage', { timeout: 8000 });
    check('app loads after login', true);
    await context.close();
  }

  /* ---------- 3. Signup lands on /app (and resumes checkout intent) ---------- */
  console.log('\nSignup flow');
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(BASE + '/signup');
    await page.fill('#signup-email', 'new@example.com');
    await page.fill('#signup-password', 'password123');
    await page.click('.auth-submit');
    await page.waitForURL('**/app', { timeout: 8000 });
    check('signup redirects to /app', page.url().endsWith('/app'));
    await context.close();
  }
  {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(BASE + '/signup?plan=starter&cycle=monthly');
    await page.fill('#signup-email', 'new@example.com');
    await page.fill('#signup-password', 'password123');
    await page.click('.auth-submit');
    await page.waitForURL('**checkout.stripe.test**', { timeout: 8000 });
    check('signup with plan → auto-resumes checkout', true);
    check(
      'checkout got tier/cycle from signup intent',
      context.checkoutCalls[0]?.tier === 'starter' &&
        context.checkoutCalls[0]?.cycle === 'monthly',
      JSON.stringify(context.checkoutCalls)
    );
    await context.close();
  }

  /* ---------- 4. Signed IN: redirected off public/auth pages ---------- */
  console.log('\nSigned in: redirects to /app');
  {
    const context = await newContext(browser, { signedIn: true });
    const page = await context.newPage();

    await page.goto(BASE + '/');
    await page.waitForURL('**/app', { timeout: 8000 });
    check('landing → /app', page.url().endsWith('/app'));

    await page.goto(BASE + '/login');
    await page.waitForURL('**/app', { timeout: 8000 });
    check('/login → /app', page.url().endsWith('/app'));

    await page.goto(BASE + '/signup');
    await page.waitForURL('**/app', { timeout: 8000 });
    check('/signup → /app', page.url().endsWith('/app'));

    await context.close();
  }
  {
    // Signed in + plan intent on /signup carries through to checkout.
    const context = await newContext(browser, { signedIn: true });
    const page = await context.newPage();
    await page.goto(BASE + '/signup?plan=pro&cycle=annual');
    await page.waitForURL('**checkout.stripe.test**', { timeout: 8000 });
    check('signed-in /signup?plan= → checkout resumes', true);
    check(
      'checkout got pro/annual',
      context.checkoutCalls[0]?.tier === 'pro' && context.checkoutCalls[0]?.cycle === 'annual',
      JSON.stringify(context.checkoutCalls)
    );
    await context.close();
  }

  /* ---------- 5. Signed IN: pricing page buttons ---------- */
  console.log('\nSigned in: pricing buttons');
  {
    const context = await newContext(browser, { signedIn: true });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(BASE + '/pricing');
    const freeBtn = page.locator('.price-card:not(.featured) .price-btn').first();
    check('Free button says Open App', (await freeBtn.textContent()).trim() === 'Open App');
    check('Free button links to /app', (await freeBtn.getAttribute('href')) === '/app');
    await freeBtn.click();
    await page.waitForURL('**/app', { timeout: 8000 });
    check('Free button opens the app (no signup form)', page.url().endsWith('/app'));

    // Starter trial: straight to checkout, no signup.
    await page.goto(BASE + '/pricing');
    await page.click('.price-card.featured .price-btn');
    await page.waitForURL('**checkout.stripe.test**', { timeout: 8000 });
    check('Starter trial → Stripe checkout', true);
    check(
      'Starter monthly sent to API',
      context.checkoutCalls.at(-1)?.tier === 'starter' &&
        context.checkoutCalls.at(-1)?.cycle === 'monthly'
    );

    // Pro trial on the ANNUAL cycle.
    await page.goto(BASE + '/pricing');
    await page.click('.cycle-toggle button:nth-child(2)');
    await page.click('.price-card:has(.price-badge.pro) .price-btn');
    await page.waitForURL('**checkout.stripe.test**', { timeout: 8000 });
    check(
      'Pro annual sent to API',
      context.checkoutCalls.at(-1)?.tier === 'pro' &&
        context.checkoutCalls.at(-1)?.cycle === 'annual',
      JSON.stringify(context.checkoutCalls.at(-1))
    );
    check('no console errors on pricing flows', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  /* ---------- 6. Mobile viewport (375x812) ---------- */
  console.log('\nMobile (375x812)');
  {
    const context = await newContext(browser, {
      signedIn: true,
      viewport: { width: 375, height: 812 },
    });
    const page = await context.newPage();
    await page.goto(BASE + '/');
    await page.waitForURL('**/app', { timeout: 8000 });
    check('signed-in landing → /app on mobile', page.url().endsWith('/app'));
    await context.close();

    const anon = await newContext(browser, { viewport: { width: 375, height: 812 } });
    const page2 = await anon.newPage();
    await page2.goto(BASE + '/');
    await page2.waitForSelector('.hero-cta');
    check('signed-out landing renders on mobile', page2.url() === BASE + '/');
    await anon.close();
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
