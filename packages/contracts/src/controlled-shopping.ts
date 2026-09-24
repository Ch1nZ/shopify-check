import { z } from "zod";

import {
  CONTRACT_VERSIONS,
  ModelRouteKeySchema,
  ReasoningEffortSchema,
} from "./base";

export const ShoppingRoleSchema = z.enum([
  "query_generator",
  "query_auditor",
  "shopping_observer",
  "result_classifier",
]);
export type ShoppingRole = z.infer<typeof ShoppingRoleSchema>;

export const ShoppingTurnStageSchema = z.enum([
  "discovery",
  "refinement",
  "shortlist",
  "comparison",
  "decision",
  "caveat_check",
]);
export type ShoppingTurnStage = z.infer<typeof ShoppingTurnStageSchema>;

export const PotentialBuyerPersonaSchema = z.object({
  label: z.string().trim().min(2).max(120),
  situation: z.string().trim().min(2).max(500),
  goals: z.array(z.string().trim().min(2).max(200)).min(1).max(5),
  priorities: z.array(z.string().trim().min(2).max(200)).min(1).max(6),
  concerns: z.array(z.string().trim().min(2).max(200)).max(6),
  natural_language: z.array(z.string().trim().min(2).max(240)).min(1).max(6),
  evidence_strength: z.enum(["high", "medium", "low"]),
});
export type PotentialBuyerPersona = z.infer<typeof PotentialBuyerPersonaSchema>;

export const ProductDecisionDimensionSchema = z.object({
  label: z.string().trim().min(2).max(160),
  applies_to: z.string().trim().min(2).max(120),
  priority: z.enum(["required", "preference", "risk_check"]),
  origin: z.enum(["merchant_evidence", "category_research", "user_supplied", "inferred"]),
  fingerprint_risk: z.enum(["low", "medium", "high"]),
  evidence_strength: z.enum(["high", "medium", "low"]),
});
export type ProductDecisionDimension = z.infer<typeof ProductDecisionDimensionSchema>;

export const ProductUnderstandingSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.guidedShopping),
  product_summary: z.string().trim().min(20).max(1_500),
  ordinary_category: z.string().trim().min(2).max(120),
  product_form: z.string().trim().min(2).max(160),
  mechanism: z.string().trim().min(2).max(500),
  target_market: z.string().trim().min(2).max(80),
  product_facts: z.array(z.object({
    aspect: z.string().trim().min(2).max(120),
    value: z.string().trim().min(2).max(500),
    applies_to: z.string().trim().min(2).max(120),
    evidence_status: z.enum(["verified", "merchant_claim", "inferred", "unknown", "conflicted"]),
    source_urls: z.array(z.string().regex(/^https:\/\/[^\s]+$/)).max(8),
  })).min(1).max(24),
  potential_buyer_personas: z.array(PotentialBuyerPersonaSchema).min(1).max(3),
  decision_dimensions: z.array(ProductDecisionDimensionSchema).min(1).max(16),
  market_requirements: z.array(z.string().trim().min(2).max(200)).max(8),
  purchase_risks: z.array(z.string().trim().min(2).max(240)).max(10),
  prohibited_fingerprints: z.array(z.string().trim().min(2).max(200)).max(12),
  unresolved_questions: z.array(z.string().trim().min(2).max(300)).max(12),
});
export type ProductUnderstanding = z.infer<typeof ProductUnderstandingSchema>;

export const BuyerBriefSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.guidedShopping),
  category: z.string().trim().min(2).max(120),
  target_market: z.string().trim().min(2).max(80),
  buyer_job: z.string().trim().min(2).max(500),
  use_cases: z.array(z.string().trim().min(2).max(160)).max(8).default([]),
  constraints: z.array(z.string().trim().min(2).max(160)).max(12),
  preferences: z.array(z.string().trim().min(2).max(160)).max(12),
  primary_persona: PotentialBuyerPersonaSchema.optional(),
  decision_dimensions: z.array(ProductDecisionDimensionSchema).max(16).default([]),
  market_requirements: z.array(z.string().trim().min(2).max(200)).max(8).default([]),
  prohibited_fingerprints: z.array(z.string().trim().min(2).max(200)).max(12).default([]),
  budget: z.object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    maximum_minor: z.int().nonnegative(),
  }).optional(),
});
export type BuyerBrief = z.infer<typeof BuyerBriefSchema>;

