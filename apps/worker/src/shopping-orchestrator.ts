import { reportInterruption } from "./report-interruption";
import { createModelJournal } from "./model-journal";
import {
  CONTRACT_VERSIONS,
  AdaptiveDecisionSchema,
  GeneratedShoppingQuerySchema,
  ModelRolePolicySchema,
  ShoppingClassificationResultSchema,
  ShoppingObserverCaptureSchema,
  ShoppingProtocolSchema,
  ShoppingQueryAuditSchema,
  TargetIdentitySchema,
  TargetObservationSchema,
  type AnswerShape,
  type BlindConversationContext,
  type GeneratedShoppingQuery,
  type ModelRolePolicy,
  type ShoppingClassificationResult,
  type ShoppingObserverCapture,
  type ShoppingProtocol,
  type ShoppingQueueMessage,
  type ShoppingRole,
  type TargetIdentity,
  type TargetObservation,
} from "@mclab/contracts";
import { adaptiveStage, decideNextTurn, isAdaptiveProtocol, MAX_QUERY_REVISIONS } from "@mclab/domain";
import {
  buildQueryAuditPrompt,
  buildQueryGeneratorPrompt,
  buildResultClassifierPrompt,
  buildShoppingObserverPrompt,
  jevClassifierEnabled as jevClassifierFlag,
  modelCapability,
  runQueryAuditor,
  runQueryGenerator,
  runResultClassifier,
  runShoppingObserver,
  type ShoppingRoleRun,
  type ModelExecution,
  STRUCTURED_ATTEMPT_LIMIT,
} from "@mclab/openrouter-adapter";
import { z } from "zod";
import type { ProductRecord, TechnicalCheck } from "@mclab/shopify-online-store";

import { consumeJobCredits, releaseJobCredits } from "./credits";
import { UncertainModelCallError } from "./model-journal";
import { buildReportDiagnosis, groupReportSources } from "./report-diagnosis";
import { readBlindConversationContext } from "./shopping-sessions";

/** Native-search observer is the slow path; bound it so a wake cannot sit until the Queue platform kill. */
export const SHOPPING_OBSERVER_TIMEOUT_MS = 120_000;
/** Planner/auditor/classifier share one budget across local structured repairs. */
export const SHOPPING_CONTROL_ROLE_TIMEOUT_MS = 90_000;

const MAX_PRIVATE_ARTIFACT_BYTES = 256_000;
const FIXTURE_CANDIDATES = ["Fixture Option A", "Fixture Option B"] as const;
const MessageProjectionSchema = z.object({ message: z.string().min(1).max(40_000), adaptive_decision: z.unknown().optional() });
const STALLED_ROLE_CALL_AGE_MS = 8 * 60 * 1_000;
const STALLED_ROLE_CALL_LIMIT = 20;
const RATE_LIMIT_RETRY_DELAYS_SECONDS = [45, 120] as const;

type SessionRow = {
  id: string;
  status: string;
  execution_mode: "fixture" | "live" | null;
  model_policy_key: string;
  target_identity_key: string;
  completed_turns: number;
  controller_version: string;
};

export type ShoppingScheduler = (message: ShoppingQueueMessage, options?: { delaySeconds: number }) => Promise<unknown>;

export async function startControlledShoppingSession(
  sessionId: string,
  executionMode: "fixture" | "live",
  env: Env,
  schedule: ShoppingScheduler = (message, options) => env.JOBS_QUEUE.send(message, options),
): Promise<{ session_id: string; status: "queued" | "running" | "completed"; execution_mode: "fixture" | "live" }> {
  const now = new Date().toISOString();
  const event = await jsonArtifact(`shopping-sessions/${sessionId}/events/000002-session-queued.json`, {
    type: "SESSION_QUEUED",
    occurred_at: now,
    execution_mode: executionMode,
  });
  await putArtifact(event, sessionId, env);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shopping_sessions
       SET status = 'queued', execution_mode = ?, updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status = 'protocol_ready' AND execution_mode IS NULL`,
    ).bind(executionMode, now, sessionId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_session_events (
        id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
       ) VALUES (?, ?, 2, 'SESSION_QUEUED', ?, ?, ?)`,
    ).bind(await stableUuid(`${sessionId}:event:queued`), sessionId, event.key, event.sha256, now),
  ]);

  const session = await loadSession(sessionId, env);
  if (!session) throw new Error("Shopping session does not exist.");
  if (session.execution_mode !== executionMode) throw new Error("Shopping session execution mode cannot be changed.");
  if (!["queued", "running", "completed"].includes(session.status)) {
    throw new Error(`Shopping session cannot be started while ${session.status}.`);
  }

  if (session.status !== "completed") await schedule(queueMessage(sessionId, executionMode));
  return {
    session_id: sessionId,
    status: session.status as "queued" | "running" | "completed",
    execution_mode: executionMode,
  };
}

type ShoppingAdvanceMessage = Extract<ShoppingQueueMessage, { kind: "shopping_advance" }>;
type ShoppingRoleCallMessage = Extract<ShoppingQueueMessage, { kind: "shopping_role_call" }>;

export async function processShoppingQueueMessage(message: ShoppingQueueMessage, env: Env): Promise<void> {
  if (message.kind === "shopping_role_call") {
    await processLiveRoleCall(message, env);
    return;
  }
  await processShoppingAdvance(message, env);
}

export async function recoverStalledShoppingRoleCalls(env: Env, now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALLED_ROLE_CALL_AGE_MS).toISOString();
  const stalled = await env.DB.prepare(
    `SELECT calls.session_id, calls.turn_id, calls.role, turns.ordinal AS turn_ordinal
     FROM shopping_model_calls AS calls
     JOIN shopping_sessions AS sessions ON sessions.id = calls.session_id
     JOIN shopping_turns AS turns ON turns.id = calls.turn_id
     WHERE calls.status = 'reserved'
       AND calls.claim_token IS NULL
       AND sessions.status = 'running'
       AND sessions.execution_mode = 'live'
       AND sessions.controller_version != 'langgraph-diagnostic/1.0'
       AND sessions.updated_at <= ?
     ORDER BY sessions.updated_at
     LIMIT ?`,
  ).bind(staleBefore, STALLED_ROLE_CALL_LIMIT).all<{
    session_id: string;
    turn_id: string;
    role: ShoppingRole;
    turn_ordinal: number;
  }>();

  let recovered = 0;
  for (const row of stalled.results) {
    await env.JOBS_QUEUE.send(roleQueueMessage(
      row.session_id,
      row.turn_id,
      row.turn_ordinal,
      row.role,
    ));
    await env.DB.prepare(
      `UPDATE shopping_sessions SET updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status = 'running' AND updated_at <= ?`,
    ).bind(now.toISOString(), row.session_id, staleBefore).run();
    recovered += 1;
  }

  if (recovered > 0) {
    console.log(JSON.stringify({
      level: "info",
      message: "stalled_shopping_role_calls_requeued",
      recovered,
      stale_before: staleBefore,
    }));
  }
  return recovered;
}

export function modelRateLimitRetryDelaySeconds(attemptCount: number): number | null {
  return RATE_LIMIT_RETRY_DELAYS_SECONDS[attemptCount] ?? null;
}

export function existingRoleCallAction(
  status: string | undefined,
): "execute" | "advance" | "reconcile" | "ignore" {
  if (status === undefined || status === "reserved") return "execute";
  if (status === "completed") return "advance";
  if (status === "running") return "reconcile";
  return "ignore";
}

