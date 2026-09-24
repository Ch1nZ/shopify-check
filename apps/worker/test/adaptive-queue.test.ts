import { diagnosticGraph, processDiagnostic } from "../src/diagnostic-workflow";
import { recoverAdaptiveEvidence } from "../../../packages/model-adapters/openrouter/src/evidence-quotes";
import { ADAPTIVE_REPAIR_QUESTION } from "../../../packages/model-adapters/openrouter/src/adaptive-repair";
import { createCustomerTask, customerPolicies, PRODUCT_RESEARCH_POLICY, readCustomerTask } from "../src/customer-tasks";
import { createAccountSession } from "../src/credits";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CreateCustomerTaskRequestSchema } from "@mclab/contracts";
import type { AdaptiveAssessment, BlindConversationContext, ShoppingQueueMessage } from "@mclab/contracts";
import { ADAPTIVE_ROLE_POLICIES, ADAPTIVE_SHOPPING_PROTOCOL, CONTROLLED_SHOPPING_PROTOCOL, DEFAULT_ROLE_POLICIES, evaluateAdaptiveAssessment, frozenBuyerNeeds, initialAdaptiveDecision, renderAdaptiveQuestion } from "@mclab/domain";
import { createControlledShoppingSession } from "../src/shopping-sessions";
import { processShoppingQueueMessage, readControlledShoppingSession, startControlledShoppingSession } from "../src/shopping-orchestrator";
import { readCreditBalance, reserveJobCredits } from "../src/credits";

