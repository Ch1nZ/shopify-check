import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  consumeJobCredits,
  grantCompletedPaddlePurchase,
  readBrowserCreditBalance,
  readCreditBalance,
  releaseJobCredits,
  reserveJobCredits,
  sha256Hex,
} from "../src/credits";
import {
  consumeAccountRecovery,
  consumeAccountSignup,
  requestAccountRecovery,
  requestAccountSignup,
} from "../src/account-access";
import {
  grantPromotionalFreeCheck,
  readFreeCheckOffer,
  recordFreeCheckAdmission,
} from "../src/free-check";
import { modelFailureSummary } from "../src/customer-tasks";
import { productionHttpsRedirect } from "../src/index";
import { applyPublicOfferHtml } from "../src/public-offer-html";
import { applyMediaByteRange, parseBytesRange } from "../src/media-byte-range";
import { routeRequest } from "../src/http";
import {
  isOwnerStatsBlockedEmail,
  readOwnerStatsBoard,
  recordOwnerProductAttempt,
  shopDomainFromProductUrl,
} from "../src/owner-stats";
import { isPaddleSimulationEventId, verifyPaddleSignature } from "../src/paddle-webhooks";
import { existingRoleCallAction, modelRateLimitRetryDelaySeconds, classifyShoppingModelError } from "../src/shopping-orchestrator";
import { UncertainModelCallError } from "../src/model-journal";

describe("model failure diagnostics", () => {
  it("records structured-output truncation metadata without storing generated text", () => {
    const error = Object.assign(new Error("No object generated: could not parse the response."), {
      finishReason: "length",
      text: "private generated product evidence",
      usage: { outputTokens: 2_000, totalTokens: 5_100 },
      response: { id: "resp_123" },
    });

    const summary = modelFailureSummary(error);
    expect(summary).toContain("finish_reason=length");
    expect(summary).toContain("output_tokens=2000");
    expect(summary).toContain("response_id=resp_123");
    expect(summary).not.toContain("private generated product evidence");
  });
});

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email_normalized TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS credit_operations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      operation_type TEXT NOT NULL,
      external_idempotency_key TEXT NOT NULL UNIQUE,
      credits INTEGER NOT NULL CHECK (credits > 0),
      status TEXT NOT NULL,
      external_operation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS credit_reservations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      job_id TEXT NOT NULL UNIQUE,
      credits INTEGER NOT NULL CHECK (credits > 0),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released', 'reconciling')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS external_identities (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (provider, external_id)
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS checkout_intents (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      pack_key TEXT NOT NULL,
      price_id TEXT NOT NULL,
      pricing_version TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      paddle_transaction_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      job_kind TEXT NOT NULL,
      protocol_version TEXT NOT NULL,
      pricing_version TEXT NOT NULL,
      reserved_credits INTEGER NOT NULL,
      reservation_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id),
      paddle_transaction_id TEXT NOT NULL UNIQUE,
      paddle_customer_id TEXT,
      pack_key TEXT NOT NULL,
      pricing_version TEXT NOT NULL,
      credit_grant INTEGER NOT NULL,
      currency_code TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY,
      paddle_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_object_key TEXT,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT
    )`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS account_recovery_tokens (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS account_signup_tokens (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      email_normalized TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS free_check_grants (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      email_normalized TEXT NOT NULL UNIQUE,
      credit_operation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS free_check_admissions (
      reservation_id TEXT PRIMARY KEY REFERENCES credit_reservations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS conversion_events (
      id TEXT PRIMARY KEY,
      journey_hash TEXT NOT NULL,
      account_id TEXT,
      site TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path_group TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shopping_sessions (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      billing_status TEXT,
      collection_id TEXT
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS collection_runs (
      id TEXT PRIMARY KEY,
      requested_url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      status TEXT NOT NULL,
      product_record_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS owner_product_attempts (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      job_id TEXT,
      source TEXT NOT NULL,
      billing_kind TEXT NOT NULL,
      product_url TEXT NOT NULL,
      shop_domain TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`).run();
});

