import { processDiagnostic, failDiagnostic } from "../src/diagnostic-workflow";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { createAccountSession, reserveJobCredits, releaseJobCredits } from "../src/credits";
import { CreateCustomerTaskRequestSchema } from "@mclab/contracts";
import { createCustomerTask, readCustomerTask } from "../src/customer-tasks";
import { buildReportDiagnosis } from "../src/report-diagnosis";
import { reportInterruption } from "../src/report-interruption";
vi.mock("@mclab/shopify-online-store", async importOriginal => ({
  ...await importOriginal<typeof import("@mclab/shopify-online-store")>(),
  collectShopifyProduct: async () => { throw new Error("upstream unavailable; private details"); },
}));
const testEnv = env as Env & { TEST_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
beforeAll(async () => { await applyD1Migrations(testEnv.TEST_DB, testEnv.TEST_MIGRATIONS); });
it("opens a failed preparation report through its owner, with no session and no false absence", async () => {
  const runtime = { ...env, DB: testEnv.TEST_DB } as Env;
  const now = new Date().toISOString();
  const accountId = crypto.randomUUID(), jobId = crypto.randomUUID(), reservationId = crypto.randomUUID();
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)").bind(accountId, now, now),
    runtime.DB.prepare("INSERT INTO credit_operations (id, account_id, operation_type, external_idempotency_key, credits, status, created_at, updated_at) VALUES (?, ?, 'grant', ?, 100, 'completed', ?, ?)").bind(crypto.randomUUID(), accountId, crypto.randomUUID(), now, now),
    runtime.DB.prepare("INSERT INTO jobs (id, account_id, job_kind, protocol_version, pricing_version, reserved_credits, reservation_id, status, created_at, updated_at) VALUES (?, ?, 'guided_search_premium', 'guided-shopping/1.0', 'test', 30, ?, 'failed', ?, ?)").bind(jobId, accountId, reservationId, now, now),
  ]);
  await reserveJobCredits({ accountId, jobId, reservationId }, runtime);
  await releaseJobCredits({ accountId, jobId, reservationId }, runtime);
  const browser = await createAccountSession(accountId, runtime);
  const request = new Request("https://example.com/api/v1/tasks/" + jobId, { headers: { cookie: browser.setCookie!.split(";")[0]! } });
  const opened = await readCustomerTask(request, jobId, runtime) as { task: { billing_status: string; session: { report: { diagnosis: { outcome: string; observed_result: string }; turns: unknown[] } } } };
  expect(opened.task.billing_status).toBe("released");
  expect(opened.task.session.report.diagnosis.outcome).toBe("inconclusive");
  expect(opened.task.session.report.diagnosis.observed_result).toContain("cannot be determined");
  expect(opened.task.session.report.turns).toEqual([]);
  const stranger = await readCustomerTask(new Request("https://example.com"), jobId, runtime);
  expect(stranger.task).toBeNull();
});
it("an unfinished test cannot become a negative product diagnosis", () => {
  const partial = buildReportDiagnosis({ turns: [], completedTurns: 0, productRecord: null, technicalCheck: null, interruption: reportInterruption("failed_validation") });
  expect(partial.outcome).toBe("inconclusive");
  expect(partial.product_source.description_state).toBe("not_captured");
  expect(partial.next_action.hypothesis).toContain("No product or source change");
});
it("public interruption text never echoes raw vendor errors", () => {
  const result = reportInterruption("incomplete", [{ role: "shopping_observer", status: "incomplete", error_code: "MODEL_TIMEOUT_UNCERTAIN", error_message: "secret-token and private prompt" }]);
  expect(result.explanation).toContain("did not return a confirmed result");
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

it("returns a task and recoverable report when admitted preparation fails", async () => {
  const runtime = { ...env, DB: testEnv.TEST_DB, TASK_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  const now = new Date().toISOString(), accountId = crypto.randomUUID();
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)").bind(accountId, now, now),
    runtime.DB.prepare("INSERT INTO credit_operations (id, account_id, operation_type, external_idempotency_key, credits, status, created_at, updated_at) VALUES (?, ?, 'grant', ?, 100, 'completed', ?, ?)").bind(crypto.randomUUID(), accountId, crypto.randomUUID(), now, now),
  ]);
  const browser = await createAccountSession(accountId, runtime);
  const request = new Request("https://example.com/api/v1/tasks", { headers: { cookie: browser.setCookie!.split(";")[0]! } });
  const started = await createCustomerTask(request, CreateCustomerTaskRequestSchema.parse({ product_url: "https://example.com/products/test", target_market: "Hong Kong", shopping_model_route: "observer", shopping_reasoning_effort: "medium" }), runtime);
  expect(started).toMatchObject({ status: "queued", session_id: null, product_record: null });
  await expect(processDiagnostic({ kind: "diagnostic_advance", job_id: started.task_id }, runtime)).rejects.toThrow("upstream unavailable");
  await failDiagnostic(started.task_id, "Queue retries exhausted.", runtime);
  const result = await readCustomerTask(request, started.task_id, runtime) as { task: { billing_status: string; balance: { available_credits: number }; session: { report: { diagnosis: { outcome: string }; interruption: { stage: string } } } } };
  expect(result.task.billing_status).toBe("released"); expect(result.task.balance.available_credits).toBe(100);
  expect(result.task.session.report.diagnosis.outcome).toBe("inconclusive");
  expect(result.task.session.report.interruption.stage).toBe("Reading the product page");
  expect(JSON.stringify(result)).not.toContain("private details");
});
