import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdaptiveAssessmentSchema, type BlindConversationContext } from "@mclab/contracts";
import { ADAPTIVE_SHOPPING_PROTOCOL, initialAdaptiveDecision, renderAdaptiveQuestion } from "@mclab/domain";
import { buildAdaptivePlannerPrompt, buildQueryAuditPrompt, buildShoppingObserverPrompt, runQueryAuditor, runQueryGenerator } from "../src";

const context: BlindConversationContext = { buyer_brief: { schema_version: "guided-shopping/1.0", category: "necklace", buyer_job: "Find wearable aromatherapy", target_market: "Hong Kong", use_cases: [], constraints: [], preferences: ["everyday jewelry"], market_requirements: [], decision_dimensions: [], prohibited_fingerprints: [] }, protocol: ADAPTIVE_SHOPPING_PROTOCOL, completed_turns: [], usage: { turns: 0, model_calls: 0, search_requests: 0, input_tokens: 0, output_tokens: 0, cost_usd_micros: 0 } };

describe("adaptive adapter contracts", () => {
  it("every strict-schema property is required without URI format", () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const o = value as Record<string, unknown>;
      if (o.type === "object") expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      expect(o.format).not.toBe("uri"); Object.values(o).forEach(visit);
    };
    visit(z.toJSONSchema(AdaptiveAssessmentSchema));
  });
  it("initial question uses no paid model generation", async () => {
    const result = await runQueryGenerator({ apiKey: "invalid-no-network", policy: { role: "query_generator", route_key: "planner", reasoning_effort: "medium", search: { enabled: false }, max_output_tokens: 6000, max_call_cost_usd_micros: 100000, max_retries: 0, allow_provider_fallback: false }, context, turn: ADAPTIVE_SHOPPING_PROTOCOL.turns[0]! });
    expect(result.usage.total_tokens).toBe(0); expect(result.output.message).toContain("Hong Kong");
  });
  it("frozen initial question skips the auditor model", async () => {
    const result = await runQueryAuditor({
      apiKey: "invalid-no-network",
      policy: { role: "query_auditor", route_key: "planner", reasoning_effort: "medium", search: { enabled: false }, max_output_tokens: 2000, max_call_cost_usd_micros: 50000, max_retries: 0, allow_provider_fallback: false },
      context,
      turn: ADAPTIVE_SHOPPING_PROTOCOL.turns[0]!,
      query: renderAdaptiveQuestion(context, initialAdaptiveDecision()),
      targetIdentity: { schema_version: "guided-shopping/1.0", canonical_product_url: "https://example.com/target", merchant_domains: ["example.com"], brand_names: ["Private Brand"], product_names: ["Private Product"], product_url_aliases: [], normalized_sku_ids: [] },
    });
    expect(result.usage.total_tokens).toBe(0);
    expect(result.output.decision).toBe("approved");
    expect(result.raw_output).toMatchObject({ audit_method: "frozen_initial_question" });
  });
  it("planner receives raw evidence but no target-aware annotations", () => {
    const ctx = { ...context, completed_turns: [{ ordinal: 1, stage: "discovery" as const, user_message: "Find options", assistant_message: "Candidate shown", answer_shape: "shortlist" as const, surfaced_candidate_names: ["PRIVATE_MARKER"], adaptive_decision: { target: "PRIVATE_MARKER" } }] };
    expect(buildAdaptivePlannerPrompt(ctx)).not.toContain("PRIVATE_MARKER");
    const q = renderAdaptiveQuestion(context, initialAdaptiveDecision());
    expect(buildShoppingObserverPrompt({ context: ctx, query: q })).not.toContain("PRIVATE_MARKER");
  });
  it("audit explicitly rejects semantic additions while allowing omissions", () => {
    const prompt = buildQueryAuditPrompt({ context, turn: ADAPTIVE_SHOPPING_PROTOCOL.turns[0]!, query: renderAdaptiveQuestion(context, initialAdaptiveDecision()), targetIdentity: { schema_version: "guided-shopping/1.0", canonical_product_url: "https://example.com/target", merchant_domains: ["example.com"], brand_names: ["Private Brand"], product_names: ["Private Product"], product_url_aliases: [], normalized_sku_ids: [] } });
    expect(prompt).toContain("Everyday jewelry does not entail minimalist jewelry");
    expect(prompt).toContain("Do not reject mere omission");
    expect(prompt).toContain("Reject ANY newly introduced requirement or preference");
  });
});
