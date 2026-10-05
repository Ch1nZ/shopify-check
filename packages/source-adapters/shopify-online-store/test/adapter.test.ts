import { describe, expect, it } from "vitest";

import {
  CollectionError,
  buildTechnicalCheck,
  collectShopifyProduct,
  evaluateAgent,
  normalizeProduct,
  parseProductHtml,
  parseShopifyAjax,
  productProfile,
  publicProductPreview,
  shopifyAjaxUrl,
  validatePublicProductUrl,
  type FetchLike,
} from "../src/index";

const capturedAt = "2026-09-02T00:00:00.000Z";

describe("Shopify URL safety", () => {
  it.each([
    "http://shop.example/products/item",
    "https://localhost/products/item",
    "https://127.0.0.1/products/item",
    "https://[::1]/products/item",
    "https://user:pass@shop.example/products/item",
    "https://shop.example/collections/all",
  ])("rejects unsafe or unsupported URL %s", (url) => {
    expect(() => validatePublicProductUrl(url)).toThrow(CollectionError);
  });

  it.each([
    "https://shop.example/products/item",
    "https://shop.example/products/item/",
    "https://shop.example/en-us/products/item?variant=123",
    "https://store.example/products/example-shoes",
  ])("accepts a valid Shopify product path %s", (url) => {
    expect(validatePublicProductUrl(url)).toBeInstanceOf(URL);
  });

  it("preserves locale paths for the Ajax endpoint", () => {
    expect(shopifyAjaxUrl(new URL("https://shop.example/en-gb/products/item?variant=2")).toString()).toBe(
      "https://shop.example/en-gb/products/item.js",
    );
  });
});

