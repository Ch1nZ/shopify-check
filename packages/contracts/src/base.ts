import { z } from "zod";

export const CONTRACT_VERSIONS = {
  productRecord: "product-record/1.0",
  evidenceObservation: "evidence-observation/1.0",
  technicalCheck: "technical-check/1.0",
  guidedShopping: "guided-shopping/1.0",
  testRun: "test-run/1.0",
  modelCapability: "model-capability/1.0",
  creditOperation: "credit-operation/1.0",
  report: "report/1.0",
} as const;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelRouteKeySchema = z.string().min(1);
export type ModelRouteKey = z.infer<typeof ModelRouteKeySchema>;
