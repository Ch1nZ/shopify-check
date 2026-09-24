import { describe, expect, it } from "vitest";
import { capturedQuote, anchorEvidenceQuotes, recoverAdaptiveEvidence } from "../src/evidence-quotes";
import { ADAPTIVE_SHOPPING_PROTOCOL, evaluateAdaptiveAssessment, frozenBuyerNeeds } from "@mclab/domain";
import type { AdaptiveAssessment, BlindConversationContext } from "@mclab/contracts";

describe("captured evidence anchoring", () => {
  it("restores raw bold spans and opening-letter case from the incident pattern", () => {
    expect(capturedQuote("Available on **Pinkoi** (ships locally)", "Available on Pinkoi")).toBe("Available on **Pinkoi");
    expect(capturedQuote("A steel locket pendant", "a steel locket pendant")).toBe("A steel locket pendant");
    expect(capturedQuote("Price: `HKD 200` today", "Price: HKD 200 today")).toBe("Price: `HKD 200` today");
    expect(capturedQuote("Ships\n  to Hong Kong", "Ships to Hong Kong")).toBe("Ships\n  to Hong Kong");
  });
  it("keeps verbatim spans and never repairs changed facts or arithmetic", () => {
    for (const [answer, quote] of [
      ["Ships to Hong Kong", "Ships to Hong Kong"],
      ["Does not ship to Hong Kong", "Ships to Hong Kong"],
      ["Power is 20 mW", "Power is 20 MW"],
      ["Price HKD 200", "Price HKD 20"],
      ["2*3 equals 6", "23 equals 6"],
      ["Ships elsewhere. Returns in Hong Kong", "Ships to Hong Kong"],
    ]) expect(capturedQuote(answer!, quote!)).toBe(quote);
  });
  it("passes the strict gate after anchoring, while rejecting invented quotes, sources and wrong turns", () => {
    const ctx: BlindConversationContext = {
      buyer_brief: { schema_version: "guided-shopping/1.0", category: "necklace", buyer_job: "Everyday use", target_market: "Hong Kong", use_cases: [], constraints: [], preferences: [], market_requirements: [], decision_dimensions: [], prohibited_fingerprints: [] },
      protocol: ADAPTIVE_SHOPPING_PROTOCOL,
      completed_turns: [{ ordinal: 1, stage: "discovery", user_message: "Find options", assistant_message: "Option Alpha is available on **Pinkoi** in Hong Kong.", answer_shape: "single_option", surfaced_candidate_names: [], sources: [{ source_id: "src_1", url: "https://example.com", title: "Listing" }] }],
      usage: { turns: 1, model_calls: 4, search_requests: 1, input_tokens: 100, output_tokens: 100, cost_usd_micros: 1 },
    };
    const raw: AdaptiveAssessment = {
      candidates: [{ name: "Option Alpha", identity_quote: "Option Alpha", turn_ordinal: 1, category_fit: "supported", needs: frozenBuyerNeeds(ctx.buyer_brief).map(n => ({ need_id: n.id, status: "supported", evidence_level: "assistant_assertion", quote: "available on Pinkoi", turn_ordinal: 1, source_ids: ["src_1"] })) }],
      demand_drift: false, decision_quote: "", decision_turn_ordinal: 1, proposed_action: "verify", need_ids: [],
    };
    expect(() => evaluateAdaptiveAssessment(ctx, raw)).toThrow("Need evidence quote");
    const anchored = anchorEvidenceQuotes(ctx, raw);
    expect(evaluateAdaptiveAssessment(ctx, anchored).action).toBe("verify");
    expect(raw.candidates[0]!.needs[0]!.quote).toBe("available on Pinkoi");
    expect(anchored.candidates[0]!.needs[0]!.evidence_level).toBe("assistant_assertion");
    for (const patch of [{ quote: "Free shipping guaranteed" }, { source_ids: ["invented"] }, { turn_ordinal: 2 }]) {
      const invalid = structuredClone(raw);
      Object.assign(invalid.candidates[0]!.needs[0]!, patch);
      expect(() => evaluateAdaptiveAssessment(ctx, anchorEvidenceQuotes(ctx, invalid))).toThrow();
      const recovered = recoverAdaptiveEvidence(ctx, invalid);
      expect(evaluateAdaptiveAssessment(ctx, recovered).action).toBe("verify");
      expect(recovered.candidates[0]!.needs[0]!).toMatchObject({ status: "unknown", evidence_level: "unknown", quote: "", source_ids: [] });
    }
  });
});
