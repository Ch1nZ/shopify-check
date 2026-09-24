import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CONTRACT_VERSIONS,
  ShoppingObserverResultSchema,
  type BlindConversationContext,
  type EvidencePack,
  type GeneratedShoppingQuery,
  type TargetIdentity,
} from "@mclab/contracts";
import { CONTROLLED_SHOPPING_PROTOCOL } from "@mclab/domain";
import type { ProductRecord } from "@mclab/shopify-online-store";

import {
  buildFixtureAnalysis,
  buildBuyerBriefGeneratorPrompt,
  buildEvidencePack,
  buildProductResearchPrompt,
  buildProductUnderstandingPrompt,
  BuyerBriefModelOutputSchema,
  ProductUnderstandingBriefOutputSchema,
  buildOpenRouterRequestDescriptor,
  buildQueryAuditPrompt,
  buildQueryGeneratorPrompt,
  buildShoppingObserverPrompt,
  SHOPPING_ROLE_OUTPUT_MODES,
  validateEvidenceLinks,
  validateDeclaredSourceUrls,
} from "../src";

const productRecord: ProductRecord = {
  schema_version: "product-record/1.0",
  requested_url: "https://target.example/products/example-drop-earrings",
  final_url: "https://target.example/products/example-drop-earrings",
  captured_at: "2026-09-02T00:00:00.000Z",
  collection_status: "complete",
  fields: {
    product_id: field("123"),
    handle: field("example-drop-earrings"),
    canonical_url: field("https://target.example/products/example-drop-earrings"),
    title: field("Example Drop Earrings in Black Buffalo Horn"),
    description: field("Black buffalo horn, rhodium-plated sterling silver, 7.5cm long."),
    vendor_brand: field("Secret Brand"),
    product_type_category: field("Earrings"),
    currency: field("USD"),
    price: field(24500),
    availability: field(true),
    sku: field("SKU-123"),
    barcode: { state: "missing", value: null, observations: [] },
    image: field("https://cdn.example/featured.jpg"),
    shipping_details: { state: "missing", value: null, observations: [] },
    merchant_return_policy: { state: "missing", value: null, observations: [] },
    warranty: { state: "missing", value: null, observations: [] },
    taxonomy_hints: { state: "missing", value: null, observations: [] },
  },
  variants: [],
  json_ld_product_count: 1,
  technical_findings: [],
};

function field(value: string | number | boolean): ProductRecord["fields"]["title"] {
  return { state: "single_source", value, observations: [] };
}

const pack: EvidencePack = {
  schema_version: CONTRACT_VERSIONS.evidenceObservation,
  collection_id: "2e9cf5cf-3156-4a55-9cab-f95f8b42ea2d",
  product_url: "https://example.com/products/test",
  captured_at: "2026-09-02T00:00:00.000Z",
  items: [
    {
      id: "ev_1234567890abcdef",
      source: "shopify_ajax",
      path: "fields.title.title",
      text: "Example Pendant Necklace",
      captured_url: "https://example.com/products/test",
      captured_at: "2026-09-02T00:00:00.000Z",
      sha256: "a".repeat(64),
    },
  ],
};

const blindContext: BlindConversationContext = {
  buyer_brief: {
    schema_version: CONTRACT_VERSIONS.guidedShopping,
    category: "aromatherapy necklace",
    target_market: "Hong Kong",
    buyer_job: "wear essential oil discreetly",
    use_cases: ["daily wear"],
    constraints: ["ordinary jewelry appearance"],
    preferences: ["sterling silver"],
    decision_dimensions: [],
    market_requirements: ["available for purchase in Hong Kong"],
    prohibited_fingerprints: [],
  },
  protocol: CONTROLLED_SHOPPING_PROTOCOL,
  completed_turns: [],
  usage: {
    turns: 0,
    model_calls: 0,
    search_requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micros: 0,
  },
};

