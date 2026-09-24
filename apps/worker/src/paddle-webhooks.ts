import { z } from "zod";

import { grantCompletedPaddlePurchase, packForPriceId } from "./credits";
import { readPaddleCustomerEmail } from "./paddle-api";

const MAX_PADDLE_WEBHOOK_BYTES = 512_000;
const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 5;

const PaddleWebhookEnvelopeSchema = z.object({
  event_id: z.string().trim().min(5).max(100),
  event_type: z.string().trim().min(3).max(120),
  occurred_at: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

const CompletedTransactionSchema = z.object({
  id: z.string().regex(/^txn_[a-z\d]{26}$/),
  status: z.literal("completed"),
  customer_id: z.string().regex(/^ctm_[a-z\d]{26}$/).nullable(),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  custom_data: z.record(z.string(), z.unknown()).nullable(),
  items: z.array(z.object({
    quantity: z.int().positive(),
    price: z.object({
      id: z.string().regex(/^pri_[a-z\d]{26}$/),
      product_id: z.string().regex(/^pro_[a-z\d]{26}$/),
      custom_data: z.record(z.string(), z.unknown()).nullable(),
    }).passthrough(),
  }).passthrough()).min(1).max(100),
  details: z.object({
    totals: z.object({ total: z.string().regex(/^\d+$/) }).passthrough(),
    line_items: z.array(z.object({
      price_id: z.string().regex(/^pri_[a-z\d]{26}$/),
      quantity: z.int().positive(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();

export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("Paddle-Signature") ?? "";
  const rawBody = await readRawBody(request);
  if (!signature || !rawBody) {
    return json({ error: "Missing Paddle signature or body." }, 400);
  }
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return json({ error: "Paddle webhook destination is not configured." }, 503);
  }

  try {
    const verified = await verifyPaddleSignature({
      signatureHeader: signature,
      rawBody,
      secret: env.PADDLE_WEBHOOK_SECRET,
    });
    if (!verified) throw new Error("PADDLE_SIGNATURE_INVALID");
    const event = PaddleWebhookEnvelopeSchema.parse(JSON.parse(rawBody));
    const objectKey = `billing/paddle/events/${event.event_id}.json`;
    const receivedAt = new Date().toISOString();
    await env.EVIDENCE.put(objectKey, rawBody, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        paddle_event_id: event.event_id,
        event_type: event.event_type,
      },
    });
    const proposedBillingEventId = crypto.randomUUID();
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO billing_events (
        id, paddle_event_id, event_type, payload_object_key, status, received_at
       ) VALUES (?, ?, ?, ?, 'received_pending_credit_grant', ?)`,
    ).bind(proposedBillingEventId, event.event_id, event.event_type, objectKey, receivedAt).run();

    const receipt = await env.DB.prepare(
      "SELECT id, status FROM billing_events WHERE paddle_event_id = ?",
    ).bind(event.event_id).first<{ id: string; status: string }>();
    if (!receipt) throw new Error("PADDLE_RECEIPT_NOT_FOUND");

    const grant = await processRecordedPaddleEvent(event, receipt, env);
    const simulation = isPaddleSimulationEventId(event.event_id);

    return json({
      received: true,
      duplicate: (result.meta.changes ?? 0) === 0,
      event_id: event.event_id,
      event_type: event.event_type,
      ...(simulation ? { simulation: true } : {}),
      ...(grant ? { credit_grant: grant } : {}),
    }, 200);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "paddle_webhook_rejected",
      error: error instanceof Error ? error.message : String(error),
    }));
    // Paddle retries every non-2xx. A single failure response also covers a
    // bad signature, a rotated secret, malformed JSON, and a transient write.
    return json({ error: "Paddle webhook could not be verified or recorded." }, 500);
  }
}

export async function reconcilePaddleBillingEvent(
  paddleEventId: string,
  env: Env,
): Promise<{ event_id: string; status: string; credit_grant: unknown }> {
  const receipt = await env.DB.prepare(
    `SELECT id, status, payload_object_key
     FROM billing_events WHERE paddle_event_id = ?`,
  ).bind(paddleEventId).first<{ id: string; status: string; payload_object_key: string | null }>();
  if (!receipt?.payload_object_key) throw new Error("PADDLE_RECEIPT_NOT_FOUND");
  const object = await env.EVIDENCE.get(receipt.payload_object_key);
  if (!object) throw new Error("PADDLE_RECEIPT_PAYLOAD_NOT_FOUND");
  const rawBody = await object.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_PADDLE_WEBHOOK_BYTES) {
    throw new Error("PADDLE_WEBHOOK_TOO_LARGE");
  }
  const event = PaddleWebhookEnvelopeSchema.parse(JSON.parse(rawBody));
  if (event.event_id !== paddleEventId) throw new Error("PADDLE_RECEIPT_ID_MISMATCH");
  const grant = await processRecordedPaddleEvent(event, receipt, env);
  const updated = await env.DB.prepare(
    "SELECT status FROM billing_events WHERE id = ?",
  ).bind(receipt.id).first<{ status: string }>();
  return { event_id: event.event_id, status: updated?.status ?? receipt.status, credit_grant: grant };
}

async function processRecordedPaddleEvent(
  event: z.infer<typeof PaddleWebhookEnvelopeSchema>,
  receipt: { id: string; status: string },
  env: Env,
): Promise<{ credits: number; balance: number; duplicate: boolean } | null> {
  if (isPaddleSimulationEventId(event.event_id)) {
    if (receipt.status === "received_pending_credit_grant") {
      await env.DB.prepare(
        "UPDATE billing_events SET status = 'simulation_verified', processed_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), receipt.id).run();
    }
    return null;
  }

  if (event.event_type !== "transaction.completed") {
    if (receipt.status === "received_pending_credit_grant") {
      await env.DB.prepare(
        `UPDATE billing_events SET status = 'ignored', processed_at = ? WHERE id = ?`,
      ).bind(new Date().toISOString(), receipt.id).run();
    }
    return null;
  }

  const transaction = CompletedTransactionSchema.parse(event.data);
  const lineItems = transaction.details.line_items;
  if (transaction.items.length !== 1 || lineItems.length !== 1) {
    throw new Error("PADDLE_TRANSACTION_MUST_CONTAIN_ONE_PACK");
  }
  const item = transaction.items[0]!;
  const lineItem = lineItems[0]!;
  if (item.quantity !== 1 || lineItem.quantity !== 1 || lineItem.price_id !== item.price.id) {
    throw new Error("PADDLE_TRANSACTION_QUANTITY_INVALID");
  }
  const pack = packForPriceId(item.price.id, env);
  if (!pack) throw new Error("PADDLE_PRICE_NOT_APPROVED");
  if (
    transaction.custom_data?.mclab_catalog_key !== pack.key ||
    transaction.custom_data?.pricing_version !== pack.pricingVersion ||
    item.price.custom_data?.credit_grant !== pack.creditGrant ||
    item.price.custom_data?.pricing_version !== pack.pricingVersion
  ) {
    throw new Error("PADDLE_CATALOG_METADATA_MISMATCH");
  }
  const checkoutIntent = transaction.custom_data?.mclab_checkout_intent_id;
  if (checkoutIntent !== undefined && (
    typeof checkoutIntent !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(checkoutIntent)
  )) {
    throw new Error("PADDLE_CHECKOUT_INTENT_INVALID");
  }
  const granted = await grantCompletedPaddlePurchase({
    billingEventId: receipt.id,
    paddleEventId: event.event_id,
    transactionId: transaction.id,
    paddleCustomerId: transaction.customer_id,
    paddleCustomerEmail: transaction.customer_id
      ? await readPaddleCustomerEmail(transaction.customer_id, env)
      : null,
    checkoutIntentId: typeof checkoutIntent === "string" ? checkoutIntent : null,
    pack,
    priceId: item.price.id,
    currencyCode: transaction.currency_code,
    amount: transaction.details.totals.total,
  }, env);
  return {
    credits: pack.creditGrant,
    balance: granted.balance.available_credits,
    duplicate: granted.duplicate,
  };
}

export function isPaddleSimulationEventId(eventId: string): boolean {
  return /^ntfsimevt_[a-z\d]{26}$/.test(eventId);
}

export async function verifyPaddleSignature(input: {
  signatureHeader: string;
  rawBody: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const parts = input.signatureHeader.split(";").map((part) => part.trim());
  const timestampValue = parts.find((part) => part.startsWith("ts="))?.slice(3);
  const signatures = parts.filter((part) => part.startsWith("h1=")).map((part) => part.slice(3));
  if (!timestampValue || signatures.length === 0 || !/^\d+$/.test(timestampValue)) return false;
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedPayload = encoder.encode(`${timestampValue}:${input.rawBody}`);
  for (const signature of signatures) {
    const bytes = hexToBytes(signature);
    if (bytes && await crypto.subtle.verify("HMAC", key, bytes, signedPayload)) return true;
  }
  return false;
}

async function readRawBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PADDLE_WEBHOOK_BYTES) {
    throw new Error("PADDLE_WEBHOOK_TOO_LARGE");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_PADDLE_WEBHOOK_BYTES) {
    throw new Error("PADDLE_WEBHOOK_TOO_LARGE");
  }
  return body;
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
