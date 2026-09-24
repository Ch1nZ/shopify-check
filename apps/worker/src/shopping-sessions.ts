import {
  BlindConversationContextSchema,
  BuyerBriefSchema,
  ModelRolePolicySchema,
  ShoppingBudgetSchema,
  ShoppingProtocolSchema,
  TargetIdentitySchema,
  type BlindConversationContext,
  type BuyerBrief,
  type ModelRolePolicy,
  type ShoppingBudget,
  type ShoppingProtocol,
  type TargetIdentity,
} from "@mclab/contracts";

const MAX_CONTROLLER_ARTIFACT_BYTES = 256_000;

export async function createControlledShoppingSession(input: {
  sessionId?: string;
  collectionId: string;
  accountId?: string;
  jobId?: string;
  creditReservationId?: string;
  buyerBrief: BuyerBrief;
  targetIdentity: TargetIdentity;
  protocol: ShoppingProtocol;
  modelPolicies: readonly ModelRolePolicy[];
  budget: ShoppingBudget;
  controllerVersion: string;
}, env: Env): Promise<{ session_id: string; status: "protocol_ready" }> {
  if (input.sessionId) {
    const existing = await env.DB.prepare("SELECT id FROM shopping_sessions WHERE id = ? AND job_id = ? AND collection_id = ?").bind(input.sessionId, input.jobId ?? null, input.collectionId).first();
    if (existing) return { session_id: input.sessionId, status: "protocol_ready" };
  }
  const buyerBrief = BuyerBriefSchema.parse(input.buyerBrief);
  const targetIdentity = TargetIdentitySchema.parse(input.targetIdentity);
  const protocol = ShoppingProtocolSchema.parse(input.protocol);
  const budget = ShoppingBudgetSchema.parse(input.budget);
  const modelPolicies = ModelRolePolicySchema.array().length(4).parse(input.modelPolicies);
  assertOnePolicyPerRole(modelPolicies);

  const collection = await env.DB.prepare("SELECT id FROM collection_runs WHERE id = ?")
    .bind(input.collectionId)
    .first<{ id: string }>();
  if (!collection) throw new Error("Collection does not exist.");

  const sessionId = input.sessionId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const prefix = `shopping-sessions/${sessionId}`;
  const artifacts = {
    buyerBrief: await prepareJsonArtifact(`${prefix}/controller/buyer-brief.json`, buyerBrief),
    protocol: await prepareJsonArtifact(`${prefix}/controller/protocol.json`, protocol),
    modelPolicy: await prepareJsonArtifact(`${prefix}/private/model-policy.json`, modelPolicies),
    targetIdentity: await prepareJsonArtifact(`${prefix}/private/target-identity.json`, targetIdentity),
    event: await prepareJsonArtifact(`${prefix}/events/000001-protocol-approved.json`, {
      type: "PROTOCOL_APPROVED",
      occurred_at: now,
      protocol_id: protocol.protocol_id,
      protocol_revision: protocol.protocol_revision,
    }),
  };

  await Promise.all(Object.values(artifacts).map((artifact) =>
    env.EVIDENCE.put(artifact.key, artifact.body, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        session_id: sessionId,
        sha256: artifact.sha256,
      },
    })
  ));

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shopping_sessions (
        id, account_id, collection_id, protocol_version, protocol_id, protocol_revision,
        controller_version, status, target_market, buyer_brief_key, buyer_brief_sha256,
        protocol_key, protocol_sha256, model_policy_key, model_policy_sha256,
        target_identity_key, target_identity_sha256, minimum_turns, maximum_turns,
        max_model_calls, max_search_requests, max_input_tokens, max_output_tokens,
        max_cost_usd_micros, job_id, credit_reservation_id, billing_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'protocol_ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sessionId,
      input.accountId ?? null,
      input.collectionId,
      protocol.schema_version,
      protocol.protocol_id,
      protocol.protocol_revision,
      input.controllerVersion,
      buyerBrief.target_market,
      artifacts.buyerBrief.key,
      artifacts.buyerBrief.sha256,
      artifacts.protocol.key,
      artifacts.protocol.sha256,
      artifacts.modelPolicy.key,
      artifacts.modelPolicy.sha256,
      artifacts.targetIdentity.key,
      artifacts.targetIdentity.sha256,
      protocol.minimum_turns,
      protocol.maximum_turns,
      budget.max_model_calls,
      budget.max_search_requests,
      budget.max_input_tokens,
      budget.max_output_tokens,
      budget.max_cost_usd_micros,
      input.jobId ?? null,
      input.creditReservationId ?? null,
      input.creditReservationId ? "reserved" : null,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO shopping_session_events (
        id, session_id, sequence, event_type, event_key, event_sha256, occurred_at
      ) VALUES (?, ?, 1, 'PROTOCOL_APPROVED', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), sessionId, artifacts.event.key, artifacts.event.sha256, now),
  ]);

  return { session_id: sessionId, status: "protocol_ready" };
}

