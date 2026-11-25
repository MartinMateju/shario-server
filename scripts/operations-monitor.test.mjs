import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadState,
  notificationEmail,
  observe,
  readConfiguration,
  readNotificationConfiguration,
  runMonitor,
  sendNotification,
} from "./operations-monitor.mjs";
import { restoreState } from "./operations-monitor-state.mjs";

const coreChecks = [
  "runtime",
  "mongo",
  "redis",
  "payments.paid-unfulfilled",
  "payments.refunds-review",
  "payments.refunds-stale",
  "worker.communication-email",
  "worker.communication-scheduler",
  "worker.data-import",
  "cron.processBookingPaymentRefunds",
  "cron.reportPaidUnfulfilledOrders",
  "cron.sendOutNotificationsAfterPayment",
];
const webHealth = () => Response.json({ status: "ok", service: "shario-client" });
const health = (failed = false, count = 1) => ({
  schemaVersion: 1,
  status: failed ? "unhealthy" : "ok",
  observedAt: new Date().toISOString(),
  checks: [
    ...coreChecks.map((id) => ({ id, status: "ok", reason: "healthy" })),
    {
      id: "cron.sendOutAccessCodes",
      status: failed ? "unhealthy" : "ok",
      reason: failed ? "last_success_stale" : "healthy",
      count,
    },
  ],
});
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );

async function fixture(
  t,
  { commandDelayMs = 0, continuationIntervalMs = 0 } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "shario-operations-monitor-"));
  const state = {
    failed: false,
    unavailableCatalogue: null,
    count: 1,
    rejectMail: false,
    httpCalls: [],
    messages: [],
    attempts: [],
    redirects: 0,
    commands: [],
  };
  const sockets = new Set();
  const smtp = createTcpServer((socket) => {
    sockets.add(socket);
    const timers = new Set();
    socket.on("close", () => {
      sockets.delete(socket);
      for (const timer of timers) clearTimeout(timer);
    });
    socket.on("error", () => {});
    socket.write("220 loopback.test ESMTP\r\n");
    let buffer = "";
    let data = null;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (data === null) state.commands.push(line);
        if (data !== null) {
          if (line === ".") {
            const message = data.join("\r\n");
            state.attempts.push(message);
            if (state.rejectMail)
              socket.write("451 Temporary test delivery failure\r\n");
            else {
              state.messages.push(message);
              socket.write("250 Message accepted\r\n");
            }
            data = null;
          } else data.push(line.replace(/^\.\./, "."));
        } else if (/^EHLO|^HELO/.test(line)) {
          if (continuationIntervalMs) {
            socket.write("250-loopback.test\r\n");
            timers.add(
              setInterval(
                () => socket.write("250-still responding\r\n"),
                continuationIntervalMs,
              ),
            );
          } else socket.write("250-loopback.test\r\n250 8BITMIME\r\n");
        } else if (/^MAIL FROM:|^RCPT TO:|^RSET/.test(line))
          timers.add(
            setTimeout(() => socket.write("250 OK\r\n"), commandDelayMs),
          );
        else if (line === "DATA") {
          data = [];
          timers.add(
            setTimeout(
              () => socket.write("354 End with dot\r\n"),
              commandDelayMs,
            ),
          );
        } else if (line === "QUIT") {
          socket.end("221 Bye\r\n");
        } else socket.write("250 OK\r\n");
      }
    });
  });
  const http = createHttpServer((request, response) => {
    state.httpCalls.push({
      path: request.url,
      authorization: request.headers.authorization,
    });
    if (request.url === "/internal/operations/health") {
      response.writeHead(state.failed ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(health(state.failed, state.count)));
    } else if (request.url.startsWith("/cs/")) {
      const path = request.url.split("?")[0];
      const markers = {
        "/cs/courses": '<main data-customer-courses-page="true"></main>',
        "/cs/memberships": '<header data-customer-portal-hero="memberships"></header>',
        "/cs/vouchers": '<main data-public-voucher-catalog="true"></main>',
      };
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(state.unavailableCatalogue === path
        ? '<main data-public-tenant-state="unavailable"><h1>Studio je dočasně nedostupné</h1></main>'
        : markers[path]);
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "/must-not-follow" });
      response.end();
    } else if (request.url === "/must-not-follow") {
      state.redirects += 1;
      response.end("unexpected");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "shario-client" }));
    }
  });
  const [smtpPort, httpPort] = await Promise.all([listen(smtp), listen(http)]);
  const origin = `http://127.0.0.1:${httpPort}`;
  const env = {
    NODE_ENV: "test",
    OPS_MONITOR_TEST_MODE: "loopback",
    OPS_MONITOR_NAMESPACE: "rehearsal",
    OPS_MONITOR_ALLOWED_ORIGINS: origin,
    OPS_MONITOR_API_URL: `${origin}/internal/operations/health`,
    OPS_MONITOR_WEB_URL: `${origin}/api/health`,
    OPS_MONITOR_TOKEN: "synthetic-monitor-token-123456789012345",
    OPS_MONITOR_STATE_PATH: join(directory, "state.json"),
    OPS_ALERT_TO: "owner@example.test",
    OPS_MONITOR_FROM_EMAIL: "monitor@example.test",
    OPS_MONITOR_SMTP_HOST: "127.0.0.1",
    OPS_MONITOR_SMTP_PORT: String(smtpPort),
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => smtp.close(resolve)),
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(resolve);
      }),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  return { config: readConfiguration(env), env, state, sockets };
}

