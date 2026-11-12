import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

const READY_MARKER = "__SHARIO_DEV_RUNNER_READY__:";

const countReadyMarkers = (output: string): number =>
  output.split(READY_MARKER).length - 1;

const waitForReadyCount = (
  runner: ChildProcess,
  getOutput: () => string,
  expectedCount: number,
  timeoutMs: number,
): Promise<void> => {
  const stdout = runner.stdout;
  const stderr = runner.stderr;
  if (!stdout || !stderr) {
    return Promise.reject(new Error("Dev-runner output was not piped."));
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      stdout.off("data", checkOutput);
      stderr.off("data", checkOutput);
      runner.off("error", handleError);
      runner.off("exit", handleExit);
    };

    const succeed = (): void => {
      cleanup();
      resolve();
    };

    const checkOutput = (): void => {
      if (countReadyMarkers(getOutput()) >= expectedCount) succeed();
    };

    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const handleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      reject(
        new Error(
          `Dev runner exited before ready marker ${expectedCount} ` +
            `(code=${code ?? "null"}, signal=${signal ?? "null"}).\n` +
            getOutput(),
        ),
      );
    };

    stdout.on("data", checkOutput);
    stderr.on("data", checkOutput);
    runner.once("error", handleError);
    runner.once("exit", handleExit);
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ready marker ${expectedCount}.\n${getOutput()}`,
        ),
      );
    }, timeoutMs);

    checkOutput();
  });
};

const stopProcessTree = async (runner: ChildProcess): Promise<void> => {
  if (
    !runner.pid ||
    runner.exitCode !== null ||
    runner.signalCode !== null
  ) {
    return;
  }

  const exited = new Promise<void>((resolveExit) => {
    runner.once("exit", () => resolveExit());
  });

  if (process.platform === "win32") {
    spawnSync(
      "taskkill",
      ["/PID", String(runner.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
  } else {
    try {
      process.kill(-runner.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        runner.kill("SIGKILL");
      }
    }
  }

  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => {
      const timeout = setTimeout(resolveTimeout, 2_000);
      timeout.unref();
    }),
  ]);
};

describe("data import local runtime", () => {
  it("starts bounded API and worker watchers from the default dev command", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    const devRunner = readFileSync(
      new URL("../../../scripts/dev.mjs", import.meta.url),
      "utf8",
    );
    const nodeVersion = readFileSync(
      new URL("../../../.nvmrc", import.meta.url),
      "utf8",
    ).trim();

    expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
    expect(packageJson.scripts["dev:api"]).toBe(
      "tsx watch --clear-screen=false src/server.ts",
    );
    expect(packageJson.devDependencies.tsx).toBe("4.22.4");
    expect(packageJson.engines.node).toBe(">=22 <23");
    expect(nodeVersion).toBe("22");

    expect(devRunner).toContain(
      'createRequire(import.meta.url).resolve("tsx/cli")',
    );
    expect(devRunner).toContain(
      '[tsxCli, "watch", "--clear-screen=false", entrypoint]',
    );
    expect(devRunner).toContain('entrypoint: "src/server.ts"');
    expect(devRunner).toContain(
      'entrypoint: "src/workers/data-import.worker.ts"',
    );
    expect(devRunner).toContain("FORCE_EXIT_AFTER_MS = 7_000");
    expect(devRunner).toContain('SHUTDOWN_DRAIN_TIMEOUT_MS || "2500"');
    expect(devRunner).toContain('SHUTDOWN_CLEANUP_TIMEOUT_MS || "1500"');
    expect(devRunner).not.toContain(
      '["--watch", "--import", "tsx", entrypoint]',
    );
  });

  it(
    "force-restarts a watched process that does not finish graceful shutdown",
    { timeout: 30_000 },
    async () => {
      const runtimeDirectory = mkdtempSync(
        join(tmpdir(), "shario-dev-runner-"),
      );
      const fixturePath = join(runtimeDirectory, "blocking-process.mjs");
      const harnessPath = join(runtimeDirectory, "dev-runner-harness.mjs");
      const devRunnerUrl = new URL(
        "../../../scripts/dev.mjs",
        import.meta.url,
      ).href;
      let runner: ChildProcess | undefined;

      try {
        writeFileSync(
          fixturePath,
          [
            `process.stdout.write("${READY_MARKER}" + process.pid + "\\n");`,
            "setInterval(() => {}, 1_000);",
            'process.once("SIGTERM", () => {',
            '  process.stdout.write("__SHARIO_DEV_RUNNER_IGNORED_SIGTERM__:" + process.pid + "\\n");',
            "});",
            "",
          ].join("\n"),
        );
        writeFileSync(
          harnessPath,
          [
            `import { runDevProcesses } from ${JSON.stringify(devRunnerUrl)};`,
            "",
            `runDevProcesses({ processes: ${JSON.stringify([
              { name: "restart-fixture", entrypoint: fixturePath },
            ])} });`,
            "",
          ].join("\n"),
        );

        runner = spawn(process.execPath, [harnessPath], {
          cwd: new URL("../../../", import.meta.url),
          detached: process.platform !== "win32",
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let output = "";
        const capture = (chunk: Buffer | string): void => {
          output += chunk.toString();
        };
        runner.stdout?.on("data", capture);
        runner.stderr?.on("data", capture);

        await waitForReadyCount(runner, () => output, 1, 8_000);
        appendFileSync(fixturePath, `\n// restart-${Date.now()}\n`);
        await waitForReadyCount(runner, () => output, 2, 15_000);

        const readyPids = [
          ...output.matchAll(new RegExp(`${READY_MARKER}(\\d+)`, "g")),
        ].map((match) => Number(match[1]));
        expect(new Set(readyPids).size).toBeGreaterThanOrEqual(2);
        expect(output).not.toContain("\u001bc");
      } finally {
        if (runner) await stopProcessTree(runner);
        rmSync(runtimeDirectory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    },
  );
});