export async function processShoppingAdvance(message: ShoppingAdvanceMessage, env: Env, schedule: ShoppingScheduler = (next, options) => env.JOBS_QUEUE.send(next, options)): Promise<void> {

  const session = await loadSession(message.session_id, env);
  if (!session) throw new Error("Shopping session does not exist.");
  if (session.execution_mode !== message.execution_mode) throw new Error("Shopping execution mode mismatch.");
  if (["completed", "incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(session.status)) {
    await settleTerminalSessionCredits(message.session_id, session.status, env);
    return;
  }
  if (!["queued", "running"].includes(session.status)) throw new Error(`Shopping session is not runnable: ${session.status}.`);

  const context = await readBlindConversationContext(message.session_id, env);
  const decision = decideNextTurn(context);
  if (decision.action === "complete") {
    await completeSession(message.session_id, env);
    return;
  }
  if (decision.action === "stop") {
    if (isAdaptiveProtocol(context.protocol)) await putArtifact(await jsonArtifact(`shopping-sessions/${message.session_id}/controller/termination.json`, { action: "stop", reason: "turn_limit", completed_turns: context.completed_turns.length }), message.session_id, env);
    await stopForBudget(message.session_id, env);
    return;
  }

  const ordinal = decision.turn.ordinal;
  const turnId = await stableUuid(`${message.session_id}:turn:${ordinal}`);
  const existing = await env.DB.prepare(
    "SELECT status FROM shopping_turns WHERE id = ?",
  ).bind(turnId).first<{ status: string }>();
  if (existing?.status === "completed") {
    await schedule(queueMessage(message.session_id, message.execution_mode));
    return;
  }
  if (existing && message.execution_mode === "live") {
    const role = roleForTurnStatus(existing.status);
    if (role) await schedule(roleQueueMessage(message.session_id, turnId, ordinal, role));
    return;
  }

  const controllerContext = await jsonArtifact(
    `shopping-sessions/${message.session_id}/turns/${pad(ordinal)}/controller-context.json`,
    context,
  );
  const startedAt = new Date().toISOString();
  const startedEvent = await jsonArtifact(
    `shopping-sessions/${message.session_id}/events/${pad(10 + ordinal * 2)}-turn-started.json`,
    { type: "TURN_STARTED", occurred_at: startedAt, turn_ordinal: ordinal },
  );
  await Promise.all([
    putArtifact(controllerContext, message.session_id, env),
    putArtifact(startedEvent, message.session_id, env),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_turns (
        id, session_id, ordinal, stage, status, query_origin,
        controller_context_key, controller_context_sha256, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'planned', 'protocol_generated', ?, ?, ?, ?)`,
    ).bind(
      turnId, message.session_id, ordinal, decision.turn.stage,
      controllerContext.key, controllerContext.sha256, startedAt, startedAt,
    ),
    env.DB.prepare(
      `UPDATE shopping_sessions
       SET status = 'running', current_turn = MIN(?, maximum_turns), started_at = COALESCE(started_at, ?),
           updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status IN ('queued', 'running') AND completed_turns = ?`,
    ).bind(ordinal, startedAt, startedAt, message.session_id, ordinal - 1),
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_session_events (
        id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
       ) VALUES (?, ?, ?, 'TURN_STARTED', ?, ?, ?)`,
    ).bind(
      await stableUuid(`${message.session_id}:event:turn:${ordinal}:started`),
      message.session_id, 10 + ordinal * 2, startedEvent.key, startedEvent.sha256, startedAt,
    ),
  ]);

  if (message.execution_mode === "live") {
    await schedule(roleQueueMessage(message.session_id, turnId, ordinal, "query_generator"));
    return;
  }

  await completeFixtureTurn({
    sessionId: message.session_id,
    turnId,
    ordinal,
    stage: decision.turn.stage,
    context,
    modelPolicyKey: session.model_policy_key,
    targetIdentityKey: session.target_identity_key,
  }, env);
  await schedule(queueMessage(message.session_id, message.execution_mode));
}

