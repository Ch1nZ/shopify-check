import { describe, expect, it } from "vitest";
import { normalizeProduct, parseProductHtml, parseShopifyAjax, publicProductPreview } from "../src/index";
import { previewReadiness } from "../src/preview-readiness";
import type { TechnicalCheck } from "../src/types";

const url = "https://shop.example/products/cushion";
const capturedAt = "2026-09-20T10:00:00Z";
const image = "//cdn.shopify.com/s/files/1/0014/3514/0183/files/cushion.jpg?v=1";
const variants = Array.from({ length: 12 }, (_, i) => ({
  id: String(100 + i), title: `Shade ${i + 1}`, sku: `SKU-${i}`, barcode: `89091060805${i}`,
  available: i < 4, price: 84900 + i * 100,
}));
function fixture(mutate: (products: Record<string, any>[]) => void = () => {}) {
  const products: Record<string, any>[] = variants.map((variant) => ({
    "@type": "Product", url: `${url}?variant=${variant.id}`, name: "Cushion foundation",
    sku: variant.sku, gtin: variant.barcode,
    image: `${url.split('/products')[0]}/cdn/shop/files/cushion.jpg?v=1&width=1200`,
    offers: { "@type": "Offer", url: `${url}?variant=${variant.id}`, price: variant.price / 100,
      priceCurrency: "INR", availability: `https://schema.org/${variant.available ? "InStock" : "OutOfStock"}` },
  }));
  mutate(products);
  const html = parseProductHtml(`<script>Shopify.currency = {"active":"INR"};</script><link rel="canonical" href="${url}"><h1>Cushion foundation</h1><script type="application/ld+json">${JSON.stringify({ "@type": "ProductGroup", hasVariant: products })}</script>`);
  const ajax = parseShopifyAjax(JSON.stringify({ id: 42, handle: "cushion", title: "Cushion foundation", type: "Face", vendor: "Brand", available: true, price: 84900, featured_image: image, images: [image], variants }));
  const record = normalizeProduct({ requestedUrl: url, finalUrl: url, capturedAt, html, ajax });
  const technicalCheck: TechnicalCheck = { schema_version: "technical-check/1.0", product_url: url,
    captured_at: capturedAt, status: "complete", page_directives: { meta_robots: [], x_robots_tag: [] },
    robots_url: "https://shop.example/robots.txt", robots_http_status: 200, crawler_access: [], findings: [] };
  const preview = publicProductPreview({ record, technicalCheck, snapshots: [] });
  return { record, preview, readiness: previewReadiness(preview) };
}

describe("variant-aware free preview", () => {
  it("accepts twelve identified variants with different prices, SKUs, barcodes and stock", () => {
    const { record, preview, readiness } = fixture();
    for (const key of ["sku", "barcode", "price", "availability", "image", "canonical_url"] as const) {
      expect(record.fields[key].state, key).toBe("verified");
    }
    expect(record.fields.availability.value).toBe(true);
    expect(record.technical_findings).toEqual([]);
    expect(preview.variant_summary).toEqual({ total: 12, with_sku: 12, available: 4, unknown_availability: 0 });
    expect(readiness.fixes).toEqual([]);
  });

  it.each(["sku", "price", "availability", "barcode"] as const)("retains a real %s mismatch within the same variant", (key) => {
    const { record, preview, readiness } = fixture((products) => {
      const product = products[10]!;
      if (key === "sku") product.sku = "WRONG-SKU";
      if (key === "barcode") product.gtin = "WRONG-BARCODE";
      if (key === "price") product.offers.price = 1;
      if (key === "availability") product.offers.availability = "https://schema.org/InStock";
    });
    expect(record.fields[key].state).toBe("conflicted");
    expect(preview.findings.some((finding) => finding.definition_id === `finding:FIELD_CONFLICT:${key}`)).toBe(true);
    expect(readiness.checks.filter((check) => check.id === `finding:FIELD_CONFLICT:${key}`)).toHaveLength(0);
    expect(readiness.fixes).toHaveLength(1);
    expect(readiness.fixes[0]?.detail).toContain("variants[10]");
  });

  it("recognizes the storefront HTTP image URL as the same Shopify asset", () => {
    const { record } = fixture((products) => { products[0]!.image = "http://shop.example/cdn/shop/files/cushion.jpg?v=1"; });
    expect(record.fields.image.state).toBe("verified");
  });

  it("does not equate a different image, another store's CDN path, or a changed asset version", () => {
    for (const replacement of [
      "https://shop.example/cdn/shop/files/other.jpg?v=1",
      "https://cdn.shopify.com/s/files/1/9999/9999/9999/files/cushion.jpg?v=1",
      "https://shop.example/cdn/shop/files/cushion.jpg?v=2",
    ]) {
      const { record } = fixture((products) => { products[0]!.image = replacement; });
      expect(record.fields.image.state).toBe("conflicted");
    }
  });

  it("preserves conflicting duplicate offers for the same variant", () => {
    const { record } = fixture((products) => {
      const duplicate = structuredClone(products[0]!);
      duplicate.offers.price = 100;
      products.push(duplicate);
    });
    expect(record.fields.price.state).toBe("conflicted");
  });
});