test("a rendered HTTP 200 unavailable page sends an incident and recovery to the operator", async (t) => {
  const { env, state } = await fixture(t);
  env.OPS_MONITOR_PUBLIC_SITE_ORIGIN = env.OPS_MONITOR_ALLOWED_ORIGINS;
  const config = readConfiguration(env);
  state.unavailableCatalogue = "/cs/memberships";
  const failed = await runMonitor(config, { initialize: true });
  assert.equal(failed.notification, "failure");
  assert.equal(failed.status, "unhealthy");
  assert.match(state.messages[0], /public.memberships.studio-unavailable/);
  const publicCalls = state.httpCalls.filter((call) => call.path.startsWith("/cs/"));
  assert.equal(publicCalls.length, 3);
  assert.ok(publicCalls.every((call) => call.authorization === undefined));
  state.unavailableCatalogue = null;
  assert.equal((await runMonitor(config)).notification, "recovery");
  assert.equal(state.messages.length, 2);
});

test("a redirect, a generic landing page and catalogue markers inside scripts are unhealthy", async (t) => {
  const { config } = await fixture(t);
  config.publicSiteOrigin = "http://127.0.0.1";
  const failures = await observe(config, (url, options) => {
    if (url === config.apiUrl || url === config.webUrl) return fetch(url, options);
    assert.equal(options.redirect, "manual");
    if (url.includes("/courses")) return new Response(null, { status: 302 });
    return new Response(url.endsWith("/vouchers")
      ? `<script>const html = '<main data-public-voucher-catalog="true">'</script>`
      : '<html><h1>Welcome</h1></html>', { headers: { "content-type": "text/html" } });
  });
  assert.deepEqual(failures, ["public.courses.http-302", "public.memberships.catalogue-missing", "public.vouchers.catalogue-missing"]);
});