describe("deterministic parsing and normalization", () => {
  it("retains every Product node, reports malformed JSON-LD, and strips hidden text", () => {
    const html = fixtureHtml({ duplicateProduct: true, malformedJsonLd: true });
    const parsed = parseProductHtml(html);

    expect(parsed.jsonLdProducts).toHaveLength(2);
    expect(parsed.jsonLdParseErrors).toBe(1);
    expect(parsed.visibleText).toContain("Example Pendant Necklace");
    expect(parsed.visibleText).not.toContain("ignore this script");
  });

  it("finds Product nodes nested outside @graph without treating a script mention as a challenge", () => {
    const nested = parseProductHtml(`
      <html><head>
        <script>window.captchaConfiguration = {};</script>
        <script type="application/ld+json">{"@context":"https://schema.org","mainEntity":{"@type":"Product","name":"Nested Product"}}</script>
      </head><body><h1>Nested Product</h1></body></html>
    `);
    expect(nested.jsonLdProducts).toHaveLength(1);
    expect(nested.challengePage).toBe(false);
  });

  it("keeps variant, sale, and out-of-stock facts from Shopify Ajax JSON", () => {
    const ajax = parseShopifyAjax(
      JSON.stringify({
        id: 42,
        handle: "example-pendant",
        title: "Example Pendant Necklace",
        vendor: "Example Brand",
        type: "Necklace",
        description: "<p>Silver necklace</p>",
        available: true,
        price: 1999,
        compare_at_price: 2499,
        variants: [
          { id: 1, title: "Silver", sku: "NS-S", barcode: "111", price: 1999, compare_at_price: 2499, available: true, options: ["Silver"] },
          { id: 2, title: "Gold", sku: "NS-G", barcode: "222", price: 2199, compare_at_price: 2699, available: false, options: ["Gold"] },
        ],
      }),
    );

    expect(ajax.priceMinor).toBe(1999);
    expect(ajax.compareAtPriceMinor).toBe(2499);
    expect(ajax.variants[1]).toMatchObject({ sku: "NS-G", available: false });
    expect(ajax.featuredImage).toBeNull();
    expect(ajax.images).toEqual([]);
    expect(ajax.tags).toEqual([]);
  });

  it("marks agreeing evidence verified and conflicting currency/SKU evidence explicitly", () => {
    const html = parseProductHtml(fixtureHtml({ currency: "EUR", jsonCurrency: "GBP", duplicateProduct: true }));
    const ajax = parseShopifyAjax(fixtureAjax());
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant",
      finalUrl: "https://shop.example/en/products/example-pendant",
      capturedAt,
      html,
      ajax,
    });

    expect(record.fields.title.state).toBe("verified");
    expect(record.fields.price).toMatchObject({ state: "single_source", value: 1999 });
    expect(record.fields.currency.state).toBe("conflicted");
    expect(record.technical_findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["FIELD_CONFLICT"]),
    );
  });

  it("does not treat a merchandising title or category plural as a product-data conflict", () => {
    const html = parseProductHtml(fixtureHtml({
      seoTitle: "Example Pendant Aromatherapy Necklace (925 Silver) | EXAMPLE BRAND",
      jsonTitle: "The Example Pendant Necklace",
      jsonCategory: "Necklaces",
      h1Title: "The Example Pendant Necklace",
      duplicateProduct: true,
      duplicateProductDescription: "Silver neck...",
    }));
    const ajaxBody = JSON.parse(fixtureAjax()) as Record<string, unknown>;
    ajaxBody.title = "The Example Pendant Necklace";
    ajaxBody.type = "Necklace";
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant-aromatherapy-necklace",
      finalUrl: "https://shop.example/en/products/example-pendant",
      capturedAt,
      html,
      ajax: parseShopifyAjax(JSON.stringify(ajaxBody)),
    });

    expect(record.fields.title).toMatchObject({ state: "verified", value: "The Example Pendant Necklace" });
    expect(record.fields.product_type_category).toMatchObject({ state: "verified", value: "Necklace" });
    expect(record.fields.description).toMatchObject({ state: "verified", value: "Silver necklace" });
    expect(record.technical_findings.filter((finding) => finding.code === "FIELD_CONFLICT")).toHaveLength(0);
  });

  it("distinguishes missing canonical, password block, and incomplete Ajax", () => {
    const html = parseProductHtml(fixtureHtml({ noCanonical: true, password: true }));
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant",
      finalUrl: "https://shop.example/products/example-pendant",
      capturedAt,
      html,
      ajax: null,
      ajaxError: "Ajax returned 404.",
    });

    expect(record.collection_status).toBe("blocked");
    // The HTML canonical is missing, but JSON-LD still supplies one source.
    expect(record.fields.canonical_url.state).toBe("single_source");
    expect(record.fields.product_id.state).toBe("incomplete");
    expect(record.technical_findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["MISSING_CANONICAL", "PASSWORD_PAGE", "AJAX_PRODUCT_UNAVAILABLE"]),
    );
  });

  it("promotes already-captured images, remaining GTINs, JSON-LD commerce nodes, and labeled taxonomy hints", () => {
    const html = parseProductHtml(fixtureHtml({
      ogImage: "//cdn.example/og.jpg",
      jsonImage: ["https://cdn.example/featured.jpg", "https://cdn.example/alt.jpg"],
      jsonGtin8: "12345678",
      jsonGtin12: "123456789012",
      jsonIsbn: "9781234567897",
      jsonMpn: "NS-MPN",
      shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { value: "0", currency: "EUR" } },
      returnPolicy: { "@type": "MerchantReturnPolicy", returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow" },
      warranty: { "@type": "WarrantyPromise", durationOfWarranty: { "@type": "QuantitativeValue", value: 1, unitCode: "ANN" } },
      breadcrumb: ["Home", "Jewelry", "Necklaces"],
    }));
    const ajaxBody = JSON.parse(fixtureAjax()) as Record<string, unknown>;
    ajaxBody.featured_image = "//cdn.example/featured.jpg";
    ajaxBody.images = ["//cdn.example/featured.jpg", "//cdn.example/alt.jpg"];
    ajaxBody.tags = ["handmade", "gift"];
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant",
      finalUrl: "https://shop.example/en/products/example-pendant",
      capturedAt,
      html,
      ajax: parseShopifyAjax(JSON.stringify(ajaxBody)),
    });

    expect(record.schema_version).toBe("product-record/1.0");
    expect(record.fields.image).toMatchObject({
      state: "conflicted",
      value: null,
    });
    expect(record.fields.image.observations.map((item) => item.path)).toEqual(
      expect.arrayContaining(["featured_image", "og:image", "products[0].image", "images[1]", "products[0].image[1]"]),
    );
    expect(record.fields.barcode.observations.map((item) => `${item.path}:${item.value}`)).toEqual(
      expect.arrayContaining([
        "variants[0].barcode:111",
        "variants[1].barcode:222",
        "products[0].gtin8:12345678",
        "products[0].gtin12:123456789012",
        "products[0].isbn:9781234567897",
        "products[0].mpn:NS-MPN",
      ]),
    );
    expect(record.fields.shipping_details.state).toBe("single_source");
    expect(String(record.fields.shipping_details.value)).toContain("OfferShippingDetails");
    expect(String(record.fields.merchant_return_policy.value)).toContain("MerchantReturnPolicy");
    expect(String(record.fields.warranty.value)).toContain("WarrantyPromise");
    expect(record.fields.taxonomy_hints).toMatchObject({
      state: "verified",
      value: "breadcrumb: Home > Jewelry > Necklaces; ajax_tag: handmade; ajax_tag: gift",
    });
    expect(record.fields.taxonomy_hints.observations.map((item) => item.path)).not.toContain("collections");
    const profile = productProfile(record);
    expect(profile.previewFields.title.value).toBe(record.fields.title.value);
    expect(profile.facts.image).toBeNull();
    expect(profile.facts.taxonomy_hints).toContain("breadcrumb:");
    expect(profile.facts.shipping_details).toContain("OfferShippingDetails");
  });

  it("leaves JSON-LD commerce extras and taxonomy hints missing when the captured HTML has none", () => {
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant",
      finalUrl: "https://shop.example/en/products/example-pendant",
      capturedAt,
      html: parseProductHtml(fixtureHtml({})),
      ajax: parseShopifyAjax(fixtureAjax()),
    });
    expect(record.fields.shipping_details.state).toBe("missing");
    expect(record.fields.merchant_return_policy.state).toBe("missing");
    expect(record.fields.warranty.state).toBe("missing");
    expect(record.fields.taxonomy_hints.state).toBe("missing");
    expect(record.fields.image.state).toBe("missing");
  });
});

