import type { EvidenceState } from "@mclab/contracts";

import type { PublicPreviewFinding, PublicPreviewPresence, PublicProductPreview } from "./public-preview";
import { PREVIEW_RULE_CATALOG_VERSION, formatFindingEvidence, presenceSeverity } from "./preview-rules";
import type { RobotsAgentResult } from "./types";

const FIELD_ORDER = ["title", "category", "price", "currency", "availability"] as const;

export type PreviewCheckOutcome = "pass" | "warn" | "fail";

export type PreviewCheck = {
  id: string;
  definition_id: string;
  definition_version: string;
  label: string;
  outcome: PreviewCheckOutcome;
  detail: string;
};

export type PreviewFix = {
  id: string;
  title: string;
  detail: string;
};

export type PreviewReadiness = {
  product_url: string;
  captured_at: string | null;
  status: "complete" | "partial";
  rule_catalog_version: string;
  ready: number;
  total: number;
  checks: PreviewCheck[];
  fixes: PreviewFix[];
};

export type PreviewRecheckChange = {
  id: string;
  label: string;
  from: PreviewCheckOutcome;
  to: PreviewCheckOutcome;
};

export type PreviewRecheckDiff = {
  improved: PreviewRecheckChange[];
  regressed: PreviewRecheckChange[];
  still_open: Array<{ id: string; label: string; outcome: PreviewCheckOutcome }>;
  ready_delta: number;
  skipped_definition_changes: Array<{ id: string; label: string }>;
};

export type PreviewSnapshot = {
  product_url: string;
  captured_at: string | null;
  status: "complete" | "partial";
  rule_catalog_version?: string;
  ready: number;
  total: number;
  checks: Array<{
    id: string;
    definition_id?: string;
    definition_version?: string;
    label: string;
    outcome: PreviewCheckOutcome;
  }>;
};

const FIELD_LABELS: Record<(typeof FIELD_ORDER)[number], string> = {
  title: "Title",
  category: "Category",
  price: "Price",
  currency: "Currency",
  availability: "Availability",
};

const SKIPPED_FINDING_CODES = new Set([
  "PAGE_NOINDEX",
  "CRAWLER_BLOCKED",
  "ROBOTS_UNAVAILABLE",
  "MISSING_CANONICAL",
  "SHIPPING_NOT_IN_CAPTURE",
  "RETURNS_NOT_IN_CAPTURE",
  "WARRANTY_NOT_IN_CAPTURE",
  "GTIN_NOT_IN_CAPTURE",
]);

const CRAWLER_LABELS: Record<RobotsAgentResult["agent"], string> = {
  "*": "General crawlers",
  "OAI-SearchBot": "OpenAI SearchBot",
  GPTBot: "GPTBot",
};

const MAX_FIXES = 5;

export function previewReadiness(preview: PublicProductPreview): PreviewReadiness {
  const checks = previewChecks(preview);
  const ready = checks.filter((check) => check.outcome === "pass").length;
  return {
    product_url: preview.product_url,
    captured_at: preview.captured_at ?? null,
    status: preview.status,
    rule_catalog_version: preview.rule_catalog_version ?? PREVIEW_RULE_CATALOG_VERSION,
    ready,
    total: checks.length,
    checks,
    fixes: rankedPreviewFixes(preview, checks),
  };
}

export function previewSnapshot(readiness: PreviewReadiness): PreviewSnapshot {
  return {
    product_url: readiness.product_url,
    captured_at: readiness.captured_at,
    status: readiness.status,
    rule_catalog_version: readiness.rule_catalog_version,
    ready: readiness.ready,
    total: readiness.total,
    checks: readiness.checks.map(({ id, definition_id, definition_version, label, outcome }) => ({
      id,
      definition_id,
      definition_version,
      label,
      outcome,
    })),
  };
}