export async function readControlledShoppingSession(sessionId: string, env: Env): Promise<unknown | null> {
  const session = await env.DB.prepare(
    `SELECT id, job_id, collection_id, protocol_id, protocol_revision, controller_version,
      status, execution_mode, target_market, minimum_turns, maximum_turns,
      current_turn, completed_turns, used_model_calls, used_search_requests,
      used_input_tokens, used_output_tokens, used_cost_usd_micros,
      created_at, updated_at, started_at, completed_at
     FROM shopping_sessions WHERE id = ?`,
  ).bind(sessionId).first<Record<string, unknown>>();
  if (!session) return null;
  const [turns, calls, events, billRows, collectionArtifacts, productUnderstandingCost] = await Promise.all([
    env.DB.prepare(
      `SELECT id, ordinal, stage, status, query_key, observer_response_key,
        answer_shape, source_count, candidate_count,
        created_at, completed_at
       FROM shopping_turns WHERE session_id = ? ORDER BY ordinal`,
    ).bind(sessionId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT role, route_key, model_id, reasoning_effort, search_enabled,
        status, execution_mode, input_tokens, output_tokens, reasoning_tokens,
        total_tokens, search_requests, cost_usd_micros, error_code, created_at, completed_at
       FROM shopping_model_calls WHERE session_id = ? ORDER BY created_at, role`,
    ).bind(sessionId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT sequence, event_type, occurred_at
       FROM shopping_session_events WHERE session_id = ? ORDER BY sequence`,
    ).bind(sessionId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT role,
        SUM(model_call_count) AS call_count,
        SUM(CASE WHEN cost_usd_micros IS NOT NULL THEN model_call_count ELSE 0 END) AS priced_call_count,
        COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(search_requests), 0) AS search_requests
       FROM shopping_model_calls WHERE session_id = ? GROUP BY role ORDER BY role`,
    ).bind(sessionId).all<{
      role: string;
      call_count: number;
      priced_call_count: number;
      cost_usd_micros: number;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      search_requests: number;
    }>(),
    env.DB.prepare(
      `SELECT product_record_key, technical_check_key
       FROM collection_runs WHERE id = ?`,
    ).bind(String(session.collection_id)).first<{
      product_record_key: string;
      technical_check_key: string;
    }>(),
    typeof session.job_id === "string"
      ? env.DB.prepare(
        `SELECT status, input_tokens, output_tokens, reasoning_tokens,
          cost_usd_micros, research_search_requests, model_call_count
         FROM buyer_brief_runs WHERE job_id = ?`,
      ).bind(session.job_id).first<{
        status: string;
        input_tokens: number | null;
        output_tokens: number | null;
        reasoning_tokens: number | null;
        cost_usd_micros: number | null;
        research_search_requests: number | null;
        model_call_count: number;
      }>()
      : Promise.resolve(null),
  ]);
  const [productRecord, technicalCheck] = await Promise.all([
    collectionArtifacts?.product_record_key
      ? readJsonArtifact<ProductRecord>(collectionArtifacts.product_record_key, env)
      : Promise.resolve(null),
    collectionArtifacts?.technical_check_key
      ? readJsonArtifact<TechnicalCheck>(collectionArtifacts.technical_check_key, env)
      : Promise.resolve(null),
  ]);
  const reportTurns = await Promise.all(turns.results.filter(turn => turn.observer_response_key).map(async (turn) => {
    const turnId = String(turn.id);
    const [queryRecord, response, sources, candidates, target] = await Promise.all([
      typeof turn.query_key === "string"
        ? readPrivateJson(turn.query_key, MessageProjectionSchema, env)
        : Promise.resolve(null),
      typeof turn.observer_response_key === "string"
        ? readPrivateJson(turn.observer_response_key, MessageProjectionSchema, env).then((value) => value.message)
        : Promise.resolve(null),
      env.DB.prepare(
        `SELECT provider_source_id AS source_id, canonical_url AS url, title, source_domain
         FROM shopping_sources WHERE turn_id = ? ORDER BY ordinal`,
      ).bind(turnId).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT displayed_name, merchant_domain, product_url, first_position AS position,
          compared, recommended, final_choice
         FROM shopping_candidate_observations WHERE turn_id = ? ORDER BY first_position, displayed_name`,
      ).bind(turnId).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT retrievability, candidate_set, comparison, recommendation
         FROM shopping_target_observations WHERE turn_id = ?`,
      ).bind(turnId).first<Record<string, unknown>>(),
    ]);
    const projectedSources = sources.results;
    return {
      ordinal: turn.ordinal,
      stage: turn.stage,
      status: turn.status,
      shopper_message: queryRecord?.message ?? null,
      adaptive_decision: queryRecord?.adaptive_decision ?? null,
      shopping_answer: response,
      answer_shape: turn.answer_shape,
      sources: projectedSources,
      source_groups: groupReportSources(projectedSources),
      candidates: candidates.results.map((candidate) => ({
        ...candidate,
        compared: candidate.compared === 1,
        recommended: candidate.recommended === 1,
        final_choice: candidate.final_choice === 1,
      })),
      target_observation: target,
      completed_at: turn.completed_at,
    };
  }));
  const taskCostRows = [...billRows.results];
  if (productUnderstandingCost?.status === "completed") {
    taskCostRows.push({
      role: "product_understanding",
      call_count: productUnderstandingCost.model_call_count,
      priced_call_count: productUnderstandingCost.cost_usd_micros === null ? 0 : productUnderstandingCost.model_call_count,
      cost_usd_micros: productUnderstandingCost.cost_usd_micros ?? 0,
      input_tokens: productUnderstandingCost.input_tokens ?? 0,
      output_tokens: productUnderstandingCost.output_tokens ?? 0,
      reasoning_tokens: productUnderstandingCost.reasoning_tokens ?? 0,
      search_requests: productUnderstandingCost.research_search_requests ?? 0,
    });
  }
  const costObservation = buildOpenRouterCostObservation(String(session.status), taskCostRows);
  const firstTurn = (dimension: "retrievability" | "candidate_set" | "recommendation", values: string[]) =>
    reportTurns.find((turn) => {
      const observation = turn.target_observation;
      return observation && values.includes(String(observation[dimension]));
    })?.ordinal ?? null;
  const terminationObject = await env.EVIDENCE.get(`shopping-sessions/${sessionId}/controller/termination.json`);
  const termination = terminationObject && terminationObject.size < MAX_PRIVATE_ARTIFACT_BYTES ? JSON.parse(await terminationObject.text()) : null;
  const report = {
    schema_version: "controlled-shopping-report/1.1",
    status: session.status === "completed" ? "complete" : "partial",
    termination,
    interruption: session.status === "completed" ? null : reportInterruption(String(session.status), calls.results),
    disclaimer: "This is one recorded model-and-search conversation under the stated conditions, not a stable ranking or recommendation guarantee.",
    summary: {
      completed_turns: session.completed_turns,
      first_retrieved_turn: firstTurn("retrievability", ["retrieved"]),
      first_candidate_set_turn: firstTurn("candidate_set", ["included"]),
      first_recommended_turn: firstTurn("recommendation", ["recommended", "final_choice"]),
      first_final_choice_turn: firstTurn("recommendation", ["final_choice"]),
    },
    diagnosis: buildReportDiagnosis({
      turns: reportTurns,
      completedTurns: Number(session.completed_turns),
      ...(session.status === "completed" ? {} : { interruption: reportInterruption(String(session.status), calls.results) }),
      productRecord,
      technicalCheck,
    }),
    turns: reportTurns,
  };
  return {
    ...session,
    report,
    cost_observation: costObservation,
    turns: turns.results,
    model_calls: calls.results,
    events: events.results,
  };
}

type RoleUsage = {
  model_calls: number; billed_cost_usd_micros: number | null; search_requests: number;
  input_tokens: number; output_tokens: number; reasoning_tokens: number; total_tokens: number; cost_usd_micros: number;
};
type PreviousLiveCall = { status: string; attempt_count: number; retry_not_before: string | null } & Partial<Record<keyof RoleUsage, number | null>>;
function accumulatedUsage(current: RoleUsage, prior: PreviousLiveCall | null): RoleUsage {
  if (!prior?.attempt_count) return current;
  return {
    model_calls: (prior.model_calls ?? 0) + current.model_calls,
    billed_cost_usd_micros: prior.billed_cost_usd_micros == null || current.billed_cost_usd_micros === null ? null : prior.billed_cost_usd_micros + current.billed_cost_usd_micros,
    search_requests: (prior.search_requests ?? 0) + current.search_requests,
    input_tokens: (prior.input_tokens ?? 0) + current.input_tokens,
    output_tokens: (prior.output_tokens ?? 0) + current.output_tokens,
    reasoning_tokens: (prior.reasoning_tokens ?? 0) + current.reasoning_tokens,
    total_tokens: (prior.total_tokens ?? 0) + current.total_tokens,
    cost_usd_micros: (prior.cost_usd_micros ?? 0) + current.cost_usd_micros,
  };
}

export async function processLiveRoleCall(message: ShoppingRoleCallMessage, env: Env, schedule: ShoppingScheduler = (next, options) => env.JOBS_QUEUE.send(next, options)): Promise<void> {
  const session = await loadSession(message.session_id, env);
  if (!session || session.execution_mode !== "live") throw new Error("Live shopping session is unavailable.");
  if (["completed", "incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(session.status)) {
    await settleTerminalSessionCredits(message.session_id, session.status, env);
    return;
  }

  const graphRun = session.controller_version === "langgraph-diagnostic/1.0";
  const turn = await env.DB.prepare(
      `SELECT id, ordinal, stage, status, query_key, observer_response_key, query_revision_count
     FROM shopping_turns WHERE id = ? AND session_id = ?`,
  ).bind(message.turn_id, message.session_id).first<{
    id: string;
    ordinal: number;
    stage: ShoppingProtocol["turns"][number]["stage"];
    status: string;
    query_key: string | null;
    observer_response_key: string | null;
    query_revision_count: number;
  }>();
  if (!turn || turn.ordinal !== message.turn_ordinal) throw new Error("Shopping turn is unavailable.");
  const expectedRole = roleForTurnStatus(turn.status);
  if (!expectedRole) return;
  if (expectedRole !== message.role) return;

  const queryRevision = message.role === "query_generator" || message.role === "query_auditor"
    ? turn.query_revision_count
    : 0;
  const revisionSuffix = queryRevision > 0 ? `:revision:${queryRevision}` : "";
  const callId = await stableUuid(
    `${message.session_id}:turn:${message.turn_ordinal}:call:${message.role}${revisionSuffix}:live-v1`,
  );
  const priorCall = await env.DB.prepare(
    `SELECT status, attempt_count, retry_not_before, model_call_count AS model_calls, input_tokens, output_tokens, reasoning_tokens, total_tokens, search_requests, cost_usd_micros AS billed_cost_usd_micros, accounted_cost_usd_micros AS cost_usd_micros FROM shopping_model_calls WHERE id = ?`,
  ).bind(callId).first<PreviousLiveCall>();
  if (graphRun && priorCall?.status === "reserved" && priorCall.retry_not_before && Date.parse(priorCall.retry_not_before) > Date.now()) {
    await schedule(message, { delaySeconds: Math.ceil((Date.parse(priorCall.retry_not_before) - Date.now()) / 1000) });
    return;
  }
  const priorCallAction = existingRoleCallAction(priorCall?.status);
  if (priorCallAction === "advance") {
    const next = roleAfter(message.role);
    if (next) await schedule(roleQueueMessage(message.session_id, message.turn_id, message.turn_ordinal, next));
    else await schedule(queueMessage(message.session_id, "live"));
    return;
  }
  if (priorCallAction === "reconcile" && !graphRun) {
    await markSessionIncomplete(message.session_id, "A provider call has an uncertain outcome and requires reconciliation.", env);
    return;
  }
  if (priorCallAction === "ignore") return;

  const [context, policies, targetIdentity] = await Promise.all([
    readBlindConversationContext(message.session_id, env),
    readPrivateJson(session.model_policy_key, ModelRolePolicySchema.array(), env),
    readPrivateJson(session.target_identity_key, TargetIdentitySchema, env),
  ]);
  const policy = policies.find((item) => item.role === message.role);
  if (!policy) throw new Error(`Missing model policy for ${message.role}.`);
  const protocolTurn = context.protocol.turns[message.turn_ordinal - 1] ?? (isAdaptiveProtocol(context.protocol) && message.turn_ordinal === context.protocol.maximum_turns + 1 ? { ...context.protocol.turns.at(-1)!, ordinal: message.turn_ordinal } : undefined);
  const turnSpec = protocolTurn ? { ...protocolTurn, stage: turn.stage } : undefined;
  if (!turnSpec) throw new Error("Shopping turn specification is unavailable.");

  const query = turn.query_key
    ? await readPrivateJson(turn.query_key, GeneratedShoppingQuerySchema, env)
    : null;
  const observerResult = turn.observer_response_key
    ? await readPrivateJson(turn.observer_response_key, ShoppingObserverCaptureSchema, env)
    : null;
  const prompt = liveRolePrompt(message.role, {
    context, turnSpec, query, observerResult, targetIdentity,
  }, queryRevision);
  const attemptLimit = graphRun && message.role !== "shopping_observer" ? STRUCTURED_ATTEMPT_LIMIT : 1;
  const reservation = {
    model_calls: attemptLimit,
    search_requests: policy.search.enabled ? policy.search.max_search_requests ?? 1 : 0,
    input_tokens: Math.max(
      1,
      Math.ceil(prompt.length / 2) + 2_000 +
        (policy.search.enabled ? 20_000 + (policy.search.max_total_results ?? 5) * 8_000 : 0),
    ),
    output_tokens: policy.max_output_tokens * attemptLimit,
    cost_usd_micros: policy.max_call_cost_usd_micros * attemptLimit,
  };
  if (graphRun) reservation.input_tokens = reservation.input_tokens * attemptLimit + (attemptLimit - 1) * 18_000;
  const artifactRole = queryRevision > 0
    ? `${message.role}-revision-${queryRevision}`
    : message.role;
  const prefix = `shopping-sessions/${message.session_id}/turns/${pad(message.turn_ordinal)}/calls/${artifactRole}`;
  const requestArtifact = await jsonArtifact(`${prefix}-request.json`, {
    role: message.role,
    policy,
    prompt,
    execution_mode: "live",
    created_at: message.created_at,
  });
  await putArtifact(requestArtifact, message.session_id, env);
  const capability = modelCapability(policy.route_key);
  const now = new Date().toISOString();
  const claimToken = crypto.randomUUID();
  if (priorCallAction !== "reconcile") {
  const reservationResults = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_model_calls (
        id, session_id, turn_id, role, route_key, model_id, provider_order_json,
        reasoning_effort, search_enabled, search_engine, max_search_requests,
        max_output_tokens, max_retries, provider_fallback_allowed, status,
        idempotency_key, request_key, created_at, execution_mode,
        reserved_search_requests, reserved_input_tokens, reserved_output_tokens,
        reserved_cost_usd_micros, reserved_model_call_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'reserved', ?, ?, ?, 'live', ?, ?, ?, ?, ?)`,
    ).bind(
      callId, message.session_id, message.turn_id, message.role, policy.route_key,
      capability.model_id, JSON.stringify(capability.provider_order), policy.reasoning_effort,
      policy.search.enabled ? 1 : 0, policy.search.engine ?? null,
      policy.search.max_search_requests ?? 0, policy.max_output_tokens,
      `${message.session_id}:${message.turn_ordinal}:${message.role}${revisionSuffix}:live-v1`,
      requestArtifact.key, now, reservation.search_requests, reservation.input_tokens,
      reservation.output_tokens, reservation.cost_usd_micros, reservation.model_calls,
    ),
    env.DB.prepare(
      `UPDATE shopping_model_calls SET claim_token = ?, claimed_at = ?
       WHERE id = ? AND status = 'reserved' AND claim_token IS NULL`,
    ).bind(claimToken, now, callId),
    env.DB.prepare(
      `UPDATE shopping_sessions SET
        reserved_model_calls = reserved_model_calls + ?,
        reserved_search_requests = reserved_search_requests + ?,
        reserved_input_tokens = reserved_input_tokens + ?,
        reserved_output_tokens = reserved_output_tokens + ?,
        reserved_cost_usd_micros = reserved_cost_usd_micros + ?,
        updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status = 'running'
         AND EXISTS (SELECT 1 FROM shopping_model_calls WHERE id = ? AND claim_token = ?)
         AND used_model_calls + reserved_model_calls + ? <= max_model_calls
         AND used_search_requests + reserved_search_requests + ? <= max_search_requests
         AND (protocol_id != 'evidence-driven-shopping' OR (
           used_cost_usd_micros + reserved_cost_usd_micros + ? <= max_cost_usd_micros
           AND used_input_tokens + reserved_input_tokens + ? <= max_input_tokens
           AND used_output_tokens + reserved_output_tokens + ? <= max_output_tokens
         ))`,
    ).bind(
      reservation.model_calls, reservation.search_requests, reservation.input_tokens, reservation.output_tokens,
      reservation.cost_usd_micros, now, message.session_id, callId, claimToken,
      reservation.model_calls, reservation.search_requests,
      reservation.cost_usd_micros, reservation.input_tokens, reservation.output_tokens,
    ),
  ]);
  if ((reservationResults[2]!.meta.changes ?? 0) !== 1) {
    if ((reservationResults[1]!.meta.changes ?? 0) !== 1) return;
    await env.DB.prepare(
      "UPDATE shopping_model_calls SET status = 'budget_rejected', completed_at = ? WHERE id = ?",
    ).bind(now, callId).run();
    await stopForBudget(message.session_id, env);
    return;
  }
  await env.DB.prepare(
    "UPDATE shopping_model_calls SET status = 'running', started_at = ? WHERE id = ? AND status = 'reserved'",
  ).bind(now, callId).run();
  }

  let executionFinished = false;
  const execution = graphRun ? createModelJournal(`${prefix}/attempt-${priorCall?.attempt_count ?? 0}`, env) : undefined;
  try {
    const openRouterApiKey = env.OPENROUTER_API_KEY ?? "configured-per-route";
    if (!openRouterApiKey) throw new Error("OPENROUTER_API_KEY_UNAVAILABLE");
    const result = await executeLiveRole({
      role: message.role,
      apiKey: openRouterApiKey,
      policy,
      context,
      turnSpec,
      query,
      observerResult,
      targetIdentity,
      queryRevision,
      jevClassifier: jevClassifierEnabled(env),
      ...(execution ? { execution } : {}),
    });
    executionFinished = true;
    if (!graphRun && result.usage.cost_usd === null) throw new Error("MODEL_COST_UNAVAILABLE");
    const modelCalls = graphRun ? result.model_calls ?? (execution?.usage().model_calls || (result.response_id ? 1 : 0)) : 1;
    const resultArtifact = await jsonArtifact(`${prefix}-result.json`, {
      role: message.role,
      output: result.output,
      ...(result.raw_output === undefined ? {} : { raw_output: result.raw_output }),
      validation_error: result.validation_error,
      ...(result.recovery ? { recovery: result.recovery } : {}),
      model_calls: modelCalls,
      provider_sources: result.provider_sources,
      usage: result.usage,
      response_id: result.response_id,
      execution_mode: "live",
    });
    await putArtifact(resultArtifact, message.session_id, env);
    const actual = {
      model_calls: modelCalls,
      billed_cost_usd_micros: result.usage.cost_usd === null ? null : Math.round(result.usage.cost_usd * 1_000_000),
      search_requests: result.usage.web_search_requests,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      reasoning_tokens: result.usage.reasoning_tokens,
      total_tokens: result.usage.total_tokens,
      cost_usd_micros: result.usage.cost_usd === null ? reservation.cost_usd_micros : Math.round(result.usage.cost_usd * 1_000_000),
    };
    await settleLiveRole({
      message, callId, policy, result, resultArtifact, reservation, actual, recorded: graphRun ? accumulatedUsage(actual, priorCall) : actual, queryRevision,
    }, env, schedule);
  } catch (error) {
    if (graphRun && executionFinished) throw error; // Retry persistence/projection from recorded provider bytes.
    const failedAt = new Date().toISOString();
    const errorCode = classifyShoppingModelError(error);
    const attempt = await env.DB.prepare(
      "SELECT attempt_count FROM shopping_model_calls WHERE id = ?",
    ).bind(callId).first<{ attempt_count: number }>();
    const retryDelaySeconds = errorCode === "MODEL_RATE_LIMITED"
      ? modelRateLimitRetryDelaySeconds(attempt?.attempt_count ?? 0)
      : null;
    const retryable = retryDelaySeconds !== null;
    const failedUsage = execution?.usage();
    const actual: RoleUsage = {
      model_calls: failedUsage?.model_calls ?? 0,
      billed_cost_usd_micros: failedUsage?.cost_usd == null ? null : Math.round(failedUsage.cost_usd * 1_000_000),
      search_requests: failedUsage?.web_search_requests ?? 0,
      input_tokens: failedUsage?.input_tokens ?? 0, output_tokens: failedUsage?.output_tokens ?? 0,
      reasoning_tokens: failedUsage?.reasoning_tokens ?? 0, total_tokens: failedUsage?.total_tokens ?? 0,
      cost_usd_micros: failedUsage?.cost_usd == null ? reservation.cost_usd_micros : Math.round(failedUsage.cost_usd * 1_000_000),
    };
    const recorded = accumulatedUsage(actual, priorCall);
    if (graphRun) await putArtifact(await jsonArtifact(`${prefix}/attempt-${priorCall?.attempt_count ?? 0}/failure.json`, { error_code: errorCode, usage: failedUsage, accounted_cost_usd_micros: actual.cost_usd_micros, failed_at: failedAt }), message.session_id, env);
    const failureAccounting = graphRun ? [env.DB.prepare(
      `UPDATE shopping_model_calls SET model_call_count = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, total_tokens = ?, search_requests = ?, cost_usd_micros = ?, accounted_cost_usd_micros = ?, retry_not_before = ? WHERE id = ? AND status = 'running'`,
    ).bind(recorded.model_calls, recorded.input_tokens, recorded.output_tokens, recorded.reasoning_tokens, recorded.total_tokens, recorded.search_requests, recorded.billed_cost_usd_micros, recorded.cost_usd_micros, retryable ? new Date(Date.now() + retryDelaySeconds * 1000).toISOString() : null, callId),
    env.DB.prepare(`UPDATE shopping_sessions SET used_model_calls = used_model_calls + ?, used_input_tokens = used_input_tokens + ?, used_output_tokens = used_output_tokens + ?, used_search_requests = used_search_requests + ?, used_cost_usd_micros = used_cost_usd_micros + ? WHERE id = ? AND status = 'running'`)
      .bind(actual.model_calls, actual.input_tokens, actual.output_tokens, actual.search_requests, actual.cost_usd_micros, message.session_id)] : [];
    await env.DB.batch([
      ...failureAccounting,
      env.DB.prepare(
        `UPDATE shopping_model_calls SET status = ?, error_code = ?, error_message = ?,
          attempt_count = attempt_count + 1, claim_token = NULL, claimed_at = NULL,
          started_at = CASE WHEN ? = 'reserved' THEN NULL ELSE started_at END,
          completed_at = CASE WHEN ? = 'reserved' THEN NULL ELSE ? END
         WHERE id = ? AND status = 'running'`,
      ).bind(
        retryable ? "reserved" : "incomplete",
        errorCode,
        error instanceof Error ? error.message.slice(0, 1_000) : "Unknown model error",
        retryable ? "reserved" : "incomplete",
        retryable ? "reserved" : "incomplete",
        failedAt,
        callId,
      ),
      env.DB.prepare(
        `UPDATE shopping_sessions SET status = ?,
          reserved_model_calls = reserved_model_calls - ?,
          reserved_search_requests = reserved_search_requests - ?,
          reserved_input_tokens = reserved_input_tokens - ?,
          reserved_output_tokens = reserved_output_tokens - ?,
          reserved_cost_usd_micros = reserved_cost_usd_micros - ?,
          updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND status = 'running'`,
      ).bind(
        retryable ? "running" : "incomplete",
        reservation.model_calls, reservation.search_requests,
        reservation.input_tokens,
        reservation.output_tokens,
        reservation.cost_usd_micros,
        failedAt,
        message.session_id,
      ),
    ]);
    if (retryable) {
      await schedule(message, { delaySeconds: retryDelaySeconds });
      return;
    }
    await settleTerminalSessionCredits(message.session_id, "incomplete", env);
  }
}

