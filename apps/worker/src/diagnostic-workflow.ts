import { isSelfHosted, SELF_HOST_ACCOUNT } from "./self-host";
import { validateDiagnosticModels } from "@mclab/openrouter-adapter";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { CONTRACT_VERSIONS, type BuyerBrief, type CreateCustomerTaskRequest, type ShoppingQueueMessage } from "@mclab/contracts";
import { ADAPTIVE_SHOPPING_PROTOCOL } from "@mclab/domain";
import { collectShopifyProduct, type ProductRecord, type ShopifyCollection } from "@mclab/shopify-online-store";
import { DiagnosticCheckpointer } from "./diagnostic-checkpointer";
import { COMPLETE_TASK_CREDITS, ensureBrowserSession, reserveJobCredits, releaseJobCredits } from "./credits";
import { recordFreeCheckAdmission, readFreeCheckOffer } from "./free-check";
import { recordOwnerProductAttempt } from "./owner-stats";
import { CustomerTaskError, CUSTOMER_BUDGET, categoryFromProductRecord, customerPolicies, generateBuyerBrief, mergeBuyerBrief, prepareDirectRetrieval, targetIdentityFromRecord } from "./customer-tasks";
import { storeCollection } from "./collection-storage";
import { createControlledShoppingSession } from "./shopping-sessions";
import { failControlledShoppingSession, processLiveRoleCall, processShoppingAdvance, startControlledShoppingSession, type ShoppingScheduler } from "./shopping-orchestrator";