describe("bounded collection", () => {
  it("follows a validated redirect and fetches the locale-aware Ajax endpoint", async () => {
    const calls: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url === "https://shop.example/products/example-pendant") {
        return new Response(null, { status: 302, headers: { location: "/en/products/example-pendant" } });
      }
      if (url.endsWith(".js")) {
        return new Response(fixtureAjax(), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /products/", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(fixtureHtml({}), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };

    const result = await collectShopifyProduct("https://shop.example/products/example-pendant", { fetcher, capturedAt });
    expect(calls).toEqual([
      "https://shop.example/products/example-pendant",
      "https://shop.example/en/products/example-pendant",
      "https://shop.example/en/products/example-pendant.js",
      "https://shop.example/robots.txt",
    ]);
    expect(result.record.collection_status).toBe("complete");
    expect(result.snapshots).toHaveLength(3);
    expect(result.technicalCheck.status).toBe("complete");
    expect(result.record.fields.taxonomy_hints.state).toBe("missing");
  });

  it("rejects a redirect to a private target", async () => {
    const fetcher: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/products/secret" } });
    await expect(
      collectShopifyProduct("https://shop.example/products/example-pendant", { fetcher, capturedAt }),
    ).rejects.toMatchObject({ code: "PRIVATE_TARGET" });
  });

  it("explains when a valid-looking product link redirects to a non-product page", async () => {
    const fetcher: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: "/collections/mens" } });
    await expect(
      collectShopifyProduct("https://shop.example/products/example-shoes", { fetcher, capturedAt }),
    ).rejects.toMatchObject({
      code: "PRODUCT_REDIRECTED_AWAY",
      status: 422,
      message: expect.stringContaining("URL format is valid"),
    });
  });
});

describe("robots and page eligibility", () => {
  it("uses the longest matching agent and path rule, with Allow winning a tie", () => {
    const robots = `
      User-agent: *
      Disallow: /products/

      User-agent: OAI-SearchBot
      Disallow: /products/
      Allow: /products/example-pendant$
    `;
    expect(evaluateAgent(robots, "/products/example-pendant", "OAI-SearchBot", "openai_search")).toMatchObject({
      result: "allowed",
      matched_user_agent: "oai-searchbot",
      matched_rule: "allow: /products/example-pendant$",
    });
    expect(evaluateAgent(robots, "/products/other", "GPTBot", "openai_training")).toMatchObject({
      result: "blocked",
      matched_user_agent: "*",
    });
  });

  it("separates page noindex from crawler access", () => {
    const html = parseProductHtml('<html><head><meta name="robots" content="noindex, follow"></head><body></body></html>');
    const check = buildTechnicalCheck({
      productUrl: "https://shop.example/products/example-pendant",
      capturedAt,
      html,
      htmlSnapshot: snapshot("html", "", 200, { "x-robots-tag": "noarchive" }),
      robotsSnapshot: snapshot("robots", "User-agent: OAI-SearchBot\nDisallow: /products/", 200),
    });
    expect(check.page_directives).toEqual({ meta_robots: ["noindex", "follow"], x_robots_tag: ["noarchive"] });
    expect(check.crawler_access.find((item) => item.agent === "OAI-SearchBot")?.result).toBe("blocked");
    expect(check.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["PAGE_NOINDEX", "CRAWLER_BLOCKED"]),
    );
  });
});

