import { z } from "zod";
import {
  CONTRACT_VERSIONS,
  ModelRouteKeySchema,
  ReasoningEffortSchema,
} from "./base";

export * from "./base";

export const ModelCapabilitySchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.modelCapability),
  registry_version: z.string().min(1),
  route_key: ModelRouteKeySchema,
  display_name: z.string().min(1),
  model_id: z.string().min(3),
  provider_order: z.array(z.string().min(1)).min(1),
  supported_reasoning: z.array(ReasoningEffortSchema).min(1),
  supports_structured_output: z.literal(true),
  supports_web_search: z.boolean(),
  qualification_status: z.enum(["catalog_verified", "live_qualified", "operator_configured"]),
  credit_cost: z.int().positive(),
});
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const EvidenceItemSchema = z.object({
  id: z.string().regex(/^ev_[0-9a-f]{16}$/),
  source: z.string().min(1),
  path: z.string().min(1),
  text: z.string().min(1).max(8_000),
  captured_url: z.url({ protocol: /^https$/ }),
  captured_at: z.iso.datetime(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const EvidencePackSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.evidenceObservation),
  collection_id: z.uuid(),
  product_url: z.url({ protocol: /^https$/ }),
  captured_at: z.iso.datetime(),
  items: z.array(EvidenceItemSchema).max(200),
});
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

export const AiFindingSchema = z.object({
  kind: z.enum(["buyer_fit", "use_case", "category_bridge", "limitation", "policy_text"]),
  statement: z.string().trim().min(1).max(1_000),
  evidence: z.array(z.object({
    evidence_id: z.string().regex(/^ev_[0-9a-f]{16}$/),
    quote: z.string().trim().min(1).max(500),
  })).min(1).max(8),
  confidence: z.enum(["high", "medium", "low"]),
});

export const AiEvidenceAnalysisSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.report),
  summary: z.string().trim().min(1).max(1_500),
  findings: z.array(AiFindingSchema).max(20),
  unresolved_questions: z.array(z.string().trim().min(1).max(500)).max(10),
});
export type AiEvidenceAnalysis = z.infer<typeof AiEvidenceAnalysisSchema>;

export const FixtureAnalysisRequestSchema = z.object({
  collection_id: z.uuid(),
  route_key: ModelRouteKeySchema,
  reasoning_effort: ReasoningEffortSchema,
  target_market: z.string().trim().min(2).max(80),
});

export const AiJobMessageSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.testRun),
  run_id: z.uuid(),
  collection_id: z.uuid(),
  route_key: ModelRouteKeySchema,
  reasoning_effort: ReasoningEffortSchema,
  target_market: z.string().trim().min(2).max(80),
  mode: z.enum(["fixture", "live"]),
  created_at: z.iso.datetime(),
});
export type AiJobMessage = z.infer<typeof AiJobMessageSchema>;

export const JobKindSchema = z.enum([
  "technical_self_check",
  "guided_search_fast",
  "guided_search_balanced",
  "guided_search_premium",
]);

export type JobKind = z.infer<typeof JobKindSchema>;

export const PreflightRequestSchema = z.object({
  product_url: z.url({ protocol: /^https$/ }),
  target_market: z.string().trim().min(2).max(80).optional(),
});

export const ShopifyCollectRequestSchema = z.object({
  product_url: z.url({ protocol: /^https$/ }),
});

export const CreateCustomerTaskRequestSchema = z.object({
  product_url: z.url({ protocol: /^https$/ }),
  category: z.string().trim().min(2).max(120).optional(),
  target_market: z.string().trim().min(2).max(80),
  buyer_job: z.string().trim().min(5).max(500).optional(),
  use_cases: z.array(z.string().trim().min(2).max(160)).max(8).default([]),
  constraints: z.array(z.string().trim().min(2).max(160)).max(12).default([]),
  preferences: z.array(z.string().trim().min(2).max(160)).max(12).default([]),
  shopping_model_route: ModelRouteKeySchema,
  shopping_reasoning_effort: ReasoningEffortSchema,
});
export type CreateCustomerTaskRequest = z.infer<typeof CreateCustomerTaskRequestSchema>;

export const EvidenceStateSchema = z.enum([
  "verified",
  "single_source",
  "conflicted",
  "missing",
  "incomplete",
]);

export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export type PreflightRequest = z.infer<typeof PreflightRequestSchema>;

export const SyntheticJobRequestSchema = z.object({
  account_id: z.string().trim().min(1).max(128),
  job_kind: JobKindSchema,
});

export const JobMessageSchema = z.object({
  schema_version: z.literal(CONTRACT_VERSIONS.testRun),
  job_id: z.uuid(),
  account_id: z.string().min(1).max(128),
  reservation_id: z.uuid(),
  job_kind: JobKindSchema,
  credits: z.int().positive(),
  created_at: z.iso.datetime(),
});

export type JobMessage = z.infer<typeof JobMessageSchema>;

export type CreditReservationRequest = {
  reservationId: string;
  observedBalance: number;
  credits: number;
};

export type CreditAdmissionResult = {
  admitted: boolean;
  availableBefore: number;
  openReservedCredits: number;
  reason: "admitted" | "insufficient_credits" | "idempotent_replay";
};

export type CreditReservationSnapshot = {
  reservationId: string;
  credits: number;
  status: "reserved" | "consumed" | "released";
};

export * from "./controlled-shopping";
export * from "./adaptive-shopping";