export function jevClassifierEnabled(env: Env): boolean {
  return jevClassifierFlag(env.SELF_CHECK_JEV_CLASSIFIER);
}

async function executeLiveRole(input: {
  role: ShoppingRole;
  apiKey: string;
  policy: ModelRolePolicy;
  context: BlindConversationContext;
  turnSpec: ShoppingProtocol["turns"][number];
  query: GeneratedShoppingQuery | null;
  observerResult: ShoppingObserverCapture | null;
  targetIdentity: TargetIdentity;
  queryRevision: number;
  jevClassifier?: boolean;
  execution?: ModelExecution;
}): Promise<ShoppingRoleRun<unknown>> {
  const abortSignal = AbortSignal.timeout(
    input.role === "shopping_observer" ? SHOPPING_OBSERVER_TIMEOUT_MS : SHOPPING_CONTROL_ROLE_TIMEOUT_MS,
  );
  switch (input.role) {
    case "query_generator":
      return runQueryGenerator({
        apiKey: input.apiKey,
        ...(input.execution ? { execution: input.execution } : {}),
        policy: input.policy as ModelRolePolicy & { role: "query_generator" },
        context: input.context,
        turn: input.turnSpec,
        revisionAttempt: input.queryRevision,
        abortSignal,
      });
    case "query_auditor":
      if (!input.query) throw new Error("Generated shopping query is unavailable.");
      return runQueryAuditor({
        apiKey: input.apiKey,
        ...(input.execution ? { execution: input.execution } : {}),
        policy: input.policy as ModelRolePolicy & { role: "query_auditor" },
        context: input.context,
        turn: input.turnSpec,
        query: input.query,
        targetIdentity: input.targetIdentity,
        abortSignal,
      });
    case "shopping_observer":
      if (!input.query) throw new Error("Approved shopping query is unavailable.");
      return runShoppingObserver({
        apiKey: input.apiKey,
        ...(input.execution ? { execution: input.execution } : {}),
        policy: input.policy as ModelRolePolicy & { role: "shopping_observer" },
        context: input.context,
        query: input.query,
        abortSignal,
      });
    case "result_classifier":
      if (!input.query || !input.observerResult) throw new Error("Captured shopping result is unavailable.");
      return runResultClassifier({
        apiKey: input.apiKey,
        ...(input.execution ? { execution: input.execution } : {}),
        policy: input.policy as ModelRolePolicy & { role: "result_classifier" },
        turnOrdinal: input.turnSpec.ordinal,
        context: input.context,
        query: input.query,
        observerResult: input.observerResult,
        targetIdentity: input.targetIdentity,
        abortSignal,
        ...(input.jevClassifier ? { jevClassifier: true } : {}),
      });
  }
}