describe("public product preview", () => {
  it("returns collect findings and present/missing tiles without adding fetches", () => {
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant",
      finalUrl: "https://shop.example/en/products/example-pendant",
      capturedAt,
      html: parseProductHtml(fixtureHtml({
        ogImage: "https://cdn.example/featured.jpg",
        jsonImage: ["https://cdn.example/featured.jpg"],
        shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { value: "0", currency: "USD" } },
        returnPolicy: { "@type": "MerchantReturnPolicy", returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow" },
        warranty: { "@type": "WarrantyPromise", durationOfWarranty: { "@type": "QuantitativeValue", value: 12, unitCode: "MON" } },
      })),
      ajax: parseShopifyAjax(fixtureAjax()),
    });
    const technicalCheck = buildTechnicalCheck({
      productUrl: "https://shop.example/products/example-pendant",
      capturedAt,
      html: parseProductHtml('<html><head><meta name="robots" content="noindex, follow"></head><body></body></html>'),
      htmlSnapshot: snapshot("html", "", 200),
      robotsSnapshot: snapshot("robots", "User-agent: OAI-SearchBot\nDisallow: /products/", 200),
    });
    const preview = publicProductPreview({ record, technicalCheck, snapshots: [] });

    expect(preview.status).toBe("complete");
    expect(preview.captured_at).toBe(capturedAt);
    expect(preview.fields.title.value).toBe(record.fields.title.value);
    expect(preview.presence).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "brand", label: "Brand", state: "present" }),
      expect.objectContaining({ key: "sku", label: "SKU", state: "present" }),
      expect.objectContaining({ key: "gtin", label: "GTIN", state: "present" }),
      expect.objectContaining({ key: "image", label: "Image", state: "present" }),
      expect.objectContaining({ key: "shipping", label: "Shipping", state: "present" }),
      expect.objectContaining({ key: "returns", label: "Returns", state: "present" }),
      expect.objectContaining({ key: "warranty", label: "Warranty", state: "present" }),
      expect.objectContaining({ key: "json_ld_product", label: "JSON-LD Product", state: "present" }),
      expect.objectContaining({ key: "json_ld_offer", label: "JSON-LD Offer", state: "present" }),
    ]));
    expect(preview.findings.every((finding) => finding.evidence.length >= 1 && finding.definition_id && finding.status)).toBe(true);
    expect(preview.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["PAGE_NOINDEX", "CRAWLER_BLOCKED"]),
    );
    expect(preview.finding_counts.error).toBeGreaterThan(0);
    expect(preview.findings.some((finding) => finding.message.includes("noindex"))).toBe(true);
    expect(preview).not.toHaveProperty("record");
    expect(preview).not.toHaveProperty("technical_check");
    expect(JSON.stringify(preview)).not.toMatch(/gemini|luna|sol|langgraph|observer/i);
  });

  it("marks JSON-LD commerce nodes missing and stays honest when robots are unavailable", () => {
    const record = normalizeProduct({
      requestedUrl: "https://shop.example/products/example-pendant",
      finalUrl: "https://shop.example/en/products/example-pendant",
      capturedAt,
      html: parseProductHtml(`<!doctype html><html><head>
        <link rel="canonical" href="https://shop.example/en/products/example-pendant">
        <title>Example Pendant Necklace</title>
      </head><body><h1>Example Pendant Necklace</h1></body></html>`),
      ajax: parseShopifyAjax(fixtureAjax()),
    });
    const technicalCheck = buildTechnicalCheck({
      productUrl: record.final_url,
      capturedAt,
      html: parseProductHtml("<html><head></head><body></body></html>"),
      htmlSnapshot: snapshot("html", "", 200),
      robotsSnapshot: snapshot("robots", "", 404),
    });
    const preview = publicProductPreview({ record, technicalCheck, snapshots: [] });

    expect(preview.status).toBe("partial");
    expect(preview.presence.find((item) => item.key === "json_ld_product")?.state).toBe("missing");
    expect(preview.presence.find((item) => item.key === "json_ld_offer")?.state).toBe("missing");
    expect(preview.presence.find((item) => item.key === "shipping")?.state).toBe("missing");
    expect(preview.presence.find((item) => item.key === "image")?.state).toBe("missing");
    expect(preview.findings.map((finding) => finding.code)).toContain("ROBOTS_UNAVAILABLE");
    expect(preview.findings.find((finding) => finding.code === "ROBOTS_UNAVAILABLE")?.status).toBe("unavailable");
    expect(preview.findings.find((finding) => finding.code === "SHIPPING_NOT_IN_CAPTURE")?.message).toContain(
      "Visible shipping text and separate policy pages have not been verified.",
    );
    expect(preview.findings.find((finding) => finding.code === "SHIPPING_NOT_IN_CAPTURE")?.guidance).toContain("Settings → Shipping and delivery");
    expect(preview.finding_counts.warning).toBeGreaterThan(0);
  });
});