export async function readBlindConversationContext(
  sessionId: string,
  env: Env,
): Promise<BlindConversationContext> {
  // Deliberately excludes target_identity_key and never queries
  // shopping_target_observations.
  const session = await env.DB.prepare(
    `SELECT buyer_brief_key, protocol_key, completed_turns,
      used_model_calls, used_search_requests, used_input_tokens,
      used_output_tokens, used_cost_usd_micros
     FROM shopping_sessions WHERE id = ?`,
  ).bind(sessionId).first<{
    buyer_brief_key: string;
    protocol_key: string;
    completed_turns: number;
    used_model_calls: number;
    used_search_requests: number;
    used_input_tokens: number;
    used_output_tokens: number;
    used_cost_usd_micros: number;
  }>();
  if (!session) throw new Error("Shopping session does not exist.");

  const turns = await env.DB.prepare(
    `SELECT id, ordinal, stage, query_key, observer_response_key, answer_shape
     FROM shopping_turns
     WHERE session_id = ? AND status = 'completed'
     ORDER BY ordinal`,
  ).bind(sessionId).all<{
    id: string;
    ordinal: number;
    stage: BlindConversationContext["completed_turns"][number]["stage"];
    query_key: string;
    observer_response_key: string;
    answer_shape: BlindConversationContext["completed_turns"][number]["answer_shape"];
  }>();

  const completedTurns = await Promise.all(turns.results.map(async (turn) => {
    const [query, response, candidates] = await Promise.all([
      readJsonObject<{ message: string; adaptive_decision?: unknown }>(turn.query_key, env),
      readJsonObject<{ message: string; sources?: Array<{ source_id: string; url: string; title: string | null }> }>(turn.observer_response_key, env),
      env.DB.prepare(
        `SELECT displayed_name FROM shopping_candidate_observations
         WHERE turn_id = ? ORDER BY first_position, displayed_name`,
      ).bind(turn.id).all<{ displayed_name: string }>(),
    ]);
    return {
      ordinal: turn.ordinal,
      stage: turn.stage,
      user_message: query.message,
      assistant_message: response.message,
      answer_shape: turn.answer_shape,
      surfaced_candidate_names: candidates.results.map((candidate) => candidate.displayed_name),
      sources: response.sources ?? [],
      ...(query.adaptive_decision ? { adaptive_decision: query.adaptive_decision } : {}),
    };
  }));

  const [buyerBrief, protocol] = await Promise.all([
    readJsonObject<BuyerBrief>(session.buyer_brief_key, env),
    readJsonObject<ShoppingProtocol>(session.protocol_key, env),
  ]);
  return BlindConversationContextSchema.parse({
    buyer_brief: buyerBrief,
    protocol,
    completed_turns: completedTurns,
    usage: {
      turns: session.completed_turns,
      model_calls: session.used_model_calls,
      search_requests: session.used_search_requests,
      input_tokens: session.used_input_tokens,
      output_tokens: session.used_output_tokens,
      cost_usd_micros: session.used_cost_usd_micros,
    },
  });
}

function assertOnePolicyPerRole(policies: ModelRolePolicy[]): void {
  const roles = policies.map((policy) => policy.role);
  if (new Set(roles).size !== roles.length) throw new Error("Model role policies must be unique.");
  for (const required of ["query_generator", "query_auditor", "shopping_observer", "result_classifier"] as const) {
    if (!roles.includes(required)) throw new Error(`Missing model policy for ${required}.`);
  }
}

async function prepareJsonArtifact(key: string, value: unknown): Promise<{
  key: string;
  body: string;
  sha256: string;
}> {
  const body = JSON.stringify(value);
  return { key, body, sha256: await sha256Hex(body) };
}

async function readJsonObject<T>(key: string, env: Env): Promise<T> {
  const object = await env.EVIDENCE.get(key);
  if (!object || object.size > MAX_CONTROLLER_ARTIFACT_BYTES) {
    throw new Error("Shopping controller artifact is unavailable or too large.");
  }
  return JSON.parse(await object.text()) as T;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
