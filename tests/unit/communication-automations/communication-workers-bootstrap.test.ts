import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("isolated communication worker model registration", () => {
  it.each([
    {
      worker: "communication-automation-scheduler.worker.ts",
      requiredModels: [
        "Booking",
        "Order",
        "User",
        "RegisteredSenderEmail",
        "EmailTemplate",
      ],
    },
    {
      worker: "communication-email.worker.ts",
      requiredModels: [
        "Booking",
        "Order",
        "User",
        "Location",
        "Product",
        "RegisteredSenderEmail",
      ],
    },
  ])("registers populated models when importing $worker alone", ({ worker, requiredModels }) => {
    const workerUrl = pathToFileURL(resolve(repositoryRoot, "src/workers", worker)).href;
    // Use a new process: other tests or the API bootstrap must not accidentally
    // register a missing model before this standalone worker imports it.
    const script = `
      import assert from "node:assert/strict";
      import net from "node:net";
      import http from "node:http";
      import https from "node:https";
      import mongoose from "mongoose";

      assert.deepEqual(mongoose.modelNames(), []);
      let networkAttempts = 0;
      const denyNetwork = () => {
        networkAttempts += 1;
        throw new Error("Worker import attempted network access.");
      };
      net.Socket.prototype.connect = denyNetwork;
      http.request = http.get = denyNetwork;
      https.request = https.get = denyNetwork;
      globalThis.fetch = denyNetwork;
      mongoose.Connection.prototype.openUri = denyNetwork;

      // This is an import, not direct execution: neither worker may start.
      await import(${JSON.stringify(workerUrl)});
      await new Promise(setImmediate);
      const modelNames = mongoose.modelNames();
      const missingModels = ${JSON.stringify(requiredModels)}.filter(
        (name) => !modelNames.includes(name),
      );
      assert.deepEqual(missingModels, [], "Unregistered populated models");
      assert.equal(mongoose.connection.readyState, 0);
      assert.equal(networkAttempts, 0);
      process.stdout.write(JSON.stringify({ modelNames, networkAttempts }));
      process.exit(0);
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          // Keep only process-launch essentials; never load real app credentials.
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          NODE_ENV: "test",
          E2E_TEST_MODE: "true",
          LOG_LEVEL: "silent",
          REDIS_URL: "redis://127.0.0.1:1",
          DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
        },
      },
    );

    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.modelNames).toEqual(expect.arrayContaining(requiredModels));
    expect(output.networkAttempts).toBe(0);
  }, 40_000);
});
