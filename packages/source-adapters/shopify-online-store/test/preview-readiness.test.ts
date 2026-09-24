import { describe, expect, it } from "vitest";

import { PREVIEW_RULE_CATALOG_VERSION } from "../src/preview-rules";
import type { PublicPreviewPresence, PublicProductPreview } from "../src/public-preview";
import { previewReadiness, previewRecheckDiff, previewSnapshot } from "../src/preview-readiness";

const capturedAt = "2026-09-18T00:00:00.000Z";

describe("preview readiness", () => {
  it("counts observed checks looking good without inventing a rank", () => {
    const readiness = previewReadiness(previewFixture());

    expect(readiness.ready).toBe(readiness.total);
    expect(readiness.total).toBeGreaterThan(10);
    expect(readiness.rule_catalog_version).toBe(PREVIEW_RULE_CATALOG_VERSION);
    expect(readiness.fixes).toEqual([]);
    expect(readiness.checks.every((check) => check.outcome === "pass")).toBe(true);
    expect(readiness.checks.every((check) => check.definition_id && check.definition_version === PREVIEW_RULE_CATALOG_VERSION)).toBe(true);
    expect(JSON.stringify(readiness)).not.toMatch(/gemini|luna|openrouter|observer|geo rank|ranking score/i);
  });

  it("distinguishes conflicting data from missing data in Shopify actions", () => {
    const result = previewReadiness(previewFixture({ presence: [
      tile("image", "Image", "conflicting"),
      tile("sku", "SKU", "missing"),
    ] }));
    expect(result.fixes.find((fix) => fix.id === "presence:image")?.title).toContain("conflicting");
    expect(result.fixes.find((fix) => fix.id === "presence:image")?.detail).toContain("valid variant differences");
    expect(result.fixes.find((fix) => fix.id === "presence:sku")?.title).toBe("Add a SKU");
  });

  it("does not recommend fixes merely because multiple Product nodes exist", () => {
    const result = previewReadiness(previewFixture({ findings: [
      finding("MULTIPLE_PRODUCT_JSON_LD", "warning", "present", "Multiple Product nodes were retained."),
    ] }));
    const fix = result.fixes.find((fix) => fix.id.includes("MULTIPLE_PRODUCT_JSON_LD"));
    expect(fix).toBeUndefined();
  });

  it("ranks free fixes from existing findings and missing presence only", () => {
    const readiness = previewReadiness(previewFixture({
      status: "partial",
      fields: {
        title: { state: "missing", value: null },
        category: { state: "missing", value: null },
        price: { state: "missing", value: null },
        currency: { state: "missing", value: null },
        availability: { state: "missing", value: null },
      },
      presence: [
        tile("brand", "Brand", "missing"),
        tile("sku", "SKU", "missing"),
        tile("gtin", "GTIN", "missing", { relevant: false }),
        tile("image", "Image", "missing"),
        tile("shipping", "Shipping", "missing"),
        tile("returns", "Returns", "missing"),
        tile("warranty", "Warranty", "missing", { relevant: false }),
        tile("json_ld_product", "JSON-LD Product", "missing"),
        tile("json_ld_offer", "JSON-LD Offer", "missing"),
      ],
      crawler_access: [
        { agent: "*", purpose: "general_crawl", result: "blocked", matched_user_agent: "*", matched_rule: "disallow: /products/" },
        { agent: "OAI-SearchBot", purpose: "openai_search", result: "blocked", matched_user_agent: "oai-searchbot", matched_rule: "disallow: /products/" },
        { agent: "GPTBot", purpose: "openai_training", result: "unknown", matched_user_agent: null, matched_rule: null },
      ],
      findings: [
        finding("PAGE_NOINDEX", "error", "present", "The product page declares noindex/none in page-level robots directives."),
        finding("CRAWLER_BLOCKED", "error", "present", "OAI-SearchBot is blocked from the captured product path by robots.txt."),
        finding("ROBOTS_UNAVAILABLE", "warning", "unavailable", "robots.txt returned HTTP 404. This preview could not verify crawler rules; that is a failed read, not proof the storefront blocks crawlers."),
      ],
      finding_counts: { error: 2, warning: 1, info: 0 },
    }));

    expect(readiness.ready).toBeLessThan(readiness.total);
    expect(readiness.checks.find((check) => check.id === "indexable")?.outcome).toBe("fail");
    expect(readiness.checks.find((check) => check.id === "presence:brand")?.outcome).toBe("fail");
    expect(readiness.checks.find((check) => check.id === "presence:shipping")?.outcome).toBe("warn");
    expect(readiness.checks.find((check) => check.id === "presence:gtin")?.outcome).toBe("pass");
    expect(readiness.checks.find((check) => check.id === "presence:warranty")?.outcome).toBe("pass");
    expect(readiness.fixes).toHaveLength(5);
    expect(readiness.fixes.map((fix) => fix.id)).toEqual([
      "indexable",
      "core-fields",
      "presence:json_ld_product",
      "presence:json_ld_offer",
      "presence:brand",
    ]);
    expect(readiness.fixes.some((fix) => /robots\.txt/i.test(fix.title))).toBe(false);
    expect(readiness.fixes.map((fix) => `${fix.title} ${fix.detail}`).join("\n")).not.toMatch(/self-check/i);
    expect(readiness.fixes.some((fix) => /warranty|shipping|returns|gtin|barcode/i.test(`${fix.title} ${fix.detail}`))).toBe(false);
    expect(readiness.fixes[0]?.detail).toContain("Themes");
  });

  it("does not invent GTIN or warranty fixes when those fields are not relevant", () => {
    const readiness = previewReadiness(previewFixture({
      presence: previewFixture().presence.map((item) => (
        item.key === "warranty" || item.key === "shipping" || item.key === "returns" || item.key === "gtin"
          ? { ...item, state: "missing" as const, sources: [], relevant: item.key === "shipping" || item.key === "returns" }
          : item
      )),
      findings: [
        finding("SHIPPING_NOT_IN_CAPTURE", "warning", "missing", "Shipping information wasn’t found in the captured product data. If it exists on a separate shipping-policy page, this preview has not verified it."),
        finding("RETURNS_NOT_IN_CAPTURE", "warning", "missing", "A return policy wasn’t found in the captured product data. If it lives on a separate refund-policy page, this preview has not verified it."),
        finding("WARRANTY_NOT_IN_CAPTURE", "info", "missing", "Warranty details weren’t found in the captured product data. This preview does not treat a warranty as required for this product."),
        finding("GTIN_NOT_IN_CAPTURE", "info", "missing", "No GTIN/barcode was found in the captured product data. This preview does not treat a barcode as required for this product."),
      ],
      finding_counts: { error: 0, warning: 2, info: 2 },
    }));

    expect(readiness.fixes).toEqual([]);
    expect(readiness.checks.find((check) => check.id === "presence:brand")?.outcome).toBe("pass");
    expect(readiness.checks.find((check) => check.id === "presence:shipping")?.detail).toContain("Visible text and policy pages are not verified");
    expect(readiness.checks.find((check) => check.id === "presence:gtin")?.outcome).toBe("pass");
    expect(readiness.checks.find((check) => check.id === "presence:warranty")?.outcome).toBe("pass");
  });

  it("ranks a warranty or GTIN fix only when the product makes that field relevant", () => {
    const readiness = previewReadiness(previewFixture({
      presence: previewFixture().presence.map((item) => (
        item.key === "warranty" || item.key === "gtin"
          ? { ...item, state: "missing" as const, sources: [], relevant: true }
          : item
      )),
    }));

    expect(readiness.fixes.map((fix) => fix.id)).toEqual(["presence:gtin", "presence:warranty"]);
    expect(readiness.fixes.find((fix) => fix.id === "presence:gtin")?.detail).toContain("Variants → Barcode");
    expect(readiness.fixes.find((fix) => fix.id === "presence:warranty")?.detail).toContain("no dedicated warranty field");
  });

  it("treats an unavailable presence tile as a failed read, not a merchant defect to fix", () => {
    const readiness = previewReadiness(previewFixture({
      presence: previewFixture().presence.map((item) => (
        item.key === "brand" || item.key === "shipping"
          ? { ...item, state: "unavailable" as const, sources: [], relevant: true }
          : item
      )),
      findings: [
        finding("AJAX_PRODUCT_UNAVAILABLE", "warning", "unavailable", "Shopify Ajax product JSON was unavailable. Fields that come from Shopify Ajax were marked incomplete instead of missing."),
      ],
      finding_counts: { error: 0, warning: 1, info: 0 },
    }));

    expect(readiness.checks.find((check) => check.id === "presence:brand")?.outcome).toBe("warn");
    expect(readiness.checks.find((check) => check.id === "presence:shipping")?.detail).toContain("not a missing catalog field");
    expect(readiness.fixes.map((fix) => fix.id)).toEqual(["finding:AJAX_PRODUCT_UNAVAILABLE"]);
    expect(readiness.fixes[0]?.detail).toContain("/products/{handle}.js");
  });

  it("diffs the same product URL against the last snapshot", () => {
    const before = previewReadiness(previewFixture({
      presence: previewFixture().presence.map((item) => (
        item.key === "brand" || item.key === "gtin"
          ? { ...item, state: "missing" as const, sources: [], relevant: item.key === "brand" }
          : item
      )),
      findings: [
        finding("PAGE_NOINDEX", "error", "present", "The product page declares noindex/none in page-level robots directives."),
      ],
      finding_counts: { error: 1, warning: 0, info: 0 },
    }));
    const after = previewReadiness(previewFixture({
      presence: previewFixture().presence.map((item) => (
        item.key === "gtin" ? { ...item, state: "missing" as const, sources: [], relevant: false } : item
      )),
    }));

    const diff = previewRecheckDiff(previewSnapshot(before), after);
    expect(diff).not.toBeNull();
    expect(diff?.improved.map((item) => item.id)).toEqual(expect.arrayContaining(["indexable", "presence:brand"]));
    expect(diff?.still_open.map((item) => item.id)).not.toContain("presence:gtin");
    expect(diff?.regressed).toEqual([]);
    expect(diff?.ready_delta).toBeGreaterThan(0);
    expect(diff?.skipped_definition_changes).toEqual([]);
    expect(previewRecheckDiff(previewSnapshot(before), previewReadiness(previewFixture({
      product_url: "https://other.example/products/other",
    })))).toBeNull();
  });

  it("does not treat a check-definition version change as a product-page change", () => {
    const current = previewReadiness(previewFixture({
      presence: previewFixture().presence.map((item) => (
        item.key === "shipping" ? { ...item, state: "missing" as const, sources: [] } : item
      )),
    }));
    const previous = previewSnapshot(current);
    previous.checks = previous.checks.map((item) => (
      item.id === "presence:shipping" ? { ...item, outcome: "fail" as const, definition_version: "2026-09-01.0" } : item
    ));

    const diff = previewRecheckDiff(previous, current);
    expect(diff?.improved.map((item) => item.id)).not.toContain("presence:shipping");
    expect(diff?.regressed.map((item) => item.id)).not.toContain("presence:shipping");
    expect(diff?.skipped_definition_changes.map((item) => item.id)).toContain("presence:shipping");
  });

  it("keeps leftover finding check ids stable when the message changes", () => {
    const first = previewReadiness(previewFixture({
      findings: [finding("FIELD_CONFLICT", "warning", "conflicting", "Sources disagree on currency.", "finding:FIELD_CONFLICT:currency")],
      finding_counts: { error: 0, warning: 1, info: 0 },
    }));
    const second = previewReadiness(previewFixture({
      findings: [finding("FIELD_CONFLICT", "warning", "conflicting", "Sources disagree on currency after a copy tweak.", "finding:FIELD_CONFLICT:currency")],
      finding_counts: { error: 0, warning: 1, info: 0 },
    }));

    expect(first.checks.find((check) => check.id === "field:currency")).toBeDefined();
    const diff = previewRecheckDiff(previewSnapshot(first), second);
    expect(diff?.still_open.map((item) => item.id)).toContain("field:currency");
    expect(diff?.improved).toEqual([]);
    expect(diff?.regressed).toEqual([]);
  });
});