let scenario: "early" | "six" | "no_progress" | "repaired_evidence" | "audit_followup" = "early";
const testEnv = env as Env & { TEST_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
let observerCalls = 0;
let observerTimeout = false;
let observerSawAbort = false;
let rejectAudit = false;
let auditCalls = 0;
let targetIncluded = false;
let unresolvedTarget = false;
let paidFailure: "none" | "rate" | "terminal" = "none";
let collections = 0;
let researchCalls = 0;
let synthesisCalls = 0;
const source = { source_id: "src_alpha001", url: "https://example.com/alpha", title: "Option Alpha", supports: "Product listing facts" };
const answer = "Option Alpha is an everyday necklace available for delivery in Hong Kong. Its original needs are supported. I recommend Option Alpha for these original needs.";
const roleResult = <T,>(output: T) => ({ output, validation_error: null, response_id: "fixture-response", usage: { input_tokens: 100, output_tokens: 100, reasoning_tokens: 0, total_tokens: 200, cost_usd: 0.001, web_search_requests: 0 }, provider_sources: [] });

function scriptedAssessment(ctx: BlindConversationContext): AdaptiveAssessment {
  const n = ctx.completed_turns.length;
  const needs = frozenBuyerNeeds(ctx.buyer_brief);
  const ready = scenario === "early" || (scenario === "six" && n >= 6) || (scenario === "audit_followup" && n >= 2);
  return {
    candidates: scenario === "no_progress" ? [] : [{ name: "Option Alpha", identity_quote: "Option Alpha", turn_ordinal: n, category_fit: "supported", needs: needs.filter(need => need.priority === "required" || Number(need.id.split("_")[1]) < n).map(need => ({ need_id: need.id, status: (need.id === "market" && !ready || scenario === "six" && need.id.startsWith("required_") && Number(need.id.split("_")[1]) >= n) ? "unknown" : "supported", evidence_level: (need.id === "market" && !ready || scenario === "six" && need.id.startsWith("required_") && Number(need.id.split("_")[1]) >= n) ? "unknown" : "cited_reference", quote: answer, turn_ordinal: n, source_ids: [source.source_id] })) }],
    demand_drift: false, decision_quote: ready ? "I recommend Option Alpha for these original needs." : "", decision_turn_ordinal: n, proposed_action: ready ? "finish" : "verify", need_ids: ["market"],
  };
}

// Only provider execution is substituted. Actual domain validation, D1
// migrations/constraints, R2 persistence, queues, role claims and credits run.
vi.mock("@mclab/openrouter-adapter", async importOriginal => {
  const actual = await importOriginal<typeof import("@mclab/openrouter-adapter")>();
  return {
    ...actual,
    runProductResearcher: async () => { researchCalls++; return roleResult("Product source research memo."); },
    runProductUnderstandingSynthesizer: async () => { synthesisCalls++; return roleResult({ understanding: {}, buyer_brief: preparationBrief() }); },
    runDirectRetrievalCapture: async () => roleResult({ message: "The named product appeared in this retained control answer.", sources: [source] }),
    assessDirectRetrieval: async () => { throw new Error("Direct classification unavailable"); },
    runQueryGenerator: async (input: Parameters<typeof actual.runQueryGenerator>[0]) => {
      const { context } = input;
      if (scenario === "audit_followup" && (input.revisionAttempt ?? 0) > 0) return actual.runQueryGenerator(input);
      const raw = context.completed_turns.length ? scriptedAssessment(context) : null;
      if (raw && scenario === "repaired_evidence") raw.candidates.forEach(candidate => candidate.needs.forEach(need => { need.quote = "A fabricated supporting sentence"; }));
      return { ...roleResult(renderAdaptiveQuestion(context, raw ? evaluateAdaptiveAssessment(context, recoverAdaptiveEvidence(context, raw)) : initialAdaptiveDecision())), raw_output: { captured_assessment: true } };
    },
    runQueryAuditor: async (input: Parameters<typeof actual.runQueryAuditor>[0]) => {
      auditCalls += 1;
      if (paidFailure !== "none" && auditCalls === 1) {
        await input.execution!.fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "paid draft" });
        await input.execution!.fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "repair" });
        throw new Error(paidFailure === "rate" ? "429 rate limit" : "provider failure after paid draft");
      }
      if (input.query.message === ADAPTIVE_REPAIR_QUESTION) return actual.runQueryAuditor(input);
      const rejected = rejectAudit || (scenario === "audit_followup" && auditCalls === 2);
      return roleResult({ decision: rejected ? "rejected" : "approved", target_leakage: rejectAudit, leaked_terms: [], issues: rejected ? ["Integrity gate rejected the message."] : [] });
    },
    runShoppingObserver: async (input: Parameters<typeof actual.runShoppingObserver>[0]) => {
      observerSawAbort = Boolean(input.abortSignal);
      observerCalls += 1;
      if (observerTimeout) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return { ...roleResult({ message: answer, sources: [source] }), usage: { ...roleResult(null).usage, web_search_requests: 1 } };
    },
    runResultClassifier: async ({ turnOrdinal }: { turnOrdinal: number }) => roleResult({ answer_shape: "shortlist", candidates: [{ candidate_id: "cand_alpha001", displayed_name: "Option Alpha", merchant_domain: "example.com", product_url: source.url, position: 1, compared: false, recommended: true, final_choice: true, supporting_source_ids: scenario === "repaired_evidence" ? [source.source_id, "src_invented"] : [source.source_id] }], target_observation: { turn_ordinal: turnOrdinal, retrievability: unresolvedTarget ? "not_observed" : targetIncluded ? "retrieved" : "not_retrieved", candidate_set: unresolvedTarget ? "not_observed" : targetIncluded ? "included" : "absent", comparison: "not_compared", recommendation: targetIncluded ? "final_choice" : "not_recommended", matched_source_ids: [], matched_candidate_ids: [], visible_reason_evidence_ids: [], semantic_classification_required: false }, deterministic_match_complete: true, semantic_match_explanation: "The private target is absent." }),
  };
});

beforeAll(async () => { await applyD1Migrations(testEnv.TEST_DB, testEnv.TEST_MIGRATIONS); });

