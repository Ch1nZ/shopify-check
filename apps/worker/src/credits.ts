import { CREDIT_PACKS, PRICING_VERSION, type CreditPack } from "@mclab/domain";
import { z } from "zod";

export const COMPLETE_TASK_CREDITS = 30;
export const CreditPackKeySchema = z.enum(["starter", "builder", "studio"]);

const SESSION_COOKIE = "mclab_session";
const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
const CHECKOUT_INTENT_TTL_SECONDS = 24 * 60 * 60;

export type BrowserSession = {
  accountId: string;
  setCookie?: string;
};

export type CreditBalance = {
  settled_credits: number;
  reserved_credits: number;
  available_credits: number;
};

export type BrowserAccountAccess = {
  status: "guest" | "connected";
  email_hint: string | null;
};

export async function ensureBrowserSession(request: Request, env: Env): Promise<BrowserSession> {
  const rawToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (rawToken) {
    const tokenHash = await sha256Hex(rawToken);
    const row = await env.DB.prepare(
      `SELECT sessions.account_id
       FROM sessions
       JOIN accounts ON accounts.id = sessions.account_id
       WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ? AND accounts.status = 'active'`,
    ).bind(tokenHash, new Date().toISOString()).first<{ account_id: string }>();
    if (row) return { accountId: row.account_id };
  }

  const accountId = crypto.randomUUID();
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO accounts (id, status, created_at, updated_at)
     VALUES (?, 'active', ?, ?)`,
  ).bind(accountId, now.toISOString(), now.toISOString()).run();

  return createAccountSession(accountId, env);
}

export async function createAccountSession(accountId: string, env: Env): Promise<BrowserSession> {
  const sessionId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1_000);
  await env.DB.prepare(
    `INSERT INTO sessions (id, account_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(sessionId, accountId, tokenHash, expires.toISOString(), now.toISOString()).run();
  return {
    accountId,
    setCookie: `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  };
}

export async function createCheckoutIntent(
  request: Request,
  packKey: z.infer<typeof CreditPackKeySchema>,
  env: Env,
): Promise<{
  intent_id: string;
  price_id: string;
  custom_data: Record<string, string>;
  customer_email: string | null;
  set_cookie?: string;
}> {
  const session = await ensureBrowserSession(request, env);
  const rateLimit = await env.CHECKOUT_RATE_LIMITER.limit({ key: session.accountId });
  if (!rateLimit.success) {
    throw new CreditRateLimitError("Too many checkout attempts. Try again shortly.");
  }
  const priceId = priceIdForPack(packKey, env);
  const intentId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHECKOUT_INTENT_TTL_SECONDS * 1_000);
  await env.DB.prepare(
    `INSERT INTO checkout_intents (
      id, account_id, pack_key, price_id, pricing_version, status,
      expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).bind(
    intentId,
    session.accountId,
    packKey,
    priceId,
    PRICING_VERSION,
    expiresAt.toISOString(),
    now.toISOString(),
    now.toISOString(),
  ).run();

  const account = await env.DB.prepare(
    "SELECT email_normalized FROM accounts WHERE id = ? AND status = 'active'",
  ).bind(session.accountId).first<{ email_normalized: string | null }>();

  return {
    intent_id: intentId,
    price_id: priceId,
    custom_data: {
      mclab_checkout_intent_id: intentId,
      mclab_catalog_key: packKey,
      pricing_version: PRICING_VERSION,
    },
    customer_email: account?.email_normalized ?? null,
    ...(session.setCookie ? { set_cookie: session.setCookie } : {}),
  };
}

export class CreditRateLimitError extends Error {}

export async function readBrowserCreditBalance(
  request: Request,
  env: Env,
): Promise<{
  balance: CreditBalance;
  account_access: BrowserAccountAccess;
  account_id: string;
  set_cookie?: string;
}> {
  const session = await ensureBrowserSession(request, env);
  const [balance, account] = await Promise.all([
    readCreditBalance(session.accountId, env),
    env.DB.prepare(
      "SELECT email_normalized FROM accounts WHERE id = ? AND status = 'active'",
    ).bind(session.accountId).first<{ email_normalized: string | null }>(),
  ]);
  const email = account?.email_normalized ?? null;
  return {
    balance,
    account_access: {
      status: email ? "connected" : "guest",
      email_hint: email ? maskEmail(email) : null,
    },
    account_id: session.accountId,
    ...(session.setCookie ? { set_cookie: session.setCookie } : {}),
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "Linked checkout email";
  if (local.length === 1) return `${local}••@${domain}`;
  const hidden = "•".repeat(Math.min(6, Math.max(2, local.length - 2)));
  return `${local[0]}${hidden}${local.at(-1)}@${domain}`;
}

export async function readCreditBalance(accountId: string, env: Env): Promise<CreditBalance> {
  const [settledRow, reservedRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(
        CASE operation_type
          WHEN 'grant' THEN credits
          WHEN 'compensation' THEN credits
          WHEN 'reversal' THEN credits
          WHEN 'usage' THEN -credits
        END
       ), 0) AS settled
       FROM credit_operations
       WHERE account_id = ? AND status = 'completed'`,
    ).bind(accountId).first<{ settled: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(credits), 0) AS reserved
       FROM credit_reservations
       WHERE account_id = ? AND status IN ('reserved', 'reconciling')`,
    ).bind(accountId).first<{ reserved: number }>(),
  ]);
  const settled = Number(settledRow?.settled ?? 0);
  const reserved = Number(reservedRow?.reserved ?? 0);
  return {
    settled_credits: settled,
    reserved_credits: reserved,
    available_credits: Math.max(0, settled - reserved),
  };
}