export const TargetIdentitySchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.guidedShopping),
  canonical_product_url: z.url({ protocol: /^https$/ }),
  merchant_domains: z.array(z.string().trim().min(3).max(253)).min(1).max(20),
  brand_names: z.array(z.string().trim().min(2).max(200)).min(1).max(20),
  product_names: z.array(z.string().trim().min(2).max(300)).min(1).max(30),
  product_url_aliases: z.array(z.url({ protocol: /^https$/ })).max(30),
  normalized_sku_ids: z.array(z.string().trim().min(1).max(200)).max(100),
});
export type TargetIdentity = z.infer<typeof TargetIdentitySchema>;

export const ShoppingProtocolTurnSchema = z.object({
  ordinal: z.int().min(1).max(8),
  stage: ShoppingTurnStageSchema,
  objective: z.string().trim().min(2).max(500),
  available_constraint_indexes: z.array(z.int().nonnegative()).max(24),
  allowed_answer_shapes: z.array(z.enum([
    "no_concrete_options",
    "single_option",
    "shortlist",
    "large_candidate_set",
    "comparison",
    "decision",
  ])).min(1),
  required: z.boolean(),
});

export const ShoppingProtocolSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.guidedShopping),
  protocol_id: z.string().trim().min(3).max(120),
  protocol_revision: z.string().trim().min(1).max(40),
  minimum_turns: z.int().min(2).max(8),
  maximum_turns: z.int().min(2).max(8),
  turns: z.array(ShoppingProtocolTurnSchema).min(2).max(8),
  target_blind_controller: z.literal(true),
  target_may_be_injected: z.literal(false),
  preserve_single_conversation: z.literal(true),
}).superRefine((value, context) => {
  if (value.minimum_turns > value.maximum_turns) {
    context.addIssue({ code: "custom", message: "minimum_turns exceeds maximum_turns" });
  }
  const ordinals = value.turns.map((turn) => turn.ordinal);
  if (new Set(ordinals).size !== ordinals.length || ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    context.addIssue({ code: "custom", message: "turn ordinals must be unique and contiguous" });
  }
  if (value.turns.length !== value.maximum_turns) {
    context.addIssue({ code: "custom", message: "turn count must equal maximum_turns" });
  }
});
export type ShoppingProtocol = z.infer<typeof ShoppingProtocolSchema>;

export const ModelRolePolicySchema = z.object({
  role: ShoppingRoleSchema,
  route_key: ModelRouteKeySchema,
  reasoning_effort: ReasoningEffortSchema,
  search: z.object({
    enabled: z.boolean(),
    engine: z.enum(["native", "exa", "parallel", "perplexity"]).optional(),
    max_total_results: z.int().min(1).max(20).optional(),
    max_search_requests: z.int().min(1).max(10).optional(),
  }),
  max_output_tokens: z.int().min(128).max(16_000),
  max_call_cost_usd_micros: z.int().positive().max(5_000_000),
  max_retries: z.literal(0),
  allow_provider_fallback: z.literal(false),
});
export type ModelRolePolicy = z.infer<typeof ModelRolePolicySchema>;

export const ShoppingBudgetSchema = z.object({
  max_turns: z.int().min(2).max(8),
  max_model_calls: z.int().min(4).max(64),
  max_search_requests: z.int().nonnegative().max(80),
  max_input_tokens: z.int().positive().max(5_000_000),
  max_output_tokens: z.int().positive().max(1_000_000),
  max_cost_usd_micros: z.int().positive(),
});
export type ShoppingBudget = z.infer<typeof ShoppingBudgetSchema>;

export const CreateShoppingSessionRequestSchema = z.object({
  collection_id: z.uuid(),
  buyer_brief: BuyerBriefSchema,
  target_identity: TargetIdentitySchema,
  model_policies: z.array(ModelRolePolicySchema).length(4).optional(),
  budget: ShoppingBudgetSchema.optional(),
});
export type CreateShoppingSessionRequest = z.infer<typeof CreateShoppingSessionRequestSchema>;