async function settleLiveRole(input: {
  message: ShoppingRoleCallMessage;
  callId: string;
  policy: ModelRolePolicy;
  result: ShoppingRoleRun<unknown>;
  resultArtifact: JsonArtifact;
  reservation: { model_calls: number; search_requests: number; input_tokens: number; output_tokens: number; cost_usd_micros: number };
  actual: RoleUsage;
  recorded: RoleUsage;
  queryRevision: number;
}, env: Env, schedule: ShoppingScheduler): Promise<void> {
  const completedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE shopping_model_calls SET status = 'completed', result_key = ?,
        provider_response_id = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
        total_tokens = ?, search_requests = ?, cost_usd_micros = ?, accounted_cost_usd_micros = ?, model_call_count = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    ).bind(
      input.resultArtifact.key, input.result.response_id,
      input.recorded.input_tokens, input.recorded.output_tokens, input.recorded.reasoning_tokens,
      input.recorded.total_tokens, input.recorded.search_requests, input.recorded.billed_cost_usd_micros, input.recorded.cost_usd_micros, input.recorded.model_calls,
      completedAt, input.callId,
    ),
    env.DB.prepare(
      `UPDATE shopping_sessions SET
        reserved_model_calls = reserved_model_calls - ?,
        reserved_search_requests = reserved_search_requests - ?,
        reserved_input_tokens = reserved_input_tokens - ?,
        reserved_output_tokens = reserved_output_tokens - ?,
        reserved_cost_usd_micros = reserved_cost_usd_micros - ?,
        used_model_calls = used_model_calls + ?,
        used_search_requests = used_search_requests + ?,
        used_input_tokens = used_input_tokens + ?,
        used_output_tokens = used_output_tokens + ?,
        used_cost_usd_micros = used_cost_usd_micros + ?,
        updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status = 'running'`,
    ).bind(
      input.reservation.model_calls, input.reservation.search_requests, input.reservation.input_tokens,
      input.reservation.output_tokens, input.reservation.cost_usd_micros,
      input.actual.model_calls, input.actual.search_requests, input.actual.input_tokens,
      input.actual.output_tokens, input.actual.cost_usd_micros,
      completedAt, input.message.session_id,
    ),
  ];

  if (input.result.validation_error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE shopping_model_calls SET status = 'failed_validation', result_key = ?,
          provider_response_id = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
          total_tokens = ?, search_requests = ?, cost_usd_micros = ?, error_code = 'OUTPUT_VALIDATION_FAILED',
          error_message = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      ).bind(
        input.resultArtifact.key, input.result.response_id,
        input.actual.input_tokens, input.actual.output_tokens, input.actual.reasoning_tokens,
        input.actual.total_tokens, input.actual.search_requests, input.actual.cost_usd_micros,
        input.result.validation_error.slice(0, 1_000), completedAt, input.callId,
      ),
      env.DB.prepare(
        `UPDATE shopping_sessions SET status = 'failed_validation',
          reserved_model_calls = reserved_model_calls - ?,
          reserved_search_requests = reserved_search_requests - ?,
          reserved_input_tokens = reserved_input_tokens - ?,
          reserved_output_tokens = reserved_output_tokens - ?,
          reserved_cost_usd_micros = reserved_cost_usd_micros - ?,
          used_model_calls = used_model_calls + ?,
          used_search_requests = used_search_requests + ?,
          used_input_tokens = used_input_tokens + ?,
          used_output_tokens = used_output_tokens + ?,
          used_cost_usd_micros = used_cost_usd_micros + ?,
          updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND status = 'running'`,
      ).bind(
        input.reservation.model_calls, input.reservation.search_requests, input.reservation.input_tokens,
        input.reservation.output_tokens, input.reservation.cost_usd_micros,
        input.actual.model_calls, input.actual.search_requests, input.actual.input_tokens,
        input.actual.output_tokens, input.actual.cost_usd_micros,
        completedAt, input.message.session_id,
      ),
      env.DB.prepare(
        `UPDATE shopping_turns SET status = 'failed_validation', updated_at = ?
         WHERE id = ? AND status != 'completed'`,
      ).bind(completedAt, input.message.turn_id),
    ]);
    await settleTerminalSessionCredits(input.message.session_id, "failed_validation", env);
    return;
  }

  let nextRole: ShoppingRole | null = roleAfter(input.message.role);
  if (input.message.role === "query_generator") {
    const generated = GeneratedShoppingQuerySchema.parse(input.result.output);
    const queryArtifactName = input.queryRevision > 0
      ? `query-revision-${input.queryRevision}.json`
      : "query.json";
    const projection = await jsonArtifact(
      `shopping-sessions/${input.message.session_id}/turns/${pad(input.message.turn_ordinal)}/${queryArtifactName}`,
      generated,
    );
    await putArtifact(projection, input.message.session_id, env);
    statements.push(env.DB.prepare(
      `UPDATE shopping_turns SET status = 'query_auditing', query_key = ?, query_sha256 = ?, updated_at = ?
       WHERE id = ? AND status = 'planned' AND query_revision_count = ?`,
    ).bind(
      projection.key, projection.sha256, completedAt, input.message.turn_id, input.queryRevision,
    ));
    if (generated.adaptive_decision) {
      const adaptive = AdaptiveDecisionSchema.parse(generated.adaptive_decision);
      statements.push(env.DB.prepare("UPDATE shopping_turns SET stage = ? WHERE id = ?").bind(adaptiveStage(adaptive), input.message.turn_id));
      if (adaptive.action === "finish" || adaptive.action === "stop") {
        const termination = await jsonArtifact(`shopping-sessions/${input.message.session_id}/controller/termination.json`, adaptive);
        await putArtifact(termination, input.message.session_id, env);
        // This slot contains a recorded planning call only: no shopper turn was
        // issued and completed_turns is deliberately unchanged.
        await env.DB.batch(statements);
        await completeSession(input.message.session_id, env);
        return;
      }
    }
  } else if (input.message.role === "query_auditor") {
    const audit = ShoppingQueryAuditSchema.parse(input.result.output);
    if (audit.decision === "rejected" || audit.target_leakage) {
      const allowedRevisions = MAX_QUERY_REVISIONS;
      if (input.queryRevision < allowedRevisions) {
        nextRole = "query_generator";
        statements.push(env.DB.prepare(
          `UPDATE shopping_turns SET status = 'planned', query_key = NULL, query_sha256 = NULL,
            query_revision_count = query_revision_count + 1, updated_at = ?
           WHERE id = ? AND status = 'query_auditing' AND query_revision_count = ?`,
        ).bind(completedAt, input.message.turn_id, input.queryRevision));
      } else {
        nextRole = null;
        statements.push(
          env.DB.prepare(
            `UPDATE shopping_turns SET status = 'failed_validation', updated_at = ? WHERE id = ? AND status = 'query_auditing'`,
          ).bind(completedAt, input.message.turn_id),
          env.DB.prepare(
            `UPDATE shopping_sessions SET status = 'failed_validation', updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND status = 'running'`,
          ).bind(completedAt, input.message.session_id),
        );
      }
    } else {
      statements.push(env.DB.prepare(
        `UPDATE shopping_turns SET status = 'observer_queued', updated_at = ?
         WHERE id = ? AND status = 'query_auditing'`,
      ).bind(completedAt, input.message.turn_id));
    }
  } else if (input.message.role === "shopping_observer") {
    const observer = ShoppingObserverCaptureSchema.parse(input.result.output);
    const projection = await jsonArtifact(
      `shopping-sessions/${input.message.session_id}/turns/${pad(input.message.turn_ordinal)}/observer-response.json`,
      observer,
    );
    await putArtifact(projection, input.message.session_id, env);
    statements.push(env.DB.prepare(
      `UPDATE shopping_turns SET status = 'classifying', observer_response_key = ?,
        observer_response_sha256 = ?, source_count = ?, candidate_count = 0, updated_at = ?
       WHERE id = ? AND status IN ('observer_queued', 'observer_running')`,
    ).bind(
      projection.key, projection.sha256, observer.sources.length, completedAt, input.message.turn_id,
    ));
    for (let index = 0; index < observer.sources.length; index += 1) {
      const source = observer.sources[index]!;
      const artifact = await jsonArtifact(
        `shopping-sessions/${input.message.session_id}/turns/${pad(input.message.turn_ordinal)}/sources/${pad(index + 1)}.json`,
        source,
      );
      await putArtifact(artifact, input.message.session_id, env);
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO shopping_sources (
          id, session_id, turn_id, ordinal, canonical_url, displayed_url, title,
          source_domain, provider_source_id, captured_key, captured_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        await stableUuid(`${input.message.session_id}:turn:${input.message.turn_ordinal}:source:${index + 1}`),
        input.message.session_id, input.message.turn_id, index + 1, source.url, source.url,
        source.title ?? null, new URL(source.url).hostname, source.source_id,
        artifact.key, artifact.sha256, completedAt,
      ));
    }
  } else {
    const classification = ShoppingClassificationResultSchema.parse(input.result.output);
    const observer = input.message.turn_ordinal > 0
      ? await readPrivateJson(
          `shopping-sessions/${input.message.session_id}/turns/${pad(input.message.turn_ordinal)}/observer-response.json`,
          ShoppingObserverCaptureSchema,
          env,
        )
      : null;
    if (!observer) throw new Error("Captured shopping result is unavailable.");
    const sourceIds = new Set(observer.sources.map((source) => source.source_id));
    for (const candidate of classification.candidates) {
      // Discard unresolvable citation pointers, not the captured shopping
      // observation. The original classifier output remains in its call artifact.
      candidate.supporting_source_ids = candidate.supporting_source_ids.filter(id => sourceIds.has(id));
    }
    classification.target_observation.matched_source_ids = classification.target_observation.matched_source_ids.filter(id => sourceIds.has(id));
    const observation = classification.target_observation;
    const targetArtifact = await jsonArtifact(
      `shopping-sessions/${input.message.session_id}/turns/${pad(input.message.turn_ordinal)}/private/target-observation-live.json`,
      classification,
    );
    const eventArtifact = await jsonArtifact(
      `shopping-sessions/${input.message.session_id}/events/${pad(11 + input.message.turn_ordinal * 2)}-turn-completed.json`,
      { type: "TURN_COMPLETED", occurred_at: completedAt, turn_ordinal: input.message.turn_ordinal },
    );
    await Promise.all([
      putArtifact(targetArtifact, input.message.session_id, env),
      putArtifact(eventArtifact, input.message.session_id, env),
    ]);
    for (let index = 0; index < classification.candidates.length; index += 1) {
      const candidate = classification.candidates[index]!;
      const artifact = await jsonArtifact(
        `shopping-sessions/${input.message.session_id}/turns/${pad(input.message.turn_ordinal)}/candidates/${pad(index + 1)}.json`,
        candidate,
      );
      await putArtifact(artifact, input.message.session_id, env);
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO shopping_candidate_observations (
          id, session_id, turn_id, normalized_name, displayed_name, merchant_domain,
          product_url, first_position, mentioned, compared, recommended, final_choice,
          observation_key, observation_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        await stableUuid(`${input.message.session_id}:turn:${input.message.turn_ordinal}:candidate:${candidate.candidate_id}`),
        input.message.session_id, input.message.turn_id, normalizeName(candidate.displayed_name),
        candidate.displayed_name, candidate.merchant_domain, candidate.product_url,
        candidate.position, candidate.compared ? 1 : 0, candidate.recommended ? 1 : 0,
        candidate.final_choice ? 1 : 0, artifact.key, artifact.sha256, completedAt,
      ));
    }
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO shopping_target_observations (
          id, session_id, turn_id, retrievability, candidate_set, comparison,
          recommendation, deterministic_match_key, semantic_evaluation_key,
          semantic_model_call_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        await stableUuid(`${input.message.session_id}:turn:${input.message.turn_ordinal}:target-observation-live`),
        input.message.session_id, input.message.turn_id, observation.retrievability,
        observation.candidate_set, observation.comparison, observation.recommendation,
        `${input.message.session_id}:${input.message.turn_ordinal}:live-target-match-v1`,
        targetArtifact.key, classification.target_observation.semantic_classification_required ? input.callId : null,
        completedAt,
      ),
      env.DB.prepare(
        `UPDATE shopping_turns SET status = 'completed', answer_shape = ?, candidate_count = ?,
          updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'classifying'`,
      ).bind(
        classification.answer_shape, classification.candidates.length,
        completedAt, completedAt, input.message.turn_id,
      ),
      env.DB.prepare(
        `UPDATE shopping_sessions SET completed_turns = ?, updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND completed_turns = ? AND current_turn = ? AND status = 'running'`,
      ).bind(
        input.message.turn_ordinal, completedAt, input.message.session_id,
        input.message.turn_ordinal - 1, input.message.turn_ordinal,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO shopping_session_events (
          id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
         ) VALUES (?, ?, ?, 'TURN_COMPLETED', ?, ?, ?)`,
      ).bind(
        await stableUuid(`${input.message.session_id}:event:turn:${input.message.turn_ordinal}:completed`),
        input.message.session_id, 11 + input.message.turn_ordinal * 2,
        eventArtifact.key, eventArtifact.sha256, completedAt,
      ),
    );
  }
  await env.DB.batch(statements);
  const terminal = await env.DB.prepare(
    "SELECT status FROM shopping_sessions WHERE id = ?",
  ).bind(input.message.session_id).first<{ status: string }>();
  if (terminal && ["incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(terminal.status)) {
    await settleTerminalSessionCredits(input.message.session_id, terminal.status, env);
  }
  if (nextRole) {
    await schedule(roleQueueMessage(
      input.message.session_id, input.message.turn_id, input.message.turn_ordinal, nextRole,
    ));
  } else if (input.message.role === "result_classifier") {
    await schedule(queueMessage(input.message.session_id, "live"));
  }
}

async function completeFixtureTurn(input: {
  sessionId: string;
  turnId: string;
  ordinal: number;
  stage: ShoppingProtocol["turns"][number]["stage"];
  context: BlindConversationContext;
  modelPolicyKey: string;
  targetIdentityKey: string;
}, env: Env): Promise<void> {
  const [policies, targetIdentity] = await Promise.all([
    readPrivateJson(input.modelPolicyKey, ModelRolePolicySchema.array(), env),
    readPrivateJson(input.targetIdentityKey, TargetIdentitySchema, env),
  ]);
  const query = fixtureQuery(input.context, input.ordinal, input.stage);
  const answer = fixtureAnswer(input.ordinal, input.stage);
  const answerShape = fixtureAnswerShape(input.stage);
  const observation = TargetObservationSchema.parse({
    turn_ordinal: input.ordinal,
    retrievability: "not_retrieved",
    candidate_set: "absent",
    comparison: input.stage === "comparison" ? "not_compared" : "not_observed",
    recommendation: "not_recommended",
    matched_source_ids: [],
    matched_candidate_ids: [],
    visible_reason_evidence_ids: [],
    semantic_classification_required: false,
  } satisfies TargetObservation);

  const prefix = `shopping-sessions/${input.sessionId}/turns/${pad(input.ordinal)}`;
  const artifacts = {
    query: await jsonArtifact(`${prefix}/query.json`, { message: query, fixture: true }),
    response: await jsonArtifact(`${prefix}/observer-response.json`, { message: answer, fixture: true }),
    targetObservation: await jsonArtifact(`${prefix}/private/target-observation.json`, {
      ...observation,
      target_canonical_url: targetIdentity.canonical_product_url,
      fixture: true,
    }),
    completedEvent: await jsonArtifact(
      `shopping-sessions/${input.sessionId}/events/${pad(11 + input.ordinal * 2)}-turn-completed.json`,
      { type: "TURN_COMPLETED", occurred_at: new Date().toISOString(), turn_ordinal: input.ordinal },
    ),
  };

  const roleArtifacts = await Promise.all(policies.map(async (policy) => {
    const request = fixtureRoleRequest(policy.role, input.context, query, targetIdentity);
    const result = fixtureRoleResult(policy.role, query, answer, observation);
    return {
      policy,
      request: await jsonArtifact(`${prefix}/calls/${policy.role}-request.json`, request),
      result: await jsonArtifact(`${prefix}/calls/${policy.role}-result.json`, result),
    };
  }));
  const candidateArtifacts = await Promise.all(FIXTURE_CANDIDATES.map((name, index) =>
    jsonArtifact(`${prefix}/candidates/${index + 1}.json`, {
      displayed_name: name,
      position: index + 1,
      fixture: true,
    })
  ));
  await Promise.all([
    ...Object.values(artifacts).map((artifact) => putArtifact(artifact, input.sessionId, env)),
    ...roleArtifacts.flatMap((item) => [
      putArtifact(item.request, input.sessionId, env),
      putArtifact(item.result, input.sessionId, env),
    ]),
    ...candidateArtifacts.map((artifact) => putArtifact(artifact, input.sessionId, env)),
  ]);

  const completedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const { policy, request, result } of roleArtifacts) {
    const capability = modelCapability(policy.route_key);
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_model_calls (
        id, session_id, turn_id, role, route_key, model_id, provider_order_json,
        reasoning_effort, search_enabled, search_engine, max_search_requests,
        max_output_tokens, max_retries, provider_fallback_allowed, status,
        idempotency_key, request_key, result_key, input_tokens, output_tokens,
        reasoning_tokens, total_tokens, search_requests, cost_usd_micros,
        latency_ms, created_at, started_at, completed_at, execution_mode
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'completed', ?, ?, ?,
         0, 0, 0, 0, 0, 0, 0, ?, ?, ?, 'fixture')`,
    ).bind(
      await stableUuid(`${input.sessionId}:turn:${input.ordinal}:call:${policy.role}`),
      input.sessionId, input.turnId, policy.role, policy.route_key, capability.model_id,
      JSON.stringify(capability.provider_order), policy.reasoning_effort,
      policy.search.enabled ? 1 : 0, policy.search.engine ?? null,
      policy.search.max_search_requests ?? 0, policy.max_output_tokens,
      `${input.sessionId}:${input.ordinal}:${policy.role}:fixture-v1`, request.key, result.key,
      completedAt, completedAt, completedAt,
    ));
  }
  for (let index = 0; index < FIXTURE_CANDIDATES.length; index += 1) {
    const name = FIXTURE_CANDIDATES[index]!;
    const artifact = candidateArtifacts[index]!;
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_candidate_observations (
        id, session_id, turn_id, normalized_name, displayed_name, first_position,
        mentioned, compared, recommended, final_choice,
        observation_key, observation_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await stableUuid(`${input.sessionId}:turn:${input.ordinal}:candidate:${index + 1}`),
      input.sessionId, input.turnId, name.toLowerCase(), name, index + 1,
      input.stage === "comparison" ? 1 : 0,
      input.stage === "decision" && index === 0 ? 1 : 0,
      input.stage === "decision" && index === 0 ? 1 : 0,
      artifact.key, artifact.sha256, completedAt,
    ));
  }
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_target_observations (
        id, session_id, turn_id, retrievability, candidate_set, comparison,
        recommendation, deterministic_match_key, semantic_evaluation_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await stableUuid(`${input.sessionId}:turn:${input.ordinal}:target-observation`),
      input.sessionId, input.turnId, observation.retrievability, observation.candidate_set,
      observation.comparison, observation.recommendation,
      `${input.sessionId}:${input.ordinal}:fixture-target-match-v1`,
      artifacts.targetObservation.key, completedAt,
    ),
    env.DB.prepare(
      `UPDATE shopping_turns
       SET status = 'completed', query_key = ?, query_sha256 = ?,
           observer_response_key = ?, observer_response_sha256 = ?, answer_shape = ?,
           source_count = 0, candidate_count = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status != 'completed'`,
    ).bind(
      artifacts.query.key, artifacts.query.sha256,
      artifacts.response.key, artifacts.response.sha256, answerShape,
      FIXTURE_CANDIDATES.length, completedAt, completedAt, input.turnId,
    ),
    env.DB.prepare(
      `UPDATE shopping_sessions
       SET completed_turns = ?, used_model_calls = used_model_calls + 4,
           updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND completed_turns = ? AND current_turn = ?`,
    ).bind(input.ordinal, completedAt, input.sessionId, input.ordinal - 1, input.ordinal),
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_session_events (
        id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
       ) VALUES (?, ?, ?, 'TURN_COMPLETED', ?, ?, ?)`,
    ).bind(
      await stableUuid(`${input.sessionId}:event:turn:${input.ordinal}:completed`),
      input.sessionId, 11 + input.ordinal * 2,
      artifacts.completedEvent.key, artifacts.completedEvent.sha256, completedAt,
    ),
  );
  await env.DB.batch(statements);
}

function fixtureRoleRequest(
  role: ShoppingRole,
  context: BlindConversationContext,
  query: string,
  target: TargetIdentity,
): unknown {
  const blind = { role, conversation: context.completed_turns, buyer_brief: context.buyer_brief, query, fixture: true };
  if (role === "query_auditor") return { ...blind, target_identity: target, instruction: "Return approve or reject only." };
  if (role === "result_classifier") return { ...blind, target_identity: target };
  if (role === "shopping_observer") return { role, conversation: context.completed_turns, query, fixture: true };
  return blind;
}

function fixtureRoleResult(
  role: ShoppingRole,
  query: string,
  answer: string,
  observation: TargetObservation,
): unknown {
  if (role === "query_generator") return { message: query, fixture: true };
  if (role === "query_auditor") return { decision: "approved", target_leakage: false, fixture: true };
  if (role === "shopping_observer") return { message: answer, fixture: true };
  return { observation, fixture: true };
}

function fixtureQuery(context: BlindConversationContext, ordinal: number, stage: ShoppingProtocol["turns"][number]["stage"]): string {
  const brief = context.buyer_brief;
  const constraints = [...brief.constraints, ...brief.preferences];
  if (stage === "discovery") {
    return `What ${brief.category} options should I consider in ${brief.target_market} for ${brief.buyer_job}?`;
  }
  if (stage === "refinement" || stage === "shortlist") {
    const detail = constraints.slice(0, Math.min(ordinal, constraints.length)).join(", ");
    return detail
      ? `Please narrow those options for these needs: ${detail}. Which concrete choices fit best?`
      : "Please narrow those options and give me a practical shortlist.";
  }
  if (stage === "comparison") return "Compare the options already mentioned, including their tradeoffs and supporting evidence.";
  if (stage === "decision") return "Which one would you choose for my needs, why, and what evidence supports that choice?";
  return "Before I buy, what facts remain uncertain, what risks should I check, and where are the source limitations?";
}

function fixtureAnswer(ordinal: number, stage: ShoppingProtocol["turns"][number]["stage"]): string {
  if (stage === "comparison") return `${FIXTURE_CANDIDATES[0]} and ${FIXTURE_CANDIDATES[1]} remain in consideration, with different tradeoffs.`;
  if (stage === "decision" || stage === "caveat_check") return `${FIXTURE_CANDIDATES[0]} is the fixture choice; verify current price, availability, and product claims before purchase.`;
  return `For fixture turn ${ordinal}, consider ${FIXTURE_CANDIDATES[0]} and ${FIXTURE_CANDIDATES[1]}.`;
}

function fixtureAnswerShape(stage: ShoppingProtocol["turns"][number]["stage"]): AnswerShape {
  if (stage === "comparison") return "comparison";
  if (stage === "decision" || stage === "caveat_check") return "decision";
  return "shortlist";
}

async function completeSession(sessionId: string, env: Env): Promise<void> {
  const session = await loadSession(sessionId, env);
  if (session?.controller_version === "langgraph-diagnostic/1.0") {
    const unresolved = await env.DB.prepare("SELECT COUNT(*) AS count FROM shopping_target_observations WHERE session_id = ? AND (retrievability = 'not_observed' OR candidate_set = 'not_observed')").bind(sessionId).first<{ count: number }>();
    if ((unresolved?.count ?? 0) > 0 || session.completed_turns === 0) {
      await markSessionIncomplete(sessionId, "Captured shopping evidence is available, but one or more target assessments remained unresolved after local repair.", env);
      return;
    }
  }
  const now = new Date().toISOString();
  const event = await jsonArtifact(`shopping-sessions/${sessionId}/events/000100-session-completed.json`, {
    type: "SESSION_COMPLETED",
    occurred_at: now,
  });
  await putArtifact(event, sessionId, env);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shopping_sessions SET status = 'completed', completed_at = ?, updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).bind(now, now, sessionId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_session_events (
        id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
       ) VALUES (?, ?, 100, 'SESSION_COMPLETED', ?, ?, ?)`,
    ).bind(await stableUuid(`${sessionId}:event:completed`), sessionId, event.key, event.sha256, now),
  ]);
  await settleTerminalSessionCredits(sessionId, "completed", env);
}

