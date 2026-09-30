import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/agent-fleet/test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
