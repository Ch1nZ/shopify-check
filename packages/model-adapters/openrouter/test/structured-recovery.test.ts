import { expect, it } from "vitest";
import { z } from "zod";
import { runStructuredRole, StructuredRoleError, type ModelExecution } from "../src";
const policy = { role: "result_classifier", route_key: "planner", reasoning_effort: "medium", search: { enabled: false }, max_output_tokens: 500, max_call_cost_usd_micros: 50000, max_retries: 0, allow_provider_fallback: false } as const;
function provider(drafts: string[]) {
  const bodies: string[] = [];
  const execution: ModelExecution = { recover: true, fetch: async (_url, options) => {
    bodies.push(String(options?.body));
    return new Response(JSON.stringify({ id: "recorded-test", object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: drafts[Math.min(bodies.length - 1, drafts.length - 1)] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.01 } }), { headers: { "content-type": "application/json" } });
  }, usage: () => ({ model_calls: bodies.length, input_tokens: bodies.length * 10, output_tokens: bodies.length * 5, total_tokens: bodies.length * 15, reasoning_tokens: 0, cost_usd: bodies.length * 0.01, web_search_requests: 0 }) };
  return { execution, bodies };
}
it("repairs malformed provider output through the actual SDK and counts every attempt", async () => {
  const { execution, bodies } = provider(['{"decision":', '{"decision":"supported"}']);
  const result = await runStructuredRole({ apiKey: "test", policy, execution, schema: z.object({ decision: z.enum(["supported", "unknown"]) }), prompt: "Only supplied evidence is allowed." });
  expect(result.output).toEqual({ decision: "supported" });
  expect(result.recovery?.resolution).toBe("repaired");
  expect(result.model_calls).toBe(2); expect(result.usage.cost_usd).toBe(0.02);
  expect(bodies[1]).toContain("Validation feedback");
  expect(bodies.every(body => !JSON.parse(body).tools)).toBe(true);
});
it("stops after three failed structures rather than starting an unbounded agent loop", async () => {
  const { execution, bodies } = provider(['{"decision":"invented"}']);
  await expect(runStructuredRole({ apiKey: "test", policy, execution, schema: z.object({ decision: z.enum(["supported", "unknown"]) }), prompt: "Only supplied evidence is allowed." })).rejects.toBeInstanceOf(StructuredRoleError);
  expect(bodies).toHaveLength(3);
});
it("repairs unsupported evidence at the same role boundary", async () => {
  const { execution, bodies } = provider(['{"quote":"invented"}', '{"quote":"source text"}']);
  const result = await runStructuredRole({ apiKey: "test", policy, execution, schema: z.object({ quote: z.string() }), prompt: "Evidence: source text", validate: output => { if (output.quote !== "source text") throw new Error("Quote is absent from the captured answer"); } });
  expect(result.output.quote).toBe("source text"); expect(bodies).toHaveLength(2);
});
