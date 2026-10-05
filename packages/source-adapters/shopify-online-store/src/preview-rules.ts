import type { NormalizedField, ProductRecord, ShopifyCollection, SourceKind, TechnicalFinding } from "./types";

export const PREVIEW_RULE_CATALOG_VERSION = "2026-10-05.1";

export type FindingStatus = "missing" | "conflicting" | "unavailable" | "present";

export type PresenceState = FindingStatus;

export type PreviewEvidence = {
  field: string;
  source: string;
  path: string;
  value?: string | number | boolean;
};

export type EvaluatedPreviewFinding = {
  definition_id: string;
  definition_version: string;
  code: string;
  severity: "info" | "warning" | "error";
  status: FindingStatus;
  message: string;
  evidence: PreviewEvidence[];
  guidance: string;
  relevant: boolean;
};

export type EvaluatedPresence = {
  key: string;
  label: string;
  field: string;
  state: PresenceState;
  sources: string[];
  relevant: boolean;
};

const PRESENCE_FIELDS = [
  { key: "brand", label: "Brand", field: "vendor_brand", jsonLdOnly: false },
  { key: "sku", label: "SKU", field: "sku", jsonLdOnly: false },
  { key: "gtin", label: "GTIN", field: "barcode", jsonLdOnly: false },
  { key: "image", label: "Image", field: "image", jsonLdOnly: false },
  { key: "shipping", label: "Shipping", field: "shipping_details", jsonLdOnly: true },
  { key: "returns", label: "Returns", field: "merchant_return_policy", jsonLdOnly: true },
  { key: "warranty", label: "Warranty", field: "warranty", jsonLdOnly: true },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  field: keyof ProductRecord["fields"];
  jsonLdOnly: boolean;
}>;

const SOURCE_LABELS: Record<string, string> = {
  shopify_ajax: "Shopify Ajax /products/{handle}.js",
  json_ld: "JSON-LD on the product page",
  html_meta: "HTML meta / Open Graph",
  visible_html: "Visible product HTML",
  robots: "robots.txt",
  page_directives: "page robots directives",
};

const CONFLICT_FIELD_KEYS: Record<string, string> = {
  "product identity": "product_id",
  "canonical URL": "canonical_url",
  "brand / vendor": "vendor_brand",
  "product type / category": "product_type_category",
  "collection-or-taxonomy hints": "taxonomy_hints",
  "merchant return policy": "merchant_return_policy",
  "shipping details": "shipping_details",
};

const DIGITAL_PATTERN = /\b(digital download|instant download|gift card|e-?gift|online course|pdf download|software license)\b/i;
const HANDMADE_PATTERN = /\b(handmade|hand-made|hand made|made to order|made-to-order|custom |commission|one of a kind|bespoke)\b/i;
const GTIN_HINT_PATTERN = /\b(isbn|upc|ean|gtin|barcode)\b/i;
const WARRANTY_CATEGORY_PATTERN = /\b(electronics?|appliance|computer|laptop|notebook|phone|smartphone|tablet|battery|power tool|furniture|mattress|watch|camera|headphones?|speaker|tv|television|monitor)\b/i;

