import { processDiagnostic, failDiagnostic, type DiagnosticMessage } from "./diagnostic-workflow";
import {
  AiJobMessageSchema,
  JobMessageSchema,
  ShoppingQueueMessageSchema,
  type AiJobMessage,
  type JobMessage,
  type ShoppingQueueMessage,
} from "@mclab/contracts";

import { processAiJobMessage } from "./ai-runs";
import { failControlledShoppingSession, processShoppingQueueMessage } from "./shopping-orchestrator";
import { consumeJobCredits } from "./credits";

export type QueueMessage = JobMessage | AiJobMessage | ShoppingQueueMessage | DiagnosticMessage;

export async function processQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  if ("kind" in message && message.kind === "diagnostic_advance") { await processDiagnostic(message, env); return; }
  const shoppingMessage = ShoppingQueueMessageSchema.safeParse(message);
  if (shoppingMessage.success) {
    await processShoppingQueueMessage(shoppingMessage.data, env);
    return;
  }
  if (AiJobMessageSchema.safeParse(message).success) {
    await processAiJobMessage(message as AiJobMessage, env);
    return;
  }
  await processJobMessage(message as JobMessage, env);
}

export async function failQueueMessage(message: QueueMessage, reason: string, env: Env): Promise<void> {
  if ("kind" in message && message.kind === "diagnostic_advance") { await failDiagnostic(message.job_id, reason, env); return; }
  const shoppingMessage = ShoppingQueueMessageSchema.safeParse(message);
  if (shoppingMessage.success) {
    await failControlledShoppingSession(shoppingMessage.data.session_id, reason, env);
  }
}

export async function processJobMessage(message: JobMessage, env: Env): Promise<void> {
  const job = JobMessageSchema.parse(message);

  // D1 is the authoritative ledger. The unique job idempotency key makes
  // duplicate Queue delivery safe and charges only a successfully completed job.
  await consumeJobCredits({
    accountId: job.account_id,
    jobId: job.job_id,
    reservationId: job.reservation_id,
  }, env);
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs
     SET status = 'completed', completed_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('credit_reserved', 'queued')`,
  )
    .bind(timestamp, timestamp, job.job_id)
    .run();
}
