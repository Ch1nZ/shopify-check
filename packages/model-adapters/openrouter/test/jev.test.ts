import { describe, expect, it, vi } from "vitest";

import {
  CONTRACT_VERSIONS,
  type BlindConversationContext,
  type GeneratedShoppingQuery,
  type ShoppingObserverCapture,
  type TargetIdentity,
} from "@mclab/contracts";
import { CONTROLLED_SHOPPING_PROTOCOL } from "@mclab/domain";

import {
  CHAT_COMPLETIONS_URL,
  JEV_CHOICE_CONFIDENCE_THRESHOLD,
  JEV_DECISIONS_URL,
  JEV_MODEL_ID,
  JEV_NOUL_YES_THRESHOLD,
  JevClassifierFallbackError,
  buildJevClassifierQuestions,
  buildJevClassifierState,
  buildJevDecisionsRequest,
  jevClassifierEnabled,
  jevUsageFromResponse,
  mapJevClassifierAnswers,
  parseJevDecisionsResponse,
  postJevDecisions,
  readJevChoice,
  readJevNoul,
  type JevAnswer,
} from "../src/jev";
import { runResultClassifier } from "../src/shopping";
import type { ModelExecution } from "../src/model-execution";

const context: BlindConversationContext = {
  buyer_brief: {
    schema_version: CONTRACT_VERSIONS.guidedShopping,
    category: "everyday necklace",
    target_market: "Hong Kong",
    buyer_job: "Find an everyday necklace I can wear to work",
    use_cases: [],
    constraints: ["looks like ordinary jewelry"],
    preferences: [],
    decision_dimensions: [],
    market_requirements: [],
    prohibited_fingerprints: [],
  },
  protocol: CONTROLLED_SHOPPING_PROTOCOL,
  completed_turns: [],
  usage: { turns: 0, model_calls: 0, search_requests: 0, input_tokens: 0, output_tokens: 0, cost_usd_micros: 0 },
};

const query: GeneratedShoppingQuery = {
  message: "Which everyday necklaces can I buy for work in Hong Kong?",
  used_constraint_indexes: [],
  naturalness_note: "Natural category question.",
};

const observerResult: ShoppingObserverCapture = {
  message: "Option Alpha is an everyday necklace available in Hong Kong. Secret Star Necklace from Secret Brand is also listed at the merchant page.",
  sources: [{
    source_id: "src_abcdef",
    url: "https://target.example/products/secret-star",
    title: "Secret Star Necklace",
    supports: "Merchant product page.",
  }],
};

const targetIdentity: TargetIdentity = {
  schema_version: CONTRACT_VERSIONS.guidedShopping,
  canonical_product_url: "https://target.example/products/secret-star",
  merchant_domains: ["target.example"],
  brand_names: ["Secret Brand"],
  product_names: ["Secret Star Necklace"],
  product_url_aliases: [],
  normalized_sku_ids: [],
};

const policy = {
  role: "result_classifier" as const,
  route_key: "planner" as const,
  reasoning_effort: "high" as const,
  search: { enabled: false },
  max_output_tokens: 3_000,
  max_call_cost_usd_micros: 75_000,
  max_retries: 0 as const,
  allow_provider_fallback: false as const,
};

function successfulAnswers(overrides: Record<string, JevAnswer> = {}): Record<string, JevAnswer> {
  return {
    outcome: {
      type: "choice",
      choice: "shortlisted",
      probabilities: {
        not_observed: 0.01,
        absent: 0.04,
        mentioned: 0.05,
        shortlisted: 0.82,
        recommended: 0.05,
        final_choice: 0.03,
      },
      confidence: 0.81,
    },
    answer_shape: {
      type: "choice",
      choice: "shortlist",
      probabilities: {
        no_concrete_options: 0.02,
        single_option: 0.1,
        shortlist: 0.78,
        large_candidate_set: 0.04,
        comparison: 0.04,
        decision: 0.02,
      },
      confidence: 0.76,
    },
    on_brief: { type: "noul", noul: 0.91 },
    exact_target_identified: { type: "noul", noul: 0.88 },
    ...overrides,
  };
}

