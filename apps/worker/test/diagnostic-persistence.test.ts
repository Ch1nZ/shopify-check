import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { DiagnosticCheckpointer } from "../src/diagnostic-checkpointer";
import { createModelJournal, UncertainModelCallError } from "../src/model-journal";
const testEnv = env as typeof env & { TEST_DB: D1Database; TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] };
beforeAll(async () => { await applyD1Migrations(testEnv.TEST_DB, testEnv.TEST_MIGRATIONS); });
describe("durable diagnostic evidence and checkpoints", () => {
  it("continues from D1 using a new graph and saver, without repeating a completed node", async () => {
    const state = Annotation.Root({ value: Annotation<number>() });
    let captures = 0;
    const graph = () => new StateGraph(state)
      .addNode("capture", () => { captures++; return { value: 10 }; })
      .addNode("assess", s => ({ value: s.value + 1 }))
      .addEdge(START, "capture").addEdge("capture", "assess").addEdge("assess", END)
      .compile({ checkpointer: new DiagnosticCheckpointer(testEnv.TEST_DB), interruptAfter: "*" });
    const config = { configurable: { thread_id: crypto.randomUUID() } };
    await graph().invoke({ value: 0 }, config);
    expect((await graph().getState(config)).next).toEqual(["assess"]);
    await graph().invoke(null, config);
    expect((await graph().getState(config)).values.value).toBe(11);
    expect((await graph().getState(config)).next).toEqual([]);
    expect(captures).toBe(1);
    const saver = new DiagnosticCheckpointer(testEnv.TEST_DB);
    const latest = await saver.getTuple(config);
    expect(latest?.parentConfig).toBeDefined();
    const history = [];
    for await (const item of saver.list(config)) history.push(item);
    expect(history.length).toBeGreaterThanOrEqual(3);
  });
  it("reuses successful parallel writes when another node fails", async () => {
    const state = Annotation.Root({ values: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }) });
    let good = 0; let bad = 0;
    const graph = () => new StateGraph(state)
      .addNode("good", () => { good++; return { values: ["captured"] }; })
      .addNode("bad", () => { bad++; if (bad === 1) throw new Error("temporary storage failure"); return { values: ["assessed"] }; })
      .addEdge(START, "good").addEdge(START, "bad").addEdge("good", END).addEdge("bad", END)
      .compile({ checkpointer: new DiagnosticCheckpointer(testEnv.TEST_DB) });
    const config = { configurable: { thread_id: crypto.randomUUID() } };
    await expect(graph().invoke({ values: [] }, config)).rejects.toThrow("temporary storage failure");
    const result = await graph().invoke(null, config);
    expect(result.values.sort()).toEqual(["assessed", "captured"]);
    expect(good).toBe(1); expect(bad).toBe(2);
  });
  it("replays exact provider bytes with usage and never stores credentials", async () => {
    const prefix = `test-journal/${crypto.randomUUID()}`;
    const network = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{broken" } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.02 } }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", network);
    try {
      const args = ["https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer test-secret" }, body: JSON.stringify({ messages: [] }) }] as const;
      const first = createModelJournal(prefix, env);
      const body = await (await first.fetch(...args)).text();
      const recovered = createModelJournal(prefix, env);
      expect(await (await recovered.fetch(...args)).text()).toBe(body);
      expect(network).toHaveBeenCalledTimes(1);
      expect(recovered.usage()).toMatchObject({ model_calls: 1, input_tokens: 10, cost_usd: 0.02 });
      expect(await (await env.EVIDENCE.get(`${prefix}/http/001-request.json`))!.text()).not.toContain("test-secret");
    } finally { vi.unstubAllGlobals(); }
  });
  it("accounts Decisions API token names from Jev responses", async () => {
    const prefix = `test-journal/${crypto.randomUUID()}`;
    const network = vi.fn(async () => new Response(JSON.stringify({
      model: "typesafe/jev-1.13",
      answers: { outcome: { type: "choice", choice: "absent", confidence: 0.9 } },
      usage: { input_tokens: 40, output_tokens: 2, cost: 0.00004 },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", network);
    try {
      const journal = createModelJournal(prefix, env);
      await journal.fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", body: JSON.stringify({ model: "typesafe/jev-1.13" }) });
      expect(journal.usage()).toMatchObject({ model_calls: 1, input_tokens: 40, output_tokens: 2, cost_usd: 0.00004 });
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not send a second request when the first provider outcome is uncertain", async () => {
    const prefix = `test-journal/${crypto.randomUUID()}`;
    const network = vi.fn(async () => { throw new Error("connection lost"); });
    vi.stubGlobal("fetch", network);
    try {
      await expect(createModelJournal(prefix, env).fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow("connection lost");
      await expect(createModelJournal(prefix, env).fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(UncertainModelCallError);
      expect(network).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
