import { withModelRuntime } from "@mclab/openrouter-adapter";
import { recoverDiagnostics } from "./diagnostic-workflow";
import { CreditAdmission } from "./durable-objects/credit-admission";
import { failure, HttpError, routeRequest } from "./http";
import { failQueueMessage, processQueueMessage, type QueueMessage } from "./jobs";
import { applyMediaByteRange } from "./media-byte-range";
import { recoverStalledShoppingRoleCalls } from "./shopping-orchestrator";

export { CreditAdmission };

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();

    try {
      const redirect = productionHttpsRedirect(request, env.ENVIRONMENT);
      if (redirect) return redirect;
      const routed = await routeRequest(request, env);
      const response = await applyMediaByteRange(request, routed);
      const headers = new Headers(response.headers);
      headers.set("X-Request-Id", requestId);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "DENY");
      if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
      headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

      console.log(
        JSON.stringify({
          level: "info",
          message: "request_completed",
          request_id: requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          duration_ms: Date.now() - startedAt,
        }),
      );

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof HttpError ? error.message : "Unexpected server error.";

      console.error(
        JSON.stringify({
          level: "error",
          message: "request_failed",
          request_id: requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          status,
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      return failure(code, message, status, undefined, requestId);
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueueMessage(message.body, env);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "job_message_failed",
            queue_message_id: message.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (message.attempts >= 3) {
          await failQueueMessage(message.body, "Queue retries exhausted.", env);
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await recoverStalledShoppingRoleCalls(env);
    await recoverDiagnostics(env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;

export function productionHttpsRedirect(
  request: Request,
  environment: string,
): Response | null {
  const requestUrl = new URL(request.url);
  if (environment !== "production" || requestUrl.protocol !== "http:") return null;
  requestUrl.protocol = "https:";
  return Response.redirect(requestUrl.toString(), 308);
}

export default {
 fetch: (request: Request, env: Env) => withModelRuntime(env, () => handler.fetch(request, env)),
 queue: (batch: MessageBatch<QueueMessage>, env: Env) => withModelRuntime(env, () => handler.queue(batch, env)),
 scheduled: (controller: ScheduledController, env: Env) => withModelRuntime(env, () => handler.scheduled(controller, env)),
} satisfies ExportedHandler<Env, QueueMessage>;
