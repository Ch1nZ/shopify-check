import { CONTRACT_VERSIONS, ModelCapabilitySchema, type ModelRouteKey, type ReasoningEffort } from '@mclab/contracts';
import { configuredModels, endpoint } from './runtime';
export const MODEL_REGISTRY_VERSION = 'operator-configured/1.0';
export function modelCapability(routeKey: ModelRouteKey) {
  const config = endpoint(routeKey);
  return ModelCapabilitySchema.parse({
    schema_version: CONTRACT_VERSIONS.modelCapability,
    registry_version: MODEL_REGISTRY_VERSION,
    route_key: routeKey, display_name: config.model, model_id: config.model,
    provider_order: config.provider_order.length ? config.provider_order : [config.provider],
    supported_reasoning: ['low', 'medium', 'high'], supports_structured_output: true,
    supports_web_search: config.search,
    qualification_status: 'operator_configured', credit_cost: 30,
  });
}
export function modelCapabilities() { return Object.keys(configuredModels()).map(modelCapability); }
export function supportsReasoning(routeKey: ModelRouteKey, effort: ReasoningEffort) { return modelCapability(routeKey).supported_reasoning.includes(effort); }
