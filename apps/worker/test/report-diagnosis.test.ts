import { describe, expect, it } from "vitest";
import type { ProductRecord, TechnicalCheck } from "@mclab/shopify-online-store";

import { buildReportDiagnosis, groupReportSources } from "../src/report-diagnosis";

const readableTechnicalCheck = {
  status: "complete",
  crawler_access: [
    { purpose: "general_crawl", result: "allowed" },
    { purpose: "openai_search", result: "allowed" },
    { purpose: "openai_training", result: "allowed" },
  ],
  findings: [],
} as unknown as TechnicalCheck;

function product(description: string) {
  return {
    final_url: "https://shop.example/products/test",
    fields: {
      title: { value: "Example Drop Earrings" },
      description: { value: description },
    },
  } as unknown as ProductRecord;
}

describe("customer report diagnosis", () => {
  it("separates an observed candidate-set absence from its unproven cause", () => {
    const diagnosis = buildReportDiagnosis({
      completedTurns: 2,
      productRecord: product("Black horn. Sterling silver. 7.5cm length."),
      technicalCheck: readableTechnicalCheck,
      turns: [1, 2].map((ordinal) => ({
        ordinal,
        stage: ordinal === 1 ? "discovery" : "refinement",
        sources: [{ title: "example.com", source_domain: "vertexaisearch.cloud.google.com", url: `https://source/${ordinal}` }],
        candidates: [{ displayed_name: ordinal === 1 ? "Option A" : "Option B" }],
        target_observation: {
          retrievability: "not_retrieved",
          candidate_set: "absent",
          recommendation: "not_recommended",
        },
      })),
    });

    expect(diagnosis.outcome).toBe("absent");
    expect(diagnosis.failure_point.label).toBe("Candidate-set entry");
    expect(diagnosis.technical_eligibility.status).toBe("readable");
    expect(diagnosis.confidence).toMatchObject({ observation: "high", cause: "limited" });
    expect(diagnosis.next_action.evidence_type).toContain("diagnostic hypothesis");
    expect(diagnosis.next_action.rationale).toContain("Description length alone does not establish an evidence gap");
    expect(diagnosis.candidate_path_interpretation).toContain("not additional independent retrieval attempts");
  });

  it("distinguishes an open entry observation from a closed comparison", () => {
    const absentObservation = {
      retrievability: "not_retrieved",
      candidate_set: "absent",
      recommendation: "not_recommended",
    };
    const diagnosis = buildReportDiagnosis({
      completedTurns: 4,
      productRecord: product("Black horn. Sterling silver. 7.5cm length."),
      technicalCheck: readableTechnicalCheck,
      turns: ["discovery", "refinement", "shortlist", "comparison"].map((stage, index) => ({
        ordinal: index + 1,
        stage,
        sources: [],
        candidates: [{ displayed_name: `Option ${index + 1}` }],
        target_observation: absentObservation,
      })),
    });

    expect(diagnosis.candidate_path[0]).toMatchObject({ target_state: "absent", entry_status: "entry_observation" });
    expect(diagnosis.candidate_path[3]).toMatchObject({
      target_state: "closed after earlier absence",
      entry_status: "closed_candidate_set",
    });
  });

  it("does not manufacture a fix when the target was selected", () => {
    const diagnosis = buildReportDiagnosis({
      completedTurns: 1,
      productRecord: product("A detailed product description with enough buyer context to support a considered purchase decision and comparison."),
      technicalCheck: readableTechnicalCheck,
      turns: [{
        ordinal: 1,
        stage: "decision",
        sources: [],
        candidates: [{ displayed_name: "Example Drop Earrings" }],
        target_observation: {
          retrievability: "retrieved",
          candidate_set: "included",
          recommendation: "final_choice",
        },
      }],
    });

    expect(diagnosis.outcome).toBe("final_choice");
    expect(diagnosis.next_action.title).toBe("Preserve the baseline; do not manufacture a fix.");
  });

  it("keeps adaptive verification and reopened exploration open after comparison", () => {
    const diagnosis = buildReportDiagnosis({
      completedTurns: 4,
      productRecord: product("A recorded product description."),
      technicalCheck: readableTechnicalCheck,
      turns: [
        ["discovery", "explore"], ["comparison", "compare"],
        ["caveat_check", "verify"], ["refinement", "explore"],
      ].map(([stage, action], index) => ({
        ordinal: index + 1, stage, sources: [], candidates: [],
        adaptive_decision: { action, reason: "An original buyer need remains unresolved." },
        target_observation: { retrievability: "not_retrieved", candidate_set: "absent", recommendation: "not_recommended" },
      })),
    });
    expect(diagnosis.candidate_path.map((turn) => turn.entry_status)).toEqual([
      "entry_observation", "closed_candidate_set", "entry_observation", "entry_observation",
    ]);
    expect(diagnosis.candidate_path[2]?.action).toBe("verify");
    expect(diagnosis.failure_point.explanation).not.toContain("before comparison");
    expect(diagnosis.candidate_path_interpretation).toContain("not independent discovery samples");
  });

  it("groups repeated provider redirects by the displayed publisher", () => {
    expect(groupReportSources([
      { title: "merchant-a.example", source_domain: "vertexaisearch.cloud.google.com", url: "https://source/1" },
      { title: "merchant-a.example", source_domain: "vertexaisearch.cloud.google.com", url: "https://source/2" },
      { title: "merchant-b.example", source_domain: "vertexaisearch.cloud.google.com", url: "https://source/3" },
    ])).toEqual([
      { label: "merchant-a.example", url: "https://source/1", urls: ["https://source/1", "https://source/2"], count: 2 },
      { label: "merchant-b.example", url: "https://source/3", urls: ["https://source/3"], count: 1 },
    ]);
  });
});


