import type { ModelExecution, ShoppingRoleUsage } from "@mclab/openrouter-adapter";

const MAX_RESPONSE_BYTES = 2_000_000;

type CapturedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export class UncertainModelCallError extends Error {
  constructor() {
    super("A recorded provider request has no complete response; it will not be sent again automatically.");
    this.name = "UncertainModelCallError";
  }
}

/** Replays provider bytes, not another model call, after a worker restart. */
export function createModelJournal(prefix: string, env: Env, recover = true): ModelExecution {
  const captures: CapturedResponse[] = [];
  let sequence = 0;
  let issued = 0;
  return {
    recover,
    fetch: async (resource, options) => {
      sequence += 1;
      const key = `${prefix}/http/${String(sequence).padStart(3, "0")}`;
      const request = new Request(resource, options);
      const body = await request.clone().text();
      const journalUrl = new URL(request.url);
      for (const key of ["key", "api_key", "token", "access_token"]) journalUrl.searchParams.delete(key);
      const descriptor = JSON.stringify({ method: request.method, url: journalUrl.toString(), body });
      const requestObject = await env.EVIDENCE.get(`${key}-request.json`);
      if (requestObject) {
        if (await requestObject.text() !== descriptor) throw new Error("Recorded model request changed during recovery.");
        issued += 1;
        const responseObject = await env.EVIDENCE.get(`${key}-response.json`);
        if (!responseObject) throw new UncertainModelCallError();
        if (responseObject.size > MAX_RESPONSE_BYTES * 3) throw new Error("Recorded model response exceeds the capture limit.");
        const captured = JSON.parse(await responseObject.text()) as CapturedResponse;
        captures.push(captured);
        return new Response(captured.body, { status: captured.status, headers: captured.headers });
      }
      // The marker is written before network I/O. A lost response must never
      // become an invisible duplicate search or charge on queue redelivery.
      await env.EVIDENCE.put(`${key}-request.json`, descriptor, { httpMetadata: { contentType: "application/json" } });
      issued += 1;
      const response = await fetch(request);
      const responseBody = await readBoundedBody(response);
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "retry-after", "x-request-id"]) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      const captured = { status: response.status, headers, body: responseBody };
      await env.EVIDENCE.put(`${key}-response.json`, JSON.stringify(captured), { httpMetadata: { contentType: "application/json" } });
      captures.push(captured);
      return new Response(responseBody, { status: response.status, headers });
    },
    usage: () => {
      const usage = aggregateCapturedUsage(captures);
      return { ...usage, model_calls: issued, cost_usd: issued > captures.length ? null : usage.cost_usd };
    },
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    length += chunk.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Provider response exceeds the bounded evidence capture limit.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function aggregateCapturedUsage(captures: CapturedResponse[]): ShoppingRoleUsage & { model_calls: number } {
  const total: ShoppingRoleUsage & { model_calls: number } = {
    model_calls: captures.length, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    total_tokens: 0, cost_usd: 0, web_search_requests: 0,
  };
  for (const capture of captures) {
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(capture.body) as Record<string, unknown>; } catch { /* Retain bytes even when the provider returned invalid JSON. */ }
    const usage = object(value.usage);
    const details = object(usage.completion_tokens_details);
    total.input_tokens += number(usage.prompt_tokens) || number(usage.input_tokens);
    total.output_tokens += number(usage.completion_tokens) || number(usage.output_tokens);
    total.reasoning_tokens += number(details.reasoning_tokens);
    total.total_tokens += number(usage.total_tokens) || (number(usage.input_tokens) + number(usage.output_tokens));
    total.web_search_requests += number(object(usage.server_tool_use).web_search_requests);
    // A rejected HTTP request has no completed model usage. A successful
    // response without a bill remains explicitly unpriced, never zero-priced.
    if (capture.status >= 200 && capture.status < 300) {
      if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) total.cost_usd = null;
      else if (total.cost_usd !== null) total.cost_usd += usage.cost;
    }
  }
  return total;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
