import { feedbackRoute } from './feedback';
import { selfHostRoute } from "./self-host";
import {
  CONTRACT_VERSIONS,
  CreateCustomerTaskRequestSchema,
  CreateShoppingSessionRequestSchema,
  FixtureAnalysisRequestSchema,
  PreflightRequestSchema,
  ShopifyCollectRequestSchema,
  SyntheticJobRequestSchema,
  type JobMessage,
} from "@mclab/contracts";
import {
  CONTROLLED_SHOPPING_PROTOCOL,
  DEFAULT_ROLE_POLICIES,
  MAX_QUERY_REVISIONS,
  creditCostFor,
  publicCatalog,
} from "@mclab/domain";
import { modelCapabilities, jevClassifierEnabled } from "@mclab/openrouter-adapter";
import {
  CollectionError,
  collectShopifyProduct,
  publicProductPreview,
  validatePublicProductUrl,
} from "@mclab/shopify-online-store";

import { storeCollection } from "./collection-storage";
import { serveCollectionArtifact } from "./collection-artifacts";
import { createFixtureRun, createLiveQualificationRun, readAiRun } from "./ai-runs";
import { createControlledShoppingSession } from "./shopping-sessions";
import { handlePaddleWebhook, reconcilePaddleBillingEvent } from "./paddle-webhooks";
import {
  createCustomerTask,
  customerOwnsCollection,
  CustomerTaskError,
  readCustomerTask,
} from "./customer-tasks";
import {
  readPaddleCheckoutConfig,
  readPaddleCatalogStatus,
  syncPaddleCatalog,
} from "./paddle-api";
import {
  consumeAccountRecovery,
  consumeAccountSignup,
  readAccountHistory,
  recoveryAvailable,
  requestAccountRecovery,
  requestAccountSignup,
} from "./account-access";
import { analyticsCorsHeaders, recordConversionEvent } from "./conversion-events";
import {
  ownerStatsAuthorized,
  ownerStatsResponse,
  ownerStatsToken,
  readOwnerStatsBoard,
  readOwnerStatsFormToken,
  recordOwnerProductAttempt,
  renderOwnerStatsPage,
} from "./owner-stats";
import {
  readControlledShoppingSession,
  startControlledShoppingSession,
} from "./shopping-orchestrator";
import {
  CreditPackKeySchema,
  CreditRateLimitError,
  createCheckoutIntent,
  ensureBrowserSession,
  readBrowserCreditBalance,
  releaseJobCredits,
  reserveJobCredits,
} from "./credits";
import { readFreeCheckOffer, freeCheckEnabled } from "./free-check";
import { servePublicAssets } from "./public-offer-html";