async function setup(legacy = false, maxCost = 2_000_000) {
  observerCalls = 0;
  observerTimeout = false;
  observerSawAbort = false;
  targetIncluded = false;
  unresolvedTarget = false;
  paidFailure = "none";
  rejectAudit = false;
  auditCalls = 0;
  const pending: ShoppingQueueMessage[] = [];
  const runtime = { ...env, DB: testEnv.TEST_DB, OPENROUTER_API_KEY: "test-no-network", JOBS_QUEUE: { send: async (message: ShoppingQueueMessage) => { pending.push(message); } } } as unknown as Env;
  const now = new Date().toISOString();
  const accountId = crypto.randomUUID(); const jobId = crypto.randomUUID(); const reservationId = crypto.randomUUID(); const collectionId = crypto.randomUUID();
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)").bind(accountId, now, now),
    runtime.DB.prepare("INSERT INTO credit_operations (id, account_id, operation_type, external_idempotency_key, credits, status, created_at, updated_at) VALUES (?, ?, 'grant', ?, 100, 'completed', ?, ?)").bind(crypto.randomUUID(), accountId, crypto.randomUUID(), now, now),
    runtime.DB.prepare("INSERT INTO jobs (id, account_id, job_kind, protocol_version, pricing_version, reserved_credits, reservation_id, status, created_at, updated_at) VALUES (?, ?, 'guided_search_balanced', 'guided-shopping/1.0', 'test', 30, ?, 'running', ?, ?)").bind(jobId, accountId, reservationId, now, now),
    runtime.DB.prepare("INSERT INTO collection_runs (id, requested_url, final_url, status, product_record_key, created_at) VALUES (?, 'https://example.com/products/private', 'https://example.com/products/private', 'complete', ?, ?)").bind(collectionId, `test/${collectionId}/product.json`, now),
  ]);
  expect((await reserveJobCredits({ accountId, jobId, reservationId }, runtime)).admitted).toBe(true);
  const created = await createControlledShoppingSession({ collectionId, accountId, jobId, creditReservationId: reservationId, buyerBrief: { schema_version: "guided-shopping/1.0", category: "everyday necklace", buyer_job: "Find a necklace for everyday use", target_market: "Hong Kong", use_cases: [], constraints: scenario === "six" ? Array.from({ length: 6 }, (_, i) => `Ordinary requirement ${i}`) : [], preferences: Array.from({ length: 6 }, (_, i) => `Ordinary preference ${i}`), market_requirements: [], prohibited_fingerprints: [], decision_dimensions: [] }, targetIdentity: { schema_version: "guided-shopping/1.0", canonical_product_url: "https://private.example.com/product", merchant_domains: ["private.example.com"], brand_names: ["Private Brand"], product_names: ["Private Target"], product_url_aliases: [], normalized_sku_ids: [] }, protocol: legacy ? CONTROLLED_SHOPPING_PROTOCOL : ADAPTIVE_SHOPPING_PROTOCOL, modelPolicies: legacy ? DEFAULT_ROLE_POLICIES : ADAPTIVE_ROLE_POLICIES, budget: { max_turns: 6, max_model_calls: 40, max_search_requests: 20, max_input_tokens: 1_000_000, max_output_tokens: 250_000, max_cost_usd_micros: maxCost }, controllerVersion: legacy ? "v4" : "adaptive-controller/1.0" }, runtime);
  const mode = legacy ? "fixture" : "live";
  await startControlledShoppingSession(created.session_id, mode, runtime);
  return { runtime, pending, sessionId: created.session_id, accountId, jobId, reservationId, mode };
}
async function drain(run: Awaited<ReturnType<typeof setup>>, duplicate = false) {
  let count = 0;
  while (run.pending.length) {
    if (++count > 200) throw new Error("Queue failed to stop.");
    const message = run.pending.shift()!;
    await processShoppingQueueMessage(message, run.runtime);
    if (duplicate) await processShoppingQueueMessage(message, run.runtime);
  }
  return run.runtime.DB.prepare("SELECT status, completed_turns, current_turn, billing_status, reserved_model_calls FROM shopping_sessions WHERE id = ?").bind(run.sessionId).first<Record<string, unknown>>();
}

