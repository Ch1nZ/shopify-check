/**
 * Jev (TypeSafe System One) is not a chat model.
 *
 * Do not call `/api/v1/chat/completions` for Jev. Do not pass `messages[]`.
 * Jev answers typed questions about a `state` through OpenRouter's Decisions API
 * and returns noul / choice / score answers. Application code owns the workflow
 * after those answers; Jev does not write report prose.
 */
import type {
  AnswerShape,
  BlindConversationContext,
  GeneratedShoppingQuery,
  ShoppingClassificationResult,
  ShoppingObserverCapture,
  TargetIdentity,
  TargetObservation,
} from "@mclab/contracts";
import { ShoppingClassificationResultSchema } from "@mclab/contracts";

import type { ModelExecution } from "./model-execution";
import type { ShoppingRoleRun } from "./shopping";

export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL_ID = "typesafe/jev-1.13";
export const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Choice answers below this confidence fall back to the previous classifier. */
export const JEV_CHOICE_CONFIDENCE_THRESHOLD = 0.7;
/** Noul values at or above this are treated as yes in our code, not by Jev. */
export const JEV_NOUL_YES_THRESHOLD = 0.8;

export const JEV_OUTCOMES = [
  "not_observed",
  "absent",
  "mentioned",
  "shortlisted",
  "recommended",
  "final_choice",
] as const;
export type JevOutcome = (typeof JEV_OUTCOMES)[number];

const ANSWER_SHAPES = [
  "no_concrete_options",
  "single_option",
  "shortlist",
  "large_candidate_set",
  "comparison",
  "decision",
] as const satisfies readonly AnswerShape[];

export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  true: string;
  false: string;
};

export type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};
export type JevScoreAnswer = {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevDecisionsRequest = {
  model: typeof JEV_MODEL_ID;
  state: unknown;
  questions: Record<string, JevQuestion>;
};

export type JevDecisionsResponse = {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
};

export type JevClassifierFallbackReason =
  | "http_error"
  | "invalid_response"
  | "low_confidence"
  | "not_observed"
  | "inconsistent_answers";

export class JevClassifierFallbackError extends Error {
  constructor(readonly reason: JevClassifierFallbackReason, message: string) {
    super(message);
    this.name = "JevClassifierFallbackError";
  }
}

export function jevClassifierEnabled(value: string | undefined | null): boolean {
  return value === "1" || value === "true";
}

export function isUncertainProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "UncertainModelCallError" || name === "TimeoutError" || name === "AbortError";
}

export function buildJevClassifierState(input: {
  turnOrdinal: number;
  context: BlindConversationContext;
  query: GeneratedShoppingQuery;
  observerResult: ShoppingObserverCapture;
  targetIdentity: TargetIdentity;
}): Record<string, unknown> {
  return {
    turn_ordinal: input.turnOrdinal,
    shopper_message: input.query.message,
    captured_shopping_answer: {
      message: input.observerResult.message,
      sources: input.observerResult.sources,
    },
    prior_turns: input.context.completed_turns.map((turn) => ({
      ordinal: turn.ordinal,
      stage: turn.stage,
      user_message: turn.user_message,
      assistant_message: turn.assistant_message,
      answer_shape: turn.answer_shape,
    })),
    buyer_brief: {
      category: input.context.buyer_brief.category,
      target_market: input.context.buyer_brief.target_market,
      buyer_job: input.context.buyer_brief.buyer_job,
      constraints: input.context.buyer_brief.constraints,
      preferences: input.context.buyer_brief.preferences,
    },
    target_identity: {
      canonical_product_url: input.targetIdentity.canonical_product_url,
      merchant_domains: input.targetIdentity.merchant_domains,
      brand_names: input.targetIdentity.brand_names,
      product_names: input.targetIdentity.product_names,
      product_url_aliases: input.targetIdentity.product_url_aliases,
      normalized_sku_ids: input.targetIdentity.normalized_sku_ids,
    },
    rules: [
      "A merchant-domain match or brand/series mention is not the exact target SKU.",
      "A sibling product is a different SKU.",
      "Do not treat a mention as a recommendation.",
      "Incomplete, timed-out, or unreadable evidence is not_observed, never absent.",
    ],
  };
}

