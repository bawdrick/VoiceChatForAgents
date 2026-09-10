import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The deployed Worker reads this from a secret; the tests need their own.
      miniflare: { bindings: { VOICE_RELAY_SECRET: "test-secret" } },
    }),
  ],
});
