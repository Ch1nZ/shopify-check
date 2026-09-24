import { describe, expect, it } from "vitest";

import { buildTechnicalCheck } from "../src/robots";
import { normalizeProduct } from "../src/normalize";
import { parseProductHtml, parseShopifyAjax } from "../src/parse";
import {
  PREVIEW_RULE_CATALOG_VERSION,
  evaluatePreviewCapture,
  productRelevance,
} from "../src/preview-rules";
import { publicProductPreview } from "../src/public-preview";

const capturedAt = "2026-09-19T00:00:00.000Z";

describe("preview rule evaluation", () => {
  it("keeps page capture separate from issue rules and versions every finding", () => {
    const collection = collectionFrom({
      html: necklaceHtml(),
      ajax: necklaceAjax(),
    });
    const evaluated = evaluatePreviewCapture(collection);

    expect(collection.record.fields.shipping_details.state).toBe("missing");
    expect(evaluated.findings.find((finding) => finding.code === "SHIPPING_NOT_IN_CAPTURE")?.status).toBe("missing");
    expect(evaluated.findings.every((finding) => finding.definition_version === PREVIEW_RULE_CATALOG_VERSION)).toBe(true);
    expect(evaluated.findings.every((finding) => finding.evidence.length >= 1)).toBe(true);
  });

  it("uses capture-limit language for shipping instead of an unconditional missing failure", () => {
    const preview = publicProductPreview(collectionFrom({
      html: necklaceHtml(),
      ajax: necklaceAjax({ tags: ["handmade", "gift"] }),
    }));
    const shipping = preview.findings.find((finding) => finding.code === "SHIPPING_NOT_IN_CAPTURE");

    expect(shipping?.status).toBe("missing");
    expect(shipping?.message).toBe(
      "Shipping details were not found in product structured data. Visible shipping text and separate policy pages have not been verified.",
    );
    expect(shipping?.evidence[0]?.field).toBe("shipping_details");
    expect(shipping?.evidence[0]?.source).toBe("json_ld");
    expect(shipping?.guidance).toContain("Settings → Shipping and delivery");
  });

  it("does not treat a handmade necklace as needing GTIN or warranty", () => {
    const collection = collectionFrom({
      html: necklaceHtml(),
      ajax: necklaceAjax({ tags: ["handmade"], barcodes: [null, null] }),
    });
    const relevance = productRelevance(collection.record);
    const evaluated = evaluatePreviewCapture(collection);
    const gtin = evaluated.findings.find((finding) => finding.code === "GTIN_NOT_IN_CAPTURE");
    const warranty = evaluated.findings.find((finding) => finding.code === "WARRANTY_NOT_IN_CAPTURE");

    expect(relevance.gtin).toBe(false);
    expect(relevance.warranty).toBe(false);
    expect(gtin?.relevant).toBe(false);
    expect(gtin?.severity).toBe("info");
    expect(gtin?.message).toContain("does not treat a barcode as required");
    expect(warranty?.relevant).toBe(false);
    expect(warranty?.message).toContain("does not treat a warranty as required");
  });

  it("treats a trade-identifier hint without a barcode as a relevant GTIN gap", () => {
    const collection = collectionFrom({
      html: necklaceHtml(),
      ajax: JSON.stringify({
        ...JSON.parse(necklaceAjax({ barcodes: [null, null], tags: [] })),
        description: "Retail ISBN edition of the necklace",
      }),
    });
    const evaluated = evaluatePreviewCapture(collection);
    const gtin = evaluated.findings.find((finding) => finding.code === "GTIN_NOT_IN_CAPTURE");

    expect(productRelevance(collection.record).gtin).toBe(true);
    expect(gtin?.relevant).toBe(true);
    expect(gtin?.severity).toBe("warning");
    expect(gtin?.guidance).toContain("Variants → Barcode");
  });

  it("treats warranty as relevant for electronics and points at description or JSON-LD", () => {
    const collection = collectionFrom({
      html: `<!doctype html><html><head>
        <link rel="canonical" href="https://shop.example/products/noise-cancelling-headphones">
        <title>Studio headphones</title>
        <script type="application/ld+json">${JSON.stringify({
          "@type": "Product",
          name: "Studio headphones",
          category: "Electronics",
          offers: { "@type": "Offer", price: "129.00", priceCurrency: "USD" },
        })}</script>
      </head><body><h1>Studio headphones</h1></body></html>`,
      ajax: JSON.stringify({
        id: 9,
        handle: "studio-headphones",
        title: "Studio headphones",
        vendor: "Example Brand Audio",
        type: "Headphones",
        description: "Wireless studio headphones",
        available: true,
        price: 12900,
        variants: [{ id: 1, title: "Black", sku: "HP-1", barcode: null, price: 12900, available: true, options: ["Black"] }],
      }),
    });
    const warranty = evaluatePreviewCapture(collection).findings.find((finding) => finding.code === "WARRANTY_NOT_IN_CAPTURE");

    expect(productRelevance(collection.record).warranty).toBe(true);
    expect(warranty?.relevant).toBe(true);
    expect(warranty?.severity).toBe("warning");
    expect(warranty?.guidance).toContain("no dedicated warranty field");
  });

  it("marks robots and Ajax failures unavailable instead of missing merchant fields", () => {
    const preview = publicProductPreview(collectionFrom({
      html: necklaceHtml(),
      ajax: null,
      ajaxError: "Shopify Ajax product JSON returned HTTP 404.",
      robotsStatus: 404,
    }));

    expect(preview.findings.find((finding) => finding.code === "ROBOTS_UNAVAILABLE")?.status).toBe("unavailable");
    expect(preview.findings.find((finding) => finding.code === "AJAX_PRODUCT_UNAVAILABLE")?.status).toBe("unavailable");
    expect(preview.presence.find((item) => item.key === "sku")?.state).toBe("unavailable");
    expect(preview.presence.find((item) => item.key === "gtin")?.state).toBe("unavailable");
    expect(preview.findings.find((finding) => finding.code === "AJAX_PRODUCT_UNAVAILABLE")?.message).toContain(
      "incomplete instead of missing",
    );
  });

  it("marks JSON-LD-only commerce fields unavailable when those blocks cannot be parsed", () => {
    const collection = collectionFrom({
      html: `<!doctype html><html><head>
        <link rel="canonical" href="https://shop.example/products/example-pendant">
        <title>Example Pendant Necklace</title>
        <script type="application/ld+json">{"@type":"Product",</script>
      </head><body><h1>Example Pendant Necklace</h1></body></html>`,
      ajax: necklaceAjax({ tags: ["handmade"] }),
    });
    const shipping = evaluatePreviewCapture(collection).presence.find((item) => item.key === "shipping");

    expect(collection.record.technical_findings.some((finding) => finding.code === "MALFORMED_JSON_LD")).toBe(true);
    expect(shipping?.state).toBe("unavailable");
  });
});