for (const slowSmtp of [
  { label: "delayed SMTP commands", commandDelayMs: 120 },
  { label: "continuous multiline SMTP replies", continuationIntervalMs: 25 },
]) {
  test(`SMTP deadline closes the connection and lets the process exit with ${slowSmtp.label}`, async (t) => {
    const { config, state, sockets } = await fixture(t, slowSmtp);
    const notification = {
      kind: "test",
      fingerprint: "a".repeat(64),
      startedAt: new Date().toISOString(),
      notifications: 0,
      failures: ["synthetic.delivery-check"],
    };
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { sendNotification } from ${JSON.stringify(new URL("./operations-monitor.mjs", import.meta.url).href)};
      try {
        await sendNotification(${JSON.stringify(config)}, ${JSON.stringify(notification)}, { timeoutMs: 300 });
        process.exitCode = 3;
      } catch (error) {
        if (error.code !== "notification-timeout") process.exitCode = 4;
      }
    `,
      ],
      { stdio: "ignore" },
    );
    let killed = false;
    const deadline = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 2500);
    t.after(() => {
      clearTimeout(deadline);
      child.kill("SIGKILL");
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(deadline);
    assert.equal(
      killed,
      false,
      "SMTP socket kept the child alive after its deadline",
    );
    assert.deepEqual(result, { code: 0, signal: null });
    // Let the peer observe EOF; any uncancelled delayed send would now finish.
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(sockets.size, 0);
    assert.equal(state.attempts.length, 0);
    assert.equal(state.messages.length, 0);
    assert.ok(state.commands.some((line) => line.startsWith("EHLO")));
    if (slowSmtp.commandDelayMs) assert.ok(state.commands.includes("DATA"));
  });
}

test("configuration fails closed and production cannot use plaintext or unapproved destinations", async (t) => {
  const { env } = await fixture(t);
  assert.throws(
    () => readConfiguration({ ...env, OPS_ALERT_TO: "" }),
    /OPS_ALERT_TO/,
  );
  assert.throws(
    () => readConfiguration({ ...env, OPS_MONITOR_TOKEN: "short" }),
    /too-short/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...env,
        OPS_MONITOR_API_URL: "https://other.example/internal/operations/health",
      }),
    /not-allowed/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...env,
        OPS_MONITOR_API_URL: `${env.OPS_MONITOR_API_URL}?token=secret`,
      }),
    /not-allowed/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...env,
        OPS_MONITOR_WEB_URL: env.OPS_MONITOR_WEB_URL.replace(
          "/api/health",
          "/en",
        ),
      }),
    /not-allowed/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...env,
        OPS_ALERT_TO: "one@example.test,two@example.test",
      }),
    /email/,
  );
  assert.throws(
    () =>
      readConfiguration({ ...env, OPS_MONITOR_SMTP_HOST: "smtp.example.com" }),
    /smtp-host/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...env,
        NODE_ENV: "production",
        OPS_MONITOR_SMTP_PORT: "1025",
      }),
    /tls-port/,
  );
  assert.throws(
    () =>
      readConfiguration({
        ...env,
        OPS_MONITOR_ALLOWED_ORIGINS: "http://example.com",
      }),
    /allowed-origin/,
  );
  const mailOnly = readNotificationConfiguration(env);
  assert.equal(mailOnly.owner, "owner@example.test");
  assert.equal(mailOnly.apiUrl, undefined);
});

test("failure, duplicate suppression, reminder and recovery persist across fresh runs and SMTP deliveries", async (t) => {
  const { config, state } = await fixture(t);
  const start = new Date("2026-11-14T10:00:00Z");
  assert.equal(
    (await runMonitor(config, { initialize: true, now: start })).code,
    0,
  );
  assert.equal(state.messages.length, 0);
  state.failed = true;
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 60_000) })).notification,
    "failure",
  );
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /Subject: .*FAILURE/);
  assert.match(state.messages[0], /cron.sendOutAccessCodes/);
  state.count = 999;
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 120_000) }))
      .notification,
    "none",
  );
  assert.equal(state.messages.length, 1);
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 62 * 60_000) }))
      .notification,
    "reminder",
  );
  assert.equal(state.messages.length, 2);
  state.failed = false;
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 63 * 60_000) }))
      .notification,
    "recovery",
  );
  assert.equal(state.messages.length, 3);
  assert.match(state.messages[2], /RECOVERED/);
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 64 * 60_000) }))
      .notification,
    "none",
  );
  assert.equal(state.messages.length, 3);
  assert.equal((await loadState(config)).incident, null);
  assert.equal((await stat(config.statePath)).mode & 0o777, 0o600);
  assert.ok(
    state.httpCalls
      .filter((call) => call.path === "/api/health")
      .every((call) => !call.authorization),
  );
  assert.ok(
    state.httpCalls
      .filter((call) => call.path.includes("internal"))
      .every((call) => call.authorization === `Bearer ${config.token}`),
  );
  const persisted = await readFile(config.statePath, "utf8");
  assert.ok(
    !persisted.includes(config.token) && !persisted.includes(config.owner),
  );
});

test("SMTP failures retry the same incident and recovery with stable Message-IDs", async (t) => {
  const { config, state } = await fixture(t);
  state.failed = true;
  state.rejectMail = true;
  const start = new Date("2026-11-14T10:00:00Z");
  assert.equal(
    (await runMonitor(config, { initialize: true, now: start })).code,
    2,
  );
  assert.equal((await loadState(config)).incident.lastNotifiedAt, null);
  state.rejectMail = false;
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 60_000) })).code,
    1,
  );
  const messageId = (message) => message.match(/Message-ID:\s*(<[^>]+>)/i)[1];
  assert.equal(messageId(state.attempts[0]), messageId(state.attempts[1]));
  state.failed = false;
  state.rejectMail = true;
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 120_000) })).code,
    2,
  );
  assert.ok((await loadState(config)).incident);
  state.rejectMail = false;
  assert.equal(
    (await runMonitor(config, { now: new Date(+start + 180_000) })).code,
    0,
  );
  assert.equal(messageId(state.attempts[2]), messageId(state.attempts[3]));
  assert.equal(state.messages.length, 2);
  assert.equal((await loadState(config)).incident, null);
});

test("missing or corrupt state is a deduplicated blocked incident until explicitly initialized", async (t) => {
  const { config, state } = await fixture(t);
  assert.equal((await runMonitor(config)).code, 1);
  assert.equal(state.httpCalls.length, 0);
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /monitor.state-unavailable/);
  assert.equal((await runMonitor(config)).notification, "none");
  assert.equal(state.messages.length, 1);
  assert.equal((await runMonitor(config, { initialize: true })).code, 0);
  assert.equal(state.httpCalls.length, 2);
  await writeFile(config.statePath, "not JSON containing synthetic-secret");
  assert.equal((await runMonitor(config)).code, 1);
  assert.equal(state.httpCalls.length, 2);
  assert.equal(state.messages.length, 2);
  assert.ok(!state.messages.join("").includes("synthetic-secret"));
});

test("recovery survives a changed failure set and rejected replacement notification across runs", async (t) => {
  const { config, state } = await fixture(t);
  let failing = "mongo";
  const fetcher = async (url) => {
    if (url !== config.apiUrl) return webHealth();
    const body = health();
    body.status = failing ? "unhealthy" : "ok";
    body.checks = body.checks.map((check) =>
      check.id === failing
        ? { ...check, status: "unavailable", reason: "probe_failed" }
        : check,
    );
    return Response.json(body, { status: failing ? 503 : 200 });
  };
  const start = Date.parse("2026-11-14T10:00:00Z");
  const run = (minutes, extra = {}) =>
    runMonitor(config, {
      fetcher,
      now: new Date(start + minutes * 60_000),
      ...extra,
    });
  assert.equal((await run(0, { initialize: true })).notification, "failure");
  assert.equal(state.messages.length, 1);
  failing = "redis";
  state.rejectMail = true;
  assert.equal((await run(5)).code, 2);
  const pending = await loadState(config);
  assert.equal(pending.incident.lastNotifiedAt, null);
  assert.ok(
    pending.lastDeliveredIncident.failures.some((key) => key.includes("mongo")),
  );
  failing = null;
  const rejectedRecovery = await run(10);
  assert.equal(rejectedRecovery.notification, "recovery");
  assert.equal(rejectedRecovery.code, 2);
  assert.ok((await loadState(config)).lastDeliveredIncident);
  state.rejectMail = false;
  assert.equal((await run(15)).code, 0);
  assert.equal(state.messages.length, 2);
  assert.match(state.messages[1], /RECOVERED/);
  assert.match(state.messages[1], /mongo/);
  const messageId = (message) => message.match(/Message-ID:\s*(<[^>]+>)/i)[1];
  assert.equal(messageId(state.attempts[2]), messageId(state.attempts[3]));
  assert.equal((await loadState(config)).incident, null);
  assert.equal((await loadState(config)).lastDeliveredIncident, null);
  assert.equal((await run(20)).notification, "none");
  assert.equal(state.messages.length, 2);
});

test("legacy delivered state retains recovery history and invalid delivery history fails closed", async (t) => {
  const { config, state } = await fixture(t);
  state.failed = true;
  await runMonitor(config, { initialize: true });
  const legacy = JSON.parse(await readFile(config.statePath, "utf8"));
  delete legacy.lastDeliveredIncident;
  await writeFile(config.statePath, JSON.stringify(legacy));
  assert.equal(
    (await loadState(config)).lastDeliveredIncident.fingerprint,
    legacy.incident.fingerprint,
  );
  state.failed = false;
  assert.equal((await runMonitor(config)).notification, "recovery");
  assert.equal(state.messages.length, 2);
  await writeFile(
    config.statePath,
    JSON.stringify({
      ...legacy,
      lastDeliveredIncident: { private: "invalid" },
    }),
  );
  assert.equal((await loadState(config)).initialized, false);
});

test("an initial notification that never reached the owner does not create a recovery email", async (t) => {
  const { config, state } = await fixture(t);
  state.failed = true;
  state.rejectMail = true;
  assert.equal((await runMonitor(config, { initialize: true })).code, 2);
  state.failed = false;
  state.rejectMail = false;
  assert.equal((await runMonitor(config)).notification, "none");
  assert.equal(state.messages.length, 0);
  assert.equal((await loadState(config)).lastDeliveredIncident, null);
});

test("HTTP redirects are not followed and response payloads never enter incident notifications", async (t) => {
  const { config, state } = await fixture(t);
  const redirected = {
    ...config,
    webUrl: config.webUrl.replace("/api/health", "/redirect"),
  };
  assert.deepEqual(await observe(redirected), ["web.http-302"]);
  assert.equal(state.redirects, 0);
  const fetcher = async (url) =>
    url === config.apiUrl
      ? new Response("secret-password customer@example.test", { status: 401 })
      : webHealth();
  const failures = await observe(config, fetcher);
  assert.deepEqual(failures, ["api.http-401"]);
  const email = notificationEmail(config, {
    kind: "failure",
    fingerprint: "a".repeat(64),
    startedAt: new Date().toISOString(),
    notifications: 0,
    failures,
  });
  assert.ok(
    !email.text.includes("secret-password") &&
      !email.text.includes("customer@example.test"),
  );
});

test("invalid, incomplete, duplicate and oversized health responses fail closed", async (t) => {
  const { config } = await fixture(t);
  const complete = health();
  for (const body of [
    { ...complete, schemaVersion: 2 },
    { ...complete, checks: complete.checks.slice(1) },
    { ...complete, checks: [...complete.checks, complete.checks[0]] },
    {
      ...complete,
      checks: [
        { id: "mongo", status: "ok", reason: "private customer details" },
      ],
    },
    { ...complete, padding: "x".repeat(40000) },
  ]) {
    const failures = await observe(config, async (url) =>
      url === config.apiUrl ? Response.json(body) : webHealth(),
    );
    assert.ok(failures.some((failure) => failure.startsWith("api.")));
  }
});

test("network checks have a bounded timeout", async (t) => {
  const { config } = await fixture(t);
  const started = Date.now();
  const failures = await observe(
    { ...config, timeoutMs: 100 },
    async (url, options) => {
      if (url !== config.apiUrl) return webHealth();
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    },
  );
  assert.deepEqual(failures, ["api.timeout"]);
  assert.ok(Date.now() - started < 1500);
});

test("stale, future or incomplete aggregate health cannot report the service healthy", async (t) => {
  const { config } = await fixture(t);
  for (const observedAt of [
    "yesterday",
    new Date(Date.now() - 180_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  ]) {
    assert.deepEqual(
      await observe(config, async (url) =>
        url === config.apiUrl
          ? Response.json({ ...health(), observedAt })
          : webHealth(),
      ),
      ["api.stale-response"],
    );
  }
  for (const missing of [
    "worker.communication-email",
    "worker.communication-scheduler",
    "worker.data-import",
    "cron.processBookingPaymentRefunds",
    "cron.reportPaidUnfulfilledOrders",
    "cron.sendOutNotificationsAfterPayment",
    "cron.sendOutAccessCodes",
  ]) {
    const body = health();
    body.checks = body.checks.filter((check) => check.id !== missing);
    assert.deepEqual(
      await observe(config, async (url) =>
        url === config.apiUrl ? Response.json(body) : webHealth(),
      ),
      ["api.invalid-response"],
    );
  }
});

test("frontend health requires its specific JSON contract, including on HTTP 200", async (t) => {
  const { config } = await fixture(t);
  for (const body of [
    { status: "ok", service: "other" },
    { status: "failed", service: "shario-client" },
    {},
  ]) {
    assert.deepEqual(
      await observe(config, async (url) =>
        Response.json(url === config.apiUrl ? health() : body),
      ),
      ["web.invalid-response"],
    );
  }
  assert.deepEqual(
    await observe(config, async (url) =>
      url === config.apiUrl
        ? Response.json(health())
        : new Response("<html>Sign in</html>"),
    ),
    ["web.unreachable-or-invalid"],
  );
});

test("synthetic notification is clearly marked and does not require endpoint credentials", async (t) => {
  const { env, state } = await fixture(t);
  const config = readNotificationConfiguration(env);
  await sendNotification(config, {
    kind: "test",
    fingerprint: "a".repeat(64),
    startedAt: new Date().toISOString(),
    notifications: 0,
    failures: ["synthetic.delivery-check"],
  });
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /synthetic delivery check/);
  assert.match(state.messages[0], /does not indicate a production incident/);
  assert.equal(state.httpCalls.length, 0);
  const preserved = notificationEmail(
    { ...config, keepMessageId: true },
    {
      kind: "test",
      fingerprint: "a".repeat(64),
      startedAt: "2026-11-14T10:00:00.000Z",
      notifications: 0,
      failures: ["synthetic.delivery-check"],
    },
  );
  assert.equal(preserved.headers["X-PM-KeepID"], "true");
});

test("artifact restoration trusts only the latest completed main monitor run and preserves manual retry state", async (t) => {
  const { config } = await fixture(t);
  const env = {
    GITHUB_REPOSITORY: "example/server",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "synthetic-github-secret",
    OPS_MONITOR_STATE_PATH: config.statePath,
  };
  const logs = [];
  const downloads = [];
  const run = (id, event, head_branch = "main") => ({
    id,
    event,
    head_branch,
    status: "completed",
  });
  const fetcher = async (url, options) => {
    assert.equal(
      options.headers.authorization,
      "Bearer synthetic-github-secret",
    );
    if (url.includes("/workflows/"))
      return Response.json({
        workflow_runs: [
          run(100, "schedule"),
          run(99, "pull_request"),
          run(98, "workflow_dispatch", "feature"),
          run(97, "schedule"),
          run(96, "schedule"),
        ],
      });
    assert.match(url, /\/runs\/(97|100)\/artifacts/);
    return Response.json({
      artifacts: [{ name: "operations-monitor-state-v1", expired: false }],
    });
  };
  const download = async (_command, args) => {
    downloads.push(args);
    await writeFile(join(args.at(-1), "state.json"), "{}");
    return { status: 0 };
  };
  await restoreState({
    env,
    fetcher,
    download,
    log: (message) => logs.push(message),
  });
  assert.equal(downloads[0][2], "97");
  await restoreState({
    env: { ...env, GITHUB_RUN_ATTEMPT: "2" },
    fetcher,
    download,
    log: (message) => logs.push(message),
  });
  assert.equal(downloads[1][2], "100");
  assert.ok(!logs.join("").includes(env.GH_TOKEN));
  assert.equal((await stat(config.statePath)).mode & 0o777, 0o600);
});

test("missing, expired or unreadable prior artifacts never silently fall back to older incident state", async (t) => {
  const { config } = await fixture(t);
  const env = {
    GITHUB_REPOSITORY: "example/server",
    GITHUB_RUN_ID: "100",
    GH_TOKEN: "synthetic",
    OPS_MONITOR_STATE_PATH: config.statePath,
  };
  for (const artifacts of [
    [],
    [{ name: "operations-monitor-state-v1", expired: true }],
  ]) {
    await assert.rejects(
      restoreState({
        env,
        log: () => {},
        download: () => {
          throw new Error("must not download");
        },
        fetcher: async (url) =>
          Response.json(
            url.includes("/workflows/")
              ? {
                  workflow_runs: [
                    {
                      id: 99,
                      status: "completed",
                      head_branch: "main",
                      event: "schedule",
                    },
                  ],
                }
              : { artifacts },
          ),
      }),
      /state-artifact-unavailable/,
    );
  }
  await assert.rejects(
    restoreState({
      env,
      fetcher: async () => new Response("private-error", { status: 503 }),
      log: () => {},
    }),
    /github-api/,
  );
});

test("partial artifact extraction cannot preserve an older state or bypass the blocked-state alarm", async (t) => {
  const { config, state } = await fixture(t);
  await runMonitor(config, { initialize: true });
  const prior = await readFile(config.statePath, "utf8");
  const before = state.httpCalls.length;
  await assert.rejects(
    restoreState({
      env: {
        GITHUB_REPOSITORY: "example/server",
        GITHUB_RUN_ID: "100",
        GH_TOKEN: "synthetic",
        OPS_MONITOR_STATE_PATH: config.statePath,
      },
      fetcher: async (url) =>
        Response.json(
          url.includes("/workflows/")
            ? {
                workflow_runs: [
                  {
                    id: 99,
                    status: "completed",
                    head_branch: "main",
                    event: "schedule",
                  },
                ],
              }
            : {
                artifacts: [
                  { name: "operations-monitor-state-v1", expired: false },
                ],
              },
        ),
      download: async (_command, args) => {
        await writeFile(join(args.at(-1), "state.json"), prior);
        return { status: 1 };
      },
      log: () => {},
    }),
    /download-failed/,
  );
  await assert.rejects(readFile(config.statePath), { code: "ENOENT" });
  assert.equal((await runMonitor(config)).status, "unhealthy");
  assert.equal(state.httpCalls.length, before);
  assert.match(state.messages[0], /monitor.state-unavailable/);
});

test("retrying a superseded workflow run is refused before its stale artifact can be restored", async (t) => {
  const { config } = await fixture(t);
  const env = {
    GITHUB_REPOSITORY: "example/server",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
    GH_TOKEN: "synthetic",
    OPS_MONITOR_STATE_PATH: config.statePath,
  };
  let requests = 0;
  await assert.rejects(
    restoreState({
      env,
      fetcher: async (url) => {
        requests += 1;
        assert.ok(url.includes("/workflows/"));
        return Response.json({
          workflow_runs: [
            {
              id: 101,
              status: "completed",
              head_branch: "main",
              event: "schedule",
            },
          ],
        });
      },
      download: () => {
        throw new Error("must not download");
      },
      log: () => {},
    }),
    /superseded-run/,
  );
  assert.equal(requests, 1);
  await assert.rejects(readFile(config.statePath), { code: "ENOENT" });
  const preload = `globalThis.fetch = async () => Response.json({ workflow_runs: [{ id: 101, status: 'completed', head_branch: 'main', event: 'schedule' }] });`;
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL("./operations-monitor-state.mjs", import.meta.url)),
    ],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /superseded-run/);
  assert.ok(!cli.stdout.includes("notify the configured owner"));
});
