import { expect, test, type Page } from '@playwright/test';
import type { PublicProductPreview } from '@mclab/shopify-online-store';

const url = 'https://shop.example/products/canvas-bag';
const preview: PublicProductPreview = {
  status: 'complete', product_url: url, captured_at: '2026-10-01T12:00:00Z', rule_catalog_version: '2026-10-05.1',
  fields: {
    title: { state: 'verified', value: 'Fictional canvas bag' }, category: { state: 'single_source', value: 'Bags' },
    price: { state: 'verified', value: 4200 }, currency: { state: 'verified', value: 'USD' }, availability: { state: 'verified', value: true },
  },
  presence: [{ key: 'sku', label: 'SKU', field: 'sku', state: 'missing', relevant: true, sources: [] }],
  crawler_access: [{ agent: 'OAI-SearchBot', purpose: 'openai_search', result: 'allowed', matched_user_agent: '*', matched_rule: null }],
  findings: [], finding_counts: { error: 0, warning: 0, info: 0 }, note: 'Fictional test fixture; no storefront or model was queried.',
};
const priceIds = { starter: `pri_${'a'.repeat(26)}`, builder: `pri_${'b'.repeat(26)}`, studio: `pri_${'c'.repeat(26)}` };
const task = (status = 'completed') => ({
  id: 'fictional-task', job_status: status, billing_status: status === 'cancelled' ? 'released' : status === 'running' ? 'reserved' : 'consumed',
  balance: { available_credits: 60, settled_credits: 60, reserved_credits: 0 }, progress_stage: 'Conducting shopping conversation',
  session: { status, report: { status: 'complete', disclaimer: 'Synthetic recorded evidence.', summary: {}, turns: [{ ordinal: 1, stage: 'discovery', shopper_message: 'Which canvas bags suit a short commute?', shopping_answer: 'Fictional shopping evidence.', target_observation: null, sources: [] }] } },
});