async function stopForBudget(sessionId: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  const event = await jsonArtifact(`shopping-sessions/${sessionId}/events/000101-budget-exhausted.json`, {
    type: "BUDGET_EXHAUSTED",
    occurred_at: now,
  });
  await putArtifact(event, sessionId, env);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shopping_sessions SET status = 'budget_exhausted', updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).bind(now, sessionId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO shopping_session_events (
        id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
       ) VALUES (?, ?, 101, 'BUDGET_EXHAUSTED', ?, ?, ?)`,
    ).bind(await stableUuid(`${sessionId}:event:budget-exhausted`), sessionId, event.key, event.sha256, now),
  ]);
  await settleTerminalSessionCredits(sessionId, "budget_exhausted", env);
}

function queueMessage(sessionId: string, executionMode: "fixture" | "live"): ShoppingAdvanceMessage {
  return {
    schema_version: CONTRACT_VERSIONS.guidedShopping,
    kind: "shopping_advance",
    session_id: sessionId,
    execution_mode: executionMode,
    created_at: new Date().toISOString(),
  };
}

function roleQueueMessage(
  sessionId: string,
  turnId: string,
  turnOrdinal: number,
  role: ShoppingRole,
): ShoppingRoleCallMessage {
  return {
    schema_version: CONTRACT_VERSIONS.guidedShopping,
    kind: "shopping_role_call",
    session_id: sessionId,
    turn_id: turnId,
    turn_ordinal: turnOrdinal,
    role,
    execution_mode: "live",
    created_at: new Date().toISOString(),
  };
}

function roleForTurnStatus(status: string): ShoppingRole | null {
  if (status === "planned" || status === "query_generating") return "query_generator";
  if (status === "query_auditing") return "query_auditor";
  if (["observer_queued", "observer_running"].includes(status)) return "shopping_observer";
  if (status === "classifying") return "result_classifier";
  return null;
}

function roleAfter(role: ShoppingRole): ShoppingRole | null {
  if (role === "query_generator") return "query_auditor";
  if (role === "query_auditor") return "shopping_observer";
  if (role === "shopping_observer") return "result_classifier";
  return null;
}

function liveRolePrompt(
  role: ShoppingRole,
  input: {
    context: BlindConversationContext;
    turnSpec: ShoppingProtocol["turns"][number];
    query: GeneratedShoppingQuery | null;
    observerResult: ShoppingObserverCapture | null;
    targetIdentity: TargetIdentity;
  },
  queryRevision = 0,
): string {
  if (role === "query_generator") {
    return buildQueryGeneratorPrompt(input.context, input.turnSpec, queryRevision);
  }
  if (!input.query) throw new Error("Generated shopping query is unavailable.");
  if (role === "query_auditor") return buildQueryAuditPrompt({
    context: input.context,
    turn: input.turnSpec,
    query: input.query,
    targetIdentity: input.targetIdentity,
  });
  if (role === "shopping_observer") return buildShoppingObserverPrompt({
    context: input.context,
    query: input.query,
  });
  if (!input.observerResult) throw new Error("Captured shopping result is unavailable.");
  return buildResultClassifierPrompt({
    turnOrdinal: input.turnSpec.ordinal,
    context: input.context,
    query: input.query,
    observerResult: input.observerResult,
    targetIdentity: input.targetIdentity,
  });
}

async function markSessionIncomplete(sessionId: string, reason: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE shopping_sessions SET status = 'incomplete', updated_at = ?, row_version = row_version + 1
     WHERE id = ? AND status IN ('protocol_ready', 'queued', 'running')`,
  ).bind(now, sessionId).run();
  const current = await loadSession(sessionId, env);
  if (current) await settleTerminalSessionCredits(sessionId, current.status, env);
  console.error(JSON.stringify({ level: "error", message: "shopping_session_incomplete", session_id: sessionId, reason }));
}