const targetIdentity: TargetIdentity = {
  schema_version: CONTRACT_VERSIONS.guidedShopping,
  canonical_product_url: "https://target.example/products/secret-star",
  merchant_domains: ["target.example"],
  brand_names: ["Secret Brand"],
  product_names: ["Secret Star Necklace"],
  product_url_aliases: [],
  normalized_sku_ids: [],
};

const generatedQuery: GeneratedShoppingQuery = {
  message: "Which aromatherapy necklaces suit daily wear?",
  used_constraint_indexes: [],
  naturalness_note: "Natural category question.",
};

describe("OpenRouter adapter", () => {
  it("uses strict output only for workflow data and preserves a natural shopping answer", () => {
    expect(SHOPPING_ROLE_OUTPUT_MODES).toEqual({
      query_generator: "strict_structured",
      query_auditor: "strict_structured",
      shopping_observer: "natural_text_with_provider_sources",
      result_classifier: "strict_structured",
    });
    const observer = buildShoppingObserverPrompt({ context: blindContext, query: generatedQuery });
    expect(observer).toContain("Answer naturally");
    expect(observer).toContain("Do not wrap the answer in JSON");
    expect(observer).toContain("identifiable, purchasable product listing");
    expect(observer).toContain("Never state an exact length, weight, material, price, availability, or return term as verified");
    expect(observer).toContain("do not base the final recommendation on it");
  });

  it("pins one provider and disables fallback", () => {
    const request = buildOpenRouterRequestDescriptor("fallback", "medium");
    expect(request.model).toBe("example/fallback");
    expect(request.provider).toMatchObject({
      order: ["openai"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(request.tools[0]?.type).toBe("openrouter:web_search");
  });

  it("uses the configured planner route for structured audit and classification work", () => {
    const request = buildOpenRouterRequestDescriptor("planner", "medium");
    expect(request.model).toBe("example/planner");
    expect(request.provider.order).toEqual(["openai"]);
  });

  it("uses the configured model for structured synthesis", () => {
    const request = buildOpenRouterRequestDescriptor("synthesizer", "medium");
    expect(request.model).toBe("example/synthesizer");
    expect(request.provider.order).toEqual(["openai"]);
  });

  it("creates fixture output linked only to captured evidence", () => {
    const output = buildFixtureAnalysis(pack);
    expect(output.findings[0]?.evidence.map((citation) => citation.evidence_id)).toEqual(["ev_1234567890abcdef"]);
  });

  it("rejects hallucinated evidence identifiers", () => {
    expect(() =>
      validateEvidenceLinks(
        {
          schema_version: CONTRACT_VERSIONS.report,
          summary: "Unsupported claim",
          findings: [
            {
              kind: "buyer_fit",
              statement: "Unsupported",
              evidence: [{ evidence_id: "ev_ffffffffffffffff", quote: "Unsupported" }],
              confidence: "low",
            },
          ],
          unresolved_questions: [],
        },
        pack,
      ),
    ).toThrow(/outside the captured pack/);
  });

  it("rejects a quote that is not present in the cited evidence", () => {
    expect(() =>
      validateEvidenceLinks(
        {
          schema_version: CONTRACT_VERSIONS.report,
          summary: "Unsupported quote",
          findings: [{
            kind: "buyer_fit",
            statement: "Unsupported",
            evidence: [{ evidence_id: "ev_1234567890abcdef", quote: "Not on the page" }],
            confidence: "low",
          }],
          unresolved_questions: [],
        },
        pack,
      ),
    ).toThrow(/quote does not occur/);
  });

  it("keeps target identity out of generator and observer prompts", () => {
    const generator = buildQueryGeneratorPrompt(blindContext, CONTROLLED_SHOPPING_PROTOCOL.turns[0]!);
    const observer = buildShoppingObserverPrompt({ context: blindContext, query: generatedQuery });
    expect(generator).not.toContain("Secret Brand");
    expect(observer).not.toContain("Secret Brand");

    const auditor = buildQueryAuditPrompt({
      context: blindContext,
      turn: CONTROLLED_SHOPPING_PROTOCOL.turns[0]!,
      query: generatedQuery,
      targetIdentity,
    });
    expect(auditor).toContain("Secret Brand");
    expect(auditor).toContain("must never flow back");
  });

  it("creates a bounded buyer-brief prompt from product facts before the target-blind conversation", () => {
    const prompt = buildBuyerBriefGeneratorPrompt(productRecord, "United States");
    expect(prompt).toContain("shopper-recognizable subcategory");
    expect(prompt).toContain("Black buffalo horn");
    expect(prompt).not.toContain("Secret Brand");
    expect(prompt).not.toContain("SKU-123");
    expect(prompt).toContain("Set budget to null");
  });

  it("uses an OpenAI-compatible strict schema for the buyer brief", () => {
    const schema = z.toJSONSchema(BuyerBriefModelOutputSchema) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.required).toEqual(Object.keys(schema.properties ?? {}));
    expect(BuyerBriefModelOutputSchema.parse({
      schema_version: CONTRACT_VERSIONS.guidedShopping,
      category: "drop earrings",
      target_market: "United States",
      buyer_job: "find lightweight statement earrings for everyday wear",
      use_cases: [],
      constraints: [],
      preferences: [],
      primary_persona: {
        label: "Everyday statement-jewelry shopper",
        situation: "Choosing one distinctive pair for frequent wear",
        goals: ["Find a wearable statement earring"],
        priorities: ["Comfort and styling versatility"],
        concerns: ["Unverified weight"],
        natural_language: ["I want something distinctive that I can wear often"],
        evidence_strength: "medium",
      },
      decision_dimensions: [],
      market_requirements: ["available in the United States"],
      prohibited_fingerprints: ["the exact material and finish combination"],
      budget: null,
    }).budget).toBeNull();
  });

  it("calibrates discovery scope and allows ordinary buyer considerations", () => {
    const generator = buildQueryGeneratorPrompt(blindContext, CONTROLLED_SHOPPING_PROTOCOL.turns[0]!);
    expect(generator).toContain("avoid the entire top-level market");
    expect(generator).toContain("meaningfully bounded but still admits multiple brands and products");
    expect(generator).toContain("Maintain demand-envelope continuity");
    expect(generator).toContain("open to any product that satisfies the approved demand envelope");
    expect(generator).toContain("primary_persona");
    expect(generator).toContain("Never turn a metal finish into a gemstone color");

    const auditor = buildQueryAuditPrompt({
      context: blindContext,
      turn: CONTROLLED_SHOPPING_PROTOCOL.turns[1]!,
      query: {
        message: "Could you narrow those down to comfortable options that work with most outfits?",
        used_constraint_indexes: [],
        naturalness_note: "Ordinary category-level refinement.",
      },
      targetIdentity,
    });
    expect(auditor).toContain("Approve ordinary category-level buyer considerations");
    expect(auditor).toContain("Do not reject merely because");
    expect(auditor).toContain("mixes incompatible personas");
    expect(auditor).toContain("presupposes a winner");
  });

  it("separates searched product research from strict product-understanding synthesis", () => {
    const research = buildProductResearchPrompt(productRecord, "United States");
    expect(research).toContain("1 to 3 plausible potential buyer personas");
    expect(research).toContain("https://target.example/products/example-drop-earrings");
    expect(research).toContain("https://cdn.example/featured.jpg");
    const synthesis = buildProductUnderstandingPrompt({
      record: productRecord,
      targetMarket: "United States",
      research: {
        memo: "Statement jewelry buyers often balance visual impact with comfort.",
        sources: [{ url: "https://target.example/pages/materials", title: "Materials" }],
      },
    });
    expect(synthesis).toContain("choose exactly one as buyer_brief.primary_persona");
    expect(synthesis).toContain("purchase situation");
    expect(synthesis).toContain("prohibited_fingerprints");
    expect(synthesis).toContain("no more than 12 product facts");
  });

  it("keeps variant barcodes in the evidence pack", async () => {
    const pack = await buildEvidencePack("2e9cf5cf-3156-4a55-9cab-f95f8b42ea2d", {
      ...productRecord,
      fields: {
        ...productRecord.fields,
        barcode: {
          state: "single_source",
          value: "111",
          observations: [
            {
              source: "shopify_ajax",
              path: "variants[0].barcode",
              value: "111",
              captured_url: productRecord.final_url,
              captured_at: productRecord.captured_at,
            },
            {
              source: "shopify_ajax",
              path: "variants[1].barcode",
              value: "222",
              captured_url: productRecord.final_url,
              captured_at: productRecord.captured_at,
            },
          ],
        },
      },
      variants: [
        {
          id: "1",
          title: "Silver",
          sku: "NS-S",
          barcode: "111",
          price_minor: 1999,
          compare_at_price_minor: null,
          available: true,
          options: ["Silver"],
        },
        {
          id: "2",
          title: "Gold",
          sku: "NS-G",
          barcode: "222",
          price_minor: 2199,
          compare_at_price_minor: null,
          available: false,
          options: ["Gold"],
        },
      ],
    });
    expect(pack.items.some((item) => item.path.includes("barcode") && item.text === "111")).toBe(true);
    expect(pack.items.some((item) => item.path.includes("barcode") && item.text === "222")).toBe(true);
    expect(pack.items.some((item) => item.path === "variants[1]" && item.text.includes('"barcode":"222"'))).toBe(true);
  });

  it("emits an OpenAI-compatible strict schema without unsupported URI formats", () => {
    const schemaObject = z.toJSONSchema(ProductUnderstandingBriefOutputSchema) as Record<string, unknown>;
    const schema = JSON.stringify(schemaObject);
    expect(schema).not.toContain('"format":"uri"');
    expect(schema).toContain('"pattern":"^https:\\\\/\\\\/[^\\\\s]+$"');
    expect(findIncompleteStrictObjects(schemaObject)).toEqual([]);
  });

  it("keeps invented budgets out of generated questions and marks revision attempts", () => {
    const prompt = buildQueryGeneratorPrompt(
      blindContext,
      CONTROLLED_SHOPPING_PROTOCOL.turns[1]!,
      1,
    );
    expect(prompt).toContain("If buyer_brief.budget is absent, do not create a price ceiling");
    expect(prompt).toContain("revision attempt 1");
    expect(prompt).toContain("materially different message");
  });

  it("rejects observer URLs that are absent from provider source records", () => {
    const observer = ShoppingObserverResultSchema.parse({
      message: "A sufficiently detailed answer with one supported candidate.",
      answer_shape: "single_option",
      sources: [{
        source_id: "src_abcdef",
        url: "https://merchant.example/product",
        title: null,
        supports: "Current product page.",
      }],
      candidates: [{
        candidate_id: "cand_abcdef",
        displayed_name: "Example Product",
        merchant_domain: "merchant.example",
        product_url: "https://merchant.example/product",
        position: 1,
        compared: false,
        recommended: true,
        final_choice: false,
        supporting_source_ids: ["src_abcdef"],
      }],
      unresolved_facts: [],
    });
    expect(() => validateDeclaredSourceUrls(observer, [{
      url: "https://different.example/product",
      title: null,
    }])).toThrow(/absent from provider source records/);
  });
});

function findIncompleteStrictObjects(
  value: unknown,
  path = "$",
): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findIncompleteStrictObjects(entry, `${path}[${index}]`));
  }
  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  if (record.type === "object" && record.properties && typeof record.properties === "object") {
    const keys = Object.keys(record.properties as Record<string, unknown>).sort();
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string").sort()
      : [];
    if (JSON.stringify(keys) !== JSON.stringify(required)) issues.push(path);
  }
  return [
    ...issues,
    ...Object.entries(record).flatMap(([key, entry]) => findIncompleteStrictObjects(entry, `${path}.${key}`)),
  ];
}
