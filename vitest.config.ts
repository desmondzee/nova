import { defineConfig } from "vitest/config";

// Most tests here run a real `compileApp`, which builds several `ts.Program`s over the
// fixture tsconfig; under parallel load that is comfortably past vitest's 5s default,
// and a timeout there is a slow machine rather than a failing assertion.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