describe("Jev Decisions classifier", () => {
  it("pins the Decisions endpoint and model, never chat completions", () => {
    const request = buildJevDecisionsRequest(
      buildJevClassifierState({ turnOrdinal: 1, context, query, observerResult, targetIdentity }),
      buildJevClassifierQuestions(),
    );
    expect(JEV_DECISIONS_URL).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(JEV_DECISIONS_URL).not.toBe(CHAT_COMPLETIONS_URL);
    expect(request.model).toBe("typesafe/jev-1.13");
    expect(request.model).not.toContain("jev-latest");
    expect(request).not.toHaveProperty("messages");
    expect(request.questions.outcome).toMatchObject({ type: "choice" });
    expect(request.questions.on_brief).toMatchObject({ type: "noul" });
    expect("criteria" in request.questions.outcome!).toBe(true);
    if (request.questions.outcome?.type === "choice") {
      expect(Object.keys(request.questions.outcome.criteria)).toEqual([
        "not_observed", "absent", "mentioned", "shortlisted", "recommended", "final_choice",
      ]);
    }
  });

  it("maps Jev answers onto existing classifier labels without inventing absence from unknown", () => {
    const mapped = mapJevClassifierAnswers({
      turnOrdinal: 2,
      observerResult,
      targetIdentity,
      answers: successfulAnswers(),
    });
    expect(mapped.answer_shape).toBe("shortlist");
    expect(mapped.target_observation).toMatchObject({
      turn_ordinal: 2,
      retrievability: "retrieved",
      candidate_set: "included",
      recommendation: "not_recommended",
    });
    expect(mapped.target_observation.matched_source_ids).toEqual(["src_abcdef"]);
    expect(mapped.semantic_match_explanation).toContain("outcome=shortlisted");
    expect(mapped.semantic_match_explanation).toContain("application mapping");
  });

  it("maps recommended and absent outcomes onto the existing observation enums", () => {
    const recommended = mapJevClassifierAnswers({
      turnOrdinal: 1,
      observerResult,
      targetIdentity,
      answers: successfulAnswers({
        outcome: { type: "choice", choice: "recommended", confidence: 0.9, probabilities: { recommended: 0.9 } },
      }),
    });
    expect(recommended.target_observation.recommendation).toBe("recommended");
    expect(recommended.target_observation.candidate_set).toBe("included");

    const absent = mapJevClassifierAnswers({
      turnOrdinal: 1,
      observerResult: { ...observerResult, sources: [] },
      targetIdentity,
      answers: successfulAnswers({
        outcome: { type: "choice", choice: "absent", confidence: 0.92, probabilities: { absent: 0.92 } },
        exact_target_identified: { type: "noul", noul: 0.05 },
      }),
    });
    expect(absent.target_observation).toMatchObject({
      retrievability: "not_retrieved",
      candidate_set: "absent",
      recommendation: "not_recommended",
    });
    expect(absent.target_observation.matched_source_ids).toEqual([]);
  });

  it("refuses to treat not_observed as a completed absent result", () => {
    expect(() => mapJevClassifierAnswers({
      turnOrdinal: 1,
      observerResult,
      targetIdentity,
      answers: successfulAnswers({
        outcome: { type: "choice", choice: "not_observed", confidence: 0.95, probabilities: { not_observed: 0.95 } },
        exact_target_identified: { type: "noul", noul: 0.4 },
      }),
    })).toThrow(JevClassifierFallbackError);
    try {
      mapJevClassifierAnswers({
        turnOrdinal: 1,
        observerResult,
        targetIdentity,
        answers: successfulAnswers({
          outcome: { type: "choice", choice: "not_observed", confidence: 0.95, probabilities: { not_observed: 0.95 } },
          exact_target_identified: { type: "noul", noul: 0.4 },
        }),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(JevClassifierFallbackError);
      expect((error as JevClassifierFallbackError).reason).toBe("not_observed");
    }
  });

  it("falls back when choice confidence is below the application threshold", () => {
    expect(() => readJevChoice(
      { outcome: { type: "choice", choice: "absent", confidence: 0.4, probabilities: { absent: 0.4 } } },
      "outcome",
      ["absent", "mentioned"],
    )).toThrow(/confidence threshold/);
    expect(JEV_CHOICE_CONFIDENCE_THRESHOLD).toBe(0.7);
    expect(JEV_NOUL_YES_THRESHOLD).toBe(0.8);
    expect(readJevNoul({ on_brief: { type: "noul", noul: 0.81 } }, "on_brief")).toBe(0.81);
  });

  it("falls back when recommended contradicts a low exact-target noul", () => {
    expect(() => mapJevClassifierAnswers({
      turnOrdinal: 1,
      observerResult,
      targetIdentity,
      answers: successfulAnswers({
        outcome: { type: "choice", choice: "recommended", confidence: 0.9, probabilities: { recommended: 0.9 } },
        exact_target_identified: { type: "noul", noul: 0.12 },
      }),
    })).toThrow(/exact-target/);
  });

  it("rejects a chat/completions-shaped payload", () => {
    expect(() => parseJevDecisionsResponse(JSON.stringify({
      choices: [{ message: { content: "{\"outcome\":\"absent\"}" } }],
    }), 200)).toThrow(/chat\/completions/);
  });

  it("posts only to the Decisions alpha endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(JEV_DECISIONS_URL);
      expect(String(url)).not.toContain("/chat/completions");
      return new Response(JSON.stringify({
        id: "gen_jev",
        model: JEV_MODEL_ID,
        answers: successfulAnswers(),
        usage: { input_tokens: 120, output_tokens: 8, cost: 0.0001 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const execution: ModelExecution = {
      recover: false,
      fetch: fetchImpl as typeof fetch,
      usage: () => ({ model_calls: 1, input_tokens: 120, output_tokens: 8, reasoning_tokens: 0, total_tokens: 128, cost_usd: 0.0001, web_search_requests: 0 }),
    };
    const posted = await postJevDecisions({
      apiKey: "test-key",
      execution,
      request: buildJevDecisionsRequest({ turn: 1 }, buildJevClassifierQuestions()),
    });
    expect(posted.response.answers.outcome).toMatchObject({ type: "choice", choice: "shortlisted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { model: string; messages?: unknown };
    expect(body.model).toBe(JEV_MODEL_ID);
    expect(body.messages).toBeUndefined();
  });

  it("classifies through Jev Decisions without a chat/completions call when answers are confident", async () => {
    const urls: string[] = [];
    const execution: ModelExecution = {
      recover: false,
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          id: "gen_jev",
          model: JEV_MODEL_ID,
          answers: successfulAnswers(),
          usage: { input_tokens: 120, output_tokens: 8, cost: 0.0001 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      usage: () => ({ model_calls: 1, input_tokens: 120, output_tokens: 8, reasoning_tokens: 0, total_tokens: 128, cost_usd: 0.0001, web_search_requests: 0 }),
    };
    const result = await runResultClassifier({
      apiKey: "test-key",
      policy,
      turnOrdinal: 1,
      context,
      query,
      observerResult,
      targetIdentity,
      jevClassifier: true,
      execution,
    });
    expect(urls).toEqual([JEV_DECISIONS_URL]);
    expect(result.output.target_observation.candidate_set).toBe("included");
    expect(result.raw_output).toMatchObject({ jev_model: JEV_MODEL_ID });
  });

  it("uses Jev when the flag is on and falls back to configured model after a complete Jev error", async () => {
    expect(jevClassifierEnabled(undefined)).toBe(false);
    expect(jevClassifierEnabled("0")).toBe(false);
    expect(jevClassifierEnabled("false")).toBe(false);
    expect(jevClassifierEnabled("1")).toBe(true);
    expect(jevClassifierEnabled("true")).toBe(true);

    const urls: string[] = [];
    const chatModels: string[] = [];
    const execution: ModelExecution = {
      recover: false,
      fetch: async (url, init) => {
        urls.push(String(url));
        if (String(url).includes("/api/alpha/decisions")) {
          return new Response("upstream overloaded", { status: 529 });
        }
        if (init?.body) chatModels.push(JSON.parse(String(init.body)).model);
        return new Response(JSON.stringify({
          id: "luna",
          object: "chat.completion",
          created: 1,
          model: "example/planner",
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                answer_shape: "no_concrete_options",
                candidates: [],
                target_observation: {
                  turn_ordinal: 1,
                  retrievability: "not_retrieved",
                  candidate_set: "absent",
                  comparison: "not_observed",
                  recommendation: "not_recommended",
                  matched_source_ids: [],
                  matched_candidate_ids: [],
                  visible_reason_evidence_ids: [],
                  semantic_classification_required: false,
                },
                deterministic_match_complete: true,
                semantic_match_explanation: "configured model fallback classified a completed negative observation.",
              }),
            },
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.01 },
        }), { headers: { "content-type": "application/json" } });
      },
      usage: () => ({ model_calls: urls.length, input_tokens: 20, output_tokens: 10, reasoning_tokens: 0, total_tokens: 30, cost_usd: 0.01, web_search_requests: 0 }),
    };

    const result = await runResultClassifier({
      apiKey: "test-key",
      policy,
      turnOrdinal: 1,
      context,
      query,
      observerResult: { ...observerResult, sources: [] },
      targetIdentity,
      jevClassifier: true,
      execution,
    });
    expect(urls[0]).toBe(JEV_DECISIONS_URL);
    expect(urls.some((url) => url.includes("/chat/completions"))).toBe(true);
    expect(chatModels).toEqual(["example/planner"]);
    expect(result.output.semantic_match_explanation).toContain("configured model fallback");
    expect(result.raw_output).toMatchObject({ jev_fallback: "http_error" });
  });

  it("keeps a timeout as uncertain and does not invent an absent outcome", async () => {
    const execution: ModelExecution = {
      recover: false,
      fetch: async () => {
        const error = new DOMException("The operation was aborted due to timeout", "TimeoutError");
        throw error;
      },
      usage: () => ({ model_calls: 1, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, cost_usd: null, web_search_requests: 0 }),
    };
    await expect(runResultClassifier({
      apiKey: "test-key",
      policy,
      turnOrdinal: 1,
      context,
      query,
      observerResult,
      targetIdentity,
      jevClassifier: true,
      execution,
    })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("reads Decisions usage fields rather than chat completion token names", () => {
    expect(jevUsageFromResponse({
      model: JEV_MODEL_ID,
      answers: {},
      usage: { input_tokens: 40, output_tokens: 2, cost: 0.00004 },
    })).toMatchObject({ input_tokens: 40, output_tokens: 2, cost_usd: 0.00004, web_search_requests: 0 });
  });
});
