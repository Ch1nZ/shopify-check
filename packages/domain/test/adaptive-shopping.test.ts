import { describe, expect, it } from "vitest";
import type { AdaptiveAssessment, BlindConversationContext } from "@mclab/contracts";
import { ADAPTIVE_SHOPPING_PROTOCOL, adaptiveBlindInput, decideNextTurn, evaluateAdaptiveAssessment, frozenBuyerNeeds, initialAdaptiveDecision, renderAdaptiveQuestion } from "../src";

function context(category = "aromatherapy necklace"): BlindConversationContext {
  return { buyer_brief: { schema_version: "guided-shopping/1.0", category, buyer_job: `Find a ${category} for everyday use`, target_market: "Hong Kong", use_cases: [], constraints: [], preferences: ["looks like everyday jewelry"], market_requirements: [], decision_dimensions: [], prohibited_fingerprints: [] }, protocol: ADAPTIVE_SHOPPING_PROTOCOL, completed_turns: [{ ordinal: 1, stage: "discovery", user_message: "What can I buy?", assistant_message: "Option Alpha suits the category and everyday use, and ships to Hong Kong. Option Beta suits the category and everyday use, and ships to Hong Kong. I recommend Option Alpha because these original needs are supported.", answer_shape: "shortlist", surfaced_candidate_names: [], sources: [{ source_id: "src_alpha", url: "https://example.com/alpha", title: "Alpha" }], adaptive_decision: initialAdaptiveDecision() }], usage: { turns: 1, model_calls: 4, search_requests: 1, input_tokens: 100, output_tokens: 100, cost_usd_micros: 1 } };
}
function assessment(ctx: BlindConversationContext, count = 2): AdaptiveAssessment {
  return { candidates: ["Option Alpha", "Option Beta"].slice(0, count).map(name => ({ name, identity_quote: name, turn_ordinal: 1, category_fit: "supported", needs: frozenBuyerNeeds(ctx.buyer_brief).filter(n => n.priority === "required").map(n => ({ need_id: n.id, status: "supported", evidence_level: "cited_reference", quote: `${name} suits the category and everyday use, and ships to Hong Kong.`, turn_ordinal: 1, source_ids: ["src_alpha"] })) })), demand_drift: false, decision_quote: "", decision_turn_ordinal: 1, proposed_action: "compare", need_ids: ["market"] };
}

describe("adaptive transition gate across five categories (30 predefined cases)", () => {
  for (const category of ["aromatherapy necklace", "baby carrier", "coffee grinder", "running shoe", "ceramic planter"]) {
    it(`${category}: no concrete products stays open`, () => {
      const ctx = context(category); const a = assessment(ctx, 0); a.proposed_action = "finish";
      expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("explore");
    });
    it(`${category}: unknown delivery is provisional`, () => {
      const ctx = context(category); const a = assessment(ctx);
      a.candidates.forEach(c => c.needs.find(n => n.need_id === "market")!.status = "unknown");
      expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("verify");
    });
    it(`${category}: conflicted stock cannot close candidates`, () => {
      const ctx = context(category); const a = assessment(ctx);
      a.candidates.forEach(c => { const n = c.needs.find(n => n.need_id === "market")!; n.status = "unknown"; n.evidence_level = "conflict"; });
      expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("verify");
    });
    it(`${category}: two cited suitable options permit comparison`, () => {
      const ctx = context(category); expect(evaluateAdaptiveAssessment(ctx, assessment(ctx)).action).toBe("compare");
    });
    it(`${category}: one supported final choice permits early finish`, () => {
      const ctx = context(category); const a = assessment(ctx, 1); a.proposed_action = "finish"; a.decision_quote = "I recommend Option Alpha because these original needs are supported.";
      expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("finish");
    });
    it(`${category}: demand drift reopens comparison`, () => {
      const ctx = context(category); ctx.completed_turns[0]!.stage = "comparison"; const a = assessment(ctx); a.demand_drift = true;
      expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("explore");
    });
  }
});

