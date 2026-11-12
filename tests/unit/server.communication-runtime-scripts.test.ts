import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("communication worker production scripts", () => {
  it("builds a runnable dist tree and keeps tsx only for development commands", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const buildConfig = JSON.parse(
      readFileSync("tsconfig.build.json", "utf8"),
    );

    expect(buildConfig.compilerOptions).toMatchObject({
      rootDir: "src",
      outDir: "dist",
      noEmitOnError: true,
    });
    expect(packageJson.scripts.build).toContain("tsc-alias");
    expect(packageJson.scripts["worker:communication-emails"]).toBe(
      "node dist/workers/communication-email.worker.js",
    );
    expect(packageJson.scripts["worker:communication-scheduler"]).toBe(
      "node dist/workers/communication-automation-scheduler.worker.js",
    );
    expect(packageJson.scripts["migration:communication-email-idempotency"])
      .toBe(
        "node dist/modules/communication-email-logs/scripts/migrate-communication-email-log-idempotency.js",
      );
    expect(packageJson.scripts["worker:communication-emails:dev"]).toContain(
      "tsx src/",
    );
  });
});
