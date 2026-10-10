export const PUBLIC_OFFER_SCRIPT_ID = "mclab-public-offer";

export type PublicOfferState = {
  free_check_enabled: boolean;
};

export function serializePublicOffer(enabled: boolean): string {
  return JSON.stringify({ free_check_enabled: enabled });
}

export function parsePublicOffer(raw: string | null | undefined): PublicOfferState {
  try {
    const parsed = JSON.parse(raw ?? "") as { free_check_enabled?: unknown };
    return { free_check_enabled: parsed.free_check_enabled === true };
  } catch {
    return { free_check_enabled: false };
  }
}

export const ACQUISITION_DOCUMENT_TITLE = "Free Shopify Product Check | MC Lab Self-Check";
export const ACQUISITION_OG_TITLE = "Can AI read and recommend your product? | MC Lab Self-Check";
export const ACQUISITION_EYEBROW = "Free Shopify product check";
export const ACQUISITION_HERO_LEAD = "Check your product.";
export const ACQUISITION_HERO_ACCENT = "Know what to fix.";
export const PREVIEW_FORM_WINDOW_TITLE = "Product Data Preview";

export function acquisitionMetaDescription(_enabled: boolean): string {
  return "Free Shopify product check with practical fixes and rechecks. Then test whether AI recommends your product in an optional recorded shopping conversation.";
}

export function acquisitionLede(_enabled: boolean): string {
  return "Find missing or conflicting Shopify product details. Get suggested fixes and recheck for free.";
}

export function previewBoundaryCopy(_enabled: boolean): string {
  return "No email or payment required. Checks public product data and crawler rules; it does not test AI recommendations.";
}

export function previewStartNavLabel(): string {
  return "Check product data";
}

export function previewResultHeadline(status: "complete" | "partial"): string {
  return status === "partial" ? "Product page partially readable" : "Product page readable";
}

export function previewResultBadge(status: "complete" | "partial"): string {
  return status === "partial" ? "Partial" : "Readable";
}

export function previewCtaLabel(pending: boolean): string {
  return pending ? "Reading product…" : "Check product data";
}

export const FREE_PREVIEW_SCAN_STAGES = [
  "Fetching page",
  "Reading product fields",
  "Checking sources",
] as const;

export const FREE_PREVIEW_FIELD_ORDER = [
  "title",
  "category",
  "price",
  "currency",
  "availability",
] as const;

export const FREE_PREVIEW_URL_EXAMPLES = [
  "https://yourstore.com/products/your-product",
  "https://your-store.myshopify.com/products/your-product",
] as const;

export function previewHonestyLine(): string {
  return "This preview checked page readability. It is not the recorded diagnostic.";
}

export function previewSignalsSummary(ready: number, total: number): string {
  if (total <= 0) return "No product-data checks ran.";
  return `${ready}/${total} checks looking good`;
}

export function previewScoreDisclaimer(): string {
  return "Observed product data only. Not a ranking, traffic, or GEO score.";
}

export function previewPresenceHeading(): string {
  return "Captured on this product URL";
}

export function previewFixesHeading(): string {
  return "Recommended next steps";
}

export function previewFixesEmptyState(): string {
  return "No confirmed fixes to recommend from this capture. Review any unverified information below and recheck after changes.";
}

export function previewFixesOptionalNextStep(): string {
  return "After these page fixes, recheck this URL. A recorded Self-Check is optional when you want shopping evidence.";
}

export function previewRecheckHeading(): string {
  return "Since last preview in this browser";
}

export function previewRecheckEmptyState(): string {
  return "No change since the last preview of this URL in this browser.";
}

export function previewRecheckDefinitionChanged(): string {
  return "Some check definitions changed. Those rules are skipped here so a rule update is not treated as a page change.";
}

export function previewRecheckFirstRunHint(): string {
  return "Recheck this URL after you change the page to see what improved.";
}

export function previewRecheckImprovedLabel(label: string): string {
  return `${label} now looks good`;
}

export function previewRecheckRegressedLabel(label: string, to: "pass" | "warn" | "fail"): string {
  return `${label} slipped to ${to}`;
}

export function previewRecheckStillOpenLabel(label: string, outcome: "warn" | "fail"): string {
  return `${label} still ${outcome === "fail" ? "needs a fix" : "needs a look"}`;
}

export function previewRecheckButtonLabel(pending: boolean): string {
  return pending ? "Rechecking…" : "Recheck this page";
}

export function previewShareLinkLabel(): string {
  return "Copy share link";
}

export function previewPrintLabel(): string {
  return "Print / save as PDF";
}

export const FREE_PREVIEW_SHARE_PARAM = "product";

export function previewShareQuery(productUrl: string): string {
  return new URLSearchParams({ [FREE_PREVIEW_SHARE_PARAM]: productUrl }).toString();
}

export function previewSharePath(productUrl: string): string {
  return `/?${previewShareQuery(productUrl)}#start`;
}

export function previewSuccessCtaLabel(pending: boolean): string {
  return pending ? "Sending…" : "Email verification link";
}

export function previewHandoffSignupDescription(): string {
  return "Verify your email to claim 1 complimentary AI shopping test. No card required.";
}

export function diagnosticWaitExpectation(): string {
  return "This is a high-capacity Self-Check: a full shopping simulation and deep analysis. A thorough run usually takes several minutes.";
}

export type PreviewSuccessNextStep = {
  kind: "verify_email" | "run_free_check" | "run_paid_test";
  label: string;
  href: string;
  secondary?: { label: string; href: string };
};

export function previewSuccessNextStep(input: {
  freeCheckEnabled: boolean;
  needsEmailVerification: boolean;
  freeCheckRemaining: boolean;
}): PreviewSuccessNextStep {
  if (input.freeCheckEnabled && input.needsEmailVerification) {
    return {
      kind: "verify_email",
      label: "Email verification link",
      href: "#free-check-signup",
      secondary: { label: "Buy a credit pack instead", href: "#pricing" },
    };
  }
  if (input.freeCheckRemaining) {
    return {
      kind: "run_free_check",
      label: "Continue to your complimentary AI test",
      href: "#run-self-check",
    };
  }
  return {
    kind: "run_paid_test",
    label: "Continue below to run the recorded AI shopping test",
    href: "#run-self-check",
  };
}

export function previewFailureMessage(error?: { code?: string; message?: string } | null): string {
  if (error?.code === "UNSUPPORTED_PRODUCT_PATH") {
    return "Use a Shopify product URL that ends in /products/{handle}.";
  }
  if (error?.code === "PRODUCT_REDIRECTED_AWAY") {
    return "This link redirects away from a product page. Paste the current /products/{handle} URL.";
  }
  if (error?.code === "PRODUCT_PAGE_UNAVAILABLE" && error.message?.includes("404")) {
    return "That product page is not live (HTTP 404). Confirm the handle, or paste the current product URL.";
  }
  if (error?.code === "RATE_LIMITED") {
    return "Too many preview attempts. Wait a moment and try again.";
  }
  if (
    error?.code === "INVALID_REQUEST" ||
    error?.code === "INVALID_URL" ||
    error?.code === "HTTPS_REQUIRED"
  ) {
    return "Enter a valid HTTPS Shopify product URL ending in /products/{handle}.";
  }
  return "This page did not return a readable product. Confirm it is a live Shopify product page.";
}