export const ShoppingUsageSchema = z.object({
  turns: z.int().nonnegative(),
  model_calls: z.int().nonnegative(),
  search_requests: z.int().nonnegative(),
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cost_usd_micros: z.int().nonnegative(),
});
export type ShoppingUsage = z.infer<typeof ShoppingUsageSchema>;

export const AnswerShapeSchema = z.enum([
  "no_concrete_options",
  "single_option",
  "shortlist",
  "large_candidate_set",
  "comparison",
  "decision",
]);
export type AnswerShape = z.infer<typeof AnswerShapeSchema>;

export const BlindTurnRecordSchema = z.object({
  ordinal: z.int().min(1).max(8),
  stage: ShoppingTurnStageSchema,
  user_message: z.string().min(1).max(4_000),
  assistant_message: z.string().min(1).max(40_000),
  answer_shape: AnswerShapeSchema,
  surfaced_candidate_names: z.array(z.string().trim().min(1).max(300)).max(100),
  sources: z.array(z.object({ source_id: z.string(), url: z.string(), title: z.string().nullable() })).max(100).optional(),
  adaptive_decision: z.unknown().optional(),
});

// This is the only context accepted by the conversation controller. It has no
// target identity, target URL, target-match flag, or target evaluation field.
export const BlindConversationContextSchema = z.object({
  buyer_brief: BuyerBriefSchema,
  protocol: ShoppingProtocolSchema,
  completed_turns: z.array(BlindTurnRecordSchema).max(8),
  usage: ShoppingUsageSchema,
});
export type BlindConversationContext = z.infer<typeof BlindConversationContextSchema>;

export const TargetObservationSchema = z.object({
  turn_ordinal: z.int().min(1).max(8),
  retrievability: z.enum(["not_observed", "not_retrieved", "retrieved"]),
  candidate_set: z.enum(["not_observed", "absent", "included"]),
  comparison: z.enum(["not_observed", "not_compared", "retained", "rejected"]),
  recommendation: z.enum(["not_observed", "not_recommended", "recommended", "final_choice"]),
  matched_source_ids: z.array(z.string().min(1).max(200)).max(100),
  matched_candidate_ids: z.array(z.string().min(1).max(200)).max(100),
  visible_reason_evidence_ids: z.array(z.string().min(1).max(200)).max(100),
  semantic_classification_required: z.boolean(),
});
export type TargetObservation = z.infer<typeof TargetObservationSchema>;

export const GeneratedShoppingQuerySchema = z.object({
  message: z.string().trim().min(5).max(2_000),
  used_constraint_indexes: z.array(z.int().nonnegative()).max(12),
  naturalness_note: z.string().trim().min(1).max(500),
  adaptive_decision: z.unknown().optional(),
});
export type GeneratedShoppingQuery = z.infer<typeof GeneratedShoppingQuerySchema>;

export const ShoppingQueryAuditSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  target_leakage: z.boolean(),
  leaked_terms: z.array(z.string().trim().min(1).max(300)).max(30),
  issues: z.array(z.string().trim().min(1).max(500)).max(20),
});
export type ShoppingQueryAudit = z.infer<typeof ShoppingQueryAuditSchema>;

export const ShoppingObserverSourceSchema = z.object({
  source_id: z.string().trim().regex(/^src_[a-zA-Z0-9_-]{6,80}$/),
  url: z.string().trim().regex(/^https:\/\/[^\s]+$/),
  title: z.string().trim().min(1).max(500).nullable(),
  supports: z.string().trim().min(1).max(1_000),
});

export const ShoppingObserverCandidateSchema = z.object({
  candidate_id: z.string().trim().regex(/^cand_[a-zA-Z0-9_-]{6,80}$/),
  displayed_name: z.string().trim().min(1).max(300),
  merchant_domain: z.string().trim().min(3).max(253).nullable(),
  product_url: z.string().trim().regex(/^https:\/\/[^\s]+$/).nullable(),
  position: z.int().positive(),
  compared: z.boolean(),
  recommended: z.boolean(),
  final_choice: z.boolean(),
  supporting_source_ids: z.array(z.string().trim().min(1).max(100)).max(30),
});