export async function failControlledShoppingSession(
  sessionId: string,
  reason: string,
  env: Env,
): Promise<void> {
  await markSessionIncomplete(sessionId, reason, env);
}

async function settleTerminalSessionCredits(
  sessionId: string,
  terminalStatus: string,
  env: Env,
): Promise<void> {
  const billing = await env.DB.prepare(
    `SELECT account_id, job_id, credit_reservation_id, billing_status
     FROM shopping_sessions WHERE id = ?`,
  ).bind(sessionId).first<{
    account_id: string | null;
    job_id: string | null;
    credit_reservation_id: string | null;
    billing_status: string | null;
  }>();
  if (
    !billing?.account_id || !billing.job_id || !billing.credit_reservation_id ||
    billing.billing_status !== "reserved"
  ) return;

  const now = new Date().toISOString();
  if (terminalStatus === "completed") {
    await consumeJobCredits({
      accountId: billing.account_id,
      jobId: billing.job_id,
      reservationId: billing.credit_reservation_id,
    }, env);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE shopping_sessions SET billing_status = 'consumed', updated_at = ?
         WHERE id = ? AND billing_status = 'reserved'`,
      ).bind(now, sessionId),
      env.DB.prepare(
        `UPDATE jobs SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'failed')`,
      ).bind(now, now, billing.job_id),
    ]);
    return;
  }

  await releaseJobCredits({
    accountId: billing.account_id,
    jobId: billing.job_id,
    reservationId: billing.credit_reservation_id,
  }, env);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shopping_sessions SET billing_status = 'released', updated_at = ?
       WHERE id = ? AND billing_status = 'reserved'`,
    ).bind(now, sessionId),
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', completed_at = ?, updated_at = ?
       WHERE id = ? AND status != 'completed'`,
    ).bind(now, now, billing.job_id),
  ]);
}

export function classifyShoppingModelError(error: unknown): string {
  if (error instanceof UncertainModelCallError || (error instanceof Error && error.name === "UncertainModelCallError")) {
    return "MODEL_TIMEOUT_UNCERTAIN";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "MODEL_TIMEOUT_UNCERTAIN";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("MODEL_COST_UNAVAILABLE")) return "MODEL_COST_UNAVAILABLE";
  if (message.includes("MODEL_USAGE_EXCEEDED_RESERVATION")) return "MODEL_USAGE_EXCEEDED_RESERVATION";
  if (/429|rate.?limit/i.test(message)) return "MODEL_RATE_LIMITED";
  if (/schema|validation|source/i.test(message)) return "OUTPUT_VALIDATION_FAILED";
  return "MODEL_REQUEST_INCOMPLETE";
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function buildOpenRouterCostObservation(
  sessionStatus: string,
  rows: Array<{
    role: string;
    call_count: number;
    priced_call_count: number;
    cost_usd_micros: number;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    search_requests: number;
  }>,
): Record<string, unknown> {
  const totals = rows.reduce((sum, row) => ({
    call_count: sum.call_count + row.call_count,
    priced_call_count: sum.priced_call_count + row.priced_call_count,
    cost_usd_micros: sum.cost_usd_micros + row.cost_usd_micros,
    input_tokens: sum.input_tokens + row.input_tokens,
    output_tokens: sum.output_tokens + row.output_tokens,
    reasoning_tokens: sum.reasoning_tokens + row.reasoning_tokens,
    search_requests: sum.search_requests + row.search_requests,
  }), {
    call_count: 0,
    priced_call_count: 0,
    cost_usd_micros: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    search_requests: 0,
  });
  const complete = sessionStatus === "completed" && totals.call_count > 0 &&
    totals.call_count === totals.priced_call_count;
  return {
    schema_version: "openrouter-cost-observation/1.0",
    status: complete ? "complete_sample" : "partial_sample",
    currency: "USD",
    openrouter_cost_usd_micros: totals.cost_usd_micros,
    openrouter_cost_usd: (totals.cost_usd_micros / 1_000_000).toFixed(6),
    call_count: totals.call_count,
    priced_call_count: totals.priced_call_count,
    unpriced_call_count: totals.call_count - totals.priced_call_count,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    reasoning_tokens: totals.reasoning_tokens,
    search_requests: totals.search_requests,
    roles: rows,
    customer_billing_basis: "not_used",
  };
}

async function loadSession(sessionId: string, env: Env): Promise<SessionRow | null> {
  return env.DB.prepare(
    `SELECT id, status, execution_mode, model_policy_key, target_identity_key, completed_turns, controller_version
     FROM shopping_sessions WHERE id = ?`,
  ).bind(sessionId).first<SessionRow>();
}

async function readPrivateJson<T>(key: string, schema: { parse(value: unknown): T }, env: Env): Promise<T> {
  const object = await env.EVIDENCE.get(key);
  if (!object || object.size > MAX_PRIVATE_ARTIFACT_BYTES) throw new Error("Private shopping artifact is unavailable or too large.");
  return schema.parse(JSON.parse(await object.text()));
}

async function readJsonArtifact<T>(key: string, env: Env): Promise<T | null> {
  const object = await env.EVIDENCE.get(key);
  if (!object || object.size > MAX_PRIVATE_ARTIFACT_BYTES) return null;
  return JSON.parse(await object.text()) as T;
}

type JsonArtifact = { key: string; body: string; sha256: string };

async function jsonArtifact(key: string, value: unknown): Promise<JsonArtifact> {
  const body = JSON.stringify(value);
  return { key, body, sha256: await sha256Hex(body) };
}

async function putArtifact(artifact: JsonArtifact, sessionId: string, env: Env): Promise<void> {
  await env.EVIDENCE.put(artifact.key, artifact.body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { session_id: sessionId, sha256: artifact.sha256 },
  });
}

async function stableUuid(seed: string): Promise<string> {
  const hash = await sha256Hex(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pad(value: number): string {
  return String(value).padStart(6, "0");
}