export function previewRecheckDiff(
  previous: PreviewSnapshot | null | undefined,
  current: PreviewReadiness,
): PreviewRecheckDiff | null {
  if (!previous || previous.product_url !== current.product_url) return null;

  const previousById = new Map(previous.checks.map((check) => [check.id, check]));
  const improved: PreviewRecheckChange[] = [];
  const regressed: PreviewRecheckChange[] = [];
  const still_open: PreviewRecheckDiff["still_open"] = [];
  const skipped_definition_changes: PreviewRecheckDiff["skipped_definition_changes"] = [];

  for (const check of current.checks) {
    const before = previousById.get(check.id);
    if (!before) {
      if (check.outcome !== "pass") still_open.push({ id: check.id, label: check.label, outcome: check.outcome });
      continue;
    }
    if (!sameCheckDefinition(before, check)) {
      skipped_definition_changes.push({ id: check.id, label: check.label });
      continue;
    }
    if (before.outcome !== "pass" && check.outcome === "pass") {
      improved.push({ id: check.id, label: check.label, from: before.outcome, to: check.outcome });
      continue;
    }
    if (before.outcome === "pass" && check.outcome !== "pass") {
      regressed.push({ id: check.id, label: check.label, from: before.outcome, to: check.outcome });
      continue;
    }
    if (rankOutcome(check.outcome) > rankOutcome(before.outcome)) {
      improved.push({ id: check.id, label: check.label, from: before.outcome, to: check.outcome });
      continue;
    }
    if (rankOutcome(check.outcome) < rankOutcome(before.outcome)) {
      regressed.push({ id: check.id, label: check.label, from: before.outcome, to: check.outcome });
      continue;
    }
    if (check.outcome !== "pass") {
      still_open.push({ id: check.id, label: check.label, outcome: check.outcome });
    }
  }

  return {
    improved,
    regressed,
    still_open,
    ready_delta: current.ready - previous.ready,
    skipped_definition_changes,
  };
}

function previewChecks(preview: PublicProductPreview): PreviewCheck[] {
  const findings = preview.findings ?? [];
  const presence = preview.presence ?? [];
  const crawlers = preview.crawler_access ?? [];
  const checks: PreviewCheck[] = [
    check(
      "completeness",
      "Preview complete",
      preview.status === "complete" ? "pass" : "warn",
      preview.status === "complete"
        ? "The collect finished."
        : "This preview only read part of the page. Incomplete sources are not treated as missing merchant fields.",
    ),
  ];

  for (const name of FIELD_ORDER) {
    const field = preview.fields[name];
    checks.push(check(
      `field:${name}`,
      FIELD_LABELS[name],
      fieldOutcome(field.state),
      field.state === "verified" ? "Captured sources agree within the compared scope; product truth is not independently verified." : field.state === "single_source" ? "Extracted from one source." : field.state.replaceAll("_", " "),
    ));
  }

  for (const item of presence) {
    checks.push(check(
      `presence:${item.key}`,
      item.label,
      presenceOutcome(item),
      presenceDetail(item),
    ));
  }

  checks.push(check(
    "indexable",
    "Indexable",
    hasFinding(findings, "PAGE_NOINDEX") ? "fail" : "pass",
    hasFinding(findings, "PAGE_NOINDEX")
      ? findingMessage(findings, "PAGE_NOINDEX") ?? "The page declares noindex."
      : "No page-level noindex directive was observed.",
  ));

  checks.push(check(
    "canonical",
    "Canonical URL",
    hasFinding(findings, "MISSING_CANONICAL") ? "warn" : "pass",
    findingMessage(findings, "MISSING_CANONICAL") ?? "A canonical product URL was found.",
  ));

  const robotsUnavailable = hasFinding(findings, "ROBOTS_UNAVAILABLE");
  checks.push(check(
    "robots",
    "robots.txt",
    robotsUnavailable ? "warn" : "pass",
    robotsUnavailable
      ? findingMessage(findings, "ROBOTS_UNAVAILABLE") ?? "robots.txt could not be read."
      : "robots.txt was reachable.",
  ));

  for (const crawler of crawlers) {
    checks.push(check(
      `crawler:${crawler.agent}`,
      CRAWLER_LABELS[crawler.agent],
      crawlerOutcome(crawler.result),
      crawler.result === "unknown"
        ? `${crawler.agent === "*" ? "General" : crawler.agent}: unknown because robots.txt was unavailable.`
        : `${crawler.agent === "*" ? "General" : crawler.agent}: ${crawler.result}`,
    ));
  }

  const leftover = leftoverFindings(findings);
  for (const finding of leftover) {
    const fieldKey = finding.code === "FIELD_CONFLICT" ? finding.definition_id.split(":").pop() : undefined;
    const existingId = fieldKey === "product_type_category" ? "field:category"
      : fieldKey === "vendor_brand" ? "presence:brand" : fieldKey === "barcode" ? "presence:gtin"
      : fieldKey && FIELD_ORDER.includes(fieldKey as typeof FIELD_ORDER[number]) ? `field:${fieldKey}`
      : fieldKey === "shipping_details" ? "presence:shipping" : fieldKey === "merchant_return_policy" ? "presence:returns"
      : fieldKey ? `presence:${fieldKey}` : undefined;
    const existing = checks.find((item) => item.id === (existingId ?? finding.definition_id));
    const detail = [finding.message, formatFindingEvidence(finding.evidence ?? [])].filter(Boolean).join(" ");
    if (existing) {
      existing.detail = detail;
      existing.outcome = finding.severity === "error" ? "fail" : finding.severity === "warning" ? "warn" : "pass";
      continue;
    }
    checks.push(check(
      finding.definition_id ?? `finding:${finding.code}`,
      fieldKey ? `${fieldKey.replaceAll("_", " ")} agreement` : findingLabel(finding.code),
      finding.severity === "error" ? "fail" : finding.severity === "warning" ? "warn" : "pass",
      detail,
    ));
  }

  return checks;
}