describe("adaptive production-schema queue integration", () => {
  it("finishes early, records only issued turns, and charges once despite duplicate deliveries", async () => {
    scenario = "early"; const run = await setup();
    expect(await drain(run, true)).toMatchObject({ status: "completed", completed_turns: 1, billing_status: "consumed", reserved_model_calls: 0 });
    expect(observerCalls).toBe(1);
    expect((await readCreditBalance(run.accountId, run.runtime)).settled_credits).toBe(70);
    const snapshot = await readControlledShoppingSession(run.sessionId, run.runtime) as { report: { turns: unknown[]; termination: { reason: string } } };
    expect(snapshot.report.turns).toHaveLength(1);
    expect(snapshot.report.termination.reason).toBe("decision_supported");
  });
  it("reviews sixth answer without violating current_turn ceiling or issuing seventh search", async () => {
    scenario = "six"; const run = await setup();
    expect(await drain(run)).toMatchObject({ status: "completed", completed_turns: 6, current_turn: 6, billing_status: "consumed", reserved_model_calls: 0 });
    expect(observerCalls).toBe(6);
    const last = await run.runtime.DB.prepare("SELECT ordinal, observer_response_key FROM shopping_turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1").bind(run.sessionId).first<Record<string, unknown>>();
    expect(last).toMatchObject({ ordinal: 7, observer_response_key: null });
  });
  it("delivers a complete negative observation and charges exactly once", async () => {
    scenario = "no_progress"; const run = await setup();
    expect(await drain(run, true)).toMatchObject({ status: "completed", completed_turns: 2, billing_status: "consumed", reserved_model_calls: 0 });
    expect(observerCalls).toBe(2);
    expect(await readCreditBalance(run.accountId, run.runtime)).toMatchObject({ settled_credits: 70, reserved_credits: 0 });
    const termination = await run.runtime.EVIDENCE.get(`shopping-sessions/${run.sessionId}/controller/termination.json`);
    expect(JSON.parse(await termination!.text()).reason).toBe("no_progress");
  });
  it("rejects an adaptive over-budget reservation before provider execution and refunds", async () => {
    scenario = "early"; const run = await setup(false, 1);
    expect(await drain(run)).toMatchObject({ status: "budget_exhausted", billing_status: "released", reserved_model_calls: 0 });
    expect(observerCalls).toBe(0);
    expect((await readCreditBalance(run.accountId, run.runtime)).settled_credits).toBe(100);
  });
  it("preserves the legacy v4 six-turn fixture with historical cost metadata", async () => {
    const run = await setup(true, 1);
    expect(await drain(run)).toMatchObject({ status: "completed", completed_turns: 6, current_turn: 6, billing_status: "consumed", reserved_model_calls: 0 });
    const stages = await run.runtime.DB.prepare("SELECT stage FROM shopping_turns WHERE session_id = ? ORDER BY ordinal").bind(run.sessionId).all<{ stage: string }>();
    expect(stages.results.map(t => t.stage)).toEqual(["discovery", "refinement", "shortlist", "comparison", "decision", "caveat_check"]);
  });
  it("permits two bounded initial-question repairs and never issues a rejected question", async () => {
    scenario = "early"; const run = await setup(); rejectAudit = true;
    expect(await drain(run, true)).toMatchObject({ status: "failed_validation", completed_turns: 0, billing_status: "released", reserved_model_calls: 0 });
    expect(auditCalls).toBe(3); expect(observerCalls).toBe(0);
    expect((await readCreditBalance(run.accountId, run.runtime)).settled_credits).toBe(100);
  });
});

it("continues after unsupported planner claims and still returns a complete negative report", async () => {
  scenario = "repaired_evidence"; const run = await setup();
  expect(await drain(run, true)).toMatchObject({ status: "completed", billing_status: "consumed", reserved_model_calls: 0 });
  expect(observerCalls).toBeGreaterThan(1);
  const session = await readControlledShoppingSession(run.sessionId, run.runtime) as { report: { status: string; diagnosis: { outcome: string }; turns: unknown[] } };
  expect(session.report.status).toBe("complete"); expect(session.report.diagnosis.outcome).toBe("absent");
  expect(session.report.turns.length).toBe(observerCalls);
  expect(await readCreditBalance(run.accountId, run.runtime)).toMatchObject({ settled_credits: 70, reserved_credits: 0 });
});
it("recovers a rejected followup using a different safe question, then completes normally", async () => {
  scenario = "audit_followup"; const run = await setup();
  expect(await drain(run, true)).toMatchObject({ status: "completed", completed_turns: 2, billing_status: "consumed" });
  expect(observerCalls).toBe(2); expect(auditCalls).toBe(3);
  const session = await readControlledShoppingSession(run.sessionId, run.runtime) as { report: { turns: Array<{ shopper_message: string }> } };
  expect(session.report.turns[1]!.shopper_message).toBe(ADAPTIVE_REPAIR_QUESTION);
});
it("a positive target outcome also produces a complete report", async () => {
  scenario = "early"; const run = await setup(); targetIncluded = true;
  expect(await drain(run)).toMatchObject({ status: "completed", billing_status: "consumed" });
  const session = await readControlledShoppingSession(run.sessionId, run.runtime) as { report: { status: string; diagnosis: { outcome: string } } };
  expect(session.report.status).toBe("complete"); expect(session.report.diagnosis.outcome).toBe("final_choice");
});
it("old failed sessions publish evidence only after termination and remain owner-only", async () => {
  scenario = "early"; const run = await setup();
  const browser = await createAccountSession(run.accountId, run.runtime);
  const req = new Request("https://example.com", { headers: { cookie: browser.setCookie!.split(";")[0]! } });
  const active = await readCustomerTask(req, run.jobId, run.runtime) as { task: { session: { report: unknown } } };
  expect(active.task.session.report).toBeNull();
  rejectAudit = true; await drain(run);
  const stopped = await readCustomerTask(req, run.jobId, run.runtime) as { task: { session: { report: { status: string; diagnosis: { outcome: string } } } } };
  expect(stopped.task.session.report.status).toBe("partial");
  expect(stopped.task.session.report.diagnosis.outcome).toBe("inconclusive");
  expect((await readCustomerTask(new Request("https://example.com"), run.jobId, run.runtime)).task).toBeNull();
});