export const ShoppingObserverResultSchema = z.object({
  message: z.string().trim().min(20).max(40_000),
  answer_shape: AnswerShapeSchema,
  sources: z.array(ShoppingObserverSourceSchema).max(40),
  candidates: z.array(ShoppingObserverCandidateSchema).max(100),
  unresolved_facts: z.array(z.string().trim().min(1).max(1_000)).max(30),
}).superRefine((value, context) => {
  const sourceIds = new Set(value.sources.map((source) => source.source_id));
  if (sourceIds.size !== value.sources.length) {
    context.addIssue({ code: "custom", message: "observer source IDs must be unique" });
  }
  const candidateIds = new Set(value.candidates.map((candidate) => candidate.candidate_id));
  if (candidateIds.size !== value.candidates.length) {
    context.addIssue({ code: "custom", message: "observer candidate IDs must be unique" });
  }
  for (const candidate of value.candidates) {
    for (const sourceId of candidate.supporting_source_ids) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({ code: "custom", message: `candidate references unknown source ${sourceId}` });
      }
    }
  }
});
export type ShoppingObserverResult = z.infer<typeof ShoppingObserverResultSchema>;

export const ShoppingObserverCaptureSchema = z.object({
  message: z.string().trim().min(20).max(40_000),
  sources: z.array(ShoppingObserverSourceSchema).max(100),
});
export type ShoppingObserverCapture = z.infer<typeof ShoppingObserverCaptureSchema>;

export const ShoppingClassificationResultSchema = z.object({
  answer_shape: AnswerShapeSchema,
  candidates: z.array(ShoppingObserverCandidateSchema).max(100),
  target_observation: TargetObservationSchema,
  deterministic_match_complete: z.boolean(),
  semantic_match_explanation: z.string().trim().min(1).max(2_000),
});
export type ShoppingClassificationResult = z.infer<typeof ShoppingClassificationResultSchema>;

export const ShoppingSessionStatusSchema = z.enum([
  "draft",
  "protocol_ready",
  "queued",
  "running",
  "completed",
  "incomplete",
  "budget_exhausted",
  "failed_validation",
  "cancelled",
]);
export type ShoppingSessionStatus = z.infer<typeof ShoppingSessionStatusSchema>;

export const ShoppingSessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PROTOCOL_APPROVED"), occurred_at: z.iso.datetime() }),
  z.object({ type: z.literal("SESSION_QUEUED"), occurred_at: z.iso.datetime() }),
  z.object({ type: z.literal("TURN_STARTED"), occurred_at: z.iso.datetime(), turn_ordinal: z.int().min(1).max(8) }),
  z.object({ type: z.literal("TURN_COMPLETED"), occurred_at: z.iso.datetime(), turn_ordinal: z.int().min(1).max(8) }),
  z.object({ type: z.literal("SESSION_COMPLETED"), occurred_at: z.iso.datetime() }),
  z.object({ type: z.literal("SESSION_INCOMPLETE"), occurred_at: z.iso.datetime(), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal("BUDGET_EXHAUSTED"), occurred_at: z.iso.datetime() }),
  z.object({ type: z.literal("SESSION_CANCELLED"), occurred_at: z.iso.datetime() }),
]);
export type ShoppingSessionEvent = z.infer<typeof ShoppingSessionEventSchema>;

export const ShoppingAdvanceMessageSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.guidedShopping),
  kind: z.literal("shopping_advance"),
  session_id: z.uuid(),
  execution_mode: z.enum(["fixture", "live"]),
  created_at: z.iso.datetime(),
});
export const ShoppingRoleCallMessageSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.guidedShopping),
  kind: z.literal("shopping_role_call"),
  session_id: z.uuid(),
  turn_id: z.uuid(),
  turn_ordinal: z.int().min(1).max(8),
  role: ShoppingRoleSchema,
  execution_mode: z.literal("live"),
  created_at: z.iso.datetime(),
});
export const ShoppingQueueMessageSchema = z.discriminatedUnion("kind", [
  ShoppingAdvanceMessageSchema,
  ShoppingRoleCallMessageSchema,
]);
export type ShoppingQueueMessage = z.infer<typeof ShoppingQueueMessageSchema>;