export function evaluatePreviewCapture(collection: ShopifyCollection): {
  presence: EvaluatedPresence[];
  findings: EvaluatedPreviewFinding[];
} {
  const relevance = productRelevance(collection.record);
  const capture = captureLimits(collection.record);
  const presence = evaluatePresence(collection.record, relevance, capture);
  const findings = [
    ...collection.technicalCheck.findings.map((finding) => enrichTechnicalFinding(finding, collection)),
    ...collection.record.technical_findings.map((finding) => enrichTechnicalFinding(finding, collection)),
    ...presenceFindings(presence, collection.record),
  ];
  for (const item of presence) {
    if (["shipping", "returns", "warranty", "gtin"].includes(item.key) || item.state === "present") continue;
    if (item.state === "conflicting" && findings.some((finding) => finding.definition_id === `finding:FIELD_CONFLICT:${item.field}`)) continue;
    findings.push({ definition_id: `presence:${item.key}`, definition_version: PREVIEW_RULE_CATALOG_VERSION,
      code: `PRESENCE_${item.key.toUpperCase()}`, status: item.state, severity: presenceSeverity(item), relevant: item.relevant,
      message: item.state === "unavailable" ? `${item.label} could not be read because a product-page source was incomplete.`
        : item.state === "conflicting" ? `Captured sources disagree on ${item.label}.` : `${item.label} was not found in captured product data.`,
      evidence: presenceEvidence(item, collection.record), guidance: presenceGuidance(item.key),
    });
  }
  for (const [name, key] of [["title", "title"], ["category", "product_type_category"], ["price", "price"], ["currency", "currency"], ["availability", "availability"]] as const) {
    const field = collection.record.fields[key];
    if (!["missing", "incomplete"].includes(field.state)) continue;
    findings.push({ definition_id: `field:${name}`, definition_version: PREVIEW_RULE_CATALOG_VERSION,
      code: `FIELD_${name.toUpperCase()}`, severity: field.state === "missing" ? "error" : "warning",
      status: field.state === "missing" ? "missing" : "unavailable", relevant: true,
      message: `${name[0]!.toUpperCase()}${name.slice(1)} ${field.state === "missing" ? "was not found in captured data" : "could not be resolved from the captured sources"}.`,
      evidence: [{ field: key, source: "captured_data", path: key }],
      guidance: name === "currency" ? "Inspect explicit currency codes in Shopify runtime data and Offer.priceCurrency; a dollar symbol does not establish a currency."
        : "Review the submitted product or variant in Shopify admin → Products and its theme structured data. Recheck incomplete sources before adding catalog fields.",
    });
  }
  return { presence, findings: dedupeFindings(findings) };
}

export function evaluatePresence(
  record: ProductRecord,
  relevance = productRelevance(record),
  capture = captureLimits(record),
): EvaluatedPresence[] {
  return [
    ...PRESENCE_FIELDS.map((item) => {
      const field = record.fields[item.field];
      return {
        key: item.key,
        label: item.label,
        field: item.field,
        state: fieldPresenceState(field, item.jsonLdOnly, capture),
        sources: uniqueSources(field.observations.map((observation) => observation.source)),
        relevant: presenceRelevant(item.key, relevance),
      };
    }),
    {
      key: "json_ld_product",
      label: "JSON-LD Product",
      field: "json_ld_product",
      state: jsonLdPresenceState(record.json_ld_product_count > 0, capture),
      sources: record.json_ld_product_count > 0 ? ["json_ld"] : [],
      relevant: true,
    },
    {
      key: "json_ld_offer",
      label: "JSON-LD Offer",
      field: "json_ld_offer",
      state: jsonLdPresenceState(hasJsonLdOffer(record), capture),
      sources: hasJsonLdOffer(record) ? ["json_ld"] : [],
      relevant: true,
    },
  ];
}

