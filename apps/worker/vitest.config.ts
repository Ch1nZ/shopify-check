import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import models from "../../scripts/test-models.json";

export default defineConfig({
  test: { setupFiles: ["../../scripts/test-setup.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The test package currently bundles workerd through 2026-08-22.
      // Production keeps the current compatibility date in wrangler.jsonc.
      miniflare: {
        compatibilityDate: "2026-08-22",
        d1Databases: ["DB", "TEST_DB"],
        bindings: { SELF_HOSTED: "false", MODEL_CONFIG: JSON.stringify(models), TEST_MODEL_KEY: "test-only-placeholder", TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../migrations/", import.meta.url))) },
      },
    }),
  ],
});