export type DiagnosticMessage = { kind: "diagnostic_advance"; job_id: string };
type Input = { jobId: string; accountId: string; reservationId: string; collectionId: string; sessionId: string; request: CreateCustomerTaskRequest };
// Checkpoints contain routing and artifact identifiers only. Model contexts are
// constructed by each existing role's allow-list, never from the graph state.
const State = Annotation.Root({ jobId: Annotation<string>(), message: Annotation<ShoppingQueueMessage | null>(), delay: Annotation<number>() });
export async function admitDiagnostic(request: Request, input: CreateCustomerTaskRequest, env: Env) {
  try { validateDiagnosticModels(); } catch { throw new CustomerTaskError("MODEL_CONFIGURATION_REQUIRED", "Configure your server-side model routes and credentials before starting a diagnostic.", 503); }
  const browser = await ensureBrowserSession(request, env);
  if (isSelfHosted(env) && browser.accountId !== SELF_HOST_ACCOUNT) throw new CustomerTaskError("OPERATOR_REQUIRED", "Sign in with your operator access token before starting a diagnostic.", 403);
  if (!(await env.TASK_RATE_LIMITER.limit({ key: browser.accountId })).success) throw new CustomerTaskError("RATE_LIMITED", "Too many task attempts. Try again shortly.", 429);
  const offer = await readFreeCheckOffer(browser.accountId, env);
  if (offer.granted && offer.remaining === 1) {
    if (!(await env.TASK_RATE_LIMITER.limit({ key: `trial:${browser.accountId}` })).success) {
      throw new CustomerTaskError("RATE_LIMITED", "Too many free Self-Check attempts. Try again shortly.", 429);
    }
  }
  const ids: Input = { jobId: crypto.randomUUID(), accountId: browser.accountId, reservationId: crypto.randomUUID(), collectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), request: input };
  const admitted = await reserveJobCredits({ accountId: ids.accountId, jobId: ids.jobId, reservationId: ids.reservationId, credits: COMPLETE_TASK_CREDITS }, env);
  if (!admitted.admitted) throw new CustomerTaskError("PAYMENT_REQUIRED", "Not enough MC Test Credits.", 402);
  const now = new Date().toISOString();
  try {
    await env.EVIDENCE.put(`jobs/${ids.jobId}/workflow-input.json`, JSON.stringify(ids));
    await env.EVIDENCE.put(`jobs/${ids.jobId}/preparation.json`, JSON.stringify({ stage: "Reading the product page", product_url: input.product_url, target_market: input.target_market, collection_id: ids.collectionId }));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO jobs (id, account_id, job_kind, protocol_version, pricing_version, reserved_credits, reservation_id, status, created_at, updated_at) VALUES (?, ?, 'guided_search_premium', ?, ?, ?, ?, 'collecting', ?, ?)`).bind(ids.jobId, ids.accountId, CONTRACT_VERSIONS.guidedShopping, env.PRICING_VERSION, COMPLETE_TASK_CREDITS, ids.reservationId, now, now),
      env.DB.prepare(`INSERT INTO diagnostic_workflows (job_id, input_key, status, next_run_at, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)`).bind(ids.jobId, `jobs/${ids.jobId}/workflow-input.json`, now, now, now),
    ]);
    await recordFreeCheckAdmission({
      accountId: ids.accountId,
      jobId: ids.jobId,
      reservationId: ids.reservationId,
    }, env);
    await recordOwnerProductAttempt({
      accountId: ids.accountId,
      jobId: ids.jobId,
      source: "diagnostic",
      billingKind: offer.granted && offer.remaining === 1 ? "free_check" : "paid",
      productUrl: input.product_url,
    }, env);
  } catch (error) {
    await releaseJobCredits({ accountId: ids.accountId, jobId: ids.jobId, reservationId: ids.reservationId }, env);
    throw error;
  }
  // The committed workflow is also the outbox: cron recovers an enqueue failure.
  try { await env.JOBS_QUEUE.send({ kind: "diagnostic_advance", job_id: ids.jobId }); } catch { /* recovered from D1 */ }
  return { task_id: ids.jobId, session_id: null, collection_id: null, status: "queued" as const, reserved_credits: COMPLETE_TASK_CREDITS, technical_check: null, product_record: null, ...(browser.setCookie ? { set_cookie: browser.setCookie } : {}) };
}

async function read<T>(key: string, env: Env): Promise<T> {
  const object = await env.EVIDENCE.get(key);
  if (!object) throw new Error(`Missing diagnostic artifact: ${key}`);
  return object.json<T>();
}
function advance(sessionId: string): ShoppingQueueMessage {
  return { schema_version: CONTRACT_VERSIONS.guidedShopping, kind: "shopping_advance", session_id: sessionId, execution_mode: "live", created_at: new Date().toISOString() };
}
export function diagnosticGraph(env: Env) {
  const input = (state: typeof State.State) => read<Input>(`jobs/${state.jobId}/workflow-input.json`, env);
  const record = (i: Input) => read<ProductRecord>(`collections/${i.collectionId}/product-record.json`, env);
  const brief = (i: Input) => read<BuyerBrief>(`jobs/${i.jobId}/buyer-brief.json`, env);
  const progress = async (i: Input, stage: string) => { await env.EVIDENCE.put(`jobs/${i.jobId}/preparation.json`, JSON.stringify({ stage, product_url: i.request.product_url, target_market: i.request.target_market, collection_id: i.collectionId })); };
  const shoppingStage = (message: ShoppingQueueMessage) => {
    if (message.kind === "shopping_advance") return "Planning the next shopping step";
    return ({
      query_generator: "Preparing the next buyer question",
      query_auditor: "Checking the next buyer question",
      shopping_observer: "Getting a shopping answer",
      result_classifier: "Assessing the captured shopping answer",
    } as Record<string, string>)[message.role] ?? "Running the shopping conversation";
  };
  // Resume-from-session tests may lack workflow-input; only refresh stage when preparation already exists.
  const markShoppingProgress = async (jobId: string, stage: string) => {
    const key = `jobs/${jobId}/preparation.json`;
    const existing = await env.EVIDENCE.get(key);
    if (!existing) return;
    const preparation = await existing.json<Record<string, unknown>>();
    await env.EVIDENCE.put(key, JSON.stringify({ ...preparation, stage }));
  };
  const step = async (state: typeof State.State) => {
    if (!state.message) return { message: null, delay: 0 };
    await markShoppingProgress(state.jobId, shoppingStage(state.message));
    let next: ShoppingQueueMessage | null = null;
    let delay = 0;
    const schedule: ShoppingScheduler = async (message, options) => { next = message; delay = options?.delaySeconds ?? 0; };
    if (state.message.kind === "shopping_role_call") {
      await processLiveRoleCall(state.message, env, schedule);
      // A role may have committed its projection just before worker loss.
      // Advancing from that projection avoids replaying the provider request.
      if (!next) next = advance(state.message.session_id);
    } else await processShoppingAdvance(state.message, env, schedule);
    return { message: next, delay };
  };
  const route = (state: typeof State.State) => !state.message ? END : state.message.kind === "shopping_advance" ? "advance" : state.message.role;
  return new StateGraph(State)
    .addNode("collect", async state => {
      const i = await input(state);
      if (!(await env.DB.prepare("SELECT id FROM collection_runs WHERE id = ?").bind(i.collectionId).first())) {
        const key = `jobs/${i.jobId}/collection.json`;
        const cached = await env.EVIDENCE.get(key);
        const collection = cached ? await cached.json<ShopifyCollection>() : await collectShopifyProduct(i.request.product_url);
        if (!cached) await env.EVIDENCE.put(key, JSON.stringify(collection));
        await storeCollection(i.collectionId, collection, env);
      }
      return {};
    })
    .addNode("understand", async state => {
      const i = await input(state); const product = await record(i);
      await progress(i, "Understanding the product and buyer needs");
      if (!i.request.category && !categoryFromProductRecord(product)) throw new Error("CATEGORY_REQUIRED");
      const generated = await generateBuyerBrief({ record: product, targetMarket: i.request.target_market, collectionId: i.collectionId, jobId: i.jobId, recover: true }, env);
      await env.EVIDENCE.put(`jobs/${i.jobId}/buyer-brief.json`, JSON.stringify(mergeBuyerBrief(generated, i.request)));
      return {};
    })
    .addNode("retrieval", async state => {
      const i = await input(state); const product = await record(i);
      await progress(i, "Checking the product by name");
      await prepareDirectRetrieval({ record: product, collectionId: i.collectionId, buyerBrief: await brief(i), targetIdentity: targetIdentityFromRecord(product), input: i.request, recover: true }, env);
      return {};
    })
    .addNode("session", async state => {
      const i = await input(state);
      await progress(i, "Starting the shopping conversation");
      await createControlledShoppingSession({ sessionId: i.sessionId, collectionId: i.collectionId, accountId: i.accountId, jobId: i.jobId, creditReservationId: i.reservationId, buyerBrief: await brief(i), targetIdentity: targetIdentityFromRecord(await record(i)), protocol: { ...ADAPTIVE_SHOPPING_PROTOCOL, protocol_revision: "2026-09-langgraph-v1" }, modelPolicies: customerPolicies(i.request), budget: CUSTOMER_BUDGET, controllerVersion: "langgraph-diagnostic/1.0" }, env);
      let message: ShoppingQueueMessage = advance(i.sessionId);
      await startControlledShoppingSession(i.sessionId, "live", env, async next => { message = next; });
      await env.DB.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'collecting'").bind(new Date().toISOString(), i.jobId).run();
      return { message, delay: 0 };
    })
    .addNode("advance", step).addNode("query_generator", step).addNode("query_auditor", step).addNode("shopping_observer", step).addNode("result_classifier", step)
    .addEdge(START, "collect").addEdge("collect", "understand").addEdge("understand", "retrieval").addEdge("retrieval", "session")
    .addConditionalEdges("session", route).addConditionalEdges("advance", route).addConditionalEdges("query_generator", route).addConditionalEdges("query_auditor", route).addConditionalEdges("shopping_observer", route).addConditionalEdges("result_classifier", route)
    .compile({ checkpointer: new DiagnosticCheckpointer(env.DB), interruptAfter: "*" });
}

// Run several zero-delay graph nodes in one queue wake to cut scheduling
// overhead. Stop for rate-limit delays, wake budgets, or terminal completion.
export const MAX_DIAGNOSTIC_STEPS_PER_WAKE = 8;
export const MAX_DIAGNOSTIC_WAKE_WALL_MS = 90_000;
/** Must exceed the slowest bounded node (search observer or product research). */
export const DIAGNOSTIC_LEASE_MS = 5 * 60_000;

export async function processDiagnostic(message: DiagnosticMessage, env: Env) {
  const now = new Date().toISOString(); const token = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE diagnostic_workflows SET status = 'running', step_attempts = step_attempts + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running') AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?)`)
    .bind(token, new Date(Date.now() + DIAGNOSTIC_LEASE_MS).toISOString(), now, message.job_id, now, now).run();
  if (claim.meta.changes !== 1) return;
  try {
    const attempt = await env.DB.prepare("SELECT step_attempts FROM diagnostic_workflows WHERE job_id = ?").bind(message.job_id).first<{ step_attempts: number }>();
    if ((attempt?.step_attempts ?? 0) > 3) { await failDiagnostic(message.job_id, "Diagnostic step recovery limit reached.", env); return; }
    const graph = diagnosticGraph(env); const config = { configurable: { thread_id: message.job_id }, recursionLimit: 100 };
    const wakeStarted = Date.now();
    let steps = 0;
    let delay = 0;
    let done = false;
    while (true) {
      const prior = await graph.getState(config);
      await graph.invoke(prior.createdAt ? null : { jobId: message.job_id, message: null, delay: 0 }, config);
      const current = await graph.getState(config);
      delay = (current.values as typeof State.State).delay ?? 0;
      done = current.next.length === 0;
      steps += 1;
      if (done || delay > 0) break;
      if (steps >= MAX_DIAGNOSTIC_STEPS_PER_WAKE) break;
      if (Date.now() - wakeStarted >= MAX_DIAGNOSTIC_WAKE_WALL_MS) break;
    }
    await env.DB.prepare(`UPDATE diagnostic_workflows SET status = ?, step_attempts = 0, next_run_at = ?, updated_at = ? WHERE job_id = ? AND lease_token = ?`)
      .bind(done ? "completed" : "queued", new Date(Date.now() + delay * 1000).toISOString(), new Date().toISOString(), message.job_id, token).run();
    if (!done) {
      // Release before enqueue so a fast consumer can claim the next checkpoint.
      await env.DB.prepare("UPDATE diagnostic_workflows SET lease_token = NULL, lease_until = NULL WHERE job_id = ? AND lease_token = ?").bind(message.job_id, token).run();
      try { await env.JOBS_QUEUE.send(message, { delaySeconds: delay }); } catch { /* committed checkpoint recovered by cron */ }
    }
  } finally {
    await env.DB.prepare("UPDATE diagnostic_workflows SET lease_token = NULL, lease_until = NULL WHERE job_id = ? AND lease_token = ?").bind(message.job_id, token).run();
  }
}
export async function failDiagnostic(jobId: string, reason: string, env: Env) {
  const i = await read<Input>(`jobs/${jobId}/workflow-input.json`, env);
  const session = await env.DB.prepare("SELECT id FROM shopping_sessions WHERE id = ?").bind(i.sessionId).first();
  if (session) await failControlledShoppingSession(i.sessionId, reason, env);
  else {
    await releaseJobCredits({ accountId: i.accountId, jobId, reservationId: i.reservationId }, env);
    await env.DB.prepare("UPDATE jobs SET status = 'failed', updated_at = ?, completed_at = ? WHERE id = ? AND status != 'completed'").bind(new Date().toISOString(), new Date().toISOString(), jobId).run();
  }
  await env.DB.prepare("UPDATE diagnostic_workflows SET status = 'failed', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE job_id = ?").bind(new Date().toISOString(), jobId).run();
}
export async function recoverDiagnostics(env: Env) {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare("SELECT job_id FROM diagnostic_workflows WHERE status IN ('queued', 'running') AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?) LIMIT 50").bind(now, now).all<{ job_id: string }>();
  for (const row of rows.results) await env.JOBS_QUEUE.send({ kind: "diagnostic_advance", job_id: row.job_id });
  return rows.results.length;
}