async function driveGraph(run: Awaited<ReturnType<typeof setup>>) {
  await run.runtime.DB.prepare("UPDATE shopping_sessions SET controller_version = 'langgraph-diagnostic/1.0', protocol_revision = '2026-09-langgraph-v1' WHERE id = ?").bind(run.sessionId).run();
  const first = run.pending.shift()!;
  const now = new Date().toISOString();
  await run.runtime.DB.prepare("INSERT INTO diagnostic_workflows (job_id, input_key, status, next_run_at, created_at, updated_at) VALUES (?, 'test', 'queued', ?, ?, ?)").bind(run.jobId, now, now, now).run();
  await diagnosticGraph(run.runtime).updateState({ configurable: { thread_id: run.jobId } }, { jobId: run.jobId, message: first, delay: 0 }, "session");
  let ticks = 0;
  while (true) {
    if (++ticks > 70) throw new Error("Graph did not terminate");
    await processDiagnostic({ kind: "diagnostic_advance", job_id: run.jobId }, run.runtime);
    const row = await run.runtime.DB.prepare("SELECT status FROM diagnostic_workflows WHERE job_id = ?").bind(run.jobId).first<{ status: string }>();
    if (row?.status === "completed") break;
  }
  await processDiagnostic({ kind: "diagnostic_advance", job_id: run.jobId }, run.runtime);
  return run.runtime.DB.prepare("SELECT status, billing_status, reserved_model_calls FROM shopping_sessions WHERE id = ?").bind(run.sessionId).first();
}
it("LangGraph resumes each role from persisted state and settles credits once", async () => {
  scenario = "early";
  const run = await setup();
  expect(await driveGraph(run)).toMatchObject({ status: "completed", billing_status: "consumed", reserved_model_calls: 0 });
  expect(observerCalls).toBe(1);
  expect(observerSawAbort).toBe(true);
  expect((await readCreditBalance(run.accountId, run.runtime)).settled_credits).toBe(70);
});
it("LangGraph preserves unknown classification, finishes the evidence report and returns credits", async () => {
  scenario = "early";
  const run = await setup(); unresolvedTarget = true;
  expect(await driveGraph(run)).toMatchObject({ status: "incomplete", billing_status: "released", reserved_model_calls: 0 });
  expect(observerCalls).toBe(1);
  expect((await readCreditBalance(run.accountId, run.runtime)).settled_credits).toBe(100);
});

