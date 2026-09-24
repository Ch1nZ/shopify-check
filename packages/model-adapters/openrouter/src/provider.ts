import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel, ToolSet } from 'ai';
import type { ModelRolePolicy } from '@mclab/contracts';
import { endpoint, endpointKey } from './runtime';

export function providerFor(policy: ModelRolePolicy, fetcher?: typeof fetch, structured = false): { model: LanguageModel; tools?: ToolSet; providerOptions: ReturnType<typeof endpoint>['provider_options'] } {
  const config = endpoint(policy.route_key);
  const options = { apiKey: endpointKey(config), ...(config.base_url ? { baseURL: config.base_url } : {}), ...(fetcher ? { fetch: fetcher } : {}) };
  const searching = policy.search.enabled;
  if (searching && !config.search) throw new Error(`Search is not enabled for ${policy.route_key}.`);
  let model: LanguageModel;
  let tools: ToolSet | undefined;
  if (config.provider === 'openai') {
    const provider = createOpenAI(options); model = provider.responses(config.model);
    if (searching) tools = { web_search: provider.tools.webSearch({}) };
  } else if (config.provider === 'google') {
    const provider = createGoogleGenerativeAI(options); model = provider(config.model);
    if (searching) tools = { google_search: provider.tools.googleSearch({}) };
  } else if (config.provider === 'anthropic') {
    const provider = createAnthropic(options); model = provider(config.model);
    if (searching) tools = { web_search: provider.tools.webSearch_20250305({ maxUses: policy.search.max_search_requests ?? 1 }) };
  } else if (config.provider === 'openrouter') {
    const provider = createOpenRouter(options);
    model = provider(config.model, {
      reasoning: { effort: policy.reasoning_effort, exclude: true },
      provider: { ...(config.provider_order.length ? { order: config.provider_order } : {}), allow_fallbacks: false, require_parameters: true, data_collection: 'deny' },
      ...(structured ? { structuredOutputs: { strict: true } } : {}),
    });
    if (searching) tools = { web_search: provider.tools.webSearch({ engine: policy.search.engine ?? 'native', maxResults: policy.search.max_total_results ?? 5 }) };
  } else {
    if (!config.base_url) throw new Error('An OpenAI-compatible endpoint requires base_url.');
    if (searching) throw new Error('OpenAI-compatible routes do not have a portable native-search protocol. Choose a native-search provider for observer/research.');
    const provider = createOpenAICompatible({ ...options, baseURL: config.base_url, name: 'operator-endpoint' }); model = provider(config.model);
  }
  return { model, ...(tools ? { tools } : {}), providerOptions: config.provider_options };
}
