import { describe, expect, it } from "vitest";

import type { BlindConversationContext, ShoppingBudget, ShoppingUsage } from "@mclab/contracts";

import {
  ADAPTIVE_ROLE_POLICIES,
  CONTROLLED_SHOPPING_PROTOCOL,
  DEFAULT_ROLE_POLICIES,
  MAX_QUERY_REVISIONS,
  ROLE_CONTEXT_BOUNDARIES,
  admitInvocation,
  applyShoppingSessionEvent,
  decideNextTurn,
} from "../src";

const usage: ShoppingUsage = {
  turns: 0,
  model_calls: 0,
  search_requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_usd_micros: 0,
};

function context(completed_turns: BlindConversationContext["completed_turns"]): BlindConversationContext {
  return {
    buyer_brief: {
      schema_version: "guided-shopping/1.0",
      category: "aromatherapy necklace",
      target_market: "Hong Kong",
      buyer_job: "Find a necklace suitable for everyday wear that can carry essential oil.",
      use_cases: ["everyday office wear"],
      constraints: ["under HKD 800", "skin-friendly material", "local delivery"],
      preferences: ["discreet appearance"],
      decision_dimensions: [],
      market_requirements: ["available for purchase in Hong Kong"],
      prohibited_fingerprints: [],
    },
    protocol: CONTROLLED_SHOPPING_PROTOCOL,
    completed_turns,
    usage: { ...usage, turns: completed_turns.length },
  };
}

describe("controlled shopping protocol", () => {
  it("permits two audited query revisions before treating the turn as invalid", () => {
    expect(MAX_QUERY_REVISIONS).toBe(2);
  });

  it("uses Gemini Flash for searched answers and Luna high on non-search shopping roles", () => {
    expect(DEFAULT_ROLE_POLICIES.find((policy) => policy.role === "query_generator")).toMatchObject({
      route_key: "synthesizer",
      reasoning_effort: "high",
      search: { enabled: false },
    });
    expect(DEFAULT_ROLE_POLICIES.find((policy) => policy.role === "shopping_observer")).toMatchObject({
      route_key: "observer",
      reasoning_effort: "medium",
      search: { enabled: true },
    });
    expect(DEFAULT_ROLE_POLICIES.find((policy) => policy.role === "query_auditor")).toMatchObject({
      route_key: "planner",
      reasoning_effort: "high",
    });
    expect(DEFAULT_ROLE_POLICIES.find((policy) => policy.role === "result_classifier")).toMatchObject({
      route_key: "planner",
      reasoning_effort: "high",
    });
    expect(ADAPTIVE_ROLE_POLICIES.find((policy) => policy.role === "query_generator")).toMatchObject({
      route_key: "planner",
      reasoning_effort: "high",
    });
  });

  it("starts with unbranded discovery and exposes no target field to the controller", () => {
    const input = context([]);
    expect(Object.keys(input)).toEqual(["buyer_brief", "protocol", "completed_turns", "usage"]);
    expect(decideNextTurn(input)).toMatchObject({
      action: "start_turn",
      turn: { ordinal: 1, stage: "discovery" },
    });
    expect(ROLE_CONTEXT_BOUNDARIES.query_generator.target_identity).toBe(false);
    expect(ROLE_CONTEXT_BOUNDARIES.shopping_observer.target_identity).toBe(false);
    expect(ROLE_CONTEXT_BOUNDARIES.result_classifier.target_identity).toBe(true);
  });

  it("preserves one ordered conversation through comparison and decision", () => {
    const completed = [
      ["discovery", "shortlist"],
      ["refinement", "shortlist"],
      ["shortlist", "comparison"],
    ].map(([stage, answer_shape], index) => ({
      ordinal: index + 1,
      stage: stage as "discovery" | "refinement" | "shortlist",
      user_message: `Question ${index + 1}`,
      assistant_message: `Answer ${index + 1}`,
      answer_shape: answer_shape as "shortlist" | "comparison",
      surfaced_candidate_names: ["Option A", "Option B"],
    }));
    expect(decideNextTurn(context(completed))).toMatchObject({
      action: "start_turn",
      turn: { ordinal: 4, stage: "comparison" },
    });
  });

  it("completes normally after the maximum turn instead of reporting budget exhaustion", () => {
    const completed = CONTROLLED_SHOPPING_PROTOCOL.turns.map((turn) => ({
      ordinal: turn.ordinal,
      stage: turn.stage,
      user_message: `Question ${turn.ordinal}`,
      assistant_message: `Answer ${turn.ordinal}`,
      answer_shape: turn.stage === "comparison" ? "comparison" as const : turn.stage === "decision" || turn.stage === "caveat_check" ? "decision" as const : "shortlist" as const,
      surfaced_candidate_names: ["Option A", "Option B"],
    }));
    expect(decideNextTurn(context(completed))).toEqual({
      action: "complete",
      reason: "protocol_complete",
    });
  });

  it("guards deterministic call and search counts without stopping on estimated token or cost usage", () => {
    const budget: ShoppingBudget = {
      max_turns: 6,
      max_model_calls: 20,
      max_search_requests: 18,
      max_input_tokens: 200_000,
      max_output_tokens: 40_000,
      max_cost_usd_micros: 500_000,
    };
    expect(admitInvocation(budget, usage, {
      model_calls: 1,
      search_requests: 3,
      input_tokens: 10_000,
      output_tokens: 4_000,
      cost_usd_micros: 100_000,
    })).toEqual({ admitted: true });
    expect(admitInvocation(budget, { ...usage, cost_usd_micros: 450_000 }, {
      model_calls: 1,
      search_requests: 0,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cost_usd_micros: 100_000_000,
    })).toEqual({ admitted: true });
  });

  it("rejects out-of-order state transitions", () => {
    expect(() => applyShoppingSessionEvent(
      { status: "draft", current_turn: 0, completed_turns: 0 },
      { type: "TURN_STARTED", turn_ordinal: 1, occurred_at: "2026-09-02T00:00:00.000Z" },
    )).toThrow(/not allowed/);
  });
});
