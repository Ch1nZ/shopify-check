import { z } from "zod";

import { createAccountSession, ensureBrowserSession, sha256Hex } from "./credits";
import { freeCheckEnabled, grantPromotionalFreeCheck } from "./free-check";

const RECOVERY_TTL_MINUTES = 15;
const EmailSchema = z.email().max(254);

export function recoveryAvailable(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.RECOVERY_EMAIL_FROM);
}

export async function requestAccountRecovery(
  request: Request,
  emailValue: unknown,
  env: Env,
): Promise<void> {
  const parsed = EmailSchema.safeParse(
    typeof emailValue === "string" ? emailValue.trim().toLowerCase() : emailValue,
  );
  if (!parsed.success || !recoveryAvailable(env)) return;

  const emailHash = await sha256Hex(parsed.data);
  const rateLimit = await env.CHECKOUT_RATE_LIMITER.limit({ key: `recover:${emailHash}` });
  if (!rateLimit.success) return;

  const account = await env.DB.prepare(
    `SELECT id FROM accounts WHERE email_normalized = ? AND status = 'active'`,
  ).bind(parsed.data).first<{ id: string }>();
  if (!account) return;

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RECOVERY_TTL_MINUTES * 60_000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_recovery_tokens SET used_at = ?
       WHERE account_id = ? AND used_at IS NULL`,
    ).bind(now.toISOString(), account.id),
    env.DB.prepare(
      `INSERT INTO account_recovery_tokens
       (id, account_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      account.id,
      tokenHash,
      expiresAt.toISOString(),
      now.toISOString(),
    ),
  ]);

  const recoveryUrl = new URL("/api/v1/account/recover", request.url);
  recoveryUrl.searchParams.set("token", token);
  try {
    await sendAccessEmail({
      to: parsed.data,
      subject: "Your MC Lab access link",
      text: `Open this secure link within ${RECOVERY_TTL_MINUTES} minutes to access your credits and report history:\n\n${recoveryUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Open the secure link below within ${RECOVERY_TTL_MINUTES} minutes to access your MC Lab credits and report history.</p><p><a href="${escapeHtml(recoveryUrl.toString())}">Access my MC Lab account</a></p><p>If you did not request this, you can ignore this email.</p>`,
      env,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "account_recovery_email_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function requestAccountSignup(
  request: Request,
  emailValue: unknown,
  env: Env,
): Promise<{ setCookie?: string }> {
  if (!freeCheckEnabled(env)) return {};
  const parsed = EmailSchema.safeParse(
    typeof emailValue === "string" ? emailValue.trim().toLowerCase() : emailValue,
  );
  if (!parsed.success || !recoveryAvailable(env)) return {};

  const session = await ensureBrowserSession(request, env);
  const emailHash = await sha256Hex(parsed.data);
  const [emailLimit, accountLimit] = await Promise.all([
    env.CHECKOUT_RATE_LIMITER.limit({ key: `signup:${emailHash}` }),
    env.CHECKOUT_RATE_LIMITER.limit({ key: `signup-account:${session.accountId}` }),
  ]);
  if (!emailLimit.success || !accountLimit.success) {
    return session.setCookie ? { setCookie: session.setCookie } : {};
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RECOVERY_TTL_MINUTES * 60_000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_signup_tokens SET used_at = ?
       WHERE account_id = ? AND email_normalized = ? AND used_at IS NULL`,
    ).bind(now.toISOString(), session.accountId, parsed.data),
    env.DB.prepare(
      `INSERT INTO account_signup_tokens
       (id, account_id, email_normalized, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      session.accountId,
      parsed.data,
      tokenHash,
      expiresAt.toISOString(),
      now.toISOString(),
    ),
  ]);

  const verifyUrl = new URL("/api/v1/account/verify", request.url);
  verifyUrl.searchParams.set("token", token);
  try {
    await sendAccessEmail({
      to: parsed.data,
      subject: "Verify your MC Lab email",
      text: `Open this secure link within ${RECOVERY_TTL_MINUTES} minutes to verify your email and start 1 free Self-Check:\n\n${verifyUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Open the secure link below within ${RECOVERY_TTL_MINUTES} minutes to verify your email and start 1 free Self-Check.</p><p><a href="${escapeHtml(verifyUrl.toString())}">Verify my email</a></p><p>If you did not request this, you can ignore this email.</p>`,
      env,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "account_signup_email_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return session.setCookie ? { setCookie: session.setCookie } : {};
}

export async function consumeAccountRecovery(
  token: string | null,
  env: Env,
): Promise<{ setCookie: string } | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT account_id FROM account_recovery_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(tokenHash, now).first<{ account_id: string }>();
  if (!row) return null;

  const consumed = await env.DB.prepare(
    `UPDATE account_recovery_tokens SET used_at = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(now, tokenHash, now).run();
  if ((consumed.meta.changes ?? 0) !== 1) return null;

  const session = await createAccountSession(row.account_id, env);
  return session.setCookie ? { setCookie: session.setCookie } : null;
}

export async function consumeAccountSignup(
  token: string | null,
  env: Env,
): Promise<{ setCookie: string } | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT account_id, email_normalized FROM account_signup_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(tokenHash, now).first<{ account_id: string; email_normalized: string }>();
  if (!row) return null;

  const consumed = await env.DB.prepare(
    `UPDATE account_signup_tokens SET used_at = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(now, tokenHash, now).run();
  if ((consumed.meta.changes ?? 0) !== 1) return null;

  const accountId = await bindSignupEmail(row.account_id, row.email_normalized, now, env);
  await grantPromotionalFreeCheck(accountId, row.email_normalized, env);
  const session = await createAccountSession(accountId, env);
  return session.setCookie ? { setCookie: session.setCookie } : null;
}

export async function readAccountHistory(request: Request, env: Env): Promise<{
  reports: Array<{
    task_id: string;
    status: string;
    billing_status: string | null;
    created_at: string;
    completed_at: string | null;
  }>;
  setCookie?: string;
}> {
  const session = await ensureBrowserSession(request, env);
  const rows = await env.DB.prepare(
    `SELECT jobs.id AS task_id, jobs.status, shopping_sessions.billing_status,
      jobs.created_at, jobs.completed_at
     FROM jobs
     LEFT JOIN shopping_sessions ON shopping_sessions.job_id = jobs.id
     WHERE jobs.account_id = ? AND jobs.job_kind = 'guided_search_premium'
     ORDER BY jobs.created_at DESC LIMIT 50`,
  ).bind(session.accountId).all<{
    task_id: string;
    status: string;
    billing_status: string | null;
    created_at: string;
    completed_at: string | null;
  }>();
  return {
    reports: rows.results,
    ...(session.setCookie ? { setCookie: session.setCookie } : {}),
  };
}

async function bindSignupEmail(
  tokenAccountId: string,
  email: string,
  now: string,
  env: Env,
): Promise<string> {
  const owner = await env.DB.prepare(
    `SELECT id FROM accounts WHERE email_normalized = ? AND status = 'active'`,
  ).bind(email).first<{ id: string }>();
  if (owner) return owner.id;

  const tokenAccount = await env.DB.prepare(
    `SELECT id, email_normalized, status FROM accounts WHERE id = ?`,
  ).bind(tokenAccountId).first<{ id: string; email_normalized: string | null; status: string }>();
  if (tokenAccount?.status === "active" && !tokenAccount.email_normalized) {
    try {
      await env.DB.prepare(
        `UPDATE accounts SET email_normalized = ?, updated_at = ?
         WHERE id = ? AND email_normalized IS NULL`,
      ).bind(email, now, tokenAccountId).run();
    } catch {
      const raced = await env.DB.prepare(
        `SELECT id FROM accounts WHERE email_normalized = ? AND status = 'active'`,
      ).bind(email).first<{ id: string }>();
      if (raced) return raced.id;
      throw new Error("Signup email could not be linked.");
    }
    const bound = await env.DB.prepare(
      `SELECT id FROM accounts WHERE email_normalized = ? AND status = 'active'`,
    ).bind(email).first<{ id: string }>();
    if (bound) return bound.id;
  }

  const accountId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO accounts (id, email_normalized, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    ).bind(accountId, email, now, now).run();
    return accountId;
  } catch {
    const raced = await env.DB.prepare(
      `SELECT id FROM accounts WHERE email_normalized = ? AND status = 'active'`,
    ).bind(email).first<{ id: string }>();
    if (raced) return raced.id;
    throw new Error("Signup account could not be created.");
  }
}

async function sendAccessEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
  env: Env;
}): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: input.env.RECOVERY_EMAIL_FROM,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Access email provider returned HTTP ${response.status}.`);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