export async function reserveJobCredits(input: {
  accountId: string;
  jobId: string;
  reservationId: string;
  credits?: number;
}, env: Env): Promise<{ admitted: boolean; balance: CreditBalance; replay: boolean }> {
  const credits = input.credits ?? COMPLETE_TASK_CREDITS;
  assertCredits(credits);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_reservations (
      id, account_id, job_id, credits, status, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, 'reserved', ?, ?
     WHERE (
       COALESCE((
         SELECT SUM(CASE operation_type
           WHEN 'grant' THEN credits
           WHEN 'compensation' THEN credits
           WHEN 'reversal' THEN credits
           WHEN 'usage' THEN -credits
         END)
         FROM credit_operations
         WHERE account_id = ? AND status = 'completed'
       ), 0)
       - COALESCE((
         SELECT SUM(credits)
         FROM credit_reservations
         WHERE account_id = ? AND status IN ('reserved', 'reconciling')
       ), 0)
     ) >= ?`,
  ).bind(
    input.reservationId,
    input.accountId,
    input.jobId,
    credits,
    now,
    now,
    input.accountId,
    input.accountId,
    credits,
  ).run();

  const existing = await env.DB.prepare(
    `SELECT id, credits, status FROM credit_reservations
     WHERE account_id = ? AND job_id = ?`,
  ).bind(input.accountId, input.jobId).first<{ id: string; credits: number; status: string }>();
  if (existing && (existing.id !== input.reservationId || existing.credits !== credits)) {
    throw new Error("Credit reservation replay does not match the original request.");
  }
  const balance = await readCreditBalance(input.accountId, env);
  return {
    admitted: Boolean(existing && existing.status !== "released"),
    balance,
    replay: (result.meta.changes ?? 0) === 0 && Boolean(existing),
  };
}

export async function consumeJobCredits(input: {
  accountId: string;
  jobId: string;
  reservationId: string;
}, env: Env): Promise<CreditBalance> {
  const reservation = await env.DB.prepare(
    `SELECT credits, status FROM credit_reservations
     WHERE id = ? AND account_id = ? AND job_id = ?`,
  ).bind(input.reservationId, input.accountId, input.jobId).first<{
    credits: number;
    status: string;
  }>();
  if (!reservation) throw new Error("Credit reservation does not exist.");
  if (reservation.status === "released") throw new Error("Released credits cannot be consumed.");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_operations (
        id, account_id, operation_type, external_idempotency_key, credits,
        status, external_operation_id, created_at, updated_at
       )
       SELECT ?, ?, 'usage', ?, credits, 'completed', ?, ?, ?
       FROM credit_reservations
       WHERE id = ? AND account_id = ? AND job_id = ? AND status = 'reserved'`,
    ).bind(
      crypto.randomUUID(),
      input.accountId,
      `job:${input.jobId}:consume`,
      input.jobId,
      now,
      now,
      input.reservationId,
      input.accountId,
      input.jobId,
    ),
    env.DB.prepare(
      `UPDATE credit_reservations
       SET status = 'consumed', updated_at = ?
       WHERE id = ? AND account_id = ? AND job_id = ? AND status = 'reserved'`,
    ).bind(now, input.reservationId, input.accountId, input.jobId),
  ]);
  const final = await env.DB.prepare(
    "SELECT status FROM credit_reservations WHERE id = ?",
  ).bind(input.reservationId).first<{ status: string }>();
  if (final?.status !== "consumed") throw new Error("Credit reservation could not be consumed.");
  return readCreditBalance(input.accountId, env);
}

