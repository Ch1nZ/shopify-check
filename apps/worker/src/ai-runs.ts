import {
  AiJobMessageSchema,
  EvidencePackSchema,
  type AiJobMessage,
  type EvidencePack,
} from "@mclab/contracts";
import {
  buildEvidencePrompt,
  buildFixtureAnalysis,
  buildOpenRouterRequestDescriptor,
  modelCapability,
  runLiveEvidenceAnalysis,
  sha256Hex,
} from "@mclab/openrouter-adapter";

export async function processAiJobMessage(rawMessage: AiJobMessage, env: Env): Promise<void> {
  const message = AiJobMessageSchema.parse(rawMessage);
  const run = await env.DB.prepare(
    "SELECT status, evidence_pack_key FROM ai_runs WHERE id = ?",
  )
    .bind(message.run_id)
    .first<{ status: string; evidence_pack_key: string }>();
  if (!run) throw new Error(`AI run ${message.run_id} does not exist.`);
  if (["fixture_completed", "completed", "incomplete", "failed_validation"].includes(run.status)) return;

  const claimed = await env.DB.prepare(
    "UPDATE ai_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'",
  )
    .bind(new Date().toISOString(), message.run_id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return;

  const evidencePack = await readEvidencePack(run.evidence_pack_key, env);
  const prefix = `ai-runs/${message.run_id}`;
  const requestKey = `${prefix}/request.json`;
  const resultKey = `${prefix}/result.json`;
  const descriptor = buildOpenRouterRequestDescriptor(message.route_key, message.reasoning_effort);
  const prompt = buildEvidencePrompt(evidencePack, message.target_market);
  await env.EVIDENCE.put(
    requestKey,
    JSON.stringify({
      run_id: message.run_id,
      mode: message.mode,
      route: descriptor,
      target_market: message.target_market,
      prompt,
      created_at: message.created_at,
    }),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { run_id: message.run_id, artifact: "request" },
    },
  );

  try {
    const openRouterApiKey = env.OPENROUTER_API_KEY ?? "configured-per-route";
    if (message.mode === "live" && !openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY_UNAVAILABLE");
    }
    const result = message.mode === "fixture"
      ? {
          output: buildFixtureAnalysis(evidencePack),
          validation_error: null,
          response_id: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
          },
        }
      : await runLiveEvidenceAnalysis({
          apiKey: openRouterApiKey!,
          routeKey: message.route_key,
          reasoningEffort: message.reasoning_effort,
          targetMarket: message.target_market,
          evidencePack,
          abortSignal: AbortSignal.timeout(90_000),
        });

    const completedAt = new Date().toISOString();
    await env.EVIDENCE.put(
      resultKey,
      JSON.stringify({
        run_id: message.run_id,
        mode: message.mode,
        model: descriptor.model,
        completed_at: completedAt,
        analysis: result.output,
        validation_error: result.validation_error,
        usage: result.usage,
      }),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { run_id: message.run_id, artifact: "result" },
      },
    );
    await env.DB.prepare(
      `UPDATE ai_runs SET status = ?, request_key = ?, result_key = ?,
       provider_response_id = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
       total_tokens = ?, cost_usd_micros = ?, error_code = ?, error_message = ?,
       updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
      .bind(
        message.mode === "fixture"
          ? "fixture_completed"
          : result.validation_error
            ? "failed_validation"
            : "completed",
        requestKey,
        resultKey,
        result.response_id,
        result.usage.input_tokens,
        result.usage.output_tokens,
        result.usage.reasoning_tokens,
        result.usage.total_tokens,
        result.usage.cost_usd === null ? null : Math.round(result.usage.cost_usd * 1_000_000),
        result.validation_error ? "OUTPUT_VALIDATION_FAILED" : null,
        result.validation_error?.slice(0, 1_000) ?? null,
        completedAt,
        completedAt,
        message.run_id,
      )
      .run();
  } catch (error) {
    const completedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE ai_runs SET status = 'incomplete', request_key = ?, error_code = ?,
       error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    )
      .bind(
        requestKey,
        classifyAiError(error),
        error instanceof Error ? error.message.slice(0, 1_000) : "Unknown model error",
        completedAt,
        completedAt,
        message.run_id,
      )
      .run();
  }
}

export async function createFixtureRun(input: {
  collectionId: string;
  routeKey: AiJobMessage["route_key"];
  reasoningEffort: AiJobMessage["reasoning_effort"];
  targetMarket: string;
}, env: Env): Promise<{ run_id: string; status: "queued" }> {
  return createAiRun(input, "fixture", env);
}

export async function createLiveQualificationRun(input: {
  collectionId: string;
  routeKey: AiJobMessage["route_key"];
  reasoningEffort: AiJobMessage["reasoning_effort"];
  targetMarket: string;
}, env: Env): Promise<{ run_id: string; status: "queued" }> {
  return createAiRun(input, "live", env);
}

async function createAiRun(input: {
  collectionId: string;
  routeKey: AiJobMessage["route_key"];
  reasoningEffort: AiJobMessage["reasoning_effort"];
  targetMarket: string;
}, mode: AiJobMessage["mode"], env: Env): Promise<{ run_id: string; status: "queued" }> {
  const collection = await env.DB.prepare(
    "SELECT evidence_pack_key FROM collection_runs WHERE id = ?",
  )
    .bind(input.collectionId)
    .first<{ evidence_pack_key: string | null }>();
  if (!collection?.evidence_pack_key) throw new Error("Collection evidence pack is unavailable.");

  const capability = modelCapability(input.routeKey);
  const evidencePack = await readEvidencePack(collection.evidence_pack_key, env);
  const promptSha256 = await sha256Hex(buildEvidencePrompt(evidencePack, input.targetMarket));
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO ai_runs (
      id, collection_id, mode, route_key, model_id, provider_order_json,
      reasoning_effort, target_market, registry_version, status, evidence_pack_key,
      prompt_sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  )
    .bind(
      runId,
      input.collectionId,
      mode,
      input.routeKey,
      capability.model_id,
      JSON.stringify(capability.provider_order),
      input.reasoningEffort,
      input.targetMarket,
      capability.registry_version,
      collection.evidence_pack_key,
      promptSha256,
      now,
      now,
    )
    .run();

  const message: AiJobMessage = {
    schema_version: "test-run/1.0",
    run_id: runId,
    collection_id: input.collectionId,
    route_key: input.routeKey,
    reasoning_effort: input.reasoningEffort,
    target_market: input.targetMarket,
    mode,
    created_at: now,
  };
  await env.JOBS_QUEUE.send(message);
  return { run_id: runId, status: "queued" };
}

export async function readAiRun(runId: string, env: Env): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT id, collection_id, mode, route_key, model_id, reasoning_effort, target_market,
     registry_version, status, result_key, input_tokens, output_tokens, reasoning_tokens,
     total_tokens, cost_usd_micros, error_code, error_message, created_at, completed_at
     FROM ai_runs WHERE id = ?`,
  )
    .bind(runId)
    .first<Record<string, string | number | null>>();
  if (!row) return null;
  let analysis: unknown;
  if (typeof row.result_key === "string") {
    const object = await env.EVIDENCE.get(row.result_key);
    if (object && object.size <= 1_000_000) {
      const stored = JSON.parse(await object.text()) as { analysis?: unknown };
      analysis = stored.analysis;
    }
  }
  return {
    ...row,
    cost_usd: typeof row.cost_usd_micros === "number" ? row.cost_usd_micros / 1_000_000 : null,
    ...(analysis === undefined ? {} : { analysis }),
  };
}

async function readEvidencePack(key: string, env: Env): Promise<EvidencePack> {
  const object = await env.EVIDENCE.get(key);
  if (!object || object.size > 1_000_000) throw new Error("Evidence pack is unavailable or too large.");
  return EvidencePackSchema.parse(JSON.parse(await object.text()) as unknown);
}

function classifyAiError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "MODEL_TIMEOUT";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("rate-limit") || message.includes("rate limit")) {
    return "MODEL_RATE_LIMITED";
  }
  if (message.includes("schema") || message.includes("validation")) return "OUTPUT_VALIDATION_FAILED";
  return "MODEL_REQUEST_INCOMPLETE";
}
