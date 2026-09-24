import { createModelJournal } from "./model-journal";
import { buildReportDiagnosis } from "./report-diagnosis";
import { reportInterruption } from "./report-interruption";
import type { TechnicalCheck } from "@mclab/shopify-online-store";
import {
  CONTRACT_VERSIONS,
  type BuyerBrief,
  type CreateCustomerTaskRequest,
  type ModelRolePolicy,
  type TargetIdentity,
} from "@mclab/contracts";
import {
  ADAPTIVE_SHOPPING_PROTOCOL,
  ADAPTIVE_ROLE_POLICIES,
  CONTROLLED_SHOPPING_PROTOCOL,
  DEFAULT_ROLE_POLICIES,
  MAX_QUERY_REVISIONS,
} from "@mclab/domain";
import {
  buildProductResearchPrompt,
  buildProductUnderstandingPrompt,
  modelCapability,
  runProductResearcher,
  runProductUnderstandingSynthesizer,
  runDirectRetrievalCapture,
  assessDirectRetrieval,
  directRetrievalQuestion,
  directRetrievalPass,
} from "@mclab/openrouter-adapter";
import {
  type ProductRecord,
} from "@mclab/shopify-online-store";

import {
  COMPLETE_TASK_CREDITS,
  ensureBrowserSession,
  readCreditBalance,
} from "./credits";
import { readControlledShoppingSession } from "./shopping-orchestrator";

export const CUSTOMER_BUDGET = {
  max_turns: CONTROLLED_SHOPPING_PROTOCOL.maximum_turns,
  max_model_calls: CONTROLLED_SHOPPING_PROTOCOL.maximum_turns * (4 + MAX_QUERY_REVISIONS * 2),
  max_search_requests: CONTROLLED_SHOPPING_PROTOCOL.maximum_turns * 3,
  max_input_tokens: 1_000_000,
  max_output_tokens: 250_000,
  max_cost_usd_micros: 2_000_000,
} as const;

export const BUYER_BRIEF_POLICY = {
  role: "query_generator",
  route_key: "synthesizer",
  reasoning_effort: "medium",
  search: { enabled: false },
  // Product Understanding and Buyer Brief are returned as one strict object.
  // A 2k cap truncated valid responses before their closing JSON delimiters.
  max_output_tokens: 6_000,
  max_call_cost_usd_micros: 100_000,
  max_retries: 0,
  allow_provider_fallback: false,
} as const satisfies ModelRolePolicy & { role: "query_generator" };

export const PRODUCT_RESEARCH_POLICY = {
  role: "query_generator",
  route_key: "observer",
  reasoning_effort: "medium",
  search: { enabled: true, engine: "native", max_total_results: 8, max_search_requests: 1 },
  max_output_tokens: 6_000,
  max_call_cost_usd_micros: 500_000,
  max_retries: 0,
  allow_provider_fallback: false,
} as const satisfies ModelRolePolicy & { role: "query_generator" };

export async function createCustomerTask(
  request: Request,
  input: CreateCustomerTaskRequest,
  env: Env,
): Promise<{
  task_id: string;
  session_id: string | null;
  collection_id: string | null;
  status: "queued" | "running" | "completed" | "failed";
  reserved_credits: number;
  technical_check: unknown;
  product_record: ProductRecord | null;
  set_cookie?: string;
}> {
  const { admitDiagnostic } = await import("./diagnostic-workflow");
  return admitDiagnostic(request, input, env);
}

