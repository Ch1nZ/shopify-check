import { providerFor } from "./provider";
import { generateText, Output } from "ai";

import {
  AiEvidenceAnalysisSchema,
  type AiEvidenceAnalysis,
  type EvidencePack,
  type ModelRouteKey,
  type ReasoningEffort,
} from "@mclab/contracts";

import { validateEvidenceLinks } from "./analysis";
import { modelCapability } from "./model-registry";

export type OpenRouterRequestDescriptor = {
  model: string;
  reasoning: { effort: ReasoningEffort; exclude: true };
  provider: {
    order: string[];
    allow_fallbacks: false;
    require_parameters: true;
    data_collection: "deny";
  };
  tools: Array<{
    type: "openrouter:web_search";
    engine: "native";
    max_total_results: number;
    search_context_size: "low";
  }>;
};

export type NormalizedUsage = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
};

export type LiveAnalysisResult = {
  output: AiEvidenceAnalysis;
  validation_error: string | null;
  response_id: string | null;
  usage: NormalizedUsage;
};

export function buildOpenRouterRequestDescriptor(
  routeKey: ModelRouteKey,
  reasoningEffort: ReasoningEffort,
): OpenRouterRequestDescriptor {
  const capability = modelCapability(routeKey);
  if (!capability.supported_reasoning.includes(reasoningEffort)) {
    throw new Error(`${reasoningEffort} reasoning is not supported by ${routeKey}`);
  }
  return {
    model: capability.model_id,
    reasoning: { effort: reasoningEffort, exclude: true },
    provider: {
      order: [...capability.provider_order],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
    },
    tools: [
      {
        type: "openrouter:web_search",
        engine: "native",
        max_total_results: 5,
        search_context_size: "low",
      },
    ],
  };
}

export function buildEvidencePrompt(pack: EvidencePack, targetMarket: string): string {
  return [
    "Analyze only the supplied captured product-page evidence.",
    "Do not claim a recommendation, ranking, retrieval result, or external fact.",
    "Every finding must cite one or more evidence IDs and exact verbatim excerpts from the pack.",
    `Target market: ${targetMarket}`,
    `Product URL: ${pack.product_url}`,
    "Evidence pack:",
    JSON.stringify(pack.items.map(({ id, source, path, text }) => ({ id, source, path, text }))),
  ].join("\n");
}

export async function runLiveEvidenceAnalysis(input: {
  apiKey: string;
  routeKey: ModelRouteKey;
  reasoningEffort: ReasoningEffort;
  targetMarket: string;
  evidencePack: EvidencePack;
  abortSignal?: AbortSignal;
}): Promise<LiveAnalysisResult> {
  const provider = providerFor({ role: "query_generator", route_key: input.routeKey, reasoning_effort: input.reasoningEffort, search: { enabled: true, engine: "native", max_total_results: 5, max_search_requests: 1 }, max_output_tokens: 2000, max_call_cost_usd_micros: 100000, max_retries: 0, allow_provider_fallback: false }, undefined, true);
  const result = await generateText({
    ...provider,
    maxRetries: 0,
    output: Output.object({ schema: AiEvidenceAnalysisSchema }),
    prompt: buildEvidencePrompt(input.evidencePack, input.targetMarket),
    maxOutputTokens: 2_000,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  const metadata = readOpenRouterMetadata(result.providerMetadata);
  let validationError: string | null = null;
  try {
    validateEvidenceLinks(result.output, input.evidencePack);
  } catch (error) {
    validationError = error instanceof Error ? error.message : "Evidence validation failed.";
  }
  return {
    output: result.output,
    validation_error: validationError,
    response_id: metadata.responseId,
    usage: {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
      reasoning_tokens: result.usage.outputTokenDetails.reasoningTokens ?? 0,
      total_tokens: result.usage.totalTokens ?? 0,
      cost_usd: metadata.cost,
    },
  };
}

function readOpenRouterMetadata(metadata: unknown): { responseId: string | null; cost: number | null } {
  if (!metadata || typeof metadata !== "object") return { responseId: null, cost: null };
  const openrouter = "openrouter" in metadata ? metadata.openrouter : null;
  if (!openrouter || typeof openrouter !== "object") return { responseId: null, cost: null };
  const responseId =
    "generationId" in openrouter && typeof openrouter.generationId === "string"
      ? openrouter.generationId
      : null;
  const usage = "usage" in openrouter ? openrouter.usage : null;
  const cost =
    usage && typeof usage === "object" && "cost" in usage && typeof usage.cost === "number"
      ? usage.cost
      : null;
  return { responseId, cost };
}