describe("MC Lab Self-Check Worker", () => {
  it("backs off provider rate limits without retrying indefinitely", () => {
    expect(modelRateLimitRetryDelaySeconds(0)).toBe(45);
    expect(modelRateLimitRetryDelaySeconds(1)).toBe(120);
    expect(modelRateLimitRetryDelaySeconds(2)).toBeNull();
  });

  it("executes a rate-limited role call again while preserving its call id", () => {
    expect(existingRoleCallAction(undefined)).toBe("execute");
    expect(existingRoleCallAction("reserved")).toBe("execute");
    expect(existingRoleCallAction("completed")).toBe("advance");
    expect(existingRoleCallAction("running")).toBe("reconcile");
    expect(existingRoleCallAction("incomplete")).toBe("ignore");
    expect(classifyShoppingModelError(new UncertainModelCallError())).toBe("MODEL_TIMEOUT_UNCERTAIN");
    expect(classifyShoppingModelError(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe("MODEL_TIMEOUT_UNCERTAIN");
    expect(classifyShoppingModelError(new Error("429 rate limited"))).toBe("MODEL_RATE_LIMITED");
  });

  it("verifies Paddle against the exact raw body and rejects tampering", async () => {
    const timestamp = 1_788_278_400;
    const secret = "pdl_ntfset_test_secret";
    const rawBody = '{"event_id":"evt_test","event_type":"transaction.completed","occurred_at":"2026-09-02T00:00:00.000Z","data":{}}';
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}:${rawBody}`));
    const signature = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const header = `ts=${timestamp};h1=${signature}`;

    await expect(verifyPaddleSignature({
      signatureHeader: header,
      rawBody,
      secret,
      nowSeconds: timestamp,
    })).resolves.toBe(true);
    await expect(verifyPaddleSignature({
      signatureHeader: header,
      rawBody: `${rawBody} `,
      secret,
      nowSeconds: timestamp,
    })).resolves.toBe(false);
  });

  it("distinguishes Paddle simulation events from real platform events", () => {
    expect(isPaddleSimulationEventId("ntfsimevt_01m1h12zttpk4w04rn8s2k1be3")).toBe(true);
    expect(isPaddleSimulationEventId("evt_00000000000000000000000001")).toBe(false);
    expect(isPaddleSimulationEventId("ntfsimevt_invalid")).toBe(false);
  });

  it("rewrites homepage first-paint offer copy to the Worker free-check flag", async () => {
    const html = `<!doctype html><html><head>
      <meta name="description" content="stale paid copy" data-offer-copy="meta" />
      <script id="mclab-public-offer" type="application/json">{"free_check_enabled":false}</script>
    </head><body>
      <p class="lede" data-offer-copy="lede">Then run a paid, recorded AI shopping test</p>
      <p class="preview-boundary" data-offer-copy="preview-boundary">Paid AI shopping test with one-time credits.</p>
    </body></html>`;

    const enabled = await applyPublicOfferHtml(
      new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      true,
    ).text();
    expect(enabled).toContain('data-free-check-enabled="true"');
    expect(enabled).toContain('"free_check_enabled":true');
    expect(enabled).toContain("No email or payment required");
    expect(enabled).toContain("does not test AI recommendations");
    expect(enabled).toContain("Free Shopify product check");
    expect(enabled).not.toContain("Then run a paid, recorded AI shopping test");
    expect(enabled).not.toMatch(/high-capacity|several minutes/i);

    const disabled = await applyPublicOfferHtml(
      new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      false,
    ).text();
    expect(disabled).toContain('data-free-check-enabled="false"');
    expect(disabled).toContain('"free_check_enabled":false');
    expect(disabled).toContain("No email or payment required");
    expect(disabled).not.toContain("verify your email to run 1 free Self-Check");
  });

  it("returns a versioned health response", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/health");
    const payload = await response.json<{ data: { status: string; pricing_version: string; jev_classifier: boolean } }>();

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    expect(payload.data).toMatchObject({ status: "ok", pricing_version: "self-hosted-v1", jev_classifier: false });
  });

  it("redirects HTTP to the exact HTTPS URL in one hop", async () => {
    const request = new Request("http://example.test/path?source=a");
    const response = productionHttpsRedirect(request, "production");

    expect(response?.status).toBe(308);
    expect(response?.headers.get("Location")).toBe("https://example.test/path?source=a");
    expect(productionHttpsRedirect(request, "local")).toBeNull();
  });

  it("fails closed when Paddle Checkout is not configured for the environment", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/billing/paddle/config");
    const payload = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.error.code).toBe("CHECKOUT_UNAVAILABLE");
  });

  it("rejects browser mutations without an exact same-origin header", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/billing/paddle/checkout-intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack_key: "starter" }),
    });
    const payload = await response.json<{ error: { code: string } }>();
    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("protects the free product preview with the same-origin check", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/free-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_url: "https://shop.example/products/sample-product" }),
    });
    const payload = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it.each(["self_check_view", "preview_recheck_completed", "preview_share_copied"])("records first-party %s without the raw journey id", async (eventName) => {
    const eventId = crypto.randomUUID();
    const journeyId = crypto.randomUUID();
    const response = await SELF.fetch("https://example.test/api/v1/analytics/events", {
      method: "POST",
      headers: { Origin: "https://example.test", "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: eventId,
        journey_id: journeyId,
        site: "self_check",
        event_name: eventName,
        path_group: "self_check",
        occurred_at: new Date().toISOString(),
      }),
    });
    expect(response.status).toBe(204);
    const row = await env.DB.prepare(
      "SELECT journey_hash, event_name FROM conversion_events WHERE id = ?",
    ).bind(eventId).first<{ journey_hash: string; event_name: string }>();
    expect(row?.event_name).toBe(eventName);
    expect(row?.journey_hash).toHaveLength(64);
    expect(row?.journey_hash).not.toBe(journeyId);
  });

  it("consumes account access links once and creates a secure browser session", async () => {
    const accountId = crypto.randomUUID();
    const token = "a".repeat(64);
    const now = new Date();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(accountId, now.toISOString(), now.toISOString()),
      env.DB.prepare(`INSERT INTO account_recovery_tokens
        (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), accountId, await sha256Hex(token), new Date(now.getTime() + 60_000).toISOString(), now.toISOString()),
    ]);
    const first = await consumeAccountRecovery(token, env);
    const replay = await consumeAccountRecovery(token, env);
    expect(first?.setCookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(replay).toBeNull();
  });

  it("distinguishes an anonymous browser from an email-connected account", async () => {
    const guest = await readBrowserCreditBalance(new Request("https://example.test"), env);
    expect(guest.account_access).toEqual({ status: "guest", email_hint: null });
    expect(guest.set_cookie).toContain("mclab_session=");

    const token = guest.set_cookie!.match(/mclab_session=([^;]+)/)?.[1];
    const tokenHash = await sha256Hex(token!);
    const session = await env.DB.prepare(
      "SELECT account_id FROM sessions WHERE token_hash = ?",
    ).bind(tokenHash).first<{ account_id: string }>();
    await env.DB.prepare(
      "UPDATE accounts SET email_normalized = ?, updated_at = ? WHERE id = ?",
    ).bind("connected-state@example.com", new Date().toISOString(), session!.account_id).run();

    const connected = await readBrowserCreditBalance(new Request("https://example.test", {
      headers: { Cookie: `mclab_session=${token}` },
    }), env);
    expect(connected.account_access).toEqual({
      status: "connected",
      email_hint: "c••••••e@example.com",
    });
    expect(connected.set_cookie).toBeUndefined();
  });

  it("accepts only a public HTTPS Shopify product path", async () => {
    const accepted = await SELF.fetch("https://example.test/api/v1/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_url: "https://shop.example/en/products/sample-product" }),
    });
    const acceptedPayload = await accepted.json<{ data: { supported: boolean; product_handle: string } }>();

    expect(accepted.status).toBe(200);
    expect(acceptedPayload.data).toMatchObject({ supported: true, product_handle: "sample-product" });

    const rejected = await SELF.fetch("https://example.test/api/v1/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_url: "https://127.0.0.1/products/private" }),
    });
    expect(rejected.status).toBe(422);
  });

  it("serializes concurrent reservations for the same account", async () => {
    const admission = env.CREDIT_ADMISSION.getByName("account-concurrency-test");
    const [first, second] = await Promise.all([
      admission.reserve({
        reservationId: crypto.randomUUID(),
        observedBalance: 20,
        credits: 20,
      }),
      admission.reserve({
        reservationId: crypto.randomUUID(),
        observedBalance: 20,
        credits: 20,
      }),
    ]);

    expect([first.admitted, second.admitted].sort()).toEqual([false, true]);
    expect(await admission.snapshot()).toHaveLength(1);
  });

  it("admits only three concurrent 30-credit tasks against a 100-credit grant", async () => {
    const accountId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
      ).bind(accountId, now, now),
      env.DB.prepare(
        `INSERT INTO credit_operations (
          id, account_id, operation_type, external_idempotency_key, credits,
          status, created_at, updated_at
         ) VALUES (?, ?, 'grant', ?, 100, 'completed', ?, ?)`,
      ).bind(crypto.randomUUID(), accountId, `test-grant:${accountId}`, now, now),
    ]);

    const attempts = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const jobId = crypto.randomUUID();
      const reservationId = crypto.randomUUID();
      return {
        jobId,
        reservationId,
        result: await reserveJobCredits({ accountId, jobId, reservationId }, env),
      };
    }));
    expect(attempts.filter((attempt) => attempt.result.admitted)).toHaveLength(3);
    await expect(readCreditBalance(accountId, env)).resolves.toEqual({
      settled_credits: 100,
      reserved_credits: 90,
      available_credits: 10,
    });

    const consumed = attempts.find((attempt) => attempt.result.admitted)!;
    await consumeJobCredits({
      accountId,
      jobId: consumed.jobId,
      reservationId: consumed.reservationId,
    }, env);
    await consumeJobCredits({
      accountId,
      jobId: consumed.jobId,
      reservationId: consumed.reservationId,
    }, env);
    await expect(readCreditBalance(accountId, env)).resolves.toEqual({
      settled_credits: 70,
      reserved_credits: 60,
      available_credits: 10,
    });

    const released = attempts.find(
      (attempt) => attempt.result.admitted && attempt.reservationId !== consumed.reservationId,
    )!;
    await releaseJobCredits({
      accountId,
      jobId: released.jobId,
      reservationId: released.reservationId,
    }, env);
    await expect(readCreditBalance(accountId, env)).resolves.toEqual({
      settled_credits: 70,
      reserved_credits: 30,
      available_credits: 40,
    });
  });

  it("grants a completed Paddle transaction exactly once", async () => {
    const billingEventId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO billing_events (
        id, paddle_event_id, event_type, status, received_at
       ) VALUES (?, ?, 'transaction.completed', 'received_pending_credit_grant', ?)`,
    ).bind(billingEventId, "evt_00000000000000000000000002", now).run();
    const input = {
      billingEventId,
      paddleEventId: "evt_00000000000000000000000002",
      transactionId: "txn_00000000000000000000000003",
      paddleCustomerId: "ctm_00000000000000000000000004",
      paddleCustomerEmail: "Buyer@Example.com",
      checkoutIntentId: null,
      pack: {
        key: "starter" as const,
        productName: "Starter",
        description: "Starter credits",
        currencyCode: "USD" as const,
        amount: "900",
        creditGrant: 90,
        completedTasks: 3,
        taxCategory: "saas" as const,
        billingType: "one_time" as const,
        pricingVersion: "2026-09-beta-v2" as const,
      },
      priceId: "pri_00000000000000000000000005",
      currencyCode: "USD",
      amount: "900",
    };

    const first = await grantCompletedPaddlePurchase(input, env);
    const replay = await grantCompletedPaddlePurchase(input, env);
    expect(first.balance.available_credits).toBe(90);
    expect(first.duplicate).toBe(false);
    expect(replay.balance.available_credits).toBe(90);
    expect(replay.duplicate).toBe(true);
    const operations = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM credit_operations WHERE external_idempotency_key = ?",
    ).bind(`paddle:transaction:${input.transactionId}`).first<{ count: number }>();
    expect(operations?.count).toBe(1);
    const account = await env.DB.prepare(
      "SELECT email_normalized FROM accounts WHERE id = ?",
    ).bind(first.account_id).first<{ email_normalized: string | null }>();
    expect(account?.email_normalized).toBe("buyer@example.com");
  });

  it("reattaches a returning Paddle customer from a fresh anonymous browser", async () => {
    const now = new Date().toISOString();
    const pack = {
      key: "starter" as const,
      productName: "Starter",
      description: "Starter credits",
      currencyCode: "USD" as const,
      amount: "900",
      creditGrant: 90,
      completedTasks: 3,
      taxCategory: "saas" as const,
      billingType: "one_time" as const,
      pricingVersion: "2026-09-beta-v2" as const,
    };
    const customerId = "ctm_00000000000000000000000006";
    const priceId = "pri_00000000000000000000000005";
    const firstAccount = crypto.randomUUID();
    const secondAccount = crypto.randomUUID();
    const firstIntent = crypto.randomUUID();
    const secondIntent = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(firstAccount, now, now),
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(secondAccount, now, now),
      env.DB.prepare("INSERT INTO sessions (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), firstAccount, crypto.randomUUID(), "2099-01-01T00:00:00.000Z", now),
      env.DB.prepare("INSERT INTO sessions (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), secondAccount, crypto.randomUUID(), "2099-01-01T00:00:00.000Z", now),
      env.DB.prepare(`INSERT INTO checkout_intents
        (id, account_id, pack_key, price_id, pricing_version, status, expires_at, created_at, updated_at)
        VALUES (?, ?, 'starter', ?, '2026-09-beta-v2', 'open', '2099-01-01T00:00:00.000Z', ?, ?)`)
        .bind(firstIntent, firstAccount, priceId, now, now),
      env.DB.prepare(`INSERT INTO checkout_intents
        (id, account_id, pack_key, price_id, pricing_version, status, expires_at, created_at, updated_at)
        VALUES (?, ?, 'starter', ?, '2026-09-beta-v2', 'open', '2099-01-01T00:00:00.000Z', ?, ?)`)
        .bind(secondIntent, secondAccount, priceId, now, now),
    ]);

    for (const [ordinal, accountIntent] of [[1, firstIntent], [2, secondIntent]] as const) {
      const eventId = crypto.randomUUID();
      const paddleEventId = `evt_00000000000000000000000007${ordinal}`;
      await env.DB.prepare(
        "INSERT INTO billing_events (id, paddle_event_id, event_type, status, received_at) VALUES (?, ?, 'transaction.completed', 'received_pending_credit_grant', ?)",
      ).bind(eventId, paddleEventId, now).run();
      const result = await grantCompletedPaddlePurchase({
        billingEventId: eventId,
        paddleEventId,
        transactionId: `txn_00000000000000000000000008${ordinal}`,
        paddleCustomerId: customerId,
        checkoutIntentId: accountIntent,
        pack,
        priceId,
        currencyCode: "USD",
        amount: "900",
      }, env);
      expect(result.account_id).toBe(firstAccount);
      expect(result.balance.available_credits).toBe(ordinal * 90);
    }
    const movedSession = await env.DB.prepare(
      "SELECT account_id FROM sessions WHERE account_id = ?",
    ).bind(firstAccount).all<{ account_id: string }>();
    expect(movedSession.results).toHaveLength(2);
    const identity = await env.DB.prepare(
      "SELECT account_id FROM external_identities WHERE provider = 'paddle_customer' AND external_id = ?",
    ).bind(customerId).first<{ account_id: string }>();
    expect(identity?.account_id).toBe(firstAccount);
  });

  it("merges a first Paddle checkout into an existing email-recovered account", async () => {
    const now = new Date().toISOString();
    const recoveredAccount = crypto.randomUUID();
    const checkoutAccount = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const billingEventId = crypto.randomUUID();
    const customerId = "ctm_00000000000000000000000009";
    const transactionId = "txn_00000000000000000000000010";
    const priceId = "pri_00000000000000000000000005";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
        .bind(recoveredAccount, "owner@example.com", now, now),
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(checkoutAccount, now, now),
      env.DB.prepare(`INSERT INTO checkout_intents
        (id, account_id, pack_key, price_id, pricing_version, status, expires_at, created_at, updated_at)
        VALUES (?, ?, 'starter', ?, '2026-09-beta-v2', 'open', '2099-01-01T00:00:00.000Z', ?, ?)`)
        .bind(intentId, checkoutAccount, priceId, now, now),
      env.DB.prepare("INSERT INTO billing_events (id, paddle_event_id, event_type, status, received_at) VALUES (?, ?, 'transaction.completed', 'received_pending_credit_grant', ?)")
        .bind(billingEventId, "evt_00000000000000000000000011", now),
    ]);
    const result = await grantCompletedPaddlePurchase({
      billingEventId,
      paddleEventId: "evt_00000000000000000000000011",
      transactionId,
      paddleCustomerId: customerId,
      paddleCustomerEmail: "OWNER@example.com",
      checkoutIntentId: intentId,
      pack: {
        key: "starter",
        productName: "Starter",
        description: "Starter credits",
        currencyCode: "USD",
        amount: "900",
        creditGrant: 90,
        completedTasks: 3,
        taxCategory: "saas",
        billingType: "one_time",
        pricingVersion: "2026-09-beta-v2",
      },
      priceId,
      currencyCode: "USD",
      amount: "900",
    }, env);
    expect(result.account_id).toBe(recoveredAccount);
    expect(result.balance.available_credits).toBe(90);
    const identity = await env.DB.prepare(
      "SELECT account_id FROM external_identities WHERE provider = 'paddle_customer' AND external_id = ?",
    ).bind(customerId).first<{ account_id: string }>();
    expect(identity?.account_id).toBe(recoveredAccount);
  });

  it("does not expose qualification routes without an admin token", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/qualification/ai-runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });
});

function withFreeCheck(testEnv: Env, overrides: { enabled?: boolean; cap?: number } = {}): Env {
  return new Proxy(testEnv, {
    get(target, prop, receiver) {
      if (prop === "FREE_CHECK_ENABLED") return overrides.enabled === false ? "false" : "true";
      if (prop === "FREE_CHECK_DAILY_CAP") return String(overrides.cap ?? 50);
      if (prop === "RESEND_API_KEY") return "re_test_key";
      if (prop === "RECOVERY_EMAIL_FROM") return "MC Lab <access@mail.mclab.party>";
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function insertSignupToken(input: {
  accountId: string;
  email: string;
  token: string;
  env: Env;
}): Promise<void> {
  const now = new Date();
  await input.env.DB.prepare(
    `INSERT INTO account_signup_tokens
     (id, account_id, email_normalized, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.accountId,
    input.email,
    await sha256Hex(input.token),
    new Date(now.getTime() + 60_000).toISOString(),
    now.toISOString(),
  ).run();
}

const starterPack = {
  key: "starter" as const,
  productName: "Starter",
  description: "Starter credits",
  currencyCode: "USD" as const,
  amount: "900",
  creditGrant: 90,
  completedTasks: 3,
  taxCategory: "saas" as const,
  billingType: "one_time" as const,
  pricingVersion: "2026-09-beta-v2" as const,
};

describe("Self-Check free check", () => {
  it("does not grant on guest cookie create", async () => {
    const guest = await readBrowserCreditBalance(new Request("https://example.test"), env);
    expect(guest.balance.available_credits).toBe(0);
    const operations = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM credit_operations WHERE account_id = ?",
    ).bind(guest.account_id).first<{ count: number }>();
    expect(operations?.count).toBe(0);
    const grants = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM free_check_grants WHERE account_id = ?",
    ).bind(guest.account_id).first<{ count: number }>();
    expect(grants?.count).toBe(0);
  });

  it("does not grant when the feature flag is off", async () => {
    const accountId = crypto.randomUUID();
    const now = new Date().toISOString();
    const email = `flag-off-${accountId.slice(0, 8)}@example.com`;
    await env.DB.prepare(
      "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    ).bind(accountId, now, now).run();
    const result = await grantPromotionalFreeCheck(accountId, email, withFreeCheck(env, { enabled: false }));
    expect(result).toEqual({ granted: false, reason: "flag_off" });
    await expect(readCreditBalance(accountId, env)).resolves.toEqual({
      settled_credits: 0,
      reserved_credits: 0,
      available_credits: 0,
    });
  });

  it("grants 30 promotional credits once per verified email", async () => {
    const accountId = crypto.randomUUID();
    const now = new Date().toISOString();
    const email = `once-${accountId.slice(0, 8)}@example.com`;
    const token = "b".repeat(64);
    await env.DB.prepare(
      "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    ).bind(accountId, now, now).run();
    await insertSignupToken({ accountId, email, token, env });
    const first = await consumeAccountSignup(token, withFreeCheck(env));
    expect(first?.setCookie).toContain("HttpOnly; Secure; SameSite=Lax");
    await expect(readCreditBalance(accountId, env)).resolves.toMatchObject({
      settled_credits: 30,
      available_credits: 30,
    });
    const offer = await readFreeCheckOffer(accountId, withFreeCheck(env));
    expect(offer).toMatchObject({ granted: true, remaining: 1 });

    const replayAccount = crypto.randomUUID();
    const replayToken = "c".repeat(64);
    await env.DB.prepare(
      "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    ).bind(replayAccount, now, now).run();
    await insertSignupToken({ accountId: replayAccount, email, token: replayToken, env });
    const replay = await consumeAccountSignup(replayToken, withFreeCheck(env));
    expect(replay?.setCookie).toContain("mclab_session=");
    await expect(readCreditBalance(accountId, env)).resolves.toMatchObject({ available_credits: 30 });
    await expect(readCreditBalance(replayAccount, env)).resolves.toMatchObject({ available_credits: 0 });
    const operations = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM credit_operations WHERE external_idempotency_key = ?",
    ).bind(`trial:v1:${email}`).first<{ count: number }>();
    expect(operations?.count).toBe(1);
  });

  it("returns 402 for a diagnostic without a grant", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/tasks", {
      method: "POST",
      headers: {
        Origin: "https://example.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_url: "https://shop.example/products/sample-product",
        target_market: "United States",
        shopping_model_route: "observer",
        shopping_reasoning_effort: "medium",
      }),
    });
    const payload = await response.json<{ error: { code: string } }>();
    expect(response.status).toBe(402);
    expect(payload.error.code).toBe("PAYMENT_REQUIRED");
  });

  it("consumes the free check on a completed reservation and restores it on release", async () => {
    const accountId = crypto.randomUUID();
    const now = new Date().toISOString();
    const email = `consume-${accountId.slice(0, 8)}@example.com`;
    await env.DB.prepare(
      "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    ).bind(accountId, now, now).run();
    const enabled = withFreeCheck(env);
    expect(await grantPromotionalFreeCheck(accountId, email, enabled)).toMatchObject({ granted: true });

    const releasedJob = crypto.randomUUID();
    const releasedReservation = crypto.randomUUID();
    expect((await reserveJobCredits({
      accountId,
      jobId: releasedJob,
      reservationId: releasedReservation,
    }, env)).admitted).toBe(true);
    await recordFreeCheckAdmission({
      accountId,
      jobId: releasedJob,
      reservationId: releasedReservation,
    }, enabled);
    await releaseJobCredits({
      accountId,
      jobId: releasedJob,
      reservationId: releasedReservation,
    }, env);
    expect(await readFreeCheckOffer(accountId, enabled)).toMatchObject({ granted: true, remaining: 1 });
    await expect(readCreditBalance(accountId, env)).resolves.toMatchObject({
      available_credits: 30,
      reserved_credits: 0,
    });

    const completedJob = crypto.randomUUID();
    const completedReservation = crypto.randomUUID();
    expect((await reserveJobCredits({
      accountId,
      jobId: completedJob,
      reservationId: completedReservation,
    }, env)).admitted).toBe(true);
    await recordFreeCheckAdmission({
      accountId,
      jobId: completedJob,
      reservationId: completedReservation,
    }, enabled);
    await consumeJobCredits({
      accountId,
      jobId: completedJob,
      reservationId: completedReservation,
    }, env);
    expect(await readFreeCheckOffer(accountId, enabled)).toMatchObject({ granted: true, remaining: 0 });
    await expect(readCreditBalance(accountId, env)).resolves.toMatchObject({
      settled_credits: 0,
      available_credits: 0,
    });
  });

  it("keeps unknown-email recovery as a silent no-op", async () => {
    const enabled = withFreeCheck(env);
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_recovery_tokens",
    ).first<{ count: number }>();
    await requestAccountRecovery(
      new Request("https://example.test/api/v1/account/recovery", { method: "POST" }),
      "unknown-recovery@example.com",
      enabled,
    );
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_recovery_tokens",
    ).first<{ count: number }>();
    const signupTokens = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_signup_tokens WHERE email_normalized = ?",
    ).bind("unknown-recovery@example.com").first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
    expect(signupTokens?.count).toBe(0);
  });

  it("creates a signup token for an unknown email when the flag is on", async () => {
    const enabled = withFreeCheck(env);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    try {
      await requestAccountSignup(
        new Request("https://example.test/api/v1/account/signup", { method: "POST" }),
        "new-signup@example.com",
        enabled,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const token = await env.DB.prepare(
      "SELECT email_normalized FROM account_signup_tokens WHERE email_normalized = ? AND used_at IS NULL",
    ).bind("new-signup@example.com").first<{ email_normalized: string }>();
    expect(token?.email_normalized).toBe("new-signup@example.com");
    const grants = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM free_check_grants WHERE email_normalized = ?",
    ).bind("new-signup@example.com").first<{ count: number }>();
    expect(grants?.count).toBe(0);
  });

  it("does not send or grant signup when the flag is off", async () => {
    const disabled = withFreeCheck(env, { enabled: false });
    await requestAccountSignup(
      new Request("https://example.test/api/v1/account/signup", { method: "POST" }),
      "flag-off-signup@example.com",
      disabled,
    );
    const token = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_signup_tokens WHERE email_normalized = ?",
    ).bind("flag-off-signup@example.com").first<{ count: number }>();
    expect(token?.count).toBe(0);
  });

  it("stops new promotional grants at the daily cap and still admits paid credits", async () => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const grantedToday = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM free_check_grants WHERE created_at >= ?",
    ).bind(dayStart.toISOString()).first<{ count: number }>();
    const cap = Number(grantedToday?.count ?? 0) + 1;
    const capped = withFreeCheck(env, { cap });
    const firstAccount = crypto.randomUUID();
    const secondAccount = crypto.randomUUID();
    const paidAccount = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(firstAccount, now, now),
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(secondAccount, now, now),
      env.DB.prepare("INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)")
        .bind(paidAccount, now, now),
    ]);
    expect(await grantPromotionalFreeCheck(firstAccount, `cap-one-${firstAccount.slice(0, 8)}@example.com`, capped))
      .toMatchObject({ granted: true });
    expect(await grantPromotionalFreeCheck(secondAccount, `cap-two-${secondAccount.slice(0, 8)}@example.com`, capped))
      .toMatchObject({ granted: false, reason: "daily_cap" });
    expect((await reserveJobCredits({
      accountId: secondAccount,
      jobId: crypto.randomUUID(),
      reservationId: crypto.randomUUID(),
    }, env)).admitted).toBe(false);

    await env.DB.prepare(
      `INSERT INTO credit_operations (
        id, account_id, operation_type, external_idempotency_key, credits,
        status, created_at, updated_at
       ) VALUES (?, ?, 'grant', ?, 90, 'completed', ?, ?)`,
    ).bind(crypto.randomUUID(), paidAccount, `paddle:transaction:txn_cap_${paidAccount.slice(0, 8)}`, now, now).run();
    expect((await reserveJobCredits({
      accountId: paidAccount,
      jobId: crypto.randomUUID(),
      reservationId: crypto.randomUUID(),
    }, env)).admitted).toBe(true);
  });

  it("keeps a later Paddle purchase on the signup account when checkout email differs", async () => {
    const now = new Date().toISOString();
    const signupAccount = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const billingEventId = crypto.randomUUID();
    const customerId = "ctm_00000000000000000000000012";
    const transactionId = "txn_00000000000000000000000013";
    const priceId = "pri_00000000000000000000000005";
    const signupEmail = `signup-${signupAccount.slice(0, 8)}@example.com`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
        .bind(signupAccount, signupEmail, now, now),
      env.DB.prepare(`INSERT INTO checkout_intents
        (id, account_id, pack_key, price_id, pricing_version, status, expires_at, created_at, updated_at)
        VALUES (?, ?, 'starter', ?, '2026-09-beta-v2', 'open', '2099-01-01T00:00:00.000Z', ?, ?)`)
        .bind(intentId, signupAccount, priceId, now, now),
      env.DB.prepare("INSERT INTO billing_events (id, paddle_event_id, event_type, status, received_at) VALUES (?, ?, 'transaction.completed', 'received_pending_credit_grant', ?)")
        .bind(billingEventId, "evt_00000000000000000000000014", now),
    ]);
    expect(await grantPromotionalFreeCheck(signupAccount, signupEmail, withFreeCheck(env)))
      .toMatchObject({ granted: true });
    const result = await grantCompletedPaddlePurchase({
      billingEventId,
      paddleEventId: "evt_00000000000000000000000014",
      transactionId,
      paddleCustomerId: customerId,
      paddleCustomerEmail: "other-checkout@example.com",
      checkoutIntentId: intentId,
      pack: starterPack,
      priceId,
      currencyCode: "USD",
      amount: "900",
    }, env);
    expect(result.account_id).toBe(signupAccount);
    expect(result.balance.available_credits).toBe(120);
    const account = await env.DB.prepare(
      "SELECT email_normalized FROM accounts WHERE id = ?",
    ).bind(signupAccount).first<{ email_normalized: string | null }>();
    expect(account?.email_normalized).toBe(signupEmail);
    const identity = await env.DB.prepare(
      "SELECT account_id FROM external_identities WHERE provider = 'paddle_customer' AND external_id = ?",
    ).bind(customerId).first<{ account_id: string }>();
    expect(identity?.account_id).toBe(signupAccount);
  });

  it("does not merge a signup account into a different paid Paddle identity", async () => {
    const now = new Date().toISOString();
    const signupAccount = crypto.randomUUID();
    const paidAccount = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const billingEventId = crypto.randomUUID();
    const customerId = "ctm_00000000000000000000000015";
    const priceId = "pri_00000000000000000000000005";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
        .bind(signupAccount, `keep-${signupAccount.slice(0, 8)}@example.com`, now, now),
      env.DB.prepare("INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
        .bind(paidAccount, "paid-owner@example.com", now, now),
      env.DB.prepare(`INSERT INTO external_identities
        (id, account_id, provider, external_id, created_at) VALUES (?, ?, 'paddle_customer', ?, ?)`)
        .bind(crypto.randomUUID(), paidAccount, customerId, now),
      env.DB.prepare(`INSERT INTO checkout_intents
        (id, account_id, pack_key, price_id, pricing_version, status, expires_at, created_at, updated_at)
        VALUES (?, ?, 'starter', ?, '2026-09-beta-v2', 'open', '2099-01-01T00:00:00.000Z', ?, ?)`)
        .bind(intentId, signupAccount, priceId, now, now),
      env.DB.prepare("INSERT INTO billing_events (id, paddle_event_id, event_type, status, received_at) VALUES (?, ?, 'transaction.completed', 'received_pending_credit_grant', ?)")
        .bind(billingEventId, "evt_00000000000000000000000016", now),
      env.DB.prepare(`INSERT INTO credit_operations (
        id, account_id, operation_type, external_idempotency_key, credits,
        status, created_at, updated_at
       ) VALUES (?, ?, 'grant', ?, 90, 'completed', ?, ?)`)
        .bind(crypto.randomUUID(), paidAccount, `paddle:transaction:txn_paid_${paidAccount.slice(0, 8)}`, now, now),
    ]);
    expect(await grantPromotionalFreeCheck(
      signupAccount,
      `keep-${signupAccount.slice(0, 8)}@example.com`,
      withFreeCheck(env),
    )).toMatchObject({ granted: true });
    await expect(grantCompletedPaddlePurchase({
      billingEventId,
      paddleEventId: "evt_00000000000000000000000016",
      transactionId: "txn_00000000000000000000000017",
      paddleCustomerId: customerId,
      paddleCustomerEmail: "paid-owner@example.com",
      checkoutIntentId: intentId,
      pack: starterPack,
      priceId,
      currencyCode: "USD",
      amount: "900",
    }, env)).rejects.toThrow("Paddle customer is already linked to a different funded account.");
  });
});

