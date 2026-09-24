import { z } from "zod";

import { sha256Hex } from "./credits";

const EventSchema = z.object({
  event_id: z.uuid(),
  journey_id: z.uuid(),
  site: z.enum(["main", "self_check"]),
  event_name: z.enum([
    "main_site_view",
    "self_check_cta",
    "self_check_view",
    "preview_started",
    "preview_completed",
    "preview_recheck_completed",
    "preview_share_copied",
    "checkout_started",
    "checkout_completed",
    "diagnostic_started",
    "diagnostic_completed",
    "human_service_cta",
  ]),
  path_group: z.enum(["home", "service", "case", "research", "self_check", "pricing", "report"]),
  occurred_at: z.iso.datetime(),
});

export async function recordConversionEvent(request: Request, payload: unknown, env: Env): Promise<boolean> {
  const origin = request.headers.get("origin");
  if (!allowedOrigin(origin, request.url, env)) return false;
  const body = EventSchema.safeParse(payload);
  if (!body.success) return false;
  if (body.data.site === "main" && origin !== "https://geo.mclab.party") return false;
  if (body.data.site === "self_check" && origin !== new URL(request.url).origin) return false;

  const now = new Date();
  const occurred = new Date(body.data.occurred_at);
  if (Math.abs(now.getTime() - occurred.getTime()) > 24 * 60 * 60 * 1_000) return false;
  const journeyHash = await sha256Hex(body.data.journey_id);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO conversion_events
     (id, journey_hash, site, event_name, path_group, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    body.data.event_id,
    journeyHash,
    body.data.site,
    body.data.event_name,
    body.data.path_group,
    body.data.occurred_at,
    now.toISOString(),
  ).run();
  return true;
}

export function analyticsCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin");
  return allowedOrigin(origin, request.url, env)
    ? { "Access-Control-Allow-Origin": origin!, "Vary": "Origin" }
    : {};
}

function allowedOrigin(origin: string | null, requestUrl: string, env: Env): boolean {
  if (!origin) return false;
  if (origin === new URL(requestUrl).origin) return true;
  return (env.ENVIRONMENT as string) === "production" && origin === "https://geo.mclab.party";
}
