const suppliedJourney = new URLSearchParams(window.location.search).get("journey");

export const journeyId = suppliedJourney && /^[0-9a-f-]{36}$/i.test(suppliedJourney)
  ? suppliedJourney
  : crypto.randomUUID();

export function trackConversion(
  eventName:
    | "self_check_view"
    | "preview_started"
    | "preview_completed"
    | "preview_recheck_completed"
    | "preview_share_copied"
    | "checkout_started"
    | "checkout_completed"
    | "diagnostic_started"
    | "diagnostic_completed"
    | "human_service_cta",
  pathGroup: "self_check" | "pricing" | "report" = "self_check",
): void {
  const privacyNavigator = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (navigator.doNotTrack === "1" || privacyNavigator.globalPrivacyControl === true) return;
  void fetch("/api/v1/analytics/events", {
    method: "POST",
    credentials: "omit",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: crypto.randomUUID(),
      journey_id: journeyId,
      site: "self_check",
      event_name: eventName,
      path_group: pathGroup,
      occurred_at: new Date().toISOString(),
    }),
  }).catch(() => undefined);
}