export async function prepareDirectRetrieval(input: {
  record: ProductRecord;
  collectionId: string;
  buyerBrief: BuyerBrief;
  targetIdentity: TargetIdentity;
  input: CreateCustomerTaskRequest;
  recover?: boolean;
}, env: Env) {
  const prefix = `collections/${input.collectionId}/direct-retrieval`;
  if (input.recover && await env.EVIDENCE.head(`${prefix}.json`)) return;
  const question = directRetrievalQuestion(input.targetIdentity);
  const capturedAt = new Date().toISOString();
  const observerPolicy = DEFAULT_ROLE_POLICIES.find((policy) => policy.role === "shopping_observer")!;
  await env.EVIDENCE.put(`${prefix}-request.json`, JSON.stringify({ question, model_route: observerPolicy.route_key, reasoning_effort: observerPolicy.reasoning_effort, fresh_context: true, captured_at: capturedAt }));
  const captureExecution = input.recover ? createModelJournal(`${prefix}/capture`, env) : undefined;
  const assessmentExecution = input.recover ? createModelJournal(`${prefix}/assessment`, env) : undefined;
  try {
    const capture = await runDirectRetrievalCapture({
      ...(captureExecution ? { execution: captureExecution } : {}),
      apiKey: env.OPENROUTER_API_KEY!,
      policy: { ...observerPolicy, role: "shopping_observer" },
      identity: input.targetIdentity,
      context: {
        buyer_brief: input.buyerBrief,
        protocol: ADAPTIVE_SHOPPING_PROTOCOL,
        completed_turns: [],
        usage: { turns: 0, model_calls: 0, search_requests: 0, input_tokens: 0, output_tokens: 0, cost_usd_micros: 0 },
      },
    });
    await env.EVIDENCE.put(`${prefix}-search.json`, JSON.stringify(capture));
    const assessment = await assessDirectRetrieval({ ...(assessmentExecution ? { execution: assessmentExecution } : {}), apiKey: env.OPENROUTER_API_KEY!, identity: input.targetIdentity, record: input.record, capture: capture.output });
    await env.EVIDENCE.put(`${prefix}-assessment.json`, JSON.stringify(assessment));
    const passed = directRetrievalPass(assessment.output, capture.output);
    const usage = {
      input_tokens: capture.usage.input_tokens + assessment.usage.input_tokens,
      output_tokens: capture.usage.output_tokens + assessment.usage.output_tokens,
      reasoning_tokens: capture.usage.reasoning_tokens + assessment.usage.reasoning_tokens,
      total_tokens: capture.usage.total_tokens + assessment.usage.total_tokens,
      cost_usd: capture.usage.cost_usd === null || assessment.usage.cost_usd === null ? null : capture.usage.cost_usd + assessment.usage.cost_usd,
      web_search_requests: capture.usage.web_search_requests,
    };
    await env.EVIDENCE.put(`${prefix}.json`, JSON.stringify({ status: passed ? "passed" : "unresolved", captured_at: capturedAt, question, answer: capture.output.message, sources: capture.output.sources, assessment: assessment.output, usage, call_count: 1 + (assessment.model_calls ?? 1) }));
    // A completed negative lookup is evidence; continue the blind observation.
  } catch (error) {
    if (error instanceof CustomerTaskError) throw error;
    const saved = input.recover ? await env.EVIDENCE.get(`${prefix}-search.json`) : null;
    const capture = saved ? await saved.json<{ output: { message: string; sources: unknown[] } }>() : null;
    const captureUsage = captureExecution?.usage(); const assessmentUsage = assessmentExecution?.usage();
    await env.EVIDENCE.put(`${prefix}.json`, JSON.stringify({ status: "failed", captured_at: capturedAt, question,
      ...(capture ? { answer: capture.output.message, sources: capture.output.sources } : {}),
      ...(captureUsage && assessmentUsage ? { call_count: captureUsage.model_calls + assessmentUsage.model_calls, usage: {
        input_tokens: captureUsage.input_tokens + assessmentUsage.input_tokens, output_tokens: captureUsage.output_tokens + assessmentUsage.output_tokens,
        reasoning_tokens: captureUsage.reasoning_tokens + assessmentUsage.reasoning_tokens, total_tokens: captureUsage.total_tokens + assessmentUsage.total_tokens,
        cost_usd: captureUsage.cost_usd === null || assessmentUsage.cost_usd === null ? null : captureUsage.cost_usd + assessmentUsage.cost_usd,
        web_search_requests: captureUsage.web_search_requests,
      } } : {}), error: modelFailureSummary(error).slice(0, 1_000) }));
    if (input.recover) return;
    throw new CustomerTaskError("DIRECT_RETRIEVAL_FAILED", "The direct product lookup could not finish. Your credits were returned. Please try again later.", 502);
  }
}