function withOwnerStats(testEnv: Env, token = "test-owner-stats-token"): Env {
  return new Proxy(testEnv, {
    get(target, prop, receiver) {
      if (prop === "OWNER_STATS_TOKEN") return token;
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("owner stats board", () => {
  it("stays dark when the owner token is unset", async () => {
    const missing = await SELF.fetch("https://example.test/owner/stats");
    const api = await SELF.fetch("https://example.test/api/v1/owner/stats", {
      headers: { Authorization: "Bearer test-owner-stats-token" },
    });
    expect(missing.status).toBe(404);
    expect(api.status).toBe(404);
    expect(await missing.text()).not.toContain("Owner stats");
  });

  it("does not index the token form and rejects a wrong token", async () => {
    const gated = withOwnerStats(env);
    const form = await routeRequest(new Request("https://example.test/owner/stats"), gated);
    expect(form.status).toBe(200);
    expect(form.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const html = await form.text();
    expect(html).toContain("Owner token");
    expect(html).not.toContain("merchant-secret@example.com");

    const rejected = await routeRequest(new Request("https://example.test/owner/stats", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=wrong-token",
    }), gated);
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).toContain("Token rejected.");
  });

  it("lists signup customers and trial shops only with the owner token", async () => {
    const gated = withOwnerStats(env);
    const now = new Date().toISOString();
    const accountId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const email = `owner-board-${accountId.slice(0, 8)}@example.com`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).bind(accountId, email, now, now),
      env.DB.prepare(
        `INSERT INTO free_check_grants (id, account_id, email_normalized, credit_operation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), accountId, email, crypto.randomUUID(), now),
      env.DB.prepare(
        `INSERT INTO conversion_events
          (id, journey_hash, site, event_name, path_group, occurred_at, received_at)
         VALUES (?, ?, 'self_check', 'self_check_view', 'self_check', ?, ?)`,
      ).bind(crypto.randomUUID(), "a".repeat(64), now, now),
    ]);
    await recordOwnerProductAttempt({
      accountId,
      jobId,
      source: "diagnostic",
      billingKind: "free_check",
      productUrl: "https://shop.example/products/trial-locket",
    }, env);

    const unauthorized = await routeRequest(new Request("https://example.test/api/v1/owner/stats"), gated);
    expect(unauthorized.status).toBe(401);

    const response = await routeRequest(new Request("https://example.test/api/v1/owner/stats", {
      headers: { Authorization: "Bearer test-owner-stats-token" },
    }), gated);
    const payload = await response.json<{ data: Awaited<ReturnType<typeof readOwnerStatsBoard>> }>();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(payload.data.counts.signup_customers).toBeGreaterThanOrEqual(1);
    expect(payload.data.counts.self_check_views).toBeGreaterThanOrEqual(1);
    expect(payload.data.signup_customers.some((row) => row.email === email)).toBe(true);
    expect(payload.data.products).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shop_domain: "shop.example",
        product_url: "https://shop.example/products/trial-locket",
        source: "diagnostic",
        billing_kind: "free_check",
        email,
      }),
    ]));

    const page = await routeRequest(new Request("https://example.test/owner/stats", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=test-owner-stats-token",
    }), gated);
    const pageHtml = await page.text();
    expect(page.status).toBe(200);
    expect(pageHtml).toContain(email);
    expect(pageHtml).toContain("shop.example");
    expect(pageHtml).toContain("free diagnostic");
  });

  it("records a preview product URL and shop domain", async () => {
    expect(shopDomainFromProductUrl("https://Brand.Example/products/one")).toBe("brand.example");
    const accountId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
    ).bind(accountId, now, now).run();
    await recordOwnerProductAttempt({
      accountId,
      source: "preview",
      billingKind: "none",
      productUrl: "https://preview.example/products/demo",
    }, env);
    const board = await readOwnerStatsBoard(env);
    expect(board.products).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shop_domain: "preview.example",
        source: "preview",
        billing_kind: "none",
      }),
    ]));
  });

  it("omits blocklisted test emails from account-scoped stats without deleting rows", async () => {
    expect(isOwnerStatsBlockedEmail("Operator-Test@Example.com")).toBe(true);
    expect(isOwnerStatsBlockedEmail("buyer@example.com")).toBe(false);

    const before = await readOwnerStatsBoard(env);
    const now = new Date().toISOString();
    const testAccount = crypto.randomUUID();
    const realAccount = crypto.randomUUID();
    const guestAccount = crypto.randomUUID();
    const testJob = crypto.randomUUID();
    const testReservation = crypto.randomUUID();
    const realEmail = `keep-${realAccount.slice(0, 8)}@example.com`;
    const testEmail = "operator-test@example.com";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).bind(testAccount, testEmail, now, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, email_normalized, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).bind(realAccount, realEmail, now, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
      ).bind(guestAccount, now, now),
      env.DB.prepare(
        `INSERT INTO free_check_grants (id, account_id, email_normalized, credit_operation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), testAccount, testEmail, crypto.randomUUID(), now),
      env.DB.prepare(
        `INSERT INTO free_check_grants (id, account_id, email_normalized, credit_operation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), realAccount, realEmail, crypto.randomUUID(), now),
      env.DB.prepare(
        `INSERT INTO jobs (id, account_id, job_kind, protocol_version, pricing_version, reserved_credits, reservation_id, status, created_at, updated_at)
         VALUES (?, ?, 'guided_search_premium', 'guided-shopping/1.0', '2026-09-beta-v2', 30, ?, 'completed', ?, ?)`,
      ).bind(testJob, testAccount, testReservation, now, now),
      env.DB.prepare(
        `INSERT INTO credit_reservations (id, account_id, job_id, credits, status, created_at, updated_at)
         VALUES (?, ?, ?, 30, 'consumed', ?, ?)`,
      ).bind(testReservation, testAccount, testJob, now, now),
      env.DB.prepare(
        `INSERT INTO free_check_admissions (reservation_id, account_id, job_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(testReservation, testAccount, testJob, now),
      env.DB.prepare(
        `INSERT INTO purchases (id, account_id, paddle_transaction_id, pack_key, pricing_version, credit_grant, currency_code, amount, status, created_at, updated_at)
         VALUES (?, ?, ?, 'starter', '2026-09-beta-v2', 90, 'USD', '900', 'completed', ?, ?)`,
      ).bind(crypto.randomUUID(), testAccount, `txn_test_${testAccount.slice(0, 8)}`, now, now),
      env.DB.prepare(
        `INSERT INTO conversion_events
          (id, journey_hash, site, event_name, path_group, occurred_at, received_at)
         VALUES (?, ?, 'self_check', 'self_check_view', 'self_check', ?, ?)`,
      ).bind(crypto.randomUUID(), "b".repeat(64), now, now),
    ]);
    await recordOwnerProductAttempt({
      accountId: testAccount,
      jobId: testJob,
      source: "diagnostic",
      billingKind: "free_check",
      productUrl: "https://test-shop.example/products/hidden",
    }, env);
    await recordOwnerProductAttempt({
      accountId: realAccount,
      source: "preview",
      billingKind: "none",
      productUrl: "https://real-shop.example/products/keep",
    }, env);
    await recordOwnerProductAttempt({
      accountId: guestAccount,
      source: "preview",
      billingKind: "none",
      productUrl: "https://guest-shop.example/products/anon",
    }, env);

    const after = await readOwnerStatsBoard(env);
    expect(after.signup_customers.some((row) => row.email === testEmail)).toBe(false);
    expect(after.signup_customers.some((row) => row.email === realEmail)).toBe(true);
    expect(after.products.some((row) => row.email === testEmail || row.product_url.includes("test-shop.example"))).toBe(false);
    expect(after.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ shop_domain: "real-shop.example", email: realEmail }),
      expect.objectContaining({ shop_domain: "guest-shop.example", email: null }),
    ]));
    expect(after.counts.signup_customers).toBe(before.counts.signup_customers + 1);
    expect(after.counts.email_connected_accounts).toBe(before.counts.email_connected_accounts + 1);
    expect(after.counts.purchases).toBe(before.counts.purchases);
    expect(after.counts.diagnostics_admitted).toBe(before.counts.diagnostics_admitted);
    expect(after.counts.free_check_diagnostics).toBe(before.counts.free_check_diagnostics);
    expect(after.counts.self_check_views).toBe(before.counts.self_check_views + 1);
    const storedGrant = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM free_check_grants WHERE email_normalized = ?",
    ).bind(testEmail).first<{ count: number }>();
    expect(Number(storedGrant?.count)).toBe(1);
  });
});

describe("media byte-range", () => {
  it("parses Safari's two-byte probe and open-ended ranges", () => {
    expect(parseBytesRange("bytes=0-1", 2838328)).toEqual({ start: 0, end: 1 });
    expect(parseBytesRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseBytesRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseBytesRange("bytes=50-49", 100)).toBeNull();
    expect(parseBytesRange("bytes=100-101", 100)).toBeNull();
  });

  it("answers Range requests for mp4 with 206 and Accept-Ranges", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const asset = new Response(body, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": "8" },
    });
    const ranged = await applyMediaByteRange(
      new Request("https://example.test/film.mp4", { headers: { Range: "bytes=0-1" } }),
      asset,
    );

    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Accept-Ranges")).toBe("bytes");
    expect(ranged.headers.get("Content-Range")).toBe("bytes 0-1/8");
    expect(ranged.headers.get("Content-Length")).toBe("2");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("advertises Accept-Ranges on a full mp4 response", async () => {
    const asset = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    });
    const full = await applyMediaByteRange(new Request("https://example.test/film.mp4"), asset);
    expect(full.status).toBe(200);
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
  });
});