export function buildJevClassifierQuestions(): Record<string, JevQuestion> {
  return {
    outcome: {
      type: "choice",
      instructions:
        "Classify the private target product in this captured shopping answer. Keep retrievability, shortlist inclusion, and recommendation separate. Choose not_observed when the evidence is incomplete or the identity match is unknown. Never use absent for a timeout, partial capture, or failed assessment.",
      criteria: {
        not_observed:
          "The captured answer cannot support a target classification: incomplete text, unreadable identity, or unknown match. Not a completed negative result.",
        absent:
          "The exact target SKU is not retrieved or mentioned. Brand or merchant mentions without this SKU still count as absent for the submitted product.",
        mentioned:
          "The exact target is retrieved or named but is not in the considered candidate set.",
        shortlisted:
          "The exact target is included among concrete options under consideration, without being recommended.",
        recommended:
          "The exact target is recommended, but is not the shopper's final exclusive choice.",
        final_choice: "The exact target is selected as the final choice in this answer.",
      },
    },
    answer_shape: {
      type: "choice",
      instructions:
        "Classify the answer shape independently from the private target outcome. Use the visible shopping answer only.",
      criteria: {
        no_concrete_options: "No identifiable purchasable product listings are named.",
        single_option: "Exactly one concrete product listing is presented.",
        shortlist: "A small set of concrete product listings is presented.",
        large_candidate_set: "A large or unfocused set of concrete listings is presented.",
        comparison: "The answer compares already surfaced options.",
        decision: "The answer makes or restates a purchase choice, tradeoffs, or caveats on a choice.",
      },
    },
    on_brief: {
      type: "noul",
      instructions:
        "Does the captured shopping answer stay on the approved buyer brief (category, market, job, constraints, preferences) without introducing a different purchase situation?",
      true: "The answer addresses the approved buyer situation.",
      false: "The answer drifts to a different job, market, or invented requirements.",
    },
    exact_target_identified: {
      type: "noul",
      instructions:
        "Does the captured answer identify the exact submitted target product, not merely the brand, merchant, series, or a sibling SKU?",
      true: "The exact target SKU is identifiable in the answer or its sources.",
      false: "Only a brand, merchant, series, sibling, or no related product is identifiable.",
    },
  };
}

export function buildJevDecisionsRequest(state: unknown, questions: Record<string, JevQuestion>): JevDecisionsRequest {
  return { model: JEV_MODEL_ID, state, questions };
}

export async function postJevDecisions(input: {
  apiKey: string;
  request: JevDecisionsRequest;
  abortSignal?: AbortSignal;
  execution?: ModelExecution;
}): Promise<{ response: JevDecisionsResponse; status: number; body: string }> {
  if (input.request.model !== JEV_MODEL_ID) {
    throw new Error(`Jev Decisions must pin ${JEV_MODEL_ID}.`);
  }
  const fetchImpl = input.execution?.fetch ?? fetch;
  const httpResponse = await fetchImpl(JEV_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://geo.mclab.party/",
      "X-OpenRouter-Title": "MC Lab Self-Check Jev Classifier",
    },
    body: JSON.stringify(input.request),
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
  });
  const body = await httpResponse.text();
  return { response: parseJevDecisionsResponse(body, httpResponse.status), status: httpResponse.status, body };
}

