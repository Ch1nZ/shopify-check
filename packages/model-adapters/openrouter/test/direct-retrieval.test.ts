import { describe, expect, it } from "vitest";
import { directRetrievalPass, directRetrievalQuestion } from "../src/direct-retrieval";

describe("isolated direct retrieval validity", () => {
  const capture = { message: "Exact locket", sources: [{ source_id: "src_1", url: "https://example.com/products/locket", title: "Example", supports: "Product" }] };
  it("requires identity, a matched name and real provider source IDs", () => {
    const assessment = { identity_matches: true, merchant_source_ids: ["src_1"], matched_name: "Lockét", explanation: "Merchant product identified" };
    expect(directRetrievalPass(assessment, capture)).toBe(true);
    expect(directRetrievalPass({ ...assessment, merchant_source_ids: [] }, capture)).toBe(false);
    expect(directRetrievalPass({ ...assessment, merchant_source_ids: ["invented"] }, capture)).toBe(false);
    expect(directRetrievalPass({ ...assessment, identity_matches: false }, capture)).toBe(false);
    expect(directRetrievalPass({ ...assessment, matched_name: null }, capture)).toBe(false);
    expect(directRetrievalPass(assessment, { ...capture, sources: [] })).toBe(false);
  });
  it("does not supply a product URL to the direct-name control", () => {
    const question = directRetrievalQuestion({ schema_version: "guided-shopping/1.0", brand_names: ["Example"], product_names: ["Lockét"], canonical_product_url: "https://example.com/products/locket", merchant_domains: ["example.com"], product_url_aliases: [], normalized_sku_ids: [] });
    expect(question).toContain("Lockét");
    expect(question).not.toContain("https://example.com/products/locket");
  });
});
