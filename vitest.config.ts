import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          GOVERNOR_API_TOKEN: "synthetic-test-token",
          MAX_CORE_SCHEMA: readFileSync(
            new URL("./max-core/storage/schema.sql", import.meta.url),
            "utf8",
          ),
          TEST_MIGRATIONS: await readD1Migrations(
            "./apps/worker/d1/migrations",
          ),
        },
      },
    }),
  ],
  test: {
    include: [
      "apps/worker/test/**/*.test.ts",
      "apps/pages/src/api/__tests__/**/*.test.ts",
    ],
  },
});