type Options = { connected?: boolean; credits?: number; remaining?: 0 | 1; offer?: boolean; history?: boolean; status?: string };
async function boot(page: Page, options: Options = {}) {
  const requests: { path: string; body: any }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window as any;
    state.checkoutOpens = [];
    state.PaddleBillingV1 = {
      Environment: { set() {} }, Initialize(config: any) { state.paddleEvent = config.eventCallback; },
      Checkout: { open(config: any) { state.checkoutOpens.push(config); } },
    };
    window.print = () => { state.printed = true; };
  });
  // Deny all external requests: these tests cannot email, purchase, crawl a merchant or call a model.
  await page.route('**/*', async route => {
    const request = route.request();
    const parsed = new URL(request.url());
    if (parsed.origin !== 'http://127.0.0.1:4173') return route.abort();
    if (request.isNavigationRequest() && parsed.pathname === '/') {
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace('/src/entry.tsx', '/src/main.tsx').replace('</head>', `<script id="mclab-public-offer" type="application/json">{"free_check_enabled":${options.offer !== false}}</script></head>`) });
    }
    if (!parsed.pathname.startsWith('/api/')) return route.continue();
    const path = parsed.pathname;
    if (request.method() === 'POST') requests.push({ path, body: request.postDataJSON() });
    let data: unknown = {};
    if (path.endsWith('/billing/credits')) data = {
      available_credits: options.credits ?? 0, settled_credits: options.credits ?? 0, reserved_credits: 0,
      account_access: { status: options.connected ? 'connected' : 'guest', email_hint: options.connected ? 's***@example.com' : null },
      free_check: { enabled: options.offer !== false, signup_available: options.offer !== false, remaining: options.remaining ?? 0, granted: !!options.connected }, credits_per_completed_task: 30,
    };
    if (path.endsWith('/account/recovery-config')) data = { enabled: true, free_check: { signup_available: options.offer !== false } };
    if (path.endsWith('/account/history')) data = { reports: options.history ? [{ task_id: 'fictional-task', status: options.status ?? 'completed', created_at: '2026-10-01T12:00:00Z' }] : [] };
    if (path.endsWith('/free-preview')) data = { ...preview, product_url: request.postDataJSON().product_url };
    if (path.endsWith('/paddle/config')) data = { environment: 'sandbox', pricing_version: '2026-09-beta-v2', client_token: 'test_fictional', price_ids: priceIds };
    if (path.endsWith('/checkout-intents')) {
      const pack = request.postDataJSON().pack_key as keyof typeof priceIds;
      const id = '00000000-0000-4000-8000-000000000001';
      data = { intent_id: id, price_id: priceIds[pack], custom_data: { mclab_checkout_intent_id: id, mclab_catalog_key: pack, pricing_version: '2026-09-beta-v2' } };
    }
    if (path === '/api/v1/tasks') data = { task_id: 'fictional-task', collection_id: 'fictional-collection' };
    if (path === '/api/v1/tasks/fictional-task') data = task(options.status);
    return route.fulfill({ json: { data } });
  });
  return { requests, errors };
}
async function checkProduct(page: Page) {
  await page.getByLabel('Shopify product URL', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Check product data', exact: true }).click();
  await expect(page.locator('#free-preview-result')).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const viewport of [{ width: 1180, height: 757 }, { width: 1180, height: 600 }, { width: 400, height: 757 }, { width: 400, height: 600 }, { width: 390, height: 600 }, { width: 320, height: 568 }]) {
  test(`first-fold action and layout ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    const { errors } = await boot(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Check product data', exact: true });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThan(viewport.height);
    await expect(page.getByText('Fictional product', { exact: true })).toBeVisible();
    await expect(page.getByText('Check the image references.')).toBeVisible();
    await expect(page.locator('#feedback details')).not.toHaveAttribute('open');
    await expect(page.locator('.sticky-start')).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
    await page.screenshot({ path: info.outputPath('first-fold.png') });
    await page.locator('.account-nav').click();
    await expect(page.locator('#recovery-email')).toBeVisible();
    await noOverflow(page);
    expect(errors).toEqual([]);
  });
}

test('native URL validation and unsupported URLs make no preview request', async ({ page }) => {
  const { requests } = await boot(page); await page.goto('/');
  const input = page.getByLabel('Shopify product URL', { exact: true });
  for (const value of ['', 'not a url', 'http://shop.example/products/bag', 'https://shop.example/collections/bags']) {
    await input.fill(value); await input.press('Enter');
  }
  await expect(page.getByRole('alert')).toContainText('/products/{handle}');
  expect(requests.filter(r => r.path.endsWith('free-preview'))).toHaveLength(0);
});

test('duplicate submits, cancel and editing cannot display a stale result', async ({ page }) => {
  await boot(page);
  let count = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/free-preview', async route => {
    count++;
    const requested = route.request().postDataJSON().product_url;
    if (count === 1) await hold;
    await route.fulfill({ json: { data: { ...preview, product_url: requested } } });
  });
  await page.goto('/');
  await page.getByLabel('Shopify product URL', { exact: true }).fill(url);
  await page.locator('.product-check-form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect(page.getByRole('button', { name: 'Cancel check' })).toBeVisible();
  expect(count).toBe(1);
  await page.getByRole('button', { name: 'Cancel check' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Check cancelled' })).toBeVisible();
  await page.getByLabel('Shopify product URL', { exact: true }).fill('https://shop.example/products/second-bag');
  await page.getByRole('button', { name: 'Check product data', exact: true }).click();
  await expect(page.locator('.preview-share-url')).toContainText('second-bag');
  release();
  await expect(page.locator('.preview-share-url')).toContainText('second-bag');
  expect(count).toBe(2);
});

test('result, recheck, share, print and optional AI handoff stay separate', async ({ page }, info) => {
  const { requests, errors } = await boot(page); await page.goto('/'); await checkProduct(page);
  await expect(page.locator('.preview-fixes')).toContainText('Add a SKU');
  await expect(page.getByText('No email or payment required.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Recheck this page' }).click();
  await expect(page.getByText('No change since the last preview of this URL in this browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Copy share link' }).click();
  await expect(page.locator('.preview-share-status')).toBeVisible();
  await page.getByRole('button', { name: 'Print / save as PDF' }).click();
  expect(await page.evaluate(() => (window as any).printed)).toBe(true);
  expect(requests.filter(r => r.path === '/api/v1/tasks')).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('result-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 600 }); await noOverflow(page);
  await page.screenshot({ path: info.outputPath('result-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('shared links run once and partial/failed reads preserve recovery controls', async ({ page }) => {
  const { requests } = await boot(page);
  await page.goto(`/?product=${encodeURIComponent(url)}#start`);
  await expect(page.locator('#free-preview-result')).toBeVisible();
  expect(requests.filter(r => r.path.endsWith('free-preview'))).toHaveLength(1);
  await page.route('**/api/v1/free-preview', route => route.fulfill({ status: 404, json: { error: { code: 'PRODUCT_PAGE_UNAVAILABLE', message: 'HTTP 404' } } }));
  await page.getByRole('button', { name: 'Recheck this page' }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 404');
  await expect(page.getByText('Accepted Shopify product URLs')).toBeVisible();
  await expect(page.locator('.ai-test-step')).toHaveCount(0);
});

test('account chooses explicit endpoints and validates email before sending once', async ({ page }, info) => {
  const { requests } = await boot(page); await page.goto('/#account');
  await expect(page.locator('#recovery-email')).toBeVisible();
  await expect(page.locator('#signup-email')).toHaveCount(0);
  await page.getByRole('button', { name: 'First time? Verify email' }).click();
  const email = page.locator('#signup-email');
  await email.fill('invalid'); await email.press('Enter');
  expect(requests.filter(r => r.path.endsWith('/signup'))).toHaveLength(0);
  await email.fill('synthetic@example.com');
  await email.evaluate((input: HTMLInputElement) => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await expect(page.locator('.free-check-signup [role=status]')).toBeVisible();
  expect(requests.filter(r => r.path.endsWith('/signup'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#recovery-email').fill('synthetic@example.com');
  await page.getByRole('button', { name: 'Email sign-in link', exact: true }).click();
  expect(requests.filter(r => r.path.endsWith('/recovery'))).toHaveLength(1);
  await page.setViewportSize({ width: 400, height: 600 }); await noOverflow(page);
  await page.screenshot({ path: info.outputPath('account-mobile.png'), fullPage: true });
});

for (const status of ['completed', 'cancelled']) {
  test(`connected account restores ${status} report without creating a task`, async ({ page }) => {
    const { requests, errors } = await boot(page, { connected: true, credits: 60, history: true, status });
    await page.goto('/#account');
    await expect(page.locator('.connected-account-summary')).toContainText('60 credits');
    await page.getByRole('button', { name: 'View report' }).click();
    await expect(page.locator('#report')).toContainText(status === 'completed' ? 'Recorded test complete' : 'Reserved credits were returned');
    await expect(page.locator('#report')).toContainText('Fictional shopping evidence');
    expect(requests.filter(r => r.path === '/api/v1/tasks')).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test('complimentary AI task starts once and hides intermediate evidence while running', async ({ page }) => {
  const { requests } = await boot(page, { connected: true, credits: 30, remaining: 1, status: 'running' });
  await page.goto('/'); await checkProduct(page);
  await page.locator('.ai-test-step').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect(page.locator('#report')).toContainText('Your report is being generated');
  await expect(page.locator('#report')).not.toContainText('Fictional shopping evidence');
  expect(requests.filter(r => r.path === '/api/v1/tasks')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'AI test running…' })).toBeDisabled();
  const body = requests.find(r => r.path === '/api/v1/tasks')!.body;
  expect(body).toMatchObject({ product_url: url, target_market: 'United States', shopping_model_route: 'observer', shopping_reasoning_effort: 'medium' });
});

test('used complimentary offer routes to credit packs without a task', async ({ page }) => {
  const { requests } = await boot(page, { connected: true, credits: 0 }); await page.goto('/'); await checkProduct(page);
  await page.getByRole('button', { name: 'Run AI shopping test', exact: true }).click();
  await expect(page.locator('.pricing-prompt')).toContainText('0 remaining');
  expect(requests.filter(r => r.path === '/api/v1/tasks')).toHaveLength(0);
});

test('Paddle checkout arguments, repeated clicks, close and retry use mocked SDK only', async ({ page }) => {
  const { requests } = await boot(page); await page.goto('/#pricing');
  const buy = page.getByRole('button', { name: 'Buy Starter' }); await expect(buy).toBeEnabled();
  await buy.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => page.evaluate(() => (window as any).checkoutOpens.length)).toBe(1);
  expect(requests.filter(r => r.path.endsWith('/checkout-intents'))).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).checkoutOpens[0])).toMatchObject({ items: [{ priceId: priceIds.starter, quantity: 1 }], settings: { displayMode: 'overlay' } });
  await page.evaluate(() => (window as any).paddleEvent({ name: 'checkout.closed' }));
  await expect(buy).toBeEnabled(); await buy.click();
  await expect.poll(() => page.evaluate(() => (window as any).checkoutOpens.length)).toBe(2);
  await page.evaluate(() => (window as any).paddleEvent({ name: 'checkout.completed' }));
  await expect(page.locator('.checkout-message')).toContainText('signed Paddle webhook');
});

test('feedback deep link, validation, retry and idempotency preserve functionality', async ({ page }) => {
  await boot(page); let count = 0; const ids: string[] = [];
  await page.route('**/api/v1/feedback', async route => { count++; ids.push(route.request().postDataJSON().id); await route.fulfill({ status: count === 1 ? 503 : 200, json: count === 1 ? { error: { message: 'Please try again.' } } : { data: {} } }); });
  await page.goto('/#feedback'); await expect(page.locator('#feedback details')).toHaveAttribute('open');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click(); expect(count).toBe(0);
  await page.getByLabel('Your feedback', { exact: true }).fill('Synthetic feedback for a local test only.');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click(); await expect(page.locator('#feedback [role=alert]')).toContainText('try again');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click(); await expect(page.locator('.feedback-success')).toBeVisible();
  expect(ids[0]).toBe(ids[1]);
});

test('keyboard navigation and reduced motion retain visible focus', async ({ page }) => {
  await boot(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to product check' })).toBeFocused();
  await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  await expect(page.getByLabel('Shopify product URL', { exact: true })).toBeFocused();
  expect(await page.locator('.free-example').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await checkProduct(page); await noOverflow(page);
});

test('editing a pending URL aborts its result and network failure can be retried', async ({ page }) => {
  await boot(page);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/free-preview', async route => { await hold; await route.fulfill({ json: { data: preview } }); });
  await page.goto('/');
  const input = page.getByLabel('Shopify product URL', { exact: true });
  await input.fill(url); await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancel check' })).toBeVisible();
  await input.fill('https://shop.example/products/new-product');
  release();
  await expect(page.locator('#free-preview-result')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check product data', exact: true })).toBeEnabled();
  await page.route('**/api/v1/free-preview', route => route.abort());
  await input.press('Enter'); await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Check product data', exact: true })).toBeEnabled();
});

test('partial data and account/email failures remain recoverable', async ({ page }) => {
  await boot(page);
  await page.route('**/api/v1/free-preview', route => route.fulfill({ json: { data: { ...preview, status: 'partial', fields: { ...preview.fields, price: { state: 'missing', value: null } } } } }));
  await page.route('**/api/v1/billing/credits', route => route.abort());
  await page.goto('/'); await checkProduct(page);
  await expect(page.getByText('Product page partially readable')).toBeVisible();
  await expect(page.locator('#account')).toContainText('Account temporarily unavailable');
  await page.route('**/api/v1/account/signup', route => route.fulfill({ status: 503, json: { error: { message: 'Please request the link again later.' } } }));
  await page.locator('#free-check-signup-email').fill('synthetic@example.com');
  await page.locator('#free-check-signup').getByRole('button', { name: 'Email verification link' }).click();
  await expect(page.locator('#free-check-signup [role=status]')).toContainText('again later');
  await expect(page.locator('#free-check-signup-email')).toHaveValue('synthetic@example.com');
});

test('connected balances and results fit narrow headers', async ({ page }) => {
  await boot(page, { connected: true, credits: 30, remaining: 1 });
  await page.setViewportSize({ width: 320, height: 568 }); await page.goto('/');
  await expect(page.locator('.account-nav')).toHaveAccessibleName('1 AI test available'); await noOverflow(page);
  await checkProduct(page); await noOverflow(page);
  await page.locator('.account-nav').click(); await noOverflow(page);
});

test('offer disabled keeps free data check and sign-in while hiding email signup', async ({ page }) => {
  const { requests } = await boot(page, { offer: false }); await page.goto('/'); await checkProduct(page);
  await expect(page.locator('#free-check-signup')).toHaveCount(0);
  await expect(page.getByText('First time? Verify email')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run AI shopping test', exact: true }).click();
  await expect(page.locator('.pricing-prompt')).toContainText('30 credits');
  expect(requests.filter(r => r.path === '/api/v1/tasks')).toHaveLength(0);
});

test('free check timeout stops the request and restores retry', async ({ page }) => {
  await page.clock.install(); await boot(page);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/free-preview', async route => { await hold; await route.fulfill({ json: { data: preview } }); });
  await page.goto('/');
  await page.getByLabel('Shopify product URL', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Check product data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel check' })).toBeVisible();
  await page.clock.fastForward(20_001);
  await expect(page.getByRole('alert')).toContainText('timed out');
  await expect(page.getByRole('button', { name: 'Check product data', exact: true })).toBeEnabled();
  release();
});
