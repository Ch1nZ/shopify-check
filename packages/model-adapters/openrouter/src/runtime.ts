import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

export const EndpointSchema = z.object({
  provider: z.enum(['openai', 'google', 'anthropic', 'openrouter', 'openai-compatible']),
  model: z.string().min(1),
  key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  base_url: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'Use a public HTTPS endpoint without credentials or query parameters.').optional(),
  search: z.boolean().default(false),
  provider_order: z.array(z.string()).default([]),
  provider_options: z.record(z.string(), z.record(z.string(), z.json())).default({}),
});
export const ModelConfigSchema = z.record(z.string(), EndpointSchema);
export type Endpoint = z.infer<typeof EndpointSchema>;
type Runtime = { models: z.infer<typeof ModelConfigSchema>; secrets: Record<string, unknown> };
export const modelRuntime = new AsyncLocalStorage<Runtime>();
export function withModelRuntime<T>(env: object, run: () => T): T {
  const secrets = env as Record<string, unknown>;
  let models: Runtime['models'] = {};
  if (typeof secrets.MODEL_CONFIG === 'string' && secrets.MODEL_CONFIG.trim()) {
    try { models = ModelConfigSchema.parse(JSON.parse(secrets.MODEL_CONFIG)); }
    catch { throw new Error('Invalid MODEL_CONFIG. Check the server-side model configuration.'); }
  }
  return modelRuntime.run({ models, secrets }, run);
}
export function configuredModels() { return modelRuntime.getStore()?.models ?? {}; }
export function endpoint(route: string): Endpoint {
  const config = configuredModels()[route];
  if (!config) throw new Error(`Configure the ${route} model route before running an AI diagnostic.`);
  return config;
}
export function endpointKey(config: Endpoint): string {
  const value = modelRuntime.getStore()?.secrets[config.key_env];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing server-side credential ${config.key_env}.`);
  return value;
}
export function validateDiagnosticModels(): void {
  for (const route of ['planner', 'observer', 'synthesizer']) {
    const config = endpoint(route); endpointKey(config);
    if (config.model.includes('REPLACE_')) throw new Error('Select your own model before running a diagnostic.');
    if (route === 'observer' && (!config.search || config.provider === 'openai-compatible')) {
      throw new Error('The observer must use a configured native-search provider: openai, google, anthropic or openrouter.');
    }
  }
}

export function configuredOwnerExclusions(): string { const value = modelRuntime.getStore()?.secrets.OWNER_STATS_EXCLUDED_EMAILS; return typeof value === "string" ? value : ""; }
