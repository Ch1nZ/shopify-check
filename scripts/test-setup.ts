import { beforeEach, afterEach, vi } from 'vitest';
import { modelRuntime, ModelConfigSchema } from '../packages/model-adapters/openrouter/src/runtime';
import models from './test-models.json';
const original = modelRuntime.getStore.bind(modelRuntime);
let restore: (() => void) | undefined;
beforeEach(() => {
  const spy = vi.spyOn(modelRuntime, 'getStore').mockImplementation(() => original() ?? ({ models: ModelConfigSchema.parse(models), secrets: { TEST_MODEL_KEY: 'test-only-placeholder', OWNER_STATS_EXCLUDED_EMAILS: 'operator-test@example.com' } }));
  restore = () => spy.mockRestore();
});
afterEach(() => restore?.());