function previewFixture(overrides: Partial<PublicProductPreview> = {}): PublicProductPreview {
  return {
    status: "complete",
    product_url: "https://shop.example/products/example-pendant",
    captured_at: capturedAt,
    rule_catalog_version: PREVIEW_RULE_CATALOG_VERSION,
    fields: {
      title: { state: "verified", value: "Example Pendant Necklace" },
      category: { state: "single_source", value: "Necklace" },
      price: { state: "verified", value: 1999 },
      currency: { state: "verified", value: "USD" },
      availability: { state: "verified", value: true },
    },
    presence: [
      tile("brand", "Brand", "present", { sources: ["shopify_ajax"] }),
      tile("sku", "SKU", "present", { sources: ["shopify_ajax"] }),
      tile("gtin", "GTIN", "present", { sources: ["shopify_ajax"], relevant: false }),
      tile("image", "Image", "present", { sources: ["json_ld"] }),
      tile("shipping", "Shipping", "present", { sources: ["json_ld"] }),
      tile("returns", "Returns", "present", { sources: ["json_ld"] }),
      tile("warranty", "Warranty", "present", { sources: ["json_ld"], relevant: false }),
      tile("json_ld_product", "JSON-LD Product", "present", { sources: ["json_ld"] }),
      tile("json_ld_offer", "JSON-LD Offer", "present", { sources: ["json_ld"] }),
    ],
    crawler_access: [
      { agent: "*", purpose: "general_crawl", result: "allowed", matched_user_agent: "*", matched_rule: null },
      { agent: "OAI-SearchBot", purpose: "openai_search", result: "allowed", matched_user_agent: "oai-searchbot", matched_rule: null },
      { agent: "GPTBot", purpose: "openai_training", result: "allowed", matched_user_agent: "gptbot", matched_rule: null },
    ],
    findings: [],
    finding_counts: { error: 0, warning: 0, info: 0 },
    note: "This free preview checks observable product data only. It does not run the controlled AI shopping test.",
    ...overrides,
  };
}

function tile(
  key: string,
  label: string,
  state: PublicPreviewPresence["state"],
  extras: Partial<PublicPreviewPresence> = {},
): PublicPreviewPresence {
  return {
    key,
    label,
    state,
    field: extras.field ?? key,
    sources: extras.sources ?? [],
    relevant: extras.relevant ?? true,
  };
}

function finding(
  code: string,
  severity: "info" | "warning" | "error",
  status: PublicProductPreview["findings"][number]["status"],
  message: string,
  definitionId = `finding:${code}`,
): PublicProductPreview["findings"][number] {
  return {
    code,
    definition_id: definitionId,
    definition_version: PREVIEW_RULE_CATALOG_VERSION,
    severity,
    status,
    message,
    evidence: [{ field: code.toLowerCase(), source: "json_ld", path: code }],
    guidance: "Shopify admin → Products → this product.",
    relevant: true,
  };
}
