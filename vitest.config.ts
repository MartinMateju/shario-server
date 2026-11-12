import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("./src"),
      "@/tests": resolve("./tests"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
    setupFiles: ["./tests/helpers/setup.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",

      /*
       * An explicit source inventory makes untouched modules appear at 0%
       * instead of silently disappearing from the report.
       */
      include: ["src/**/*.{ts,tsx}"],

      /*
       * Exclude only files without independently testable runtime behavior:
       * type declarations, re-export barrels, and process/CLI bootstraps.
       * Application routes, models, repositories, services and utilities all
       * remain in the denominator even when no test imports them.
       */
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.types.ts",
        "src/**/index.ts",
        "src/server.ts",
        "src/workers/**/*.ts",
        "src/**/scripts/**/*.ts",
      ],

      reporter: ["text", "json-summary", "lcov"],
      /*
       * Begin with floors just below the measured whole-source baseline. Raise
       * them as zero-coverage runtime modules receive tests.
       */
      thresholds: {
        lines: 34,
        statements: 34,
        functions: 28,
        branches: 28,
      },
      reportsDirectory: "coverage",
      clean: true,
      reportOnFailure: true,
    },
  },
});