export function parseJevDecisionsResponse(body: string, status: number): JevDecisionsResponse {
  if (status < 200 || status >= 300) {
    throw new JevClassifierFallbackError("http_error", `Jev Decisions HTTP ${status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new JevClassifierFallbackError("invalid_response", "Jev Decisions returned non-JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JevClassifierFallbackError("invalid_response", "Jev Decisions returned an empty body.");
  }
  const record = parsed as Record<string, unknown>;
  if ("choices" in record) {
    throw new JevClassifierFallbackError(
      "invalid_response",
      "Jev Decisions returned a chat/completions payload; refusing to treat it as answers.",
    );
  }
  const answers = record.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JevClassifierFallbackError("invalid_response", "Jev Decisions response is missing answers.");
  }
  const model = typeof record.model === "string" ? record.model : JEV_MODEL_ID;
  const response: JevDecisionsResponse = {
    model,
    answers: answers as Record<string, JevAnswer>,
  };
  if (typeof record.id === "string") response.id = record.id;
  if (typeof record.provider === "string") response.provider = record.provider;
  if (record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)) {
    response.usage = record.usage as {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
    };
  }
  return response;
}

export function readJevChoice(answers: Record<string, JevAnswer>, id: string, allowed: readonly string[]): {
  choice: string;
  confidence: number;
} {
  const answer = answers[id];
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new JevClassifierFallbackError("invalid_response", `Jev answer ${id} is not a choice.`);
  }
  if (!allowed.includes(answer.choice)) {
    throw new JevClassifierFallbackError("invalid_response", `Jev answer ${id} used an unknown option.`);
  }
  const confidence = choiceConfidence(answer);
  if (confidence < JEV_CHOICE_CONFIDENCE_THRESHOLD) {
    throw new JevClassifierFallbackError("low_confidence", `Jev answer ${id} is below the confidence threshold.`);
  }
  return { choice: answer.choice, confidence };
}

export function readJevNoul(answers: Record<string, JevAnswer>, id: string): number {
  const answer = answers[id];
  if (!answer || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
    throw new JevClassifierFallbackError("invalid_response", `Jev answer ${id} is not a noul.`);
  }
  if (answer.noul < 0 || answer.noul > 1) {
    throw new JevClassifierFallbackError("invalid_response", `Jev answer ${id} is outside [0, 1].`);
  }
  return answer.noul;
}

export function mapJevClassifierAnswers(input: {
  turnOrdinal: number;
  observerResult: ShoppingObserverCapture;
  targetIdentity: TargetIdentity;
  answers: Record<string, JevAnswer>;
}): ShoppingClassificationResult {
  const outcome = readJevChoice(input.answers, "outcome", JEV_OUTCOMES).choice as JevOutcome;
  if (outcome === "not_observed") {
    throw new JevClassifierFallbackError(
      "not_observed",
      "Jev could not classify the target. Unknown is not absence.",
    );
  }
  const answerShape = readJevChoice(input.answers, "answer_shape", ANSWER_SHAPES).choice as AnswerShape;
  const onBrief = readJevNoul(input.answers, "on_brief");
  const exactTarget = readJevNoul(input.answers, "exact_target_identified");
  assertOutcomeConsistency(outcome, exactTarget);

  const matched = matchTargetEvidence(input.observerResult, input.targetIdentity);
  const observation = observationFromOutcome(input.turnOrdinal, outcome, answerShape, matched);
  return ShoppingClassificationResultSchema.parse({
    answer_shape: answerShape,
    candidates: matched.candidates,
    target_observation: observation,
    deterministic_match_complete: matched.deterministic,
    semantic_match_explanation: [
      `Jev Decisions classified outcome=${outcome}.`,
      `exact_target noul=${exactTarget.toFixed(3)}.`,
      `on_brief noul=${onBrief.toFixed(3)}.`,
      onBrief >= JEV_NOUL_YES_THRESHOLD
        ? "The captured answer stayed on the approved buyer brief."
        : "The captured answer may have drifted from the approved buyer brief; the target labels still describe only this answer.",
      "This note is application mapping, not Jev-generated report prose.",
    ].join(" "),
  });
}

export function jevUsageFromResponse(response: JevDecisionsResponse): ShoppingRoleRun<unknown>["usage"] {
  const usage = response.usage ?? {};
  const inputTokens = numberOrZero(usage.input_tokens) || numberOrZero(usage.prompt_tokens);
  const outputTokens = numberOrZero(usage.output_tokens) || numberOrZero(usage.completion_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    total_tokens: totalTokens,
    cost_usd: typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
    web_search_requests: 0,
  };
}

function assertOutcomeConsistency(outcome: JevOutcome, exactTarget: number): void {
  const identified = exactTarget >= JEV_NOUL_YES_THRESHOLD;
  const unidentified = exactTarget <= 1 - JEV_NOUL_YES_THRESHOLD;
  if ((outcome === "recommended" || outcome === "final_choice" || outcome === "shortlisted" || outcome === "mentioned") && unidentified) {
    throw new JevClassifierFallbackError(
      "inconsistent_answers",
      "Jev outcome requires an exact-target match that the noul does not support.",
    );
  }
  if (outcome === "absent" && identified) {
    throw new JevClassifierFallbackError(
      "inconsistent_answers",
      "Jev outcome absent contradicts a high exact-target noul.",
    );
  }
}

function observationFromOutcome(
  turnOrdinal: number,
  outcome: JevOutcome,
  answerShape: AnswerShape,
  matched: ReturnType<typeof matchTargetEvidence>,
): TargetObservation {
  const compared = answerShape === "comparison" || answerShape === "decision";
  if (outcome === "absent") {
    return {
      turn_ordinal: turnOrdinal,
      retrievability: "not_retrieved",
      candidate_set: "absent",
      comparison: compared ? "not_compared" : "not_observed",
      recommendation: "not_recommended",
      matched_source_ids: [],
      matched_candidate_ids: [],
      visible_reason_evidence_ids: [],
      semantic_classification_required: true,
    };
  }
  const included = outcome === "shortlisted" || outcome === "recommended" || outcome === "final_choice";
  return {
    turn_ordinal: turnOrdinal,
    retrievability: "retrieved",
    candidate_set: included ? "included" : "absent",
    comparison: compared ? (included ? "retained" : "not_compared") : included ? "not_compared" : "not_observed",
    recommendation:
      outcome === "final_choice" ? "final_choice" : outcome === "recommended" ? "recommended" : "not_recommended",
    matched_source_ids: matched.sourceIds,
    matched_candidate_ids: matched.candidates.map((candidate) => candidate.candidate_id),
    visible_reason_evidence_ids: matched.sourceIds,
    semantic_classification_required: true,
  };
}

function matchTargetEvidence(
  observerResult: ShoppingObserverCapture,
  targetIdentity: TargetIdentity,
): {
  deterministic: boolean;
  sourceIds: string[];
  candidates: ShoppingClassificationResult["candidates"];
} {
  const nameNeedles = [...targetIdentity.product_names, ...targetIdentity.normalized_sku_ids]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 4);
  const urls = new Set(
    [targetIdentity.canonical_product_url, ...targetIdentity.product_url_aliases].map(normalizeUrl),
  );
  const domains = new Set(targetIdentity.merchant_domains.map((domain) => domain.toLowerCase()));
  const sourceIds: string[] = [];
  const candidates: ShoppingClassificationResult["candidates"] = [];
  for (const [index, source] of observerResult.sources.entries()) {
    const sourceUrl = normalizeUrl(source.url);
    let host = "";
    try { host = new URL(source.url).hostname.toLowerCase(); } catch { host = ""; }
    const urlHit = urls.has(sourceUrl);
    const domainHit = host !== "" && [...domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
    const nameHit = nameNeedles.some((needle) =>
      `${source.title ?? ""} ${observerResult.message}`.toLowerCase().includes(needle),
    );
    if (!urlHit && !(domainHit && nameHit) && !nameHit) continue;
    sourceIds.push(source.source_id);
    if (urlHit || (domainHit && nameHit)) {
      candidates.push({
        candidate_id: `cand_${source.source_id.replace(/^src_/, "")}`.slice(0, 80),
        displayed_name: source.title?.trim() || targetIdentity.product_names[0] || "Target product",
        merchant_domain: host || null,
        product_url: source.url,
        position: index + 1,
        compared: false,
        recommended: false,
        final_choice: false,
        supporting_source_ids: [source.source_id],
      });
    }
  }
  return { deterministic: sourceIds.length > 0, sourceIds, candidates };
}

function choiceConfidence(answer: JevChoiceAnswer): number {
  if (typeof answer.confidence === "number" && Number.isFinite(answer.confidence)) return answer.confidence;
  const probability = answer.probabilities?.[answer.choice];
  if (typeof probability === "number" && Number.isFinite(probability)) return probability;
  return 0;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return value;
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