export async function generateBuyerBrief(input: {
  record: ProductRecord;
  targetMarket: string;
  collectionId: string;
  jobId: string;
  recover?: boolean;
}, env: Env): Promise<BuyerBrief> {
  if (!env.MODEL_CONFIG) {
    throw new CustomerTaskError("AI_UNAVAILABLE", "The AI shopping service is temporarily unavailable.", 503);
  }
  const openRouterApiKey = env.OPENROUTER_API_KEY ?? "configured-per-route";
  const runId = input.recover ? input.jobId : crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const prefix = `collections/${input.collectionId}/buyer-brief-runs/${runId}`;
  const cached = input.recover ? await env.EVIDENCE.get(`${prefix}/result.json`) : null;
  if (cached) {
    const saved = await cached.json<{ buyer_brief: BuyerBrief }>();
    const done = await env.DB.prepare("SELECT status FROM buyer_brief_runs WHERE id = ?").bind(runId).first<{ status: string }>();
    if (done?.status === "completed") return saved.buyer_brief;
  }
  const researchPrompt = buildProductResearchPrompt(input.record, input.targetMarket);
  const researchRequestKey = `${prefix}/product-research-request.txt`;
  const researchResultKey = `${prefix}/product-research-result.json`;
  const requestKey = researchRequestKey;
  const synthesisRequestKey = `${prefix}/synthesis-request.txt`;
  const resultKey = `${prefix}/result.json`;
  const understandingKey = `${prefix}/product-understanding.json`;
  const researchCapability = modelCapability(PRODUCT_RESEARCH_POLICY.route_key);
  const synthesisCapability = modelCapability(BUYER_BRIEF_POLICY.route_key);

  await env.EVIDENCE.put(researchRequestKey, researchPrompt, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { job_id: input.jobId, prompt_sha256: await sha256Hex(researchPrompt) },
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO buyer_brief_runs (
      id, job_id, collection_id, route_key, model_id, reasoning_effort,
      status, request_key, prompt_sha256, created_at,
      research_route_key, research_model_id, research_reasoning_effort,
      research_request_key, research_result_key, synthesis_request_key, understanding_key
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    runId,
    input.jobId,
    input.collectionId,
    BUYER_BRIEF_POLICY.route_key,
    synthesisCapability.model_id,
    BUYER_BRIEF_POLICY.reasoning_effort,
    requestKey,
    await sha256Hex(researchPrompt),
    createdAt,
    PRODUCT_RESEARCH_POLICY.route_key,
    researchCapability.model_id,
    PRODUCT_RESEARCH_POLICY.reasoning_effort,
    researchRequestKey,
    researchResultKey,
    synthesisRequestKey,
    understandingKey,
  ).run();

  const researchExecution = input.recover ? createModelJournal(`${prefix}/research`, env) : undefined;
  const synthesisExecution = input.recover ? createModelJournal(`${prefix}/synthesis`, env) : undefined;
  try {
    if (input.recover) await env.DB.prepare("UPDATE buyer_brief_runs SET status = 'running' WHERE id = ?").bind(runId).run();
    const retry = input.recover ? <T>(run: () => Promise<T>) => run() : withTransientModelRetry;
    const research = await retry(() => runProductResearcher({
      ...(researchExecution ? { execution: researchExecution } : {}),
      apiKey: openRouterApiKey,
      policy: PRODUCT_RESEARCH_POLICY,
      record: input.record,
      targetMarket: input.targetMarket,
      abortSignal: AbortSignal.timeout(120_000),
    }));
    const researchBody = JSON.stringify({
      memo: research.output,
      sources: research.provider_sources,
      usage: research.usage,
      response_id: research.response_id,
    });
    await env.EVIDENCE.put(researchResultKey, researchBody, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { job_id: input.jobId, sha256: await sha256Hex(researchBody) },
    });
    const synthesisPrompt = buildProductUnderstandingPrompt({
      record: input.record,
      targetMarket: input.targetMarket,
      research: { memo: research.output, sources: research.provider_sources },
    });
    await env.EVIDENCE.put(synthesisRequestKey, synthesisPrompt, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { job_id: input.jobId, prompt_sha256: await sha256Hex(synthesisPrompt) },
    });
    const result = await retry(() => runProductUnderstandingSynthesizer({
      ...(synthesisExecution ? { execution: synthesisExecution } : {}),
      apiKey: openRouterApiKey,
      policy: BUYER_BRIEF_POLICY,
      record: input.record,
      targetMarket: input.targetMarket,
      research: { memo: research.output, sources: research.provider_sources },
      abortSignal: AbortSignal.timeout(90_000),
    }));
    const completedAt = new Date().toISOString();
    const understandingBody = JSON.stringify(result.output.understanding);
    const resultBody = JSON.stringify({
      product_understanding: result.output.understanding,
      buyer_brief: result.output.buyer_brief,
      research: {
        sources: research.provider_sources,
        usage: research.usage,
        response_id: research.response_id,
      },
      synthesis: { usage: result.usage, response_id: result.response_id },
    });
    await Promise.all([
      env.EVIDENCE.put(understandingKey, understandingBody, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { job_id: input.jobId, sha256: await sha256Hex(understandingBody) },
      }),
      env.EVIDENCE.put(resultKey, resultBody, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { job_id: input.jobId, sha256: await sha256Hex(resultBody) },
      }),
    ]);
    const totalCost = research.usage.cost_usd === null || result.usage.cost_usd === null
      ? null
      : Math.max(0, Math.round((research.usage.cost_usd + result.usage.cost_usd) * 1_000_000));
    await env.DB.prepare(
      `UPDATE buyer_brief_runs SET status = 'completed', result_key = ?,
        provider_response_id = ?, input_tokens = ?, output_tokens = ?,
        reasoning_tokens = ?, total_tokens = ?, cost_usd_micros = ?, completed_at = ?,
        research_provider_response_id = ?, research_source_count = ?, research_search_requests = ?, model_call_count = ?
       WHERE id = ? AND status = 'running'`,
    ).bind(
      resultKey,
      result.response_id,
      research.usage.input_tokens + result.usage.input_tokens,
      research.usage.output_tokens + result.usage.output_tokens,
      research.usage.reasoning_tokens + result.usage.reasoning_tokens,
      research.usage.total_tokens + result.usage.total_tokens,
      totalCost,
      completedAt,
      research.response_id,
      research.provider_sources.length,
      research.usage.web_search_requests,
      1 + (result.model_calls ?? 1),
      runId,
    ).run();
    return result.output.buyer_brief;
  } catch (error) {
    if (researchExecution && synthesisExecution) {
      const research = researchExecution.usage(); const synthesis = synthesisExecution.usage();
      const cost = research.cost_usd === null || synthesis.cost_usd === null ? null : Math.round((research.cost_usd + synthesis.cost_usd) * 1_000_000);
      await env.DB.prepare(`UPDATE buyer_brief_runs SET input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, total_tokens = ?, cost_usd_micros = ?, model_call_count = ?, research_search_requests = ? WHERE id = ? AND status = 'running'`)
        .bind(research.input_tokens + synthesis.input_tokens, research.output_tokens + synthesis.output_tokens, research.reasoning_tokens + synthesis.reasoning_tokens, research.total_tokens + synthesis.total_tokens, cost, research.model_calls + synthesis.model_calls, research.web_search_requests, runId).run();
    }
    await env.DB.prepare(
      `UPDATE buyer_brief_runs SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    ).bind(
      modelFailureSummary(error).slice(0, 1_000),
      new Date().toISOString(),
      runId,
    ).run();
    throw new CustomerTaskError(
      "BUYER_BRIEF_FAILED",
      "We could not prepare this report. Your credits were returned. Please try again.",
      502,
    );
  }
}

export function modelFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") return message;

  const record = error as Record<string, unknown>;
  const details: string[] = [];
  if (typeof record.finishReason === "string") {
    details.push(`finish_reason=${record.finishReason}`);
  }
  if (record.usage && typeof record.usage === "object") {
    const usage = record.usage as Record<string, unknown>;
    if (typeof usage.outputTokens === "number") {
      details.push(`output_tokens=${usage.outputTokens}`);
    }
    if (typeof usage.totalTokens === "number") {
      details.push(`total_tokens=${usage.totalTokens}`);
    }
  }
  if (record.response && typeof record.response === "object") {
    const response = record.response as Record<string, unknown>;
    if (typeof response.id === "string" && response.id.trim()) {
      details.push(`response_id=${response.id.trim()}`);
    }
  }
  return details.length ? `${message} [${details.join("; ")}]` : message;
}

export function mergeBuyerBrief(
  generated: BuyerBrief,
  input: CreateCustomerTaskRequest,
): BuyerBrief {
  const userDimensions = [
    ...input.constraints.map((label) => ({
      label,
      applies_to: "product or purchase",
      priority: "required" as const,
      origin: "user_supplied" as const,
      fingerprint_risk: "medium" as const,
      evidence_strength: "high" as const,
    })),
    ...input.preferences.map((label) => ({
      label,
      applies_to: "product or purchase",
      priority: "preference" as const,
      origin: "user_supplied" as const,
      fingerprint_risk: "medium" as const,
      evidence_strength: "high" as const,
    })),
  ];
  return {
    ...generated,
    schema_version: CONTRACT_VERSIONS.guidedShopping,
    target_market: input.target_market,
    category: input.category ?? generated.category,
    buyer_job: input.buyer_job ?? generated.buyer_job,
    use_cases: input.use_cases.length ? input.use_cases : generated.use_cases,
    constraints: input.constraints.length ? input.constraints : generated.constraints,
    preferences: input.preferences.length ? input.preferences : generated.preferences,
    decision_dimensions: userDimensions.length
      ? [...generated.decision_dimensions, ...userDimensions].slice(0, 16)
      : generated.decision_dimensions,
  };
}

async function withTransientModelRetry<T>(run: () => Promise<T>): Promise<T> {
  const delaysMs = [5_000, 20_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /429|rate.?limit|overload|temporar|timeout|502|503|504/i.test(message);
      const delayMs = delaysMs[attempt];
      if (!transient || delayMs === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function categoryFromProductRecord(record: ProductRecord): string | null {
  const value = record.fields.product_type_category.value;
  if (typeof value !== "string") return null;
  const category = value.trim().replace(/\s+/g, " ");
  return category.length >= 2 ? category.slice(0, 120) : null;
}

export async function readCustomerTask(request: Request, taskId: string, env: Env): Promise<{
  task: unknown | null;
  set_cookie?: string;
}> {
  const browser = await ensureBrowserSession(request, env);
  const owned = await env.DB.prepare(
    `SELECT jobs.status AS job_status, jobs.reserved_credits, jobs.completed_at,
      shopping_sessions.id AS session_id, shopping_sessions.collection_id,
      COALESCE(shopping_sessions.billing_status, credit_reservations.status) AS billing_status,
      buyer_brief_runs.collection_id AS preparation_collection_id
     FROM jobs
     LEFT JOIN shopping_sessions ON shopping_sessions.job_id = jobs.id
     LEFT JOIN credit_reservations ON credit_reservations.id = jobs.reservation_id
     LEFT JOIN buyer_brief_runs ON buyer_brief_runs.job_id = jobs.id
     WHERE jobs.id = ? AND jobs.account_id = ?`,
  ).bind(taskId, browser.accountId).first<{
    job_status: string;
    reserved_credits: number;
    completed_at: string | null;
    session_id: string | null;
    collection_id: string | null;
    preparation_collection_id: string | null;
    billing_status: string;
  }>();
  if (!owned) return { task: null, ...(browser.setCookie ? { set_cookie: browser.setCookie } : {}) };
  const [session, balance] = await Promise.all([
    owned.session_id ? readControlledShoppingSession(owned.session_id, env) : readPreparationReport(taskId, owned.job_status, owned.preparation_collection_id, env),
    readCreditBalance(browser.accountId, env),
  ]);
  const publicSession = customerSessionProjection(session);
  if (publicSession?.report && typeof publicSession.report === "object") {
    const report = publicSession.report as Record<string, unknown>;
    const controlObject = await env.EVIDENCE.get(`collections/${owned.collection_id}/direct-retrieval.json`);
    if (controlObject && controlObject.size < 256_000) {
      const control = JSON.parse(await controlObject.text());
      report.direct_retrieval = { status: control.status, question: control.question, answer: control.answer, sources: control.sources, explanation: control.assessment?.explanation };
      if (report.status === "complete" && control.status === "passed" && report.diagnosis && typeof report.diagnosis === "object") {
        const diagnosis = report.diagnosis as Record<string, unknown>;
        diagnosis.confidence = { ...(diagnosis.confidence as object), explanation: "The isolated direct-name lookup identified the product from merchant sources. The recorded shopping outcome is observed separately; its cause remains uncertain and competitor claims are not independently verified sentence by sentence." };
        if (Array.isArray(diagnosis.limitations)) diagnosis.limitations = diagnosis.limitations.map((item) => typeof item === "string" && item.startsWith("No branded") ? "The separate branded lookup establishes direct identity only; it is excluded from natural discovery and does not prove why the shopping answer included or omitted the product." : item);
      }
      if (report.status === "complete" && control.status === "unresolved" && report.diagnosis && typeof report.diagnosis === "object") {
        const diagnosis = report.diagnosis as Record<string, unknown>;
        diagnosis.confidence = { ...(diagnosis.confidence as object), explanation: "The separate name lookup did not establish this exact product. The natural shopping outcome is recorded independently. Neither observation proves the product is poor or establishes a single cause." };
        if (Array.isArray(diagnosis.limitations)) diagnosis.limitations = diagnosis.limitations.map(item => typeof item === "string" && item.startsWith("No branded") ? "The completed direct-name lookup did not establish the exact product; this is a negative retrieval observation, not proof that the product is unavailable everywhere." : item);
        if (diagnosis.outcome === "absent") {
          diagnosis.observed_result = "The product was not established by the separate direct-name lookup and did not enter the recorded natural shopping candidate set.";
          diagnosis.failure_point = { label: "Direct retrieval and candidate-set entry", explanation: "The first observed gap was the exact-product name lookup. The separate unbranded conversation also did not surface the product. Product fit, source clarity and search coverage remain possible explanations; product quality is not established by absence." };
        }
      }
    }
    const rawSession = session as Record<string, unknown>;
    if (typeof rawSession.buyer_brief_key === "string") {
      const briefObject = await env.EVIDENCE.get(rawSession.buyer_brief_key);
      if (briefObject && briefObject.size < 100_000) {
        const brief = JSON.parse(await briefObject.text());
        report.buyer_situation = { category: brief.category, job: brief.buyer_job, market: brief.target_market, constraints: brief.constraints, preferences: brief.preferences };
      }
    }
  }
  const sessionStatus = typeof publicSession?.status === "string" ? publicSession.status : "queued";
  const terminalSession = ["completed", "incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(sessionStatus);
  let progress_stage: string | null = null;
  if (!terminalSession) {
    const preparationObject = await env.EVIDENCE.get(`jobs/${taskId}/preparation.json`);
    if (preparationObject) {
      try {
        const preparation = JSON.parse(await preparationObject.text()) as { stage?: unknown };
        if (typeof preparation.stage === "string" && preparation.stage.trim()) progress_stage = preparation.stage;
      } catch {
        // Ignore malformed progress artifacts; the wait UI still has a generic message.
      }
    }
  }
  return {
    task: {
      id: taskId,
      job_status: owned.job_status,
      billing_status: owned.billing_status,
      reserved_credits: owned.reserved_credits,
      completed_at: owned.completed_at,
      collection_id: owned.collection_id,
      session: publicSession,
      progress_stage,
      balance,
      artifact_base: `/api/v1/tasks/${taskId}/artifacts`,
    },
    ...(browser.setCookie ? { set_cookie: browser.setCookie } : {}),
  };
}

async function readPreparationReport(taskId: string, jobStatus: string, historicalCollectionId: string | null, env: Env) {
  if (jobStatus !== "failed") return { status: "queued", completed_turns: 0, report: null };
  const read = async <T>(key: string | null): Promise<T | null> => {
    if (!key) return null;
    const object = await env.EVIDENCE.get(key);
    if (!object || object.size > 1_000_000) return null;
    return JSON.parse(await object.text()) as T;
  };
  const preparation = await read<{ stage: string; collection_id: string | null }>(`jobs/${taskId}/preparation.json`);
  const collectionId = preparation?.collection_id ?? historicalCollectionId;
  const artifacts = collectionId ? await env.DB.prepare("SELECT product_record_key, technical_check_key FROM collection_runs WHERE id = ?").bind(collectionId).first<{ product_record_key: string; technical_check_key: string | null }>() : null;
  const [productRecord, technicalCheck, directRetrieval] = await Promise.all([
    read<ProductRecord>(artifacts?.product_record_key ?? null),
    read<TechnicalCheck>(artifacts?.technical_check_key ?? null),
    read<{ status: string; question?: string; answer?: string; sources?: unknown[] }>(collectionId ? `collections/${collectionId}/direct-retrieval.json` : null),
  ]);
  const interruption = reportInterruption("incomplete", [], preparation?.stage ?? "Preparing the shopping test");
  return { status: "incomplete", completed_turns: 0, report: {
    status: "partial", interruption,
    disclaimer: "This report preserves the available evidence from this attempt. No completed shopping observation is available; recommendation cannot be determined.",
    summary: { completed_turns: 0, first_retrieved_turn: null, first_candidate_set_turn: null, first_recommended_turn: null, first_final_choice_turn: null },
    diagnosis: buildReportDiagnosis({ turns: [], completedTurns: 0, productRecord, technicalCheck, interruption }),
    direct_retrieval: directRetrieval ? { status: directRetrieval.status, question: directRetrieval.question, answer: directRetrieval.answer, sources: directRetrieval.sources } : null,
    turns: [],
  } };
}

function customerSessionProjection(session: unknown): {
  status: string;
  completed_turns: number;
  report: unknown | null;
} | null {
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  const value = session as Record<string, unknown>;
  const status = typeof value.status === "string" ? value.status : "unknown";
  return {
    status,
    completed_turns: typeof value.completed_turns === "number" ? value.completed_turns : 0,
    report: ["completed", "incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(status) ? value.report ?? null : null,
  };
}

export async function customerOwnsCollection(
  request: Request,
  taskId: string,
  env: Env,
): Promise<{ collectionId: string | null; set_cookie?: string }> {
  const browser = await ensureBrowserSession(request, env);
  const row = await env.DB.prepare(
    `SELECT shopping_sessions.collection_id
     FROM jobs JOIN shopping_sessions ON shopping_sessions.job_id = jobs.id
     WHERE jobs.id = ? AND jobs.account_id = ?`,
  ).bind(taskId, browser.accountId).first<{ collection_id: string }>();
  return {
    collectionId: row?.collection_id ?? null,
    ...(browser.setCookie ? { set_cookie: browser.setCookie } : {}),
  };
}

export function customerPolicies(_input?: CreateCustomerTaskRequest): readonly ModelRolePolicy[] {
  return ADAPTIVE_ROLE_POLICIES;
}

export function targetIdentityFromRecord(record: ProductRecord): TargetIdentity {
  const url = new URL(record.final_url);
  const title = textField(record.fields.title.value) ?? productNameFromUrl(url);
  const brand = textField(record.fields.vendor_brand.value) ?? url.hostname.replace(/^www\./, "");
  const canonical = textField(record.fields.canonical_url.value) ?? record.final_url;
  const skuIds = new Set<string>();
  const recordSku = textField(record.fields.sku.value);
  if (recordSku) skuIds.add(recordSku);
  for (const variant of record.variants) {
    if (variant.sku) skuIds.add(variant.sku);
    if (variant.barcode) skuIds.add(variant.barcode);
  }
  return {
    schema_version: CONTRACT_VERSIONS.guidedShopping,
    canonical_product_url: canonical,
    merchant_domains: [url.hostname],
    brand_names: [brand],
    product_names: [title],
    product_url_aliases: [...new Set([record.requested_url, record.final_url, canonical])],
    normalized_sku_ids: [...skuIds].slice(0, 100),
  };
}

function textField(value: string | number | boolean | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function productNameFromUrl(url: URL): string {
  const handle = url.pathname.split("/").filter(Boolean).at(-1) ?? "Shopify product";
  return handle.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export class CustomerTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
