import { CONTRACT_VERSIONS } from "@mclab/contracts";

import { breadcrumbNames, jsonLdCompactText, jsonLdImageUrls, jsonLdOffers } from "./parse";
import type {
  EvidenceObservation,
  NormalizedField,
  ParsedHtml,
  ProductRecord,
  ProductVariant,
  ShopifyAjaxProduct,
  SourceKind,
  TechnicalFinding,
} from "./types";

type NormalizeInput = {
  requestedUrl: string;
  finalUrl: string;
  capturedAt: string;
  html: ParsedHtml;
  ajax: ShopifyAjaxProduct | null;
  ajaxError?: string;
};

export function normalizeProduct(input: NormalizeInput): ProductRecord {
  const findings: TechnicalFinding[] = [];
  const observed = (source: SourceKind, path: string, value: unknown): EvidenceObservation[] => {
    const scalar = scalarValue(value);
    return scalar === null
      ? []
      : [{ source, path, value: scalar, captured_url: input.finalUrl, captured_at: input.capturedAt }];
  };
  const fromProducts = (path: string, getter: (product: Record<string, unknown>) => unknown) =>
    input.html.jsonLdProducts.flatMap((product, index) =>
      observed("json_ld", `products[${index}].${path}`, getter(product)),
    );

  const offers = input.html.jsonLdProducts.flatMap((product, productIndex) =>
    jsonLdOffers(product).map((offer, offerIndex) => ({ offer, productIndex, offerIndex })),
  );
  const offerObservations = (path: string, getter: (offer: Record<string, unknown>) => unknown) =>
    offers.flatMap(({ offer, productIndex, offerIndex }) =>
      observed("json_ld", `products[${productIndex}].offers[${offerIndex}].${path}`, getter(offer)),
    );

  const ajax = input.ajax;
  const fields = {
    product_id: field([
      ...observed("shopify_ajax", "id", ajax?.id),
      ...fromProducts("productID", (product) => product.productID),
    ], !ajax),
    handle: field([
      ...observed("shopify_ajax", "handle", ajax?.handle),
      ...observed("html_meta", "url.handle", productHandle(input.finalUrl)),
    ], !ajax),
    canonical_url: field([
      ...observed("html_meta", "link[rel=canonical]", absoluteUrl(input.html.canonicalUrl, input.finalUrl)),
      ...fromProducts("url", (product) => absoluteUrl(scalarString(product.url), input.finalUrl)),
    ], false, canonicalKey),
    title: preferredField([
      ...observed("shopify_ajax", "title", ajax?.title),
      ...fromProducts("name", (product) => product.name),
      ...observed("visible_html", "h1", input.html.h1),
    ], [
      ...observed("html_meta", "og:title", input.html.og["og:title"]),
    ], !ajax),
    description: preferredField([
      ...observed("shopify_ajax", "description", ajax?.description),
      ...fromProducts("description", (product) => product.description),
    ], [
      ...observed("html_meta", "meta.description", input.html.metaDescription),
      ...observed("html_meta", "og:description", input.html.og["og:description"]),
    ], !ajax),
    vendor_brand: field([
      ...observed("shopify_ajax", "vendor", ajax?.vendor),
      ...fromProducts("brand", (product) => brandName(product.brand)),
    ], !ajax),
    product_type_category: field([
      ...observed("shopify_ajax", "type", ajax?.productType),
      ...fromProducts("category", (product) => product.category),
    ], !ajax, comparableCategory),
    currency: field([
      ...observed("html_meta", "product:price:currency", input.html.og["product:price:currency"]),
      ...offerObservations("priceCurrency", (offer) => offer.priceCurrency),
    ]),
    price: field([
      ...observed("shopify_ajax", "price", ajax?.priceMinor),
      ...observed("html_meta", "product:price:amount", decimalPrice(input.html.og["product:price:amount"])),
      ...offerObservations("price", (offer) => decimalPrice(offer.price ?? offer.lowPrice)),
    ], !ajax),
    availability: field([
      ...observed("shopify_ajax", "available", ajax?.available),
      ...observed(
        "html_meta",
        "product:availability",
        normalizedAvailability(input.html.og["product:availability"]),
      ),
      ...offerObservations("availability", (offer) => normalizedAvailability(offer.availability)),
    ], !ajax),
    sku: field([
      ...observed("shopify_ajax", "variants[0].sku", ajax?.variants[0]?.sku),
      ...fromProducts("sku", (product) => product.sku),
      ...offerObservations("sku", (offer) => offer.sku),
    ], !ajax),
    barcode: preferredField([
      ...observed("shopify_ajax", "variants[0].barcode", ajax?.variants[0]?.barcode),
      ...fromProducts("gtin", (product) => product.gtin),
      ...fromProducts("gtin8", (product) => product.gtin8),
      ...fromProducts("gtin12", (product) => product.gtin12),
      ...fromProducts("gtin13", (product) => product.gtin13),
      ...fromProducts("gtin14", (product) => product.gtin14),
      ...fromProducts("isbn", (product) => product.isbn),
      ...fromProducts("mpn", (product) => product.mpn),
    ], [
      ...(ajax?.variants.slice(1) ?? []).flatMap((variant, index) =>
        observed("shopify_ajax", `variants[${index + 1}].barcode`, variant.barcode),
      ),
    ], !ajax),
    image: preferredField([
      ...observed(
        "shopify_ajax",
        ajax?.featuredImage ? "featured_image" : "images[0]",
        absoluteUrl(ajax?.featuredImage ?? ajax?.images[0] ?? null, input.finalUrl),
      ),
      ...observed("html_meta", "og:image", absoluteUrl(input.html.og["og:image"] ?? null, input.finalUrl)),
      ...input.html.jsonLdProducts.flatMap((product, index) => {
        const url = jsonLdImageUrls(product.image)[0];
        return url ? observed("json_ld", `products[${index}].image`, absoluteUrl(url, input.finalUrl)) : [];
      }),
    ], [
      ...(ajax?.images ?? []).flatMap((url, imageIndex) =>
        observed("shopify_ajax", `images[${imageIndex}]`, absoluteUrl(url, input.finalUrl)),
      ),
      ...input.html.jsonLdProducts.flatMap((product, index) =>
        jsonLdImageUrls(product.image).slice(1).flatMap((url, imageIndex) =>
          observed("json_ld", `products[${index}].image[${imageIndex + 1}]`, absoluteUrl(url, input.finalUrl)),
        ),
      ),
    ]),
    shipping_details: field([
      ...fromProducts("shippingDetails", (product) => jsonLdCompactText(product.shippingDetails)),
      ...offerObservations("shippingDetails", (offer) => jsonLdCompactText(offer.shippingDetails)),
    ]),
    merchant_return_policy: field([
      ...fromProducts("hasMerchantReturnPolicy", (product) => jsonLdCompactText(product.hasMerchantReturnPolicy)),
      ...offerObservations("hasMerchantReturnPolicy", (offer) => jsonLdCompactText(offer.hasMerchantReturnPolicy)),
    ]),
    warranty: field([
      ...fromProducts("warranty", (product) => jsonLdCompactText(product.warranty)),
      ...fromProducts("hasWarrantyPromise", (product) => jsonLdCompactText(product.hasWarrantyPromise)),
      ...offerObservations("warranty", (offer) => jsonLdCompactText(offer.warranty)),
      ...offerObservations("hasWarrantyPromise", (offer) => jsonLdCompactText(offer.hasWarrantyPromise)),
    ]),
    taxonomy_hints: labeledHintsField(
      input.html.jsonLdBreadcrumbLists.map((list, index) => {
        const names = breadcrumbNames(list);
        return {
          names,
          observations: names.flatMap((name, nameIndex) =>
            observed("json_ld", `breadcrumbs[${index}].itemListElement[${nameIndex}].name`, name),
          ),
        };
      }),
      (ajax?.tags ?? []).flatMap((tag, index) => observed("shopify_ajax", `tags[${index}]`, tag)),
    ),
  };

  // Compare each identified variant with that same Shopify variant, never with
  // the first SKU or the product-wide "any variant available" value.
  if (ajax) {
    for (const [name, variantKey] of [
      ["sku", "sku"], ["barcode", "barcode"], ["price", "price_minor"], ["availability", "available"],
    ] as const) {
      fields[name] = variantField(fields[name], variantKey, input, observed);
    }
  }
  const imageKey = shopifyImageKey(input);
  const imageObservations = fields.image.observations;
  const catalogImages = new Set(imageObservations.filter((item) => item.source === "shopify_ajax").map((item) => imageKey(item.value)));
  const primaryImages = imageObservations.filter((item) => !/images\[|image\[/.test(item.path));
  fields.image = field(primaryImages.length ? primaryImages : imageObservations, false,
    (value) => catalogImages.has(imageKey(value)) ? "catalog-image" : imageKey(value));
  fields.image.observations = imageObservations;

  if (!input.html.canonicalUrl) finding(findings, "MISSING_CANONICAL", "warning", "No canonical product URL was found.", []);
  if (input.html.jsonLdParseErrors) {
    finding(findings, "MALFORMED_JSON_LD", "warning", `${input.html.jsonLdParseErrors} JSON-LD block(s) could not be parsed.`, []);
  }
  if (input.html.jsonLdProducts.length > 1 && !input.html.jsonLdProducts.every((product) => matchedVariant(product, input))) {
    finding(findings, "MULTIPLE_PRODUCT_JSON_LD", "info", "Multiple Product JSON-LD nodes were found and all were retained.", []);
  }
  if (input.html.passwordPage) finding(findings, "PASSWORD_PAGE", "error", "The storefront returned a password page.", []);
  if (input.html.challengePage) finding(findings, "CHALLENGE_PAGE", "error", "The storefront returned a bot challenge.", []);
  if (!ajax) finding(findings, "AJAX_PRODUCT_UNAVAILABLE", "warning", input.ajaxError ?? "Shopify Ajax product JSON was unavailable.", []);

  for (const [name, value] of Object.entries(fields)) {
    if (value.state === "conflicted") {
      finding(
        findings,
        "FIELD_CONFLICT",
        "warning",
        `Sources disagree on ${fieldDisplayName(name)}.`,
        value.observations.map((item) => item.path),
      );
    }
  }

  return {
    schema_version: CONTRACT_VERSIONS.productRecord,
    requested_url: input.requestedUrl,
    final_url: input.finalUrl,
    captured_at: input.capturedAt,
    collection_status: input.html.passwordPage || input.html.challengePage ? "blocked" : ajax ? "complete" : "partial",
    fields,
    variants: ajax?.variants ?? [],
    json_ld_product_count: input.html.jsonLdProducts.length,
    technical_findings: findings,
  };
}

function fieldDisplayName(name: string): string {
  const labels: Record<string, string> = {
    product_id: "product identity",
    canonical_url: "canonical URL",
    vendor_brand: "brand / vendor",
    product_type_category: "product type / category",
    taxonomy_hints: "collection-or-taxonomy hints",
    merchant_return_policy: "merchant return policy",
    shipping_details: "shipping details",
  };
  return labels[name] ?? name.replace(/_/g, " ");
}

function labeledHintsField(
  breadcrumbGroups: Array<{ names: string[]; observations: EvidenceObservation[] }>,
  tagObservations: EvidenceObservation[],
): NormalizedField {
  const observations = [
    ...breadcrumbGroups.flatMap((group) => group.observations),
    ...tagObservations,
  ];
  if (!observations.length) return { state: "missing", value: null, observations };
  const labels = [
    ...breadcrumbGroups
      .map((group) => group.names.join(" > "))
      .filter(Boolean)
      .map((trail) => `breadcrumb: ${trail}`),
    ...tagObservations.map((observation) => `ajax_tag: ${observation.value}`),
  ];
  const sources = new Set(observations.map((observation) => observation.source));
  return {
    state: sources.size >= 2 ? "verified" : "single_source",
    value: labels.join("; "),
    observations,
  };
}

function field(
  observations: EvidenceObservation[],
  incomplete = false,
  keyFor: (value: unknown) => string = comparable,
): NormalizedField {
  if (!observations.length) return { state: incomplete ? "incomplete" : "missing", value: null, observations };
  const groups = new Map<string, EvidenceObservation[]>();
  for (const observation of observations) {
    const key = keyFor(observation.value);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  if (groups.size > 1) return { state: "conflicted", value: null, observations };
  const sources = new Set(observations.map((observation) => observation.source));
  return { state: sources.size >= 2 ? "verified" : "single_source", value: observations[0]!.value, observations };
}

function preferredField(
  primary: EvidenceObservation[],
  fallback: EvidenceObservation[],
  incomplete = false,
): NormalizedField {
  if (!primary.length) return field(fallback, incomplete);
  const resolved = field(primary, incomplete);
  if (resolved.state === "conflicted") {
    const ajaxObservation = primary.find((observation) => observation.source === "shopify_ajax");
    if (ajaxObservation) {
      const ajaxKey = comparable(ajaxObservation.value);
      const supportingSources = new Set(
        primary
          .filter((observation) => comparable(observation.value) === ajaxKey)
          .map((observation) => observation.source),
      );
      if (supportingSources.size >= 2) {
        return {
          state: "verified",
          value: ajaxObservation.value,
          observations: [...primary, ...fallback],
        };
      }
    }
  }
  return { ...resolved, observations: [...primary, ...fallback] };
}

function comparable(value: unknown): string {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase().replace(/\/$/, "");
  return String(value);
}

function comparableCategory(value: unknown): string {
  return comparable(value).split(" ").map((token) => {
    if (token.endsWith("'s")) return token;
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && /(?:sses|ches|shes|xes|zes)$/.test(token)) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
    return token;
  }).join(" ");
}

function scalarValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function absoluteUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

function productHandle(url: string): string | null {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const index = segments.lastIndexOf("products");
  return index >= 0 ? segments[index + 1] ?? null : null;
}

function brandName(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "name" in value) return (value as { name?: unknown }).name;
  return null;
}

function decimalPrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

function normalizedAvailability(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const token = value.toLowerCase().split("/").pop();
  if (token === "instock" || token === "in_stock") return true;
  if (token === "outofstock" || token === "out_of_stock" || token === "soldout") return false;
  return null;
}

function finding(findings: TechnicalFinding[], code: string, severity: TechnicalFinding["severity"], message: string, evidencePaths: string[]): void {
  findings.push({ code, severity, message, evidence_paths: evidencePaths });
}

function canonicalKey(value: unknown): string {
  try {
    const url = new URL(String(value));
    url.searchParams.delete("variant");
    url.hash = "";
    return url.toString();
  } catch { return comparable(value); }
}

function matchedVariant(node: Record<string, unknown>, input: NormalizeInput): ProductVariant | undefined {
  const variants = input.ajax?.variants ?? [];
  for (const candidate of [node.url, node["@id"]]) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate, input.finalUrl);
      const page = new URL(input.finalUrl);
      if (url.origin !== page.origin || url.pathname !== page.pathname) continue;
      const id = url.searchParams.get("variant");
      if (id) return variants.find((variant) => variant.id === id);
    } catch { /* An invalid identity cannot establish a variant match. */ }
  }
  if (typeof node.sku === "string") {
    const matches = variants.filter((variant) => variant.sku === node.sku);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function variantField(
  original: NormalizedField,
  key: "sku" | "barcode" | "price_minor" | "available",
  input: NormalizeInput,
  observed: (source: SourceKind, path: string, value: unknown) => EvidenceObservation[],
): NormalizedField {
  const unscoped: EvidenceObservation[] = [];
  const groups = new Map<ProductVariant, EvidenceObservation[]>();
  for (const observation of original.observations) {
    const match = /^products\[(\d+)\](?:\.offers\[(\d+)\])?/.exec(observation.path);
    const product = match ? input.html.jsonLdProducts[Number(match[1])] : undefined;
    const offer = product && match?.[2] !== undefined ? jsonLdOffers(product)[Number(match[2])] : undefined;
    const variant = (offer && matchedVariant(offer, input)) || (product && matchedVariant(product, input));
    if (!variant) { unscoped.push(observation); continue; }
    if (!groups.has(variant)) {
      const index = input.ajax!.variants.indexOf(variant);
      groups.set(variant, observed("shopify_ajax", `variants[${index}].${key}`, variant[key]));
    }
    groups.get(variant)!.push(observation);
  }
  if (!groups.size) return original;
  const checks = [...groups.values()].map((items) => field(items));
  // Other variants' barcodes are audit evidence, not competing page identifiers.
  const page = field(unscoped.filter((item) => !(key === "barcode" && /^variants\[[1-9]\d*\]/.test(item.path))));
  const observations = [...unscoped, ...[...groups.values()].flat()];
  if (page.state === "conflicted" || checks.some((item) => item.state === "conflicted")) {
    const conflicts = [...groups.values()].filter((items) => field(items).state === "conflicted").flat();
    return { state: "conflicted", value: null, observations: [...conflicts, ...observations.filter((item) => !conflicts.includes(item))] };
  }
  const baseline = input.ajax!;
  const value = key === "available" ? baseline.available : key === "price_minor" ? baseline.priceMinor
    : baseline.variants[0]?.[key] ?? null;
  return {
    state: value === null ? "incomplete" : checks.every((item) => item.state === "verified") ? "verified" : "single_source",
    value,
    observations,
  };
}

function shopifyImageKey(input: NormalizeInput): (value: unknown) => string {
  const page = new URL(input.finalUrl);
  const images = [input.ajax?.featuredImage, ...(input.ajax?.images ?? [])];
  const storePrefixes = new Set(images.flatMap((image) => {
    if (!image) return [];
    try {
      const url = new URL(image, page);
      const match = /^\/s\/files\/(?:\d+\/)+/.exec(url.pathname);
      return url.hostname === "cdn.shopify.com" && match ? [match[0]] : [];
    } catch { return []; }
  }));
  return (value) => {
    try {
      const url = new URL(String(value), page);
      const prefix = [...storePrefixes].find((prefix) => url.hostname === "cdn.shopify.com" && url.pathname.startsWith(prefix));
      const local = ["http:", "https:"].includes(url.protocol) && url.host === page.host && url.pathname.startsWith("/cdn/shop/");
      if (!prefix && !local) return url.toString();
      const path = prefix ? url.pathname.slice(prefix.length) : url.pathname.slice("/cdn/shop/".length);
      for (const parameter of ["width", "height", "crop", "format"]) url.searchParams.delete(parameter);
      url.searchParams.sort();
      return `shopify:${path}?${url.searchParams.toString()}`;
    } catch { return String(value); }
  };
}