export async function releaseJobCredits(input: {
  accountId: string;
  jobId: string;
  reservationId: string;
}, env: Env): Promise<CreditBalance> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE credit_reservations
     SET status = 'released', updated_at = ?
     WHERE id = ? AND account_id = ? AND job_id = ? AND status = 'reserved'`,
  ).bind(now, input.reservationId, input.accountId, input.jobId).run();
  const final = await env.DB.prepare(
    "SELECT status FROM credit_reservations WHERE id = ?",
  ).bind(input.reservationId).first<{ status: string }>();
  if (!final || !["released", "consumed"].includes(final.status)) {
    throw new Error("Credit reservation could not be released.");
  }
  return readCreditBalance(input.accountId, env);
}

export async function grantCompletedPaddlePurchase(input: {
  billingEventId: string;
  paddleEventId: string;
  transactionId: string;
  paddleCustomerId: string | null;
  paddleCustomerEmail?: string | null;
  checkoutIntentId: string | null;
  pack: CreditPack;
  priceId: string;
  currencyCode: string;
  amount: string;
}, env: Env): Promise<{ account_id: string; balance: CreditBalance; duplicate: boolean }> {
  const now = new Date().toISOString();
  const verifiedEmail = normalizeEmail(input.paddleCustomerEmail);
  const emailAccount = verifiedEmail
    ? await env.DB.prepare(
      "SELECT id FROM accounts WHERE email_normalized = ? AND status = 'active'",
    ).bind(verifiedEmail).first<{ id: string }>()
    : null;
  const accountId = input.checkoutIntentId
    ? await accountForCheckoutIntent(input.checkoutIntentId, input, emailAccount?.id ?? null, now, env)
    : await accountForPaddleCustomer(input.paddleCustomerId, emailAccount?.id ?? null, now, env);
  if (verifiedEmail) {
    const currentEmail = await env.DB.prepare(
      "SELECT email_normalized FROM accounts WHERE id = ?",
    ).bind(accountId).first<{ email_normalized: string | null }>();
    // A signup email already on this account is the customer identity. Do not
    // overwrite it, and do not merge into a different account that happens to
    // own the Paddle checkout email.
    if (!currentEmail?.email_normalized || currentEmail.email_normalized === verifiedEmail) {
      await attachVerifiedEmail(accountId, verifiedEmail, now, env);
    }
  }
  const operationKey = `paddle:transaction:${input.transactionId}`;
  const purchaseId = await stableUuid(`purchase:${input.transactionId}`);
  const operationId = await stableUuid(`credit-operation:${operationKey}`);

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO purchases (
        id, account_id, paddle_transaction_id, paddle_customer_id, pack_key,
        pricing_version, credit_grant, currency_code, amount, status,
        created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
    ).bind(
      purchaseId,
      accountId,
      input.transactionId,
      input.paddleCustomerId,
      input.pack.key,
      input.pack.pricingVersion,
      input.pack.creditGrant,
      input.currencyCode,
      input.amount,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_operations (
        id, account_id, operation_type, external_idempotency_key, credits,
        status, external_operation_id, created_at, updated_at
       ) VALUES (?, ?, 'grant', ?, ?, 'completed', ?, ?, ?)`,
    ).bind(
      operationId,
      accountId,
      operationKey,
      input.pack.creditGrant,
      input.transactionId,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE billing_events
       SET status = 'processed_credit_granted', processed_at = ?
       WHERE id = ? AND paddle_event_id = ?`,
    ).bind(now, input.billingEventId, input.paddleEventId),
  ]);

  const [purchase, operation] = await Promise.all([
    env.DB.prepare(
      `SELECT account_id, pack_key, credit_grant, status
       FROM purchases WHERE paddle_transaction_id = ?`,
    ).bind(input.transactionId).first<{
      account_id: string;
      pack_key: string;
      credit_grant: number;
      status: string;
    }>(),
    env.DB.prepare(
      `SELECT account_id, credits, status
       FROM credit_operations WHERE external_idempotency_key = ?`,
    ).bind(operationKey).first<{ account_id: string; credits: number; status: string }>(),
  ]);
  if (
    !purchase || !operation ||
    purchase.account_id !== accountId || operation.account_id !== accountId ||
    purchase.pack_key !== input.pack.key || purchase.credit_grant !== input.pack.creditGrant ||
    operation.credits !== input.pack.creditGrant ||
    purchase.status !== "completed" || operation.status !== "completed"
  ) {
    throw new Error("Paddle purchase ledger reconciliation failed.");
  }

  return {
    account_id: accountId,
    balance: await readCreditBalance(accountId, env),
    duplicate: (results[1]?.meta.changes ?? 0) === 0,
  };
}

async function attachVerifiedEmail(
  accountId: string,
  email: string,
  now: string,
  env: Env,
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Paddle customer email is invalid.");
  const existing = await env.DB.prepare(
    "SELECT id FROM accounts WHERE email_normalized = ?",
  ).bind(normalized).first<{ id: string }>();
  if (existing && existing.id !== accountId) {
    throw new Error("Paddle customer email is already linked to a different account.");
  }
  await env.DB.prepare(
    `UPDATE accounts SET email_normalized = ?, updated_at = ?
     WHERE id = ? AND (email_normalized IS NULL OR email_normalized = ?)`,
  ).bind(normalized, now, accountId, normalized).run();
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return z.email().safeParse(normalized).success ? normalized : null;
}

export function packForPriceId(priceId: string, env: Env): CreditPack | null {
  return CREDIT_PACKS.find((pack) => priceIdForPack(pack.key, env) === priceId) ?? null;
}

function priceIdForPack(packKey: CreditPack["key"], env: Env): string {
  const priceId = {
    starter: env.PADDLE_PRICE_ID_STARTER,
    builder: env.PADDLE_PRICE_ID_BUILDER,
    studio: env.PADDLE_PRICE_ID_STUDIO,
  }[packKey];
  if (!priceId || !/^pri_[a-z\d]{26}$/.test(priceId)) {
    throw new Error(`Paddle price for ${packKey} is not configured.`);
  }
  return priceId;
}

async function accountForCheckoutIntent(
  intentId: string,
  input: {
    transactionId: string;
    paddleCustomerId: string | null;
    pack: CreditPack;
    priceId: string;
  },
  emailAccountId: string | null,
  now: string,
  env: Env,
): Promise<string> {
  const intent = await env.DB.prepare(
    `SELECT account_id, pack_key, price_id, pricing_version, status,
      expires_at, paddle_transaction_id
     FROM checkout_intents WHERE id = ?`,
  ).bind(intentId).first<{
    account_id: string;
    pack_key: string;
    price_id: string;
    pricing_version: string;
    status: string;
    expires_at: string;
    paddle_transaction_id: string | null;
  }>();
  if (!intent) throw new Error("Paddle checkout intent is unknown.");
  if (
    intent.pack_key !== input.pack.key ||
    intent.price_id !== input.priceId ||
    intent.pricing_version !== PRICING_VERSION
  ) {
    throw new Error("Paddle checkout intent does not match the purchased pack.");
  }
  if (intent.status === "completed" && intent.paddle_transaction_id !== input.transactionId) {
    throw new Error("Paddle checkout intent was already used by a different transaction.");
  }
  // Expiry prevents stale browser intents from being offered again; it is not
  // a reason to discard an already-paid, catalog-verified transaction. Paddle
  // delivery can legitimately arrive after the browser session has ended.
  await env.DB.prepare(
    `UPDATE checkout_intents
     SET status = 'completed', paddle_transaction_id = ?, updated_at = ?
     WHERE id = ? AND status = 'open'`,
  ).bind(input.transactionId, now, intentId).run();
  return bindCheckoutAccountToPaddleCustomer(
    intent.account_id,
    input.paddleCustomerId,
    emailAccountId,
    now,
    env,
  );
}

async function bindCheckoutAccountToPaddleCustomer(
  checkoutAccountId: string,
  paddleCustomerId: string | null,
  emailAccountId: string | null,
  now: string,
  env: Env,
): Promise<string> {
  if (!paddleCustomerId || !/^ctm_[a-z\d]{26}$/.test(paddleCustomerId)) {
    throw new Error("Completed Paddle transaction has no recoverable customer identity.");
  }
  const identityId = await stableUuid(`paddle-customer-identity:${paddleCustomerId}`);
  const existingIdentity = await env.DB.prepare(
    `SELECT account_id FROM external_identities
     WHERE provider = 'paddle_customer' AND external_id = ?`,
  ).bind(paddleCustomerId).first<{ account_id: string }>();
  const checkoutAccount = await env.DB.prepare(
    "SELECT email_normalized FROM accounts WHERE id = ?",
  ).bind(checkoutAccountId).first<{ email_normalized: string | null }>();
  // If this browser already verified a signup email, keep the purchase on that
  // account even when the Paddle overlay uses a different address.
  const identityAccountId = existingIdentity?.account_id
    ?? (checkoutAccount?.email_normalized ? checkoutAccountId : (emailAccountId ?? checkoutAccountId));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO external_identities (
      id, account_id, provider, external_id, created_at
     ) VALUES (?, ?, 'paddle_customer', ?, ?)`,
  ).bind(identityId, identityAccountId, paddleCustomerId, now).run();
  const identity = await env.DB.prepare(
    `SELECT account_id FROM external_identities
     WHERE provider = 'paddle_customer' AND external_id = ?`,
  ).bind(paddleCustomerId).first<{ account_id: string }>();
  if (!identity) throw new Error("Paddle customer identity could not be resolved.");
  if (identity.account_id === checkoutAccountId) return checkoutAccountId;

  // A returning Paddle customer may check out from a fresh anonymous browser.
  // Only reattach a truly empty temporary account; never strand an existing
  // balance, purchase, or task on a different account implicitly.
  const activity = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM credit_operations WHERE account_id = ?) +
      (SELECT COUNT(*) FROM purchases WHERE account_id = ?) +
      (SELECT COUNT(*) FROM jobs WHERE account_id = ?) AS count`,
  ).bind(checkoutAccountId, checkoutAccountId, checkoutAccountId).first<{ count: number }>();
  if (Number(activity?.count ?? 0) !== 0) {
    throw new Error("Paddle customer is already linked to a different funded account.");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET account_id = ? WHERE account_id = ?")
      .bind(identity.account_id, checkoutAccountId),
    env.DB.prepare("UPDATE checkout_intents SET account_id = ?, updated_at = ? WHERE account_id = ?")
      .bind(identity.account_id, now, checkoutAccountId),
  ]);
  return identity.account_id;
}

async function accountForPaddleCustomer(
  paddleCustomerId: string | null,
  emailAccountId: string | null,
  now: string,
  env: Env,
): Promise<string> {
  if (!paddleCustomerId || !/^ctm_[a-z\d]{26}$/.test(paddleCustomerId)) {
    throw new Error("Completed Paddle transaction has no recoverable customer identity.");
  }
  const existingIdentity = await env.DB.prepare(
    `SELECT account_id FROM external_identities
     WHERE provider = 'paddle_customer' AND external_id = ?`,
  ).bind(paddleCustomerId).first<{ account_id: string }>();
  if (existingIdentity) return existingIdentity.account_id;
  const accountId = emailAccountId ?? await stableUuid(`paddle-customer-account:${paddleCustomerId}`);
  const identityId = await stableUuid(`paddle-customer-identity:${paddleCustomerId}`);
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO external_identities (
        id, account_id, provider, external_id, created_at
       ) VALUES (?, ?, 'paddle_customer', ?, ?)`,
    ).bind(identityId, accountId, paddleCustomerId, now),
  ];
  if (!emailAccountId) {
    statements.unshift(env.DB.prepare(
      `INSERT OR IGNORE INTO accounts (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?)`,
    ).bind(accountId, now, now));
  }
  await env.DB.batch(statements);
  const identity = await env.DB.prepare(
    `SELECT account_id FROM external_identities
     WHERE provider = 'paddle_customer' AND external_id = ?`,
  ).bind(paddleCustomerId).first<{ account_id: string }>();
  if (!identity) throw new Error("Paddle customer identity could not be resolved.");
  return identity.account_id;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableUuid(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function assertCredits(credits: number): void {
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    throw new Error("Credits must be a positive integer.");
  }
}