function preparationBrief() {
  return { schema_version: "guided-shopping/1.0" as const, category: "everyday necklace", buyer_job: "Find a necklace for everyday use", target_market: "Hong Kong", use_cases: [], constraints: [], preferences: [], market_requirements: [], prohibited_fingerprints: [], decision_dimensions: [] };
}
vi.mock("@mclab/shopify-online-store", async importOriginal => {
  const actual = await importOriginal<typeof import("@mclab/shopify-online-store")>();
  return { ...actual, collectShopifyProduct: async (url: string) => {
    collections++;
    return actual.collectShopifyProduct(url, { fetcher: async request => {
      const path = String(request);
      if (path.endsWith(".js")) return new Response(JSON.stringify({ id: 123, handle: "private", title: "Private Target", vendor: "Private Brand", type: "necklace", description: "An everyday necklace", price: 5000, available: true, variants: [] }), { headers: { "content-type": "application/json" } });
      if (path.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
      return new Response('<html><head><title>Private Target</title><meta property="og:price:currency" content="HKD"></head><body><h1>Private Target</h1><p>An everyday necklace</p></body></html>', { headers: { "content-type": "text/html" } });
    } });
  } };
});
it("admits and runs preparation through the terminal report, retaining evidence when the direct control fails", async () => {
  scenario = "early";
  const existing = await setup();
  collections = 0; researchCalls = 0; synthesisCalls = 0;
  const runtime = { ...existing.runtime, TASK_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  const browser = await createAccountSession(existing.accountId, runtime);
  const request = new Request("https://example.com/api/v1/tasks", { headers: { cookie: browser.setCookie!.split(";")[0]! } });
  const started = await createCustomerTask(request, CreateCustomerTaskRequestSchema.parse({ product_url: "https://example.com/products/private", target_market: "Hong Kong", category: "necklace", shopping_model_route: "observer", shopping_reasoning_effort: "medium" }), runtime);
  expect(started.status).toBe("queued");
  const message = { kind: "diagnostic_advance" as const, job_id: started.task_id };
  for (let step = 0; step < 50; step++) {
    await processDiagnostic(message, runtime);
    const state = await runtime.DB.prepare("SELECT status FROM diagnostic_workflows WHERE job_id = ?").bind(started.task_id).first<{ status: string }>();
    if (state?.status === "completed") break;
  }
  await processDiagnostic(message, runtime);
  const job = await runtime.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(started.task_id).first();
  expect(job).toMatchObject({ status: "completed" });
  expect(collections).toBe(1); expect(researchCalls).toBe(1); expect(synthesisCalls).toBe(1);
  const opened = await readCustomerTask(request, started.task_id, runtime) as { task: { billing_status: string; session: { report: { turns: unknown[]; diagnosis: { outcome: string }; direct_retrieval?: { status: string; answer: string } } } } };
  expect(opened.task.billing_status).toBe("consumed");
  expect(opened.task.session.report.turns).toHaveLength(1);
  expect(opened.task.session.report.diagnosis.outcome).toBe("absent");
  expect(opened.task.session.report.direct_retrieval).toMatchObject({ status: "failed", answer: "The named product appeared in this retained control answer." });
});

it("coalesces multiple zero-delay diagnostic steps inside one queue wake", async () => {
  scenario = "early";
  const existing = await setup();
  collections = 0; researchCalls = 0; synthesisCalls = 0;
  const enqueued: unknown[] = [];
  const runtime = {
    ...existing.runtime,
    TASK_RATE_LIMITER: { limit: async () => ({ success: true }) },
    JOBS_QUEUE: {
      send: async (message: unknown) => { enqueued.push(message); },
    },
  } as unknown as Env;
  const browser = await createAccountSession(existing.accountId, runtime);
  const request = new Request("https://example.com/api/v1/tasks", { headers: { cookie: browser.setCookie!.split(";")[0]! } });
  const started = await createCustomerTask(request, CreateCustomerTaskRequestSchema.parse({ product_url: "https://example.com/products/private", target_market: "Hong Kong", category: "necklace", shopping_model_route: "observer", shopping_reasoning_effort: "medium" }), runtime);
  enqueued.length = 0;
  const message = { kind: "diagnostic_advance" as const, job_id: started.task_id };
  await processDiagnostic(message, runtime);
  const afterOneWake = await runtime.DB.prepare("SELECT status FROM diagnostic_workflows WHERE job_id = ?").bind(started.task_id).first<{ status: string }>();
  expect(["queued", "completed"]).toContain(afterOneWake?.status);
  expect(collections).toBe(1);
  expect(researchCalls).toBe(1);
  expect(synthesisCalls).toBe(1);
  expect(enqueued.length).toBeLessThanOrEqual(1);
  for (let step = 0; step < 50; step++) {
    const state = await runtime.DB.prepare("SELECT status FROM diagnostic_workflows WHERE job_id = ?").bind(started.task_id).first<{ status: string }>();
    if (state?.status === "completed") break;
    await processDiagnostic(message, runtime);
  }
  const job = await runtime.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(started.task_id).first();
  expect(job).toMatchObject({ status: "completed" });
  const opened = await readCustomerTask(request, started.task_id, runtime) as { task: { billing_status: string; session: { report: { turns: unknown[] } } } };
  expect(opened.task.billing_status).toBe("consumed");
  expect(opened.task.session.report.turns).toHaveLength(1);
});

it.each(["rate", "terminal"] as const)("records paid usage before a %s failure without double accounting", async mode => {
  scenario = "early"; const run = await setup(); paidFailure = mode;
  await run.runtime.DB.prepare("UPDATE shopping_sessions SET controller_version = 'langgraph-diagnostic/1.0' WHERE id = ?").bind(run.sessionId).run();
  let networkCalls = 0;
  vi.stubGlobal("fetch", async () => {
    networkCalls++;
    return new Response(JSON.stringify(networkCalls === 1 ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.02 } } : { error: { message: "busy" } }), { status: networkCalls === 1 ? 200 : 429 });
  });
  try {
    for (let n = 0; n < 3; n++) await processShoppingQueueMessage(run.pending.shift()!, run.runtime);
    const initial = await run.runtime.DB.prepare("SELECT model_call_count, cost_usd_micros, input_tokens FROM shopping_model_calls WHERE session_id = ? AND role = 'query_auditor'").bind(run.sessionId).first();
    expect(initial).toMatchObject({ model_call_count: 2, cost_usd_micros: 20000, input_tokens: 10 });
    if (mode === "rate") {
      const retry = run.pending.shift()!;
      await processShoppingQueueMessage(retry, run.runtime);
      expect(auditCalls).toBe(1); // Persisted backoff also holds after replay.
      await run.runtime.DB.prepare("UPDATE shopping_model_calls SET retry_not_before = NULL WHERE session_id = ?").bind(run.sessionId).run();
      await drain(run, true);
      const recovered = await run.runtime.DB.prepare("SELECT model_call_count, cost_usd_micros, input_tokens FROM shopping_model_calls WHERE session_id = ? AND role = 'query_auditor'").bind(run.sessionId).first();
      expect(recovered).toMatchObject({ model_call_count: 3, cost_usd_micros: 21000, input_tokens: 110 });
    } else {
      expect(await readCreditBalance(run.accountId, run.runtime)).toMatchObject({ available_credits: 100, reserved_credits: 0 });
    }
    expect(networkCalls).toBe(2);
  } finally { vi.unstubAllGlobals(); }
});