function snapshot(
  kind: "html" | "robots",
  body: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return {
    kind,
    requested_url: "https://shop.example/robots.txt",
    final_url: "https://shop.example/robots.txt",
    status,
    content_type: "text/plain",
    captured_at: capturedAt,
    headers,
    body,
  };
}

function fixtureAjax(): string {
  return JSON.stringify({
    id: 42,
    handle: "example-pendant",
    title: "Example Pendant Necklace",
    vendor: "Example Brand",
    type: "Necklace",
    description: "Silver necklace",
    available: true,
    price: 1999,
    variants: [
      { id: 1, title: "Silver", sku: "NS-S", barcode: "111", price: 1999, available: true, options: ["Silver"] },
      { id: 2, title: "Gold", sku: "NS-G", barcode: "222", price: 2199, available: false, options: ["Gold"] },
    ],
  });
}

function fixtureHtml(options: {
  currency?: string;
  jsonCurrency?: string;
  duplicateProduct?: boolean;
  malformedJsonLd?: boolean;
  noCanonical?: boolean;
  password?: boolean;
  seoTitle?: string;
  jsonTitle?: string;
  jsonCategory?: string;
  h1Title?: string;
  duplicateProductDescription?: string;
  ogImage?: string;
  jsonImage?: string | string[];
  jsonGtin8?: string;
  jsonGtin12?: string;
  jsonIsbn?: string;
  jsonMpn?: string;
  shippingDetails?: Record<string, unknown>;
  returnPolicy?: Record<string, unknown>;
  warranty?: Record<string, unknown>;
  breadcrumb?: string[];
}): string {
  const offer = {
    "@type": "Offer",
    price: "19.99",
    priceCurrency: options.jsonCurrency ?? "EUR",
    availability: "https://schema.org/InStock",
    sku: "NS-S",
    ...(options.shippingDetails ? { shippingDetails: options.shippingDetails } : {}),
    ...(options.returnPolicy ? { hasMerchantReturnPolicy: options.returnPolicy } : {}),
    ...(options.warranty ? { warranty: options.warranty } : {}),
  };
  const product = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: options.jsonTitle ?? "Example Pendant Necklace",
    ...(options.jsonCategory ? { category: options.jsonCategory } : {}),
    description: "Silver necklace",
    brand: { "@type": "Brand", name: "Example Brand" },
    sku: "NS-S",
    url: "https://shop.example/en/products/example-pendant",
    ...(options.jsonImage ? { image: options.jsonImage } : {}),
    ...(options.jsonGtin8 ? { gtin8: options.jsonGtin8 } : {}),
    ...(options.jsonGtin12 ? { gtin12: options.jsonGtin12 } : {}),
    ...(options.jsonIsbn ? { isbn: options.jsonIsbn } : {}),
    ...(options.jsonMpn ? { mpn: options.jsonMpn } : {}),
    offers: offer,
  });
  const breadcrumb = options.breadcrumb
    ? JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: options.breadcrumb.map((name, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name,
        })),
      })
    : "";
  return `<!doctype html><html><head>
    ${options.noCanonical ? "" : '<link rel="canonical" href="https://shop.example/en/products/example-pendant">'}
    <title>${options.seoTitle ?? "Example Pendant Necklace"}</title>
    <meta name="description" content="Silver necklace">
    <meta property="og:title" content="${options.seoTitle ?? "Example Pendant Necklace"}">
    ${options.ogImage ? `<meta property="og:image" content="${options.ogImage}">` : ""}
    <meta property="product:price:amount" content="19.99">
    <meta property="product:price:currency" content="${options.currency ?? "EUR"}">
    <script type="application/ld+json">${product}</script>
    ${options.duplicateProduct ? `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[${JSON.stringify({ ...JSON.parse(product), description: options.duplicateProductDescription ?? "Silver necklace" })}]}</script>` : ""}
    ${breadcrumb ? `<script type="application/ld+json">${breadcrumb}</script>` : ""}
    ${options.malformedJsonLd ? '<script type="application/ld+json">{"@type":"Product",</script>' : ""}
    <script>ignore this script</script>
  </head><body class="${options.password ? "shopify-section-password" : ""}">
    <h1>${options.h1Title ?? "Example Pendant Necklace"}</h1>${options.password ? "Enter store using password" : "Available now"}
  </body></html>`;
}
