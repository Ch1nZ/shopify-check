import {
  BlindConversationContextSchema,
  ShoppingProtocolSchema,
  type BlindConversationContext,
  type ModelRolePolicy,
  type ShoppingBudget,
  type ShoppingProtocol,
  type ShoppingSessionEvent,
  type ShoppingSessionStatus,
  type ShoppingUsage,
} from "@mclab/contracts";
import { isAdaptiveProtocol } from "./adaptive-shopping";

export const MAX_QUERY_REVISIONS = 2;

export const CONTROLLED_SHOPPING_PROTOCOL: ShoppingProtocol = ShoppingProtocolSchema.parse({
  schema_version: "guided-shopping/1.0",
  protocol_id: "conversational-narrowing",
  protocol_revision: "2026-09-v4",
  minimum_turns: 4,
  maximum_turns: 6,
  target_blind_controller: true,
  target_may_be_injected: false,
  preserve_single_conversation: true,
  turns: [
    {
      ordinal: 1,
      stage: "discovery",
      objective: "Ask a natural unbranded question for the primary persona that opens a meaningfully bounded, target-market-relevant, but non-unique product candidate set.",
      available_constraint_indexes: [],
      allowed_answer_shapes: ["no_concrete_options", "single_option", "shortlist", "large_candidate_set"],
      required: true,
    },
    {
      ordinal: 2,
      stage: "refinement",
      objective: "Add one or two ordinary buyer considerations from the approved brief without naming or fingerprinting a target.",
      available_constraint_indexes: [0, 1],
      allowed_answer_shapes: ["no_concrete_options", "single_option", "shortlist", "large_candidate_set"],
      required: true,
    },
    {
      ordinal: 3,
      stage: "shortlist",
      objective: "Request concrete options or narrow an oversized candidate set using the approved brief and prior answer.",
      available_constraint_indexes: Array.from({ length: 22 }, (_, index) => index + 2),
      allowed_answer_shapes: ["single_option", "shortlist", "large_candidate_set", "comparison"],
      required: false,
    },
    {
      ordinal: 4,
      stage: "comparison",
      objective: "Compare only options already surfaced in the conversation using relevant buyer priorities and ordinary category-level decision criteria.",
      available_constraint_indexes: Array.from({ length: 24 }, (_, index) => index),
      allowed_answer_shapes: ["comparison", "decision"],
      required: true,
    },
    {
      ordinal: 5,
      stage: "decision",
      objective: "Ask for a final choice, visible tradeoffs, and the evidence supporting that choice.",
      available_constraint_indexes: [],
      allowed_answer_shapes: ["decision"],
      required: true,
    },
    {
      ordinal: 6,
      stage: "caveat_check",
      objective: "Ask for unresolved facts, purchase risks, and source limitations without reopening discovery.",
      available_constraint_indexes: [],
      allowed_answer_shapes: ["decision"],
      required: false,
    },
  ],
});

export const DEFAULT_ROLE_POLICIES: readonly ModelRolePolicy[] = [
  {
    role: "query_generator",
    route_key: "synthesizer",
    reasoning_effort: "high",
    search: { enabled: false },
    max_output_tokens: 2_000,
    max_call_cost_usd_micros: 50_000,
    max_retries: 0,
    allow_provider_fallback: false,
  },
  {
    role: "query_auditor",
    route_key: "planner",
    reasoning_effort: "high",
    search: { enabled: false },
    max_output_tokens: 2_000,
    max_call_cost_usd_micros: 50_000,
    max_retries: 0,
    allow_provider_fallback: false,
  },
  {
    role: "shopping_observer",
    route_key: "observer",
    reasoning_effort: "medium",
    search: {
      enabled: true,
      engine: "native",
      max_total_results: 5,
      max_search_requests: 1,
    },
    max_output_tokens: 4_000,
    max_call_cost_usd_micros: 250_000,
    max_retries: 0,
    allow_provider_fallback: false,
  },
  {
    role: "result_classifier",
    route_key: "planner",
    reasoning_effort: "high",
    search: { enabled: false },
    max_output_tokens: 3_000,
    max_call_cost_usd_micros: 75_000,
    max_retries: 0,
    allow_provider_fallback: false,
  },
] as const;

export const ADAPTIVE_SHOPPING_PROTOCOL: ShoppingProtocol = ShoppingProtocolSchema.parse({
  ...CONTROLLED_SHOPPING_PROTOCOL,
  protocol_id: "evidence-driven-shopping",
  protocol_revision: "2026-09-adaptive-v1",
  minimum_turns: 2,
  turns: CONTROLLED_SHOPPING_PROTOCOL.turns.map(turn => ({ ...turn, stage: turn.ordinal === 1 ? "discovery" : "refinement", objective: "Review captured evidence against frozen buyer needs and select exploration, verification, comparison, or stop.", available_constraint_indexes: Array.from({ length: 24 }, (_, i) => i), required: false })),
});
export const ADAPTIVE_ROLE_POLICIES: readonly ModelRolePolicy[] = DEFAULT_ROLE_POLICIES.map(policy => policy.role === "query_generator" ? { ...policy, route_key: "planner", reasoning_effort: "high", max_output_tokens: 6_000, max_call_cost_usd_micros: 100_000 } : policy);