describe("adaptive evidence integrity and bounded execution", () => {
  it("communicates hard needs initially and evaluates the explicit budget", () => {
    const ctx = context();
    ctx.buyer_brief.constraints = ["usable without batteries"];
    ctx.buyer_brief.budget = { maximum_minor: 50000, currency: "HKD" };
    const question = renderAdaptiveQuestion(ctx, initialAdaptiveDecision());
    expect(question.message).toContain("usable without batteries");
    expect(question.message).toContain("500 HKD");
    const a = assessment(ctx, 1);
    a.candidates[0]!.needs = a.candidates[0]!.needs.filter(n => n.need_id !== "budget");
    a.proposed_action = "finish";
    a.decision_quote = "I recommend Option Alpha because these original needs are supported.";
    expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("verify");
  });
  it("rejects fabricated source IDs and quotes", () => {
    const ctx = context(); const a = assessment(ctx); a.candidates[0]!.needs[0]!.source_ids = ["src_invented"];
    expect(() => evaluateAdaptiveAssessment(ctx, a)).toThrow("unknown captured source");
    a.candidates[0]!.needs[0]!.source_ids = ["src_alpha"]; a.candidates[0]!.identity_quote = "Invented model";
    expect(() => evaluateAdaptiveAssessment(ctx, a)).toThrow("identity quote");
  });
  it("rejects conflict promoted into supported evidence", () => {
    const ctx = context(); const a = assessment(ctx); a.candidates[0]!.needs[0]!.evidence_level = "conflict";
    expect(() => evaluateAdaptiveAssessment(ctx, a)).toThrow("Unsupported evidence promotion");
  });
  it("rejects unknown and duplicate need identifiers", () => {
    const ctx = context(); const a = assessment(ctx); a.need_ids = ["minimalist"];
    expect(() => evaluateAdaptiveAssessment(ctx, a)).toThrow("unknown frozen need");
    a.need_ids = []; a.candidates[0]!.needs.push(a.candidates[0]!.needs[0]!);
    expect(() => evaluateAdaptiveAssessment(ctx, a)).toThrow("duplicate candidate need");
  });
  it("stops two unchanged evidence assessments", () => {
    const ctx = context(); const a = assessment(ctx); const first = evaluateAdaptiveAssessment(ctx, a);
    ctx.completed_turns[0]!.adaptive_decision = first;
    const second = evaluateAdaptiveAssessment(ctx, a); expect(second.no_progress_count).toBe(1);
    ctx.completed_turns[0]!.adaptive_decision = second;
    expect(evaluateAdaptiveAssessment(ctx, a)).toMatchObject({ action: "stop", reason: "no_progress" });
  });
  it("allows final review but no seventh observer at turn cap", () => {
    const ctx = context(); ctx.completed_turns = Array.from({ length: 6 }, (_, i) => ({ ...ctx.completed_turns[0]!, ordinal: i + 1 }));
    expect(decideNextTurn(ctx)).toMatchObject({ action: "start_turn", turn: { ordinal: 7 } });
    expect(evaluateAdaptiveAssessment(ctx, assessment(ctx))).toMatchObject({ action: "stop", reason: "turn_limit" });
  });
  it("is invariant to target identity and private classifier output", () => {
    const ctx = context(); const before = JSON.stringify(adaptiveBlindInput(ctx));
    const changed = { ...ctx, target_identity: { product_name: "Private Target B" } };
    changed.completed_turns = changed.completed_turns.map(t => ({ ...t, answer_shape: "decision", surfaced_candidate_names: ["Private Target B"], adaptive_decision: { target_included: true } }));
    expect(JSON.stringify(adaptiveBlindInput(changed))).toBe(before);
  });
  it("renders frozen preference without copying answer's invented minimalism", () => {
    const ctx = context(); ctx.completed_turns[0]!.assistant_message += " Only minimalist jewelry matters.";
    const d = { ...initialAdaptiveDecision(), action: "explore" as const, reason: "unmet_needs" as const, need_ids: ["preference_0"] };
    const q = renderAdaptiveQuestion(ctx, d);
    expect(q.message).toContain("Preference, not a requirement: looks like everyday jewelry");
    expect(q.message).not.toContain("minimalist");
    expect(q.message).toContain("New products are welcome");
  });
  it("observer followup verification remains open to replacement", () => {
    const q = renderAdaptiveQuestion(context(), { ...initialAdaptiveDecision(), action: "verify", reason: "unknown_evidence", need_ids: ["market"] });
    expect(q.message).toContain("other products are welcome");
    expect(q.message).toContain("checkout or seller confirmation");
  });
});


describe("general decision quality", () => {
  for (const category of ["coffee grinder", "baby carrier", "running shoe", "ceramic planter", "earrings"]) {
    it(`${category}: asks the unresolved hard need, not generic verification`, () => {
      const ctx = context(category); const a = assessment(ctx);
      a.candidates.forEach(c => { c.needs.find(n => n.need_id === "market")!.status = "unknown"; });
      const d = evaluateAdaptiveAssessment(ctx, a);
      expect(d).toMatchObject({ action: "verify", need_ids: ["market"] });
      expect(renderAdaptiveQuestion(ctx, d).message).toContain("Purchasable or deliverable to Hong Kong");
    });
    it(`${category}: one suitable option goes to decision despite unknown alternatives`, () => {
      const ctx = context(category); const a = assessment(ctx);
      a.candidates[1]!.needs.forEach(n => { n.status = "unknown"; });
      a.proposed_action = "verify"; a.need_ids = [];
      expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("compare");
    });
  }
  it("Markdown alone does not create progress or prevent a supported finish", () => {
    const ctx = context(); const a = assessment(ctx, 1);
    ctx.completed_turns[0]!.adaptive_decision = evaluateAdaptiveAssessment(ctx, a);
    ctx.completed_turns[0]!.assistant_message += " **Option Alpha**";
    a.candidates[0]!.name = "**Option Alpha**"; a.candidates[0]!.identity_quote = "**Option Alpha**";
    expect(evaluateAdaptiveAssessment(ctx, a).no_progress_count).toBe(1);
    a.proposed_action = "finish"; a.decision_quote = "I recommend Option Alpha because these original needs are supported.";
    expect(evaluateAdaptiveAssessment(ctx, a).action).toBe("finish");
  });
  it("stops a repeated evidence task even when displayed candidate names vary", () => {
    const ctx = context(); const a = assessment(ctx);
    a.candidates.forEach(c => { c.needs.find(n => n.need_id === "market")!.status = "unknown"; });
    const d = evaluateAdaptiveAssessment(ctx, a);
    ctx.completed_turns = [1, 2].map(ordinal => ({ ...ctx.completed_turns[0]!, ordinal, adaptive_decision: d }));
    a.candidates[0]!.name = "Alpha"; a.candidates[0]!.identity_quote = "Option Alpha";
    expect(evaluateAdaptiveAssessment(ctx, a)).toMatchObject({ action: "stop", reason: "no_progress" });
  });
  it("keeps hard constraints and explicit budget in the initial buyer question", () => {
    const ctx = context("coffee grinder"); ctx.buyer_brief.constraints = ["Must operate without electricity."];
    ctx.buyer_brief.budget = { maximum_minor: 20000, currency: "HKD" };
    const q = renderAdaptiveQuestion(ctx, initialAdaptiveDecision());
    expect(q.message).toContain("Must operate without electricity.");
    expect(q.message).toContain("200 HKD"); expect(q.message).not.toContain("..");
  });
});
