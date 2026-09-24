import { z } from "zod";

// No free-form question: condition-bearing text is rendered from the frozen brief.
export const AdaptiveAssessmentSchema = z.object({
  candidates: z.array(z.object({
    name: z.string().min(1).max(200),
    identity_quote: z.string().min(1).max(400),
    turn_ordinal: z.int().min(1).max(8),
    category_fit: z.enum(["supported", "unknown", "contradicted"]),
    needs: z.array(z.object({
      need_id: z.string().min(1).max(40),
      status: z.enum(["supported", "unknown", "contradicted"]),
      evidence_level: z.enum(["assistant_assertion", "cited_reference", "conflict", "unknown"]),
      quote: z.string().max(700),
      turn_ordinal: z.int().min(1).max(8),
      source_ids: z.array(z.string().max(100)).max(5),
    })).max(30),
  })).max(6),
  demand_drift: z.boolean(),
  decision_quote: z.string().max(600),
  decision_turn_ordinal: z.int().min(1).max(8),
  proposed_action: z.enum(["explore", "verify", "compare", "finish"]),
  need_ids: z.array(z.string().max(40)).max(2),
});
export type AdaptiveAssessment = z.infer<typeof AdaptiveAssessmentSchema>;

export const AdaptiveDecisionSchema = z.object({
  version: z.literal("adaptive-controller/1.0"),
  action: z.enum(["explore", "verify", "compare", "finish", "stop"]),
  reason: z.enum(["initial_discovery", "unmet_needs", "unknown_evidence", "comparison_ready", "decision_supported", "no_progress", "turn_limit"]),
  need_ids: z.array(z.string()).max(2),
  candidate_names: z.array(z.string()).max(6),
  evidence_signatures: z.array(z.string()).max(200),
  no_progress_count: z.int().nonnegative(),
  repair_count: z.int().nonnegative(),
  assessment: AdaptiveAssessmentSchema.nullable(),
});
export type AdaptiveDecision = z.infer<typeof AdaptiveDecisionSchema>;