export const ROLE_CONTEXT_BOUNDARIES = {
  query_generator: {
    buyer_brief: true,
    conversation_transcript: true,
    target_identity: false,
    target_observations: false,
  },
  query_auditor: {
    buyer_brief: true,
    conversation_transcript: true,
    target_identity: true,
    target_observations: false,
  },
  shopping_observer: {
    buyer_brief: false,
    conversation_transcript: true,
    target_identity: false,
    target_observations: false,
  },
  result_classifier: {
    buyer_brief: true,
    conversation_transcript: true,
    target_identity: true,
    target_observations: true,
  },
} as const satisfies Record<ModelRolePolicy["role"], {
  buyer_brief: boolean;
  conversation_transcript: boolean;
  target_identity: boolean;
  target_observations: boolean;
}>;

export type ControllerDecision =
  | { action: "start_turn"; turn: ShoppingProtocol["turns"][number] }
  | { action: "complete"; reason: "protocol_complete" | "decision_reached" }
  | { action: "stop"; reason: "budget_exhausted" };

export function decideNextTurn(rawContext: BlindConversationContext): ControllerDecision {
  const context = BlindConversationContextSchema.parse(rawContext);
  const completed = context.completed_turns.length;
  if (isAdaptiveProtocol(context.protocol)) {
    // The last slot may contain only the final evidence review, never a seventh
    // observer request. This lets a supported sixth answer finish normally.
    if (completed > context.protocol.maximum_turns) return { action: "stop", reason: "budget_exhausted" };
    return { action: "start_turn", turn: context.protocol.turns[completed] ?? { ...context.protocol.turns.at(-1)!, ordinal: completed + 1 } };
  }
  if (completed >= context.protocol.maximum_turns) {
    return { action: "complete", reason: "protocol_complete" };
  }
  if (budgetAtLimit(context.protocol, context.usage)) {
    return { action: "stop", reason: "budget_exhausted" };
  }

  const last = context.completed_turns.at(-1);
  if (
    completed >= context.protocol.minimum_turns &&
    last?.answer_shape === "decision" &&
    last.stage === "decision"
  ) {
    const caveatTurn = context.protocol.turns.find((turn) => turn.stage === "caveat_check");
    if (caveatTurn && completed < context.protocol.maximum_turns) {
      return { action: "start_turn", turn: caveatTurn };
    }
    return { action: "complete", reason: "decision_reached" };
  }

  const next = context.protocol.turns[completed];
  return next
    ? { action: "start_turn", turn: next }
    : { action: "complete", reason: "protocol_complete" };
}

function budgetAtLimit(protocol: ShoppingProtocol, usage: ShoppingUsage): boolean {
  return usage.turns >= protocol.maximum_turns;
}

export type InvocationReservation = {
  model_calls: number;
  search_requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
};

export function admitInvocation(
  budget: ShoppingBudget,
  usage: ShoppingUsage,
  reservation: InvocationReservation,
): { admitted: true } | { admitted: false; dimension: keyof ShoppingBudget } {
  const checks: Array<[keyof ShoppingBudget, number, number]> = [
    ["max_model_calls", usage.model_calls, reservation.model_calls],
    ["max_search_requests", usage.search_requests, reservation.search_requests],
  ];
  for (const [dimension, used, requested] of checks) {
    if (used + requested > budget[dimension]) return { admitted: false, dimension };
  }
  return { admitted: true };
}

export type ShoppingSessionState = {
  status: ShoppingSessionStatus;
  current_turn: number;
  completed_turns: number;
};

export function applyShoppingSessionEvent(
  state: ShoppingSessionState,
  event: ShoppingSessionEvent,
): ShoppingSessionState {
  switch (event.type) {
    case "PROTOCOL_APPROVED":
      requireStatus(state, ["draft"]);
      return { ...state, status: "protocol_ready" };
    case "SESSION_QUEUED":
      requireStatus(state, ["protocol_ready"]);
      return { ...state, status: "queued" };
    case "TURN_STARTED":
      requireStatus(state, ["queued", "running"]);
      if (event.turn_ordinal !== state.completed_turns + 1) {
        throw new Error("Turn start is not contiguous.");
      }
      return { ...state, status: "running", current_turn: event.turn_ordinal };
    case "TURN_COMPLETED":
      requireStatus(state, ["running"]);
      if (event.turn_ordinal !== state.current_turn) throw new Error("Completed turn does not match active turn.");
      return { ...state, completed_turns: state.completed_turns + 1 };
    case "SESSION_COMPLETED":
      requireStatus(state, ["running"]);
      return { ...state, status: "completed" };
    case "SESSION_INCOMPLETE":
      requireStatus(state, ["queued", "running"]);
      return { ...state, status: "incomplete" };
    case "BUDGET_EXHAUSTED":
      requireStatus(state, ["queued", "running"]);
      return { ...state, status: "budget_exhausted" };
    case "SESSION_CANCELLED":
      requireStatus(state, ["draft", "protocol_ready", "queued", "running"]);
      return { ...state, status: "cancelled" };
  }
}

function requireStatus(state: ShoppingSessionState, allowed: ShoppingSessionStatus[]): void {
  if (!allowed.includes(state.status)) {
    throw new Error(`Event is not allowed while session is ${state.status}.`);
  }
}