const MAX_JSON_BYTES = 16_384;

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const selfHost = await selfHostRoute(request, env);
  if (selfHost) return selfHost;
  const feedback = await feedbackRoute(request, env);
  if (feedback) return feedback;
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return success({
      status: "ok",
      environment: env.ENVIRONMENT,
      api_version: env.API_VERSION,
      pricing_version: env.PRICING_VERSION,
      jev_classifier: jevClassifierEnabled(env.SELF_CHECK_JEV_CLASSIFIER),
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/catalog") {
    return success(publicCatalog());
  }

  if (
    url.pathname === "/owner/stats" ||
    url.pathname === "/owner/stats/" ||
    url.pathname === "/api/v1/owner/stats"
  ) {
    return routeOwnerStats(request, env);
  }

  if (request.method === "OPTIONS" && url.pathname === "/api/v1/analytics/events") {
    return new Response(null, {
      status: 204,
      headers: {
        ...analyticsCorsHeaders(request, env),
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/analytics/events") {
    const recorded = await recordConversionEvent(request, await readBoundedJson(request), env);
    const response = recorded
      ? new Response(null, { status: 204 })
      : failure("INVALID_EVENT", "Conversion event was not accepted.", 400);
    return withHeaders(response, analyticsCorsHeaders(request, env));
  }

  if (request.method === "GET" && url.pathname === "/api/v1/account/recovery-config") {
    return success({
      enabled: recoveryAvailable(env),
      free_check: {
        enabled: freeCheckEnabled(env),
        signup_available: freeCheckEnabled(env) && recoveryAvailable(env),
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/account/recovery") {
    if (!sameOriginRequest(request)) {
      return failure("ORIGIN_NOT_ALLOWED", "Recovery requests must come from this site.", 403);
    }
    const body = await readBoundedJson(request);
    await requestAccountRecovery(
      request,
      typeof body === "object" && body !== null && "email" in body
        ? (body as { email?: unknown }).email
        : undefined,
      env,
    );
    return success({
      message: "If that email is linked to an MC Lab purchase, a secure access link is on its way.",
    }, 202);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/account/signup") {
    if (!sameOriginRequest(request)) {
      return failure("ORIGIN_NOT_ALLOWED", "Signup requests must come from this site.", 403);
    }
    const body = await readBoundedJson(request);
    const signup = await requestAccountSignup(
      request,
      typeof body === "object" && body !== null && "email" in body
        ? (body as { email?: unknown }).email
        : undefined,
      env,
    );
    return withOptionalCookie(success({
      message: "If that email can receive mail, a verification link is on its way.",
    }, 202), signup.setCookie);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/account/recover") {
    const recovered = await consumeAccountRecovery(url.searchParams.get("token"), env);
    const destination = new URL("/", request.url);
    destination.searchParams.set("recovery", recovered ? "success" : "invalid");
    const response = Response.redirect(destination.toString(), 303);
    return recovered ? withOptionalCookie(response, recovered.setCookie) : response;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/account/verify") {
    const verified = await consumeAccountSignup(url.searchParams.get("token"), env);
    const destination = new URL("/", request.url);
    destination.searchParams.set("signup", verified ? "success" : "invalid");
    destination.hash = "start";
    const response = Response.redirect(destination.toString(), 303);
    return verified ? withOptionalCookie(response, verified.setCookie) : response;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/account/history") {
    const history = await readAccountHistory(request, env);
    return withOptionalCookie(success({ reports: history.reports }), history.setCookie);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/billing/paddle/webhook") {
    return handlePaddleWebhook(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/billing/paddle/config") {
    const config = readPaddleCheckoutConfig(env);
    return config
      ? success(config)
      : failure("CHECKOUT_UNAVAILABLE", "Checkout is not configured for this environment.", 503);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/billing/paddle/checkout-intents") {
    if (!sameOriginRequest(request)) {
      return failure("ORIGIN_NOT_ALLOWED", "Checkout requests must come from this site.", 403);
    }
    const body = await readBoundedJson(request);
    const packKey = CreditPackKeySchema.safeParse(
      typeof body === "object" && body !== null && "pack_key" in body
        ? (body as { pack_key?: unknown }).pack_key
        : undefined,
    );
    if (!packKey.success) {
      return failure("INVALID_REQUEST", "Choose an available credit pack.", 400);
    }
    try {
      const intent = await createCheckoutIntent(request, packKey.data, env);
      return withOptionalCookie(success({
        intent_id: intent.intent_id,
        price_id: intent.price_id,
        custom_data: intent.custom_data,
        customer_email: intent.customer_email,
      }, 201), intent.set_cookie);
    } catch (error) {
      if (error instanceof CreditRateLimitError) {
        return failure("RATE_LIMITED", error.message, 429);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/v1/billing/credits") {
    const result = await readBrowserCreditBalance(request, env);
    const freeCheck = await readFreeCheckOffer(result.account_id, env);
    return withOptionalCookie(success({
      ...result.balance,
      account_access: result.account_access,
      credits_per_completed_task: 30,
      free_check: freeCheck,
    }), result.set_cookie);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/free-preview") {
    if (!sameOriginRequest(request)) {
      return failure("ORIGIN_NOT_ALLOWED", "Preview requests must come from this site.", 403);
    }
    const parsed = ShopifyCollectRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Enter a valid HTTPS Shopify product URL.", 400);
    }
    const browser = await ensureBrowserSession(request, env);
    const rateLimit = await env.TASK_RATE_LIMITER.limit({ key: `preview:${env.SELF_HOSTED === "true" ? request.headers.get("CF-Connecting-IP") ?? "local" : browser.accountId}` });
    if (!rateLimit.success) {
      return failure("RATE_LIMITED", "Too many preview attempts. Try again shortly.", 429);
    }
    try {
      const collection = await collectShopifyProduct(parsed.data.product_url);
      await recordOwnerProductAttempt({
        accountId: browser.accountId,
        source: "preview",
        billingKind: "none",
        productUrl: collection.record.final_url,
      }, env);
      return withOptionalCookie(success(publicProductPreview(collection)), browser.setCookie);
    } catch (error) {
      if (error instanceof CollectionError) {
        return failure(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
    if (!sameOriginRequest(request)) {
      return failure("ORIGIN_NOT_ALLOWED", "Task requests must come from this site.", 403);
    }
    const parsed = CreateCustomerTaskRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Complete the product and buyer-test configuration.", 400);
    }
    try {
      const task = await createCustomerTask(request, parsed.data, env);
      return withOptionalCookie(success({
        task_id: task.task_id,
        session_id: task.session_id,
        collection_id: task.collection_id,
        status: task.status,
        reserved_credits: task.reserved_credits,
        product_record: task.product_record,
        technical_check: task.technical_check,
      }, 202), task.set_cookie);
    } catch (error) {
      if (error instanceof CustomerTaskError) {
        return failure(error.code, error.message, error.status);
      }
      if (error instanceof CollectionError) {
        return failure(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  const customerTaskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (request.method === "GET" && customerTaskMatch) {
    const taskId = customerTaskMatch[1]!;
    if (!isUuid(taskId)) return failure("NOT_FOUND", "Task not found.", 404);
    const result = await readCustomerTask(request, taskId, env);
    return withOptionalCookie(
      result.task ? success(result.task) : failure("NOT_FOUND", "Task not found.", 404),
      result.set_cookie,
    );
  }

  const customerArtifactMatch = url.pathname.match(
    /^\/api\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/,
  );
  if (request.method === "GET" && customerArtifactMatch) {
    const taskId = customerArtifactMatch[1]!;
    if (!isUuid(taskId)) return failure("NOT_FOUND", "Artifact not found.", 404);
    const ownership = await customerOwnsCollection(request, taskId, env);
    if (!ownership.collectionId) {
      return withOptionalCookie(failure("NOT_FOUND", "Artifact not found.", 404), ownership.set_cookie);
    }
    const artifact = await serveCollectionArtifact(
      ownership.collectionId,
      customerArtifactMatch[2]!,
      url.searchParams.get("download") === "1",
      env,
    );
    return withOptionalCookie(
      artifact ?? failure("NOT_FOUND", "Artifact not found.", 404),
      ownership.set_cookie,
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v1/model-capabilities") {
    return success({
      registry: modelCapabilities(),
      live_execution_enabled: true,
      note: "The public controlled-shopping route is enabled in production.",
    });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/preflight") {
    const parsed = PreflightRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Enter a valid HTTPS Shopify product URL.", 400);
    }

    const result = validateProductUrl(parsed.data.product_url);
    return success(result, result.supported ? 200 : 422);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/dev/synthetic-jobs") {
    if ((env.ENVIRONMENT as string) !== "local") {
      return failure("NOT_FOUND", "Route not found.", 404);
    }

    const parsed = SyntheticJobRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Synthetic job payload is invalid.", 400);
    }

    const credits = creditCostFor(parsed.data.job_kind);
    const jobId = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    const decision = await reserveJobCredits({
      accountId: parsed.data.account_id,
      jobId,
      reservationId,
      credits,
    }, env);

    if (!decision.admitted) {
      return failure("PAYMENT_REQUIRED", "Not enough MC Test Credits.", 402, decision);
    }

    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO jobs (
          id, account_id, job_kind, protocol_version, pricing_version,
          reserved_credits, reservation_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
        .bind(
          jobId,
          parsed.data.account_id,
          parsed.data.job_kind,
          CONTRACT_VERSIONS.testRun,
          env.PRICING_VERSION,
          credits,
          reservationId,
          now,
          now,
        )
        .run();

      const message: JobMessage = {
        schema_version: CONTRACT_VERSIONS.testRun,
        job_id: jobId,
        account_id: parsed.data.account_id,
        reservation_id: reservationId,
        job_kind: parsed.data.job_kind,
        credits,
        created_at: now,
      };
      await env.JOBS_QUEUE.send(message);
    } catch (error) {
      await releaseJobCredits({
        accountId: parsed.data.account_id,
        jobId,
        reservationId,
      }, env);
      throw error;
    }

    return success(
      {
        job_id: jobId,
        status: "queued",
        reserved_credits: credits,
        admission: decision,
      },
      202,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/v1/dev/shopify-collect") {
    if ((env.ENVIRONMENT as string) !== "local") {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const parsed = ShopifyCollectRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Enter a valid HTTPS Shopify product URL.", 400);
    }

    try {
      const collection = await collectShopifyProduct(parsed.data.product_url);
      const collectionId = crypto.randomUUID();
      await storeCollection(collectionId, collection, env);
      const artifactBase = `/api/v1/dev/collections/${collectionId}/artifacts`;
      const snapshotKinds = new Set(collection.snapshots.map((snapshot) => snapshot.kind));
      return success(
        {
          collection_id: collectionId,
          record: collection.record,
          technical_check: collection.technicalCheck,
          artifact_links: {
            product_record: `${artifactBase}/product-record?download=1`,
            technical_check: `${artifactBase}/technical-check?download=1`,
            evidence_pack: `${artifactBase}/evidence-pack?download=1`,
            ...(snapshotKinds.has("html") ? { html: `${artifactBase}/html?download=1` } : {}),
            ...(snapshotKinds.has("shopify_ajax")
              ? { shopify_ajax: `${artifactBase}/shopify-ajax?download=1` }
              : {}),
            ...(snapshotKinds.has("robots") ? { robots: `${artifactBase}/robots?download=1` } : {}),
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof CollectionError) {
        throw new HttpError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/v1/qualification/shopify-collect") {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const parsed = ShopifyCollectRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Enter a valid HTTPS Shopify product URL.", 400);
    }
    try {
      const collection = await collectShopifyProduct(parsed.data.product_url);
      const collectionId = crypto.randomUUID();
      await storeCollection(collectionId, collection, env);
      return success({
        collection_id: collectionId,
        product_url: collection.record.final_url,
        collection_status: collection.record.collection_status,
        evidence_states: Object.fromEntries(
          Object.entries(collection.record.fields).map(([key, value]) => [key, value.state]),
        ),
      });
    } catch (error) {
      if (error instanceof CollectionError) {
        throw new HttpError(error.code, error.message, error.status);
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/v1/qualification/ai-runs") {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const parsed = FixtureAnalysisRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "AI qualification configuration is invalid.", 400);
    }
    try {
      return success(await createLiveQualificationRun({
        collectionId: parsed.data.collection_id,
        routeKey: parsed.data.route_key,
        reasoningEffort: parsed.data.reasoning_effort,
        targetMarket: parsed.data.target_market,
      }, env), 202);
    } catch (error) {
      if (error instanceof Error && error.message.includes("evidence pack")) {
        return failure("COLLECTION_NOT_FOUND", error.message, 404);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/v1/qualification/ai-runs/")) {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const runId = url.pathname.slice("/api/v1/qualification/ai-runs/".length);
    if (!isUuid(runId)) return failure("NOT_FOUND", "AI run not found.", 404);
    const run = await readAiRun(runId, env);
    return run ? success(run) : failure("NOT_FOUND", "AI run not found.", 404);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/qualification/shopping-sessions") {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const parsed = CreateShoppingSessionRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "Controlled-shopping configuration is invalid.", 400);
    }
    const defaultBudget = {
      max_turns: CONTROLLED_SHOPPING_PROTOCOL.maximum_turns,
      max_model_calls: CONTROLLED_SHOPPING_PROTOCOL.maximum_turns * (4 + MAX_QUERY_REVISIONS * 2),
      max_search_requests: CONTROLLED_SHOPPING_PROTOCOL.maximum_turns * 3,
      max_input_tokens: 240_000,
      max_output_tokens: 66_000,
      max_cost_usd_micros: 3_000_000,
    } as const;
    try {
      return success(await createControlledShoppingSession({
        collectionId: parsed.data.collection_id,
        buyerBrief: parsed.data.buyer_brief,
        targetIdentity: parsed.data.target_identity,
        protocol: CONTROLLED_SHOPPING_PROTOCOL,
        modelPolicies: parsed.data.model_policies ?? DEFAULT_ROLE_POLICIES,
        budget: parsed.data.budget ?? defaultBudget,
        controllerVersion: "explicit-state-machine/2026-09-v4",
      }, env), 201);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Collection does not exist")) {
        return failure("COLLECTION_NOT_FOUND", error.message, 404);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/v1/qualification/paddle/status") {
    if (!(await paddleCatalogAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    return success(await readPaddleCatalogStatus(env));
  }

  if (request.method === "POST" && url.pathname === "/api/v1/qualification/paddle/catalog-sync") {
    if (!(await paddleCatalogAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    return success(await syncPaddleCatalog(env));
  }

  if (request.method === "POST" && url.pathname === "/api/v1/qualification/paddle/reconcile") {
    if (!(await paddleCatalogAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const body = await readBoundedJson(request);
    const eventId = typeof body === "object" && body !== null && "event_id" in body
      ? (body as { event_id?: unknown }).event_id
      : null;
    if (typeof eventId !== "string" || !/^(?:evt|ntfsimevt)_[a-z\d]{26}$/.test(eventId)) {
      return failure("INVALID_REQUEST", "A valid Paddle event ID is required.", 400);
    }
    return success(await reconcilePaddleBillingEvent(eventId, env));
  }

  const shoppingStartMatch = url.pathname.match(
    /^\/api\/v1\/qualification\/shopping-sessions\/([^/]+)\/fixture-start$/,
  );
  if (request.method === "POST" && shoppingStartMatch) {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const sessionId = shoppingStartMatch[1]!;
    if (!isUuid(sessionId)) return failure("NOT_FOUND", "Shopping session not found.", 404);
    return success(await startControlledShoppingSession(sessionId, "fixture", env), 202);
  }

  const shoppingLiveStartMatch = url.pathname.match(
    /^\/api\/v1\/qualification\/shopping-sessions\/([^/]+)\/live-start$/,
  );
  if (request.method === "POST" && shoppingLiveStartMatch) {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const sessionId = shoppingLiveStartMatch[1]!;
    if (!isUuid(sessionId)) return failure("NOT_FOUND", "Shopping session not found.", 404);
    return success(await startControlledShoppingSession(sessionId, "live", env), 202);
  }

  const shoppingReadMatch = url.pathname.match(
    /^\/api\/v1\/qualification\/shopping-sessions\/([^/]+)$/,
  );
  if (request.method === "GET" && shoppingReadMatch) {
    if (!(await qualificationAuthorized(request, env))) {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const sessionId = shoppingReadMatch[1]!;
    if (!isUuid(sessionId)) return failure("NOT_FOUND", "Shopping session not found.", 404);
    const session = await readControlledShoppingSession(sessionId, env);
    return session ? success(session) : failure("NOT_FOUND", "Shopping session not found.", 404);
  }


  if (request.method === "POST" && url.pathname === "/api/v1/dev/ai-runs") {
    if ((env.ENVIRONMENT as string) !== "local") {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const parsed = FixtureAnalysisRequestSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return failure("INVALID_REQUEST", "AI fixture configuration is invalid.", 400);
    }
    try {
      const run = await createFixtureRun(
        {
          collectionId: parsed.data.collection_id,
          routeKey: parsed.data.route_key,
          reasoningEffort: parsed.data.reasoning_effort,
          targetMarket: parsed.data.target_market,
        },
        env,
      );
      return success(run, 202);
    } catch (error) {
      if (error instanceof Error && error.message.includes("evidence pack")) {
        return failure("COLLECTION_NOT_FOUND", error.message, 404);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/v1/dev/ai-runs/")) {
    if ((env.ENVIRONMENT as string) !== "local") {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const runId = url.pathname.slice("/api/v1/dev/ai-runs/".length);
    if (!isUuid(runId)) return failure("NOT_FOUND", "AI run not found.", 404);
    const run = await readAiRun(runId, env);
    return run ? success(run) : failure("NOT_FOUND", "AI run not found.", 404);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/v1/dev/collections/")) {
    if ((env.ENVIRONMENT as string) !== "local") {
      return failure("NOT_FOUND", "Route not found.", 404);
    }
    const match = url.pathname.match(
      /^\/api\/v1\/dev\/collections\/([^/]+)\/artifacts\/([^/]+)$/,
    );
    if (match) {
      const artifact = await serveCollectionArtifact(
        match[1]!,
        match[2]!,
        url.searchParams.get("download") === "1",
        env,
      );
      return artifact ?? failure("NOT_FOUND", "Artifact not found.", 404);
    }
  }

  if (url.pathname.startsWith("/api/")) {
    return failure("NOT_FOUND", "Route not found.", 404);
  }

  return servePublicAssets(request, env);
}

async function routeOwnerStats(request: Request, env: Env): Promise<Response> {
  if (!ownerStatsToken(env)) {
    return failure("NOT_FOUND", "Route not found.", 404);
  }
  const url = new URL(request.url);
  const wantsJson = url.pathname === "/api/v1/owner/stats";
  if (wantsJson && request.method !== "GET") {
    return failure("NOT_FOUND", "Route not found.", 404);
  }
  if (!wantsJson && request.method !== "GET" && request.method !== "POST") {
    return failure("NOT_FOUND", "Route not found.", 404);
  }

  const formToken = request.method === "POST" ? await readOwnerStatsFormToken(request) : null;
  const authorized = await ownerStatsAuthorized(request, env, formToken);
  if (wantsJson) {
    if (!authorized) return failure("UNAUTHORIZED", "Owner stats token required.", 401);
    return withHeaders(success(await readOwnerStatsBoard(env)), { "X-Robots-Tag": "noindex, nofollow" });
  }
  if (!authorized) {
    return ownerStatsResponse(
      renderOwnerStatsPage(null, request.method === "POST" ? { error: "Token rejected." } : undefined),
      request.method === "POST" ? 401 : 200,
    );
  }
  return ownerStatsResponse(renderOwnerStatsPage(await readOwnerStatsBoard(env)));
}

async function qualificationAuthorized(request: Request, env: Env): Promise<boolean> {
  const token = (env as Env & { QUALIFICATION_ADMIN_TOKEN?: string }).QUALIFICATION_ADMIN_TOKEN;
  if ((env.ENVIRONMENT as string) !== "production" || !token) return false;
  return adminTokenAuthorized(request, token);
}

async function paddleCatalogAuthorized(request: Request, env: Env): Promise<boolean> {
  return qualificationAuthorized(request, env);
}

async function adminTokenAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const encoder = new TextEncoder();
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedDigest);
  const actual = new Uint8Array(suppliedDigest);
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ actual[index]!;
  }
  return difference === 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}

function validateProductUrl(rawUrl: string): PreflightResult {
  let url: URL;
  try {
    url = validatePublicProductUrl(rawUrl);
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof CollectionError ? error.message : "The product URL is not supported.",
    };
  }
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const productsIndex = pathSegments.lastIndexOf("products");
  const handle = pathSegments[productsIndex + 1]!;

  return {
    supported: true,
    normalized_url: url.toString(),
    hostname: url.hostname,
    product_handle: handle,
    next_step: "shopify_platform_detection",
  };
}

type PreflightResult = {
  supported: boolean;
  normalized_url?: string;
  hostname?: string;
  product_handle?: string;
  next_step?: "shopify_platform_detection";
  reason?: string;
};

export async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_JSON_BYTES) {
    throw new HttpError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", 415);
  }

  const body = await readBoundedText(request.body, MAX_JSON_BYTES);

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError("INVALID_JSON", "Request body is not valid JSON.", 400);
  }
}

export async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("request body limit exceeded");
        throw new HttpError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export class HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function failure(
  code: string,
  message: string,
  status: number,
  details?: unknown,
  requestId?: string,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      ...(requestId ? { request_id: requestId } : {}),
    },
    status,
  );
}

export function success(data: unknown, status = 200, requestId?: string): Response {
  return jsonResponse(
    {
      data,
      ...(requestId ? { request_id: requestId } : {}),
    },
    status,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: securityHeaders(),
  });
}

function withOptionalCookie(response: Response, cookie?: string): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withHeaders(response: Response, additional: HeadersInit): Response {
  const headers = new Headers(response.headers);
  new Headers(additional).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function securityHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
