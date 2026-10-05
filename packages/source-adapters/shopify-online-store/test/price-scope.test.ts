import { describe, expect, it } from "vitest";
import { collectShopifyProduct, normalizeProduct, parseProductHtml, parseShopifyAjax, publicProductPreview, previewReadiness, previewSnapshot, previewRecheckDiff } from "../src/index";
import type { TechnicalCheck, FetchLike } from "../src/index";

const url = "https://shop.example/products/bag";
const capturedAt = "2026-10-05T00:00:00Z";
const variants = [
  { id: 101, title: "Crossbody strap + Wrist strap", price: 47000, available: true, sku: null },
  { id: 102, title: "Wrist strap", price: 42000, available: false, sku: null },
];
const ajax = JSON.stringify({ id: 1, handle: "bag", title: "Handmade bag", vendor: "Example", type: "Bag", price: 42000, variants });
function html(options: { currency?: string | null; offerCurrency?: string; secondCurrency?: string; wrongPrice?: boolean; duplicate?: boolean } = {}) {
  const currency = options.currency === undefined ? "AUD" : options.currency;
  const offers = variants.map((variant) => ({ "@type": "Offer", url: `${url}?variant=${variant.id}`, price: options.wrongPrice && variant.id === 101 ? 420 : variant.price / 100,
    priceCurrency: variant.id === 102 && options.secondCurrency ? options.secondCurrency : options.offerCurrency ?? "AUD", availability: `https://schema.org/${variant.available ? "InStock" : "OutOfStock"}` }));
  if (options.duplicate) offers.push({ ...offers[0]!, price: 420 });
  return `<h1>Handmade bag</h1><link rel="canonical" href="${url}">${currency ? `<script>Shopify.currency = ${JSON.stringify({ active: currency })};</script>` : ""}<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Handmade bag", offers })}</script>`;
}
function fixture(query = "", options: Parameters<typeof html>[0] = {}) {
  const record = normalizeProduct({ requestedUrl: url + query, finalUrl: url + query, capturedAt, html: parseProductHtml(html(options)), ajax: parseShopifyAjax(ajax) });
  const technicalCheck: TechnicalCheck = { schema_version: "technical-check/1.0", product_url: url + query, captured_at: capturedAt, status: "complete", page_directives: { meta_robots: [], x_robots_tag: [] }, robots_url: "https://shop.example/robots.txt", robots_http_status: 200, crawler_access: [], findings: [] };
  const preview = publicProductPreview({ record, technicalCheck, snapshots: [] });
  return { record, preview, readiness: previewReadiness(preview) };
}