it("pins searched observer and product research to Gemini Flash even when the client asks for Luna", () => {
  expect(PRODUCT_RESEARCH_POLICY).toMatchObject({ route_key: "observer", reasoning_effort: "medium", search: { enabled: true } });
  expect(customerPolicies(CreateCustomerTaskRequestSchema.parse({
    product_url: "https://example.com/products/private",
    target_market: "Hong Kong",
    shopping_model_route: "planner",
    shopping_reasoning_effort: "high",
  })).find((policy) => policy.role === "shopping_observer")).toMatchObject({
    route_key: "observer",
    reasoning_effort: "medium",
    search: { enabled: true },
  });
});

it("observer abort remains worker safety and refunds as an execution failure", async () => {
  scenario = "early";
  const run = await setup();
  observerTimeout = true;
  expect(await driveGraph(run)).toMatchObject({ status: "incomplete", billing_status: "released", reserved_model_calls: 0 });
  expect(observerSawAbort).toBe(true);
  expect((await readCreditBalance(run.accountId, run.runtime)).settled_credits).toBe(100);
});

it("leaves a leased diagnostic untouched when a duplicate wake cannot claim it", async () => {
  scenario = "early";
  const run = await setup();
  const now = new Date().toISOString();
  const leaseToken = "held-lease";
  await run.runtime.DB.prepare(
    "INSERT INTO diagnostic_workflows (job_id, input_key, status, step_attempts, lease_token, lease_until, next_run_at, created_at, updated_at) VALUES (?, 'test', 'running', 1, ?, ?, ?, ?, ?)",
  ).bind(run.jobId, leaseToken, new Date(Date.now() + 60_000).toISOString(), now, now, now).run();
  await processDiagnostic({ kind: "diagnostic_advance", job_id: run.jobId }, run.runtime);
  expect(await run.runtime.DB.prepare("SELECT status, step_attempts, lease_token FROM diagnostic_workflows WHERE job_id = ?").bind(run.jobId).first()).toMatchObject({
    status: "running", step_attempts: 1, lease_token: leaseToken,
  });
});