describe("brand-neutral identity diagnosis", () => {
  const make = (brand: string, name: string, domain = "shop.example", sourceOnly = false) => {
    const record = product("Short factual description.");
    record.fields.vendor_brand = { value: brand } as ProductRecord["fields"]["vendor_brand"];
    return buildReportDiagnosis({ productRecord: record, technicalCheck: readableTechnicalCheck, completedTurns: 1,
      turns: [{ ordinal: 1, stage: "discovery", sources: [{ title: domain }], candidates: sourceOnly ? [] : [{ displayed_name: name, merchant_domain: domain, recommended: true }], target_observation: { candidate_set: "absent", recommendation: "not_recommended", retrievability: "not_retrieved" } }],
    });
  };
  for (const [brand, candidate] of [["River Tools", "River Tools Hand Grinder"], ["Moon Carry", "Moon Carry Air Carrier"], ["Fern Works", "Fern Works Ceramic Collection"]]) {
    it(`${brand}: distinguishes a brand suggestion from the submitted SKU`, () => {
      const d = make(brand!, candidate!);
      expect(d.outcome).toBe("absent");
      expect(d.identity_context.first_brand_candidate_turn).toBe(1);
      expect(d.identity_context.first_exact_product_candidate_turn).toBeNull();
      expect(d.identity_context.series_status).toBe("not independently assessed");
      expect(d.observed_result).toContain(candidate!);
      expect(d.next_action.rationale).toContain(candidate!);
      expect(d.next_action.title).not.toContain("rewrit");
    });
  }
  it("does not turn retailer-domain or source matches into brand inclusion", () => {
    const d = make("River Tools", "Other Brand Grinder");
    expect(d.identity_context.first_merchant_candidate_turn).toBe(1);
    expect(d.identity_context.first_brand_candidate_turn).toBeNull();
    expect(make("River Tools", "River Tools Grinder", "shop.example", true).identity_context.first_brand_candidate_turn).toBeNull();
  });
  it("requires whole brand tokens and preserves unknown matches", () => {
    expect(make("Fern", "Fernwood Planter").identity_context.first_brand_candidate_turn).toBeNull();
    expect(make("Rivér Tools", "River Tools Grinder").identity_context.first_brand_candidate_turn).toBe(1);
  });
});

it("uses only captured, source-referenced decision evidence in the next action", () => {
  const quote = "Option A works without electricity.";
  const turn = { ordinal: 1, stage: "discovery", shopping_answer: quote, sources: [{ source_id: "src_a", url: "https://example.com/a" }], candidates: [{ displayed_name: "Option A" }], target_observation: { candidate_set: "absent" } };
  const review = { ...turn, ordinal: 2, adaptive_decision: { action: "verify", assessment: {
    candidates: [{ name: "Option A", identity_quote: "Option A", turn_ordinal: 1, category_fit: "supported", needs: [{ need_id: "required_0", status: "supported", evidence_level: "cited_reference", quote, turn_ordinal: 1, source_ids: ["src_a"] }] }],
    demand_drift: false, decision_quote: "", decision_turn_ordinal: 1, proposed_action: "verify", need_ids: ["market"],
  } } };
  const input = { turns: [turn, review], completedTurns: 2, productRecord: product("Manual coffee grinder."), technicalCheck: readableTechnicalCheck };
  expect(buildReportDiagnosis(input).next_action.rationale).toContain(quote);
  review.adaptive_decision.assessment.candidates[0]!.needs[0]!.source_ids = ["invented"];
  expect(buildReportDiagnosis(input).decision_evidence).toEqual([]);
  review.adaptive_decision.assessment.candidates[0]!.needs[0]!.source_ids = ["src_a"];
  review.adaptive_decision.assessment.candidates[0]!.needs[0]!.quote = "Invented performance fact";
  expect(buildReportDiagnosis(input).decision_evidence).toEqual([]);
});