function rankedPreviewFixes(preview: PublicProductPreview, checks: PreviewCheck[]): PreviewFix[] {
  const findings = preview.findings ?? [];
  const presenceByKey = new Map((preview.presence ?? []).map((item) => [item.key, item]));
  const candidates: Array<{ priority: number; fix: PreviewFix }> = [];
  const checkById = new Map(checks.map((check) => [check.id, check]));

  const addIfOpen = (priority: number, id: string, title: string, detail: string) => {
    const found = checkById.get(id);
    if (!found || found.outcome === "pass") return;
    candidates.push({ priority, fix: { id, title, detail } });
  };

  const addPresenceFix = (priority: number, key: string, title: string, detail: string) => {
    const item = presenceByKey.get(key);
    if (!item || item.state === "present" || item.state === "unavailable" || !item.relevant) return;
    addIfOpen(priority, `presence:${key}`,
      item.state === "conflicting" ? `Review conflicting ${item.label.toLowerCase()} information` : title,
      item.state === "conflicting"
        ? `${checkById.get(`presence:${key}`)?.detail ?? ""} Compare ${item.label.toLowerCase()} in Shopify admin → Products → this product with the page’s structured data and social sharing metadata. Check the source details below; correct outdated references, while preserving valid variant differences.`
        : detail);

  };

  addIfOpen(
    10,
    findingCheckId(checks, "PASSWORD_PAGE") ?? "finding:PASSWORD_PAGE",
    "Make the storefront public",
    "Shopify admin → Online Store → Preferences → Password protection. Turn off the storefront password so this product URL can be read.",
  );
  addIfOpen(
    20,
    findingCheckId(checks, "CHALLENGE_PAGE") ?? "finding:CHALLENGE_PAGE",
    "Remove the bot challenge from the product page",
    "A challenge page replaced the product HTML. Check storefront bot protection or a security app on this URL.",
  );
  addIfOpen(
    30,
    "indexable",
    "Turn off noindex on this product page",
    "Shopify admin → Online Store → Themes (product template) or the SEO app. Remove noindex/none from this product’s meta robots or X-Robots-Tag.",
  );
  if (!hasFinding(findings, "ROBOTS_UNAVAILABLE")) {
    addIfOpen(
      40,
      "crawler:*",
      "Allow general crawlers on this product path",
      "Inspect /robots.txt. Shopify: theme robots.txt.liquid. Allow this /products/{handle} path for User-agent: *.",
    );
    addIfOpen(
      50,
      "crawler:OAI-SearchBot",
      "Allow OpenAI SearchBot on this product path",
      "Inspect /robots.txt and allow this /products/{handle} path for User-agent: OAI-SearchBot.",
    );
  }
  if (preview.fields.title.state === "missing" || preview.fields.price.state === "missing") {
    candidates.push({
      priority: 60,
      fix: {
        id: "core-fields",
        title: "Make title and price readable on the live product URL",
        detail: "Shopify admin → Products → this product → Title and Pricing. Confirm the public /products/{handle} URL is the one submitted here.",
      },
    });
  } else if (checkById.get("completeness")?.outcome !== "pass") {
    addIfOpen(
      65,
      "completeness",
      "Finish the missing product-page sources",
      "This preview was only partial. Confirm /robots.txt and /products/{handle}.js load for anonymous visitors before treating blank fields as missing catalog data.",
    );
  }
  if (checkById.get("robots")?.outcome !== "pass" && !hasFinding(findings, "ROBOTS_UNAVAILABLE")) {
    addIfOpen(
      70,
      "robots",
      "Publish a reachable robots.txt",
      "Shopify usually serves /robots.txt. If it is missing, check the theme robots.txt.liquid file.",
    );
  }
  addPresenceFix(
    80,
    "json_ld_product",
    "Add Product JSON-LD",
    "Theme product template or SEO app: emit one Product node on this URL. Shopify admin product fields do not create JSON-LD by themselves unless the theme does.",
  );
  addPresenceFix(
    90,
    "json_ld_offer",
    "Add Offer JSON-LD",
    "Add price and availability inside an Offer on the Product JSON-LD node (theme / SEO app), matching Shopify admin → Products → Pricing and inventory.",
  );
  addPresenceFix(
    100,
    "brand",
    "Add a brand name",
    "Shopify admin → Products → this product → Vendor. That value is the brand this preview reads from Ajax and JSON-LD.",
  );
  addPresenceFix(
    110,
    "sku",
    "Add a SKU",
    "Shopify admin → Products → this product → Variants → SKU. Give each variant its own SKU.",
  );
  addPresenceFix(
    120,
    "gtin",
    "Add a GTIN or barcode",
    "Shopify admin → Products → this product → Variants → Barcode. Use this only when the product already has a trade identifier (ISBN, UPC, GTIN).",
  );
  addPresenceFix(
    130,
    "image",
    "Add a product image",
    "Shopify admin → Products → this product → Media. The preview reads featured image, og:image, and Product.image.",
  );
  addIfOpen(
    140,
    "canonical",
    "Add a canonical product URL",
    "Theme product template should output <link rel=\"canonical\" href=\"https://…/products/{handle}\">. Check a custom theme or SEO app override.",
  );

  const malformed = findingCheckId(checks, "MALFORMED_JSON_LD");
  if (malformed) {
    addIfOpen(
      150,
      malformed,
      "Fix JSON-LD that could not be parsed",
      "View Source → application/ld+json on this product URL. Invalid JSON is an unread source, not a missing Shopify catalog field.",
    );
  }
  const ajax = findingCheckId(checks, "AJAX_PRODUCT_UNAVAILABLE");
  if (ajax) {
    addIfOpen(
      160,
      ajax,
      "Make Shopify Ajax product JSON available",
      "Open /products/{handle}.js logged out. If it fails, a theme or app is blocking Shopify Ajax. Fields from that source are incomplete, not blank.",
    );
  }
  if (!hasFinding(findings, "ROBOTS_UNAVAILABLE")) {
    addIfOpen(
      170,
      "crawler:GPTBot",
      "Allow GPTBot on this product path",
      "Inspect /robots.txt and allow this /products/{handle} path for User-agent: GPTBot if you want that crawler to read the product.",
    );
  }
  for (const conflict of findings.filter((item) => item.code === "FIELD_CONFLICT")) {
    const key = conflict.definition_id.split(":").pop()!;
    if (["sku", "image", "vendor_brand", "barcode"].includes(key)) continue;
    candidates.push({ priority: 180, fix: {
      id: conflict.definition_id,
      title: `Review ${key.replaceAll("_", " ")} disagreement`,
      detail: `${conflict.message} ${formatFindingEvidence(conflict.evidence)} ${conflict.guidance}`,
    } });
  }
  addPresenceFix(
    220,
    "warranty",
    "Add warranty details if this product has one",
    "Shopify has no dedicated warranty field. Add it in the product description or a WarrantyPromise JSON-LD node only when this product actually offers a warranty.",
  );

  const seen = new Set<string>();
  const fixes: PreviewFix[] = [];
  for (const candidate of candidates.sort((left, right) => left.priority - right.priority)) {
    if (seen.has(candidate.fix.id)) continue;
    seen.add(candidate.fix.id);
    fixes.push(candidate.fix);
    if (fixes.length >= MAX_FIXES) break;
  }
  return fixes;
}