describe("price scope and currency evidence", () => {
  it.each([[101, 47000, true, "Crossbody strap + Wrist strap"], [102, 42000, false, "Wrist strap"]] as const)("shows variant %s price, name and availability", (id, price, available, title) => {
    const { record, preview } = fixture(`?variant=${id}`);
    expect(record.fields.price).toMatchObject({ state: "verified", value: price });
    expect(record.fields.availability.value).toBe(available);
    expect(preview.price_context).toMatchObject({ scope: "variant", variant_id: String(id), variant_title: title, currency: "AUD" });
    expect(preview.product_url).toContain(`variant=${id}`);
    expect(record.fields.price.observations.some((item) => item.path.includes(`variants[${id === 101 ? 0 : 1}]`))).toBe(true);
  });
  it("shows a named product minimum and captured range without comparing sibling prices", () => {
    const { record, preview } = fixture();
    expect(record.fields.price).toMatchObject({ value: 42000, state: "verified" });
    expect(preview.price_context).toMatchObject({ scope: "product_minimum", minimum_minor: 42000, maximum_minor: 47000 });
  });
  it("does not replace an unknown selection with the cheaper product minimum", () => {
    const { record, readiness } = fixture("?variant=999");
    expect(record.fields.price).toMatchObject({ state: "incomplete", value: null });
    expect(record.fields.availability.value).toBeNull();
    expect(readiness.checks.find((item) => item.id === "field:price")?.outcome).toBe("warn");
  });
  it("exposes currency disagreement and never verifies equal numbers in different currencies", () => {
    const { record } = fixture("?variant=101", { offerCurrency: "USD" });
    expect(record.fields.currency.state).toBe("conflicted");
    expect(record.fields.price).toMatchObject({ value: 47000, state: "single_source" });
    expect(record.price_context?.currency).toBeNull();
  });
  it("does not mix sibling currencies into a selected variant", () => {
    const { record } = fixture("?variant=101", { secondCurrency: "USD" });
    expect(record.fields.currency.value).toBe("AUD");
    expect(record.fields.price.state).toBe("verified");
    expect(fixture("", { secondCurrency: "USD" }).record.fields.currency.state).toBe("conflicted");
  });
  it("retains genuine mismatches for the same variant and currency", () => {
    expect(fixture("?variant=101", { wrongPrice: true }).record.fields.price.state).toBe("conflicted");
    expect(fixture("?variant=101", { duplicate: true }).record.fields.price.state).toBe("conflicted");
    expect(fixture("?variant=101", { duplicate: true, currency: null }).record.fields.price.state).toBe("conflicted");
  });
  it("does not infer currency from a dollar symbol or Ajax money integers", () => {
    const record = normalizeProduct({ requestedUrl: url, finalUrl: url, capturedAt, html: parseProductHtml('<h1>Bag $470</h1>'), ajax: parseShopifyAjax(ajax) });
    expect(record.fields.currency).toMatchObject({ state: "missing", value: null });
    expect(record.fields.price.state).toBe("single_source");
    expect(fixture("?variant=101", { currency: null }).record.fields.price.state).toBe("single_source");
  });
  it("reports missing SKU and optional notes consistently with checks and fixes", () => {
    const { preview, readiness } = fixture("?variant=101");
    expect(preview.findings.find((item) => item.definition_id === "presence:sku")).toMatchObject({ status: "missing", severity: "error", relevant: true });
    expect(readiness.checks.find((item) => item.id === "presence:sku")?.outcome).toBe("fail");
    expect(readiness.fixes.find((item) => item.id === "presence:sku")?.title).toBe("Add a SKU");
    for (const key of ["gtin", "warranty"]) {
      expect(preview.findings.find((item) => item.definition_id === `presence:${key}`)).toMatchObject({ severity: "info", relevant: false });
      expect(readiness.checks.find((item) => item.id === `presence:${key}`)?.outcome).toBe("pass");
      expect(readiness.fixes.some((item) => item.id === `presence:${key}`)).toBe(false);
    }
    expect(preview.finding_counts.error).toBe(preview.findings.filter((item) => item.severity === "error").length);
    expect(preview.finding_counts.warning).toBe(preview.findings.filter((item) => item.severity === "warning").length);
    expect(new Set(readiness.checks.map((item) => item.id)).size).toBe(readiness.checks.length);
    expect(preview.note).toContain("does not run the controlled AI shopping test");
    const snapshot = previewSnapshot(readiness);
    expect(previewRecheckDiff(snapshot, fixture("?variant=102").readiness)).toBeNull();
  });
  it.each([true, false])("preserves submitted and resolved variants through redirects (destination selection=%s)", async (hasSelection) => {
    const requested = "https://shop.example/products/old-bag?variant=101";
    const fetcher: FetchLike = async (input) => {
      const target = String(input);
      if (target === requested) return new Response(null, { status: 301, headers: { location: url + (hasSelection ? "?variant=102" : "") } });
      if (target.includes(".js")) return new Response(ajax, { headers: { "content-type": "application/json" } });
      if (target.includes("robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
      return new Response(html(), { headers: { "content-type": "text/html" } });
    };
    const preview = publicProductPreview(await collectShopifyProduct(requested, { fetcher, capturedAt }));
    expect(preview.requested_url).toBe(requested);
    expect(preview.product_url).toBe(url + `?variant=${hasSelection ? 102 : 101}`);
    expect(preview.fields.price.value).toBe(hasSelection ? 42000 : 47000);
  });
});
