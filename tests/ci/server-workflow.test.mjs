import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/server-ci.yml", import.meta.url),
  "utf8",
);
const gateStep = workflow.split(
  "      - name: Require verified evidence or a successful build and complete suite\n",
)[1];
assert.ok(gateStep, "The release gate must be present");
const gateScript = gateStep
  .split("        run: |\n")[1]
  .split("\n      - name:")[0]
  .split("\n")
  .map((line) => line.replace(/^          /, ""))
  .join("\n");

function runGate(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "server-release-gate-"));
  try {
    return spawnSync("bash", ["-e", "-c", gateScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
        VALIDATION_RESULT: "success",
        REUSED: "false",
        SOURCE_URL: "https://github.com/example/server/actions/runs/1",
        BUILD_RESULT: "success",
        COVERAGE_RESULT: "success",
        ...overrides,
      },
    }).status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("fresh release requires both production build and complete coverage", () => {
  assert.equal(runGate(), 0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    assert.notEqual(runGate({ BUILD_RESULT: result }), 0, `build=${result}`);
    assert.notEqual(runGate({ COVERAGE_RESULT: result }), 0, `coverage=${result}`);
  }
});

test("verified reuse can pass without rerunning the build and coverage", () => {
  assert.equal(
    runGate({ REUSED: "true", BUILD_RESULT: "skipped", COVERAGE_RESULT: "skipped" }),
    0,
  );
  assert.notEqual(
    runGate({ REUSED: "", BUILD_RESULT: "skipped", COVERAGE_RESULT: "skipped" }),
    0,
  );
});

test("a failed or interrupted evidence job cannot release either path", () => {
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    assert.notEqual(runGate({ VALIDATION_RESULT: result }), 0);
    assert.notEqual(runGate({ VALIDATION_RESULT: result, REUSED: "true" }), 0);
  }
});
