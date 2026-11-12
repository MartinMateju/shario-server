import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const FORCE_EXIT_AFTER_MS = 7_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

export const devProcesses = [
  { name: "api", entrypoint: "src/server.ts" },
  {
    name: "data-import-worker",
    entrypoint: "src/workers/data-import.worker.ts",
  },
];

const isRunning = (child) =>
  typeof child.pid === "number" &&
  child.exitCode === null &&
  child.signalCode === null;

const forceStopChild = ({ child, name }) => {
  if (!isRunning(child)) return;

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      },
    );

    if (result.error) {
      console.error(
        `[dev:${name}] failed to force-stop process tree`,
        result.error,
      );
    }
    return;
  }

  child.kill("SIGKILL");
};

const createDevEnvironment = (name) => ({
  ...process.env,
  SHARIO_DEV_PROCESS: name,
  SHUTDOWN_DRAIN_TIMEOUT_MS:
    process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || "2500",
  SHUTDOWN_CLEANUP_TIMEOUT_MS:
    process.env.SHUTDOWN_CLEANUP_TIMEOUT_MS || "1500",
});

export const runDevProcesses = ({
  processes = devProcesses,
  stdio = "inherit",
  registerSignalHandlers = true,
} = {}) => {
  const children = [];
  let stopping = false;

  const stopChildren = (signal = "SIGTERM", exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;

    for (const entry of children) {
      const { child } = entry;
      if (!isRunning(child)) continue;

      if (process.platform === "win32") {
        // Ctrl+C is already broadcast to the shared Windows console. Calling
        // child.kill("SIGINT") here could kill only the tsx wrapper and orphan
        // its application process.
        if (signal !== "SIGINT") {
          forceStopChild(entry);
        }
      } else {
        child.kill(signal);
      }
    }

    const forceExit = setTimeout(() => {
      console.error(
        "[dev] shutdown timed out; force-stopping child processes",
      );
      for (const entry of children) {
        forceStopChild(entry);
      }
      process.exit(exitCode);
    }, FORCE_EXIT_AFTER_MS);
    forceExit.unref();
  };

  for (const { name, entrypoint } of processes) {
    const child = spawn(
      process.execPath,
      [tsxCli, "watch", "--clear-screen=false", entrypoint],
      {
        env: createDevEnvironment(name),
        stdio,
        windowsHide: true,
      },
    );

    children.push({ child, name });

    child.on("error", (error) => {
      console.error(`[dev:${name}] failed to start`, error);
      stopChildren("SIGTERM", 1);
    });

    child.on("exit", (code, signal) => {
      if (stopping) return;
      console.error(
        `[dev:${name}] exited unexpectedly (${
          signal || `code ${code ?? 1}`
        })`,
      );
      stopChildren(
        "SIGTERM",
        typeof code === "number" && code > 0 ? code : 1,
      );
    });
  }

  if (registerSignalHandlers) {
    process.once("SIGINT", () => stopChildren("SIGINT"));
    process.once("SIGTERM", () => stopChildren("SIGTERM"));
  }

  return { children, stopChildren };
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runDevProcesses();
}
