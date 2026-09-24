import { z } from "zod";

import { COMPLETE_TASK_CREDITS, sha256Hex } from "./credits";

export const FREE_CHECK_CREDITS = COMPLETE_TASK_CREDITS;
export const FREE_CHECK_KIND = "free_check_v1";
const DEFAULT_DAILY_CAP = 50;
const EmailSchema = z.email().max(254);

export type FreeCheckGrantResult = {
  granted: boolean;
  reason: "granted" | "already_granted" | "flag_off" | "daily_cap";
};

export type FreeCheckOffer = {
  enabled: boolean;
  signup_available: boolean;
  granted: boolean;
  remaining: 0 | 1;
};

export function freeCheckEnabled(env: Env): boolean {
  return (env.FREE_CHECK_ENABLED as string) === "true";
}

export function freeCheckDailyCap(env: Env): number {
  const parsed = Number.parseInt(String(env.FREE_CHECK_DAILY_CAP ?? "50"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CAP;
}

export function freeCheckIdempotencyKey(email: string): string {
  return `trial:v1:${email}`;
}

export function normalizeAccountEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return EmailSchema.safeParse(normalized).success ? normalized : null;
}

export async function grantPromotionalFreeCheck(
  accountId: string,
  email: string,
  env: Env,
): Promise<FreeCheckGrantResult> {
  const normalized = normalizeAccountEmail(email);
  if (!normalized) throw new Error("Free-check email is invalid.");
  if (!freeCheckEnabled(env)) return { granted: false, reason: "flag_off" };

  const operationKey = freeCheckIdempotencyKey(normalized);
  const existing = await env.DB.prepare(
    `SELECT credit_operations.account_id
     FROM credit_operations
     WHERE credit_operations.external_idempotency_key = ?`,
  ).bind(operationKey).first<{ account_id: string }>();
  if (existing) return { granted: false, reason: "already_granted" };

  const existingGrant = await env.DB.prepare(
    "SELECT account_id FROM free_check_grants WHERE email_normalized = ?",
  ).bind(normalized).first<{ account_id: string }>();
  if (existingGrant) return { granted: false, reason: "already_granted" };

  const cap = freeCheckDailyCap(env);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const grantedToday = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM free_check_grants WHERE created_at >= ?",
  ).bind(dayStart.toISOString()).first<{ count: number }>();
  if (Number(grantedToday?.count ?? 0) >= cap) {
    return { granted: false, reason: "daily_cap" };
  }

  const now = new Date().toISOString();
  const operationId = await stableUuid(`credit-operation:${operationKey}`);
  const grantId = await stableUuid(`free-check-grant:${operationKey}`);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_operations (
        id, account_id, operation_type, external_idempotency_key, credits,
        status, external_operation_id, created_at, updated_at
       ) VALUES (?, ?, 'grant', ?, ?, 'completed', ?, ?, ?)`,
    ).bind(
      operationId,
      accountId,
      operationKey,
      FREE_CHECK_CREDITS,
      FREE_CHECK_KIND,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO free_check_grants (
        id, account_id, email_normalized, credit_operation_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(grantId, accountId, normalized, operationId, now),
  ]);

  const operation = await env.DB.prepare(
    `SELECT account_id, credits, status, external_operation_id
     FROM credit_operations WHERE external_idempotency_key = ?`,
  ).bind(operationKey).first<{
    account_id: string;
    credits: number;
    status: string;
    external_operation_id: string | null;
  }>();
  if (!operation || operation.credits !== FREE_CHECK_CREDITS || operation.status !== "completed") {
    throw new Error("Free-check ledger reconciliation failed.");
  }
  if (operation.account_id !== accountId || (results[0]?.meta.changes ?? 0) === 0) {
    return { granted: false, reason: "already_granted" };
  }
  if (operation.external_operation_id !== FREE_CHECK_KIND) {
    throw new Error("Free-check ledger reconciliation failed.");
  }
  return { granted: true, reason: "granted" };
}

export async function readFreeCheckOffer(accountId: string, env: Env): Promise<FreeCheckOffer> {
  const enabled = freeCheckEnabled(env);
  const signupAvailable = enabled && Boolean(env.RESEND_API_KEY && env.RECOVERY_EMAIL_FROM);
  const grant = await env.DB.prepare(
    "SELECT id FROM free_check_grants WHERE account_id = ?",
  ).bind(accountId).first<{ id: string }>();
  if (!grant) {
    return { enabled, signup_available: signupAvailable, granted: false, remaining: 0 };
  }
  const consumed = await env.DB.prepare(
    `SELECT 1 AS used
     FROM free_check_admissions
     JOIN credit_reservations ON credit_reservations.id = free_check_admissions.reservation_id
     WHERE free_check_admissions.account_id = ?
       AND credit_reservations.status = 'consumed'
     LIMIT 1`,
  ).bind(accountId).first();
  return {
    enabled,
    signup_available: signupAvailable,
    granted: true,
    remaining: consumed ? 0 : 1,
  };
}

export async function recordFreeCheckAdmission(input: {
  accountId: string;
  jobId: string;
  reservationId: string;
}, env: Env): Promise<void> {
  const offer = await readFreeCheckOffer(input.accountId, env);
  if (!offer.granted || offer.remaining !== 1) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO free_check_admissions (
      reservation_id, account_id, job_id, created_at
     ) VALUES (?, ?, ?, ?)`,
  ).bind(input.reservationId, input.accountId, input.jobId, new Date().toISOString()).run();
}

async function stableUuid(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