function collectionFrom(input: {
  html: string;
  ajax: string | null;
  ajaxError?: string;
  robotsStatus?: number;
}) {
  const record = normalizeProduct({
    requestedUrl: "https://shop.example/products/example-pendant",
    finalUrl: "https://shop.example/products/example-pendant",
    capturedAt,
    html: parseProductHtml(input.html),
    ajax: input.ajax ? parseShopifyAjax(input.ajax) : null,
    ...(input.ajaxError ? { ajaxError: input.ajaxError } : {}),
  });
  return {
    record,
    technicalCheck: buildTechnicalCheck({
      productUrl: record.final_url,
      capturedAt,
      html: parseProductHtml(input.html),
      htmlSnapshot: {
        kind: "html",
        requested_url: record.final_url,
        final_url: record.final_url,
        status: 200,
        content_type: "text/html",
        captured_at: capturedAt,
        headers: {},
        body: input.html,
      },
      robotsSnapshot: {
        kind: "robots",
        requested_url: "https://shop.example/robots.txt",
        final_url: "https://shop.example/robots.txt",
        status: input.robotsStatus ?? 200,
        content_type: "text/plain",
        captured_at: capturedAt,
        headers: {},
        body: input.robotsStatus === 404 ? "" : "User-agent: *\nAllow: /",
      },
    }),
    snapshots: [],
  };
}

function necklaceHtml(): string {
  return `<!doctype html><html><head>
    <link rel="canonical" href="https://shop.example/products/example-pendant">
    <title>Example Pendant Necklace</title>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Example Pendant Necklace",
      category: "Necklace",
      brand: { "@type": "Brand", name: "Example Brand" },
      offers: { "@type": "Offer", price: "19.99", priceCurrency: "USD" },
    })}</script>
  </head><body><h1>Example Pendant Necklace</h1></body></html>`;
}

function necklaceAjax(options: { tags?: string[]; barcodes?: Array<string | null> } = {}): string {
  const barcodes = options.barcodes ?? [null, null];
  return JSON.stringify({
    id: 42,
    handle: "example-pendant",
    title: "Example Pendant Necklace",
    vendor: "Example Brand",
    type: "Necklace",
    description: "Handmade silver necklace",
    available: true,
    price: 1999,
    tags: options.tags ?? ["handmade"],
    variants: [
      { id: 1, title: "Silver", sku: "NS-S", barcode: barcodes[0], price: 1999, available: true, options: ["Silver"] },
      { id: 2, title: "Gold", sku: "NS-G", barcode: barcodes[1], price: 2199, available: false, options: ["Gold"] },
    ],
  });
}