function check(
  id: string,
  label: string,
  outcome: PreviewCheckOutcome,
  detail: string,
): PreviewCheck {
  return {
    id,
    definition_id: id,
    definition_version: PREVIEW_RULE_CATALOG_VERSION,
    label,
    outcome,
    detail,
  };
}

function leftoverFindings(findings: PublicPreviewFinding[]): PublicPreviewFinding[] {
  return findings.filter((finding) => !SKIPPED_FINDING_CODES.has(finding.code));
}

function findingCheckId(checks: PreviewCheck[], code: string): string | undefined {
  return checks.find((item) => item.id === `finding:${code}` || item.id.startsWith(`finding:${code}:`))?.id;
}

function findingLabel(code: string): string {
  switch (code) {
    case "PASSWORD_PAGE":
      return "Public storefront";
    case "CHALLENGE_PAGE":
      return "No challenge page";
    case "MISSING_CANONICAL":
      return "Canonical URL";
    case "MALFORMED_JSON_LD":
      return "Parseable JSON-LD";
    case "MULTIPLE_PRODUCT_JSON_LD":
      return "Product data entries";
    case "AJAX_PRODUCT_UNAVAILABLE":
      return "Shopify Ajax JSON";
    case "FIELD_CONFLICT":
      return "Field agreement";
    case "SIBLING_SKU_AMBIGUITY":
      return "Variant SKUs";
    default:
      return code.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
  }
}

