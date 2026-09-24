import type { BlindConversationContext, GeneratedShoppingQuery } from "@mclab/contracts";
import { AdaptiveDecisionSchema } from "@mclab/contracts";
import { initialAdaptiveDecision } from "@mclab/domain";

// No interpolation: this recovery question introduces no name, fingerprint,
// buyer condition, shortlist closure, or unsupported recommendation request.
export const ADAPTIVE_REPAIR_QUESTION = "Please check the original requirements against the products discussed. Use current sources and identify missing or conflicting information. Other options are welcome if the original requirements are not met.";

export function adaptiveRepairQuery(context: BlindConversationContext): GeneratedShoppingQuery {
  const previous = AdaptiveDecisionSchema.safeParse(context.completed_turns.at(-1)?.adaptive_decision);
  return {
    message: ADAPTIVE_REPAIR_QUESTION,
    used_constraint_indexes: [],
    naturalness_note: "Fixed target-blind verification template after question review.",
    adaptive_decision: { ...(previous.success ? previous.data : initialAdaptiveDecision()), action: "verify", reason: "unknown_evidence", need_ids: [], candidate_names: [], assessment: null },
  };
}