export function productRelevance(record: ProductRecord): {
  physical: boolean;
  gtin: boolean;
  warranty: boolean;
  shipping: boolean;
  returns: boolean;
} {
  const text = productText(record);
  const digital = DIGITAL_PATTERN.test(text);
  const handmade = HANDMADE_PATTERN.test(text);
  const variantBarcodes = record.variants.map((variant) => variant.barcode).filter(Boolean);
  const someBarcode = variantBarcodes.length > 0;
  const incompleteBarcodes = someBarcode && record.variants.some((variant) => !variant.barcode);
  const gtin = !digital && (
    incompleteBarcodes
    || GTIN_HINT_PATTERN.test(text)
    || (Boolean(record.fields.vendor_brand.value) && !handmade && someBarcode)
  );
  const warranty = !digital && (WARRANTY_CATEGORY_PATTERN.test(text) || /\bwarrant(y|ies)\b/i.test(text));
  return {
    physical: !digital,
    gtin,
    warranty,
    shipping: !digital,
    returns: !digital,
  };
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function formatFindingEvidence(evidence: PreviewEvidence[]): string {
  if (!evidence.length) return "No captured field produced this result.";
  return evidence.map((item) => {
    const source = sourceLabel(item.source);
    const path = item.path ? ` · ${item.path}` : "";
    return `${item.field} from ${source}${path}${item.value === undefined ? "" : ` = ${JSON.stringify(item.value)}`}`;
  }).join("; ");
}

function presenceFindings(presence: EvaluatedPresence[], record: ProductRecord): EvaluatedPreviewFinding[] {
  const findings: EvaluatedPreviewFinding[] = [];
  const add = (
    item: EvaluatedPresence,
    code: string,
    message: string,
    guidance: string,
  ) => {
    if (item.state === "present") return;
    if (item.state === "conflicting" && record.technical_findings.some((finding) => {
      const label = conflictFieldLabel(finding.message);
      return finding.code === "FIELD_CONFLICT" && (CONFLICT_FIELD_KEYS[label] ?? label.replace(/\s+/g, "_")) === item.field;
    })) return;
    findings.push({
      definition_id: `presence:${item.key}`,
      definition_version: PREVIEW_RULE_CATALOG_VERSION,
      code,
      severity: presenceSeverity(item),
      status: item.state,
      message,
      evidence: presenceEvidence(item, record),
      guidance,
      relevant: item.relevant,
    });
  };

  const shipping = presence.find((item) => item.key === "shipping");
  if (shipping) {
    add(
      shipping,
      "SHIPPING_NOT_IN_CAPTURE",
      shipping.state === "unavailable"
        ? "Shipping information could not be verified because this preview could not finish reading the product-page sources that would contain it."
        : shipping.state === "conflicting"
          ? "Captured product sources disagree about shipping details."
          : "Shipping details were not found in product structured data. Visible shipping text and separate policy pages have not been verified.",
      "This preview only inspects the submitted product URL. Check Shopify admin → Settings → Shipping and delivery, or Online Store → Pages / Policies → Shipping policy. To expose shipping on the product itself, add OfferShippingDetails in the product template JSON-LD.",
    );
  }

  const returns = presence.find((item) => item.key === "returns");
  if (returns) {
    add(
      returns,
      "RETURNS_NOT_IN_CAPTURE",
      returns.state === "unavailable"
        ? "Return-policy information could not be verified from the captured product-page sources."
        : returns.state === "conflicting"
          ? "Captured product sources disagree about the return policy."
          : "Return-policy details were not found in product structured data. Visible return statements and separate policy pages have not been verified.",
      "Check Shopify admin → Settings → Policies → Refund policy, or the product template JSON-LD hasMerchantReturnPolicy node. A store-wide policy page is outside this product capture.",
    );
  }

  const warranty = presence.find((item) => item.key === "warranty");
  if (warranty) {
    add(
      warranty,
      "WARRANTY_NOT_IN_CAPTURE",
      warranty.state === "unavailable"
        ? "Warranty information could not be verified from the captured product-page sources."
        : warranty.state === "conflicting"
          ? "Captured product sources disagree about warranty details."
          : warranty.relevant
            ? "Warranty details weren’t found in the captured product data for this product."
            : "Warranty details weren’t found in the captured product data. This preview does not treat a warranty as required for this product.",
      "Shopify has no dedicated warranty field. If this product needs one, add it in the product description or a WarrantyPromise JSON-LD node on the product template. Skip this when warranty does not apply.",
    );
  }

  const gtin = presence.find((item) => item.key === "gtin");
  if (gtin) {
    add(
      gtin,
      "GTIN_NOT_IN_CAPTURE",
      gtin.state === "unavailable"
        ? "A GTIN/barcode could not be verified because a product-page source was incomplete."
        : gtin.state === "conflicting"
          ? "Captured product sources disagree about the GTIN/barcode."
          : gtin.relevant
            ? "No GTIN/barcode was found on the captured variants for this product."
            : "No GTIN/barcode was found in the captured product data. This preview does not treat a barcode as required for this product.",
      "Shopify admin → Products → this product → Variants → Barcode (ISBN, UPC, GTIN-13, or GTIN-14). Leave blank for handmade, custom, or digital products that do not have a trade identifier.",
    );
  }

  return findings;
}

function enrichTechnicalFinding(finding: TechnicalFinding, collection: ShopifyCollection): EvaluatedPreviewFinding {
  const mapped = technicalFindingCopy(finding, collection);
  return {
    definition_id: mapped.definition_id,
    definition_version: PREVIEW_RULE_CATALOG_VERSION,
    code: finding.code,
    severity: finding.severity,
    status: mapped.status,
    message: mapped.message,
    evidence: mapped.evidence,
    guidance: mapped.guidance,
    relevant: true,
  };
}

function technicalFindingCopy(
  finding: TechnicalFinding,
  collection: ShopifyCollection,
): {
  definition_id: string;
  status: FindingStatus;
  message: string;
  evidence: PreviewEvidence[];
  guidance: string;
} {
  const paths = finding.evidence_paths;
  switch (finding.code) {
    case "PAGE_NOINDEX":
      return {
        definition_id: "finding:PAGE_NOINDEX",
        status: "present",
        message: finding.message,
        evidence: paths.map((path) => ({ field: "page_directives", source: path.startsWith("x-robots") ? "page_directives" : "html_meta", path })),
        guidance: "Shopify admin → Online Store → Themes (product template) or the SEO app on this product. Remove noindex or none from the page meta robots / X-Robots-Tag.",
      };
    case "CRAWLER_BLOCKED":
      return {
        definition_id: `finding:CRAWLER_BLOCKED:${agentFromMessage(finding.message)}`,
        status: "present",
        message: finding.message,
        evidence: paths.map((path) => ({ field: "crawler_access", source: "robots", path })),
        guidance: "Inspect /robots.txt for this hostname. Shopify: Online Store → Themes → robots.txt.liquid, or the app that publishes robots rules. Allow this /products/{handle} path for the blocked user-agent.",
      };
    case "ROBOTS_UNAVAILABLE":
      return {
        definition_id: "finding:ROBOTS_UNAVAILABLE",
        status: "unavailable",
        message: `${finding.message} This preview could not verify crawler rules; that is a failed read, not proof the storefront blocks crawlers.`,
        evidence: [{ field: "robots.txt", source: "robots", path: "/robots.txt" }],
        guidance: "Open https://{shop}/robots.txt in a browser. Shopify serves this automatically; a 404 or timeout here is a capture limit until the file responds.",
      };
    case "MISSING_CANONICAL":
      return {
        definition_id: "finding:MISSING_CANONICAL",
        status: "missing",
        message: finding.message,
        evidence: [{ field: "canonical_url", source: "html_meta", path: "link[rel=canonical]" }],
        guidance: "Theme product template should output <link rel=\"canonical\" href=\"https://…/products/{handle}\">. Check a custom theme or SEO app if Shopify’s default canonical was removed.",
      };
    case "MALFORMED_JSON_LD":
      return {
        definition_id: "finding:MALFORMED_JSON_LD",
        status: "unavailable",
        message: `${finding.message} Structured product fields that only exist in those blocks could not be verified.`,
        evidence: [{ field: "json_ld", source: "json_ld", path: "script[type=application/ld+json]" }],
        guidance: "View Source on the product URL and fix invalid application/ld+json in the product template or SEO app. Do not treat the unreadable blocks as missing merchant fields.",
      };
    case "MULTIPLE_PRODUCT_JSON_LD":
      return {
        definition_id: "finding:MULTIPLE_PRODUCT_JSON_LD",
        status: "present",
        message: finding.message,
        evidence: [{ field: "json_ld_product", source: "json_ld", path: `Product nodes: ${collection.record.json_ld_product_count}` }],
        guidance: "Review the Product entries in the theme or SEO app. Multiple entries may describe valid variants; correct conflicting duplicates without removing valid variant data.",
      };
    case "PASSWORD_PAGE":
      return {
        definition_id: "finding:PASSWORD_PAGE",
        status: "unavailable",
        message: finding.message,
        evidence: [{ field: "storefront", source: "visible_html", path: "password page" }],
        guidance: "Shopify admin → Online Store → Preferences → Password protection. Turn the storefront password off so this product URL is public.",
      };
    case "CHALLENGE_PAGE":
      return {
        definition_id: "finding:CHALLENGE_PAGE",
        status: "unavailable",
        message: finding.message,
        evidence: [{ field: "storefront", source: "visible_html", path: "challenge page" }],
        guidance: "A bot challenge replaced the product HTML. Check storefront bot protection, a security app, or a challenge interstitial on this URL.",
      };
    case "AJAX_PRODUCT_UNAVAILABLE":
      return {
        definition_id: "finding:AJAX_PRODUCT_UNAVAILABLE",
        status: "unavailable",
        message: `${finding.message} Fields that come from Shopify Ajax were marked incomplete instead of missing.`,
        evidence: [{ field: "shopify_ajax", source: "shopify_ajax", path: "/products/{handle}.js" }],
        guidance: "Open /products/{handle}.js while logged out. If that payload is blocked, a theme or app is hiding Shopify Ajax product JSON. This is a failed source read, not a blank catalog field.",
      };
    case "FIELD_CONFLICT": {
      const fieldLabel = conflictFieldLabel(finding.message);
      const fieldKey = CONFLICT_FIELD_KEYS[fieldLabel] ?? fieldLabel.replace(/\s+/g, "_");
      const field = collection.record.fields[fieldKey as keyof ProductRecord["fields"]];
      return {
        definition_id: `finding:FIELD_CONFLICT:${fieldKey}`,
        status: "conflicting",
        message: finding.message,
        evidence: (field?.observations ?? []).slice(0, 4).map((observation) => ({
          field: fieldKey,
          source: observation.source,
          path: observation.path,
          value: observation.value,
        })),
        guidance: `Compare Shopify admin → Products → this product with the theme JSON-LD for ${fieldLabel}. Align the disagreeing source; do not guess which value shopping systems will keep.`,
      };
    }
    case "SIBLING_SKU_AMBIGUITY":
      return {
        definition_id: "finding:SIBLING_SKU_AMBIGUITY",
        status: "conflicting",
        message: finding.message,
        evidence: paths.map((path) => ({ field: "sku", source: sourceFromPath(path), path })),
        guidance: "Verify which variant each captured SKU identifies before changing Shopify data. Different variants can legitimately have different SKUs.",
      };
    default:
      return {
        definition_id: `finding:${finding.code}`,
        status: "present",
        message: finding.message,
        evidence: paths.map((path) => ({ field: finding.code.toLowerCase(), source: sourceFromPath(path), path })),
        guidance: "Inspect the captured product URL and the Shopify admin fields that correspond to this check.",
      };
  }
}

function fieldPresenceState(field: NormalizedField, jsonLdOnly: boolean, capture: CaptureLimits): PresenceState {
  if (field.state === "conflicted") return "conflicting";
  if (field.state === "verified" || field.state === "single_source") return "present";
  if (field.state === "incomplete") return "unavailable";
  if (capture.blocked) return "unavailable";
  if (jsonLdOnly && capture.jsonLdUnreadable) return "unavailable";
  return "missing";
}

function jsonLdPresenceState(found: boolean, capture: CaptureLimits): PresenceState {
  if (found) return "present";
  if (capture.blocked || capture.jsonLdUnreadable) return "unavailable";
  return "missing";
}

function presenceRelevant(key: string, relevance: ReturnType<typeof productRelevance>): boolean {
  if (key === "gtin") return relevance.gtin;
  if (key === "warranty") return relevance.warranty;
  if (key === "shipping") return relevance.shipping;
  if (key === "returns") return relevance.returns;
  return true;
}

function presenceEvidence(item: EvaluatedPresence, record: ProductRecord): PreviewEvidence[] {
  const field = record.fields[item.field as keyof ProductRecord["fields"]];
  if (field?.observations.length) {
    return field.observations.slice(0, 4).map((observation) => ({
      field: item.field,
      source: observation.source,
      path: observation.path,
      value: observation.value,
    }));
  }
  if (item.field === "json_ld_product" || item.field === "json_ld_offer") {
    return [{ field: item.field, source: "json_ld", path: item.field === "json_ld_offer" ? "Product.offers" : "Product" }];
  }
  const source = item.field === "shipping_details" || item.field === "merchant_return_policy" || item.field === "warranty"
    ? "json_ld"
    : "shopify_ajax";
  const path = item.field === "shipping_details"
    ? "Product.shippingDetails / Offer.shippingDetails"
    : item.field === "merchant_return_policy"
      ? "Product.hasMerchantReturnPolicy / Offer.hasMerchantReturnPolicy"
      : item.field === "warranty"
        ? "Product.warranty / Product.hasWarrantyPromise"
        : item.field === "barcode"
          ? "variants[].barcode / Product.gtin*"
          : item.field;
  return [{ field: item.field, source, path }];
}

type CaptureLimits = {
  blocked: boolean;
  jsonLdUnreadable: boolean;
};

function captureLimits(record: ProductRecord): CaptureLimits {
  const blocked = record.collection_status === "blocked"
    || record.technical_findings.some((finding) => finding.code === "PASSWORD_PAGE" || finding.code === "CHALLENGE_PAGE");
  const jsonLdUnreadable = record.json_ld_product_count === 0
    && record.technical_findings.some((finding) => finding.code === "MALFORMED_JSON_LD");
  return { blocked, jsonLdUnreadable };
}

function productText(record: ProductRecord): string {
  return [
    record.fields.title.value,
    record.fields.product_type_category.value,
    record.fields.description.value,
    record.fields.taxonomy_hints.value,
    record.fields.vendor_brand.value,
  ].filter((value) => typeof value === "string").join(" ");
}

function hasJsonLdOffer(record: ProductRecord): boolean {
  return Object.values(record.fields).some((field) =>
    field.observations.some((observation) => (
      observation.source === "json_ld" && observation.path.includes(".offers[")
    )),
  );
}

function uniqueSources(sources: SourceKind[]): string[] {
  return [...new Set(sources)];
}

function conflictFieldLabel(message: string): string {
  return message.match(/Sources disagree on (.+)\.$/)?.[1] ?? "field";
}

function agentFromMessage(message: string): string {
  const agent = message.match(/^(.*) is blocked/)?.[1];
  return agent === "*" ? "general" : (agent ?? "unknown").replaceAll(" ", "_");
}

function sourceFromPath(path: string): string {
  if (path.startsWith("robots")) return "robots";
  if (path.startsWith("meta[") || path.startsWith("x-robots")) return "html_meta";
  if (path.includes("variants[") || path === "id" || path === "handle") return "shopify_ajax";
  if (path.includes("products[") || path.includes("offers[")) return "json_ld";
  return "html_meta";
}

function dedupeFindings(findings: EvaluatedPreviewFinding[]): EvaluatedPreviewFinding[] {
  const seen = new Set<string>();
  const unique: EvaluatedPreviewFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.definition_id}:${finding.code}:${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}


export function presenceSeverity(item: Pick<EvaluatedPresence, "state" | "key" | "relevant">): "info" | "warning" | "error" {
  if (item.state === "present" || item.state === "missing" && !item.relevant) return "info";
  if (item.state === "unavailable" || item.state === "conflicting") return "warning";
  return ["brand", "sku", "image"].includes(item.key) ? "error" : "warning";
}

function presenceGuidance(key: string): string {
  const copy: Record<string, string> = {
    brand: "Shopify admin → Products → this product → Vendor. Review the brand in Ajax and JSON-LD.",
    sku: "Shopify admin → Products → this product → Variants → SKU. Give each variant its own SKU.",
    image: "Shopify admin → Products → this product → Media. Review featured image, og:image and Product.image.",
    json_ld_product: "Theme product template or SEO app: emit Product JSON-LD on this URL.",
    json_ld_offer: "Theme product template or SEO app: emit Offer price and availability matching the same Shopify variant and currency.",
  };
  return copy[key] ?? "Review the captured source and recheck.";
}
