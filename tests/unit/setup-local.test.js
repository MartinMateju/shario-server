import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/setup-local.mjs", import.meta.url));
const roots = [];
const backendKeys = ["ACCESS_TOKEN_SECRET", "REFRESH_TOKEN_SECRET", "AUTH_FIRST_PARTY_PROXY_SECRET", "AUTH_SESSION_HANDOFF_SECRET", "BOOKING_INTENT_SECRET", "EMAIL_SECRET_KEY", "COMMUNICATION_SECRET_KEY", "ACCESS_CODE_ENCRYPTION_KEY", "POSTMARK_OUTBOUND_WEBHOOK_PASSWORD"];
const clientExample = "NEXT_PUBLIC_API_URL=http://api.shario.localhost:4311\n";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "shario-setup-test-"));
  roots.push(root);
  const server = join(root, "shario-server");
  const client = join(root, "shario-client");
  const targetScript = join(server, "scripts", "setup-local.mjs");
  mkdirSync(dirname(targetScript), { recursive: true });
  mkdirSync(client);
  copyFileSync(script, targetScript);
  writeFileSync(join(server, ".env.example"), backendKeys.map((key) => `${key}=placeholder`).join("\n") + "\n");
  writeFileSync(join(client, ".env.example"), clientExample);
  return { serverEnv: join(server, ".env"), clientEnv: join(client, ".env.local"), run: () => execFileSync(process.execPath, [targetScript], { stdio: "pipe" }) };
};

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("isolated local setup", () => {
  it("keeps fresh independent backend secrets out of the generated frontend environment", () => {
    const setup = fixture();
    setup.run();
    const server = readFileSync(setup.serverEnv, "utf8");
    const client = readFileSync(setup.clientEnv, "utf8");
    const keys = Object.fromEntries(server.trim().split("\n").map((line) => line.split("=")));
    expect(client).toBe(clientExample);
    expect(new Set(Object.values(keys)).size).toBe(backendKeys.length);
    for (const key of backendKeys) {
      expect(keys[key]).toMatch(/^[a-f0-9]{64}$/);
      expect(client).not.toContain(key);
      expect(client).not.toContain(keys[key]);
    }
  });

  it.each(["serverEnv", "clientEnv"])("refuses existing %s without changing or creating either environment", (existing) => {
    const setup = fixture();
    writeFileSync(setup[existing], "existing private configuration\n");
    expect(setup.run).toThrow();
    expect(readFileSync(setup[existing], "utf8")).toBe("existing private configuration\n");
    expect(existsSync(setup[existing === "serverEnv" ? "clientEnv" : "serverEnv"])).toBe(false);
  });
});