function fieldOutcome(state: EvidenceState): PreviewCheckOutcome {
  if (state === "missing") return "fail";
  if (state === "conflicted" || state === "incomplete") return "warn";
  return "pass";
}

function presenceOutcome(item: PublicPreviewPresence): PreviewCheckOutcome {
  const severity = presenceSeverity(item);
  return severity === "error" ? "fail" : severity === "warning" ? "warn" : "pass";
}

function presenceDetail(item: PublicPreviewPresence): string {
  const sources = item.sources.length ? ` Sources: ${item.sources.join(", ")}.` : "";
  if (item.state === "present") return `Present in captured product data.${sources}`;
  if (item.state === "conflicting") return `Captured sources disagree on ${item.field}.${sources}`;
  if (item.state === "unavailable") {
    return `Could not verify ${item.label.toLowerCase()} because a product-page source was incomplete. This is not a missing catalog field.`;
  }
  if (!item.relevant) {
    return `${item.label} wasn’t found in the captured product data. This preview does not treat it as required for this product.`;
  }
  if (item.key === "shipping") {
    return "Shipping details were not found in structured data. Visible text and policy pages are not verified.";
  }
  if (item.key === "returns") return "Return details were not found in structured data. Visible text and policy pages are not verified.";
  return `Not found in captured product data (field: ${item.field}).`;
}

function crawlerOutcome(result: RobotsAgentResult["result"]): PreviewCheckOutcome {
  if (result === "allowed") return "pass";
  if (result === "blocked") return "fail";
  return "warn";
}

function hasFinding(findings: PublicPreviewFinding[], code: string): boolean {
  return findings.some((finding) => finding.code === code);
}

function findingMessage(findings: PublicPreviewFinding[], code: string): string | undefined {
  return findings.find((finding) => finding.code === code)?.message;
}

function sameCheckDefinition(
  previous: PreviewSnapshot["checks"][number],
  current: PreviewCheck,
): boolean {
  const previousVersion = previous.definition_version;
  if (!previousVersion) return false;
  return previousVersion === current.definition_version;
}

function rankOutcome(outcome: PreviewCheckOutcome): number {
  if (outcome === "pass") return 2;
  if (outcome === "warn") return 1;
  return 0;
}
