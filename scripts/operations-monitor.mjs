import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
import nodemailer from "nodemailer";

const TOKEN = /^[a-zA-Z0-9._-]{1,100}$/;
const EMAIL = /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

export class MonitorError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const required = (env, name) => {
  const value = String(env[name] || "").trim();
  if (!value || /[\r\n]/.test(value))
    throw new MonitorError(`missing-or-invalid-${name}`);
  return value;
};

const number = (value, fallback, minimum, maximum) => {
  const result = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new MonitorError("invalid-numeric-configuration");
  }
  return result;
};

export function readNotificationConfiguration(env = process.env) {
  const testMode =
    env.NODE_ENV === "test" && env.OPS_MONITOR_TEST_MODE === "loopback";
  const namespace = required(env, "OPS_MONITOR_NAMESPACE");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace))
    throw new MonitorError("invalid-namespace");
  const owner = required(env, "OPS_ALERT_TO");
  const from = required(env, "OPS_MONITOR_FROM_EMAIL");
  if (!EMAIL.test(owner) || !EMAIL.test(from))
    throw new MonitorError("invalid-email-address");
  const smtpHost = required(env, "OPS_MONITOR_SMTP_HOST");
  if (
    !/^[a-zA-Z0-9.:[\]-]+$/.test(smtpHost) ||
    (testMode && !LOOPBACK.has(smtpHost))
  ) {
    throw new MonitorError("invalid-smtp-host");
  }
  const smtpPort = number(env.OPS_MONITOR_SMTP_PORT, 465, 1, 65535);
  if (!testMode && ![465, 587].includes(smtpPort))
    throw new MonitorError("smtp-requires-tls-port");
  const smtpUser = testMode
    ? env.OPS_MONITOR_SMTP_USER
    : required(env, "OPS_MONITOR_SMTP_USER");
  const smtpPassword = testMode
    ? env.OPS_MONITOR_SMTP_PASSWORD
    : required(env, "OPS_MONITOR_SMTP_PASSWORD");
  if (Boolean(smtpUser) !== Boolean(smtpPassword))
    throw new MonitorError("incomplete-smtp-authentication");
  return {
    namespace,
    testMode,
    owner,
    from,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPassword,
    keepMessageId: env.OPS_MONITOR_POSTMARK_KEEP_ID === "true",
  };
}

export function readConfiguration(env = process.env) {
  const notification = readNotificationConfiguration(env);
  const { testMode } = notification;
  const parseOrigin = (origin) => {
    const url = new URL(origin.trim());
    if (
      url.origin !== origin.trim() ||
      !(testMode
        ? LOOPBACK.has(url.hostname) && ["http:", "https:"].includes(url.protocol)
        : url.protocol === "https:")
    ) throw new MonitorError("invalid-allowed-origin");
    return url.origin;
  };
  const allowedOrigins = required(env, "OPS_MONITOR_ALLOWED_ORIGINS").split(",").map(parseOrigin);
  const endpoint = (name, path) => {
    const url = new URL(required(env, name));
    if (
      !allowedOrigins.includes(url.origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (path && url.pathname !== path)
    )
      throw new MonitorError("endpoint-not-allowed");
    // Test mode cannot accidentally address a real environment or SMTP server.
    if (testMode && !LOOPBACK.has(url.hostname))
      throw new MonitorError("test-endpoint-not-loopback");
    return url.href;
  };
  const apiUrl = endpoint("OPS_MONITOR_API_URL", "/internal/operations/health");
  const webUrl = endpoint("OPS_MONITOR_WEB_URL", "/api/health");
  const token = required(env, "OPS_MONITOR_TOKEN");
  if (token.length < 32) throw new MonitorError("monitor-token-too-short");
  return {
    ...notification,
    apiUrl,
    webUrl,
    token,
    publicSiteOrigin: env.OPS_MONITOR_PUBLIC_SITE_ORIGIN
      ? parseOrigin(env.OPS_MONITOR_PUBLIC_SITE_ORIGIN)
      : null,
    statePath: resolve(required(env, "OPS_MONITOR_STATE_PATH")),
    timeoutMs: number(env.OPS_MONITOR_TIMEOUT_MS, 8000, 100, 15000),
    reminderMs: number(env.OPS_MONITOR_REMINDER_MINUTES, 60, 15, 1440) * 60_000,
  };
}

async function readBoundedText(response, maximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new MonitorError("invalid-response");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new MonitorError("response-too-large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const readBoundedJson = async (response) =>
  JSON.parse(await readBoundedText(response, 32768));

// These markers are rendered in the catalogue HTML before the browser starts.
// Exclude scripts: Next also serializes UI strings and markup into its payload.
const publicPages = [
  ["courses", "/cs/courses?location=vaclavska", 'data-customer-courses-page="true"'],
  ["memberships", "/cs/memberships", 'data-customer-portal-hero="memberships"'],
  ["vouchers", "/cs/vouchers", 'data-public-voucher-catalog="true"'],
];

async function observeCatalogue(response, marker, kind) {
  if (response.status !== 200) {
    await response.body?.cancel();
    return [`${kind}.http-${response.status}`];
  }
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/html") {
    await response.body?.cancel();
    return [`${kind}.invalid-response`];
  }
  const html = (await readBoundedText(response, 2 * 1024 * 1024))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<!--[\s\S]*?-->/gi, "");
  const tags = html.match(/<(?:main|header)\b[^>]*>/gi) || [];
  if (tags.some((tag) => tag.includes(' data-public-tenant-state="unavailable"'))) {
    return [`${kind}.studio-unavailable`];
  }
  return tags.some((tag) => tag.includes(` ${marker}`)) ? [] : [`${kind}.catalogue-missing`];
}

const knownCheck = (id) =>
  [
    "public-site.configuration",
    "runtime",
    "mongo",
    "redis",
    "configuration",
    "monitor",
    "worker.communication-email",
    "worker.communication-scheduler",
    "worker.data-import",
    "payments.paid-unfulfilled",
    "payments.refunds-review",
    "payments.refunds-stale",
  ].includes(id) || /^cron\.[a-zA-Z0-9._-]{1,70}$/.test(id);
const CORE_CHECKS = [
  "runtime",
  "mongo",
  "redis",
  "payments.paid-unfulfilled",
  "payments.refunds-review",
  "payments.refunds-stale",
  "worker.communication-email",
  "worker.communication-scheduler",
  "worker.data-import",
  "cron.sendOutAccessCodes",
  "cron.processBookingPaymentRefunds",
  "cron.reportPaidUnfulfilledOrders",
  "cron.sendOutNotificationsAfterPayment",
];

export async function observe(config, fetcher = fetch) {
  const check = async (kind, url, catalogueMarker) => {
    try {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(config.timeoutMs),
        credentials: "omit",
        headers:
          kind === "api"
            ? {
                authorization: `Bearer ${config.token}`,
                accept: "application/json",
              }
            : { accept: catalogueMarker ? "text/html" : "application/json" },
      });
      if (catalogueMarker) return await observeCatalogue(response, catalogueMarker, kind);
      if (kind === "web") {
        if (response.status !== 200) {
          await response.body?.cancel();
          return [`web.http-${response.status}`];
        }
        const data = await readBoundedJson(response);
        return data?.status === "ok" && data.service === "shario-client"
          ? []
          : ["web.invalid-response"];
      }
      if (![200, 503].includes(response.status)) {
        await response.body?.cancel();
        return [`api.http-${response.status}`];
      }
      const data = await readBoundedJson(response);
      if (
        data?.schemaVersion !== 1 ||
        !["ok", "unhealthy"].includes(data.status) ||
        !Array.isArray(data.checks) ||
        !data.checks.length ||
        data.checks.length > 50 ||
        data.checks.some(
          (item) =>
            !knownCheck(item?.id) ||
            !["ok", "unhealthy", "unavailable"].includes(item.status) ||
            !TOKEN.test(item.reason),
        ) ||
        new Set(data.checks.map((item) => item.id)).size !==
          data.checks.length ||
        CORE_CHECKS.some((id) => !data.checks.some((item) => item.id === id))
      ) {
        return ["api.invalid-response"];
      }
      const observedAt = Date.parse(data.observedAt);
      const ageMs = Date.now() - observedAt;
      if (
        typeof data.observedAt !== "string" ||
        !Number.isFinite(observedAt) ||
        new Date(observedAt).toISOString() !== data.observedAt ||
        ageMs > 120_000 ||
        ageMs < -30_000
      ) {
        return ["api.stale-response"];
      }
      const failures = data.checks
        .filter((item) => item.status !== "ok")
        .map((item) => `api.${item.id}.${item.status}.${item.reason}`);
      if (
        !failures.length &&
        (data.status !== "ok" || response.status !== 200)
      ) {
        return ["api.inconsistent-response"];
      }
      if (
        failures.length &&
        (data.status !== "unhealthy" || response.status !== 503)
      ) {
        return ["api.inconsistent-response", ...failures];
      }
      return failures;
    } catch (error) {
      return [
        `${kind}.${error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "unreachable-or-invalid"}`,
      ];
    }
  };
  return [
    ...new Set(
      (
        await Promise.all([
          check("api", config.apiUrl),
          check("web", config.webUrl),
          ...(config.publicSiteOrigin
            ? publicPages.map(([page, path, marker]) =>
                check(`public.${page}`, new URL(path, config.publicSiteOrigin).href, marker))
            : []),
        ])
      ).flat(),
    ),
  ].sort();
}

const initialState = (namespace, initialized) => ({
  schemaVersion: 1,
  namespace,
  initialized,
  incident: null,
  lastDeliveredIncident: null,
  lastObservedAt: null,
});
const iso = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function validateState(state, namespace) {
  const incident = state?.incident;
  const validIncident = (value) =>
    value !== null &&
    typeof value === "object" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    Array.isArray(value.failures) &&
    value.failures.length > 0 &&
    value.failures.length <= 56 &&
    value.failures.every((key) => /^[a-zA-Z0-9._-]{1,220}$/.test(key)) &&
    iso(value.startedAt) &&
    iso(value.lastSeenAt) &&
    (value.lastNotifiedAt === null || iso(value.lastNotifiedAt)) &&
    Number.isSafeInteger(value.notifications) &&
    value.notifications >= 0 &&
    hash([...new Set(value.failures)].sort().join("\n")) === value.fingerprint;
  // Read the original v1 state without discarding a previously delivered alarm.
  const delivered =
    state?.lastDeliveredIncident === undefined
      ? incident?.lastNotifiedAt
        ? structuredClone(incident)
        : null
      : state.lastDeliveredIncident;
  if (
    state?.schemaVersion !== 1 ||
    state.namespace !== namespace ||
    typeof state.initialized !== "boolean" ||
    (state.lastObservedAt !== null && !iso(state.lastObservedAt)) ||
    (incident !== null && !validIncident(incident)) ||
    (delivered !== null &&
      (!validIncident(delivered) ||
        !iso(delivered.lastNotifiedAt) ||
        delivered.notifications < 1))
  ) {
    throw new MonitorError("state-invalid");
  }
  return { ...state, lastDeliveredIncident: delivered };
}

export async function loadState(config, { initialize = false } = {}) {
  let state;
  try {
    const stat = await lstat(config.statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new MonitorError("state-invalid");
    state = validateState(
      JSON.parse(await readFile(config.statePath, "utf8")),
      config.namespace,
    );
  } catch {
    state = initialState(config.namespace, false);
  }
  if (initialize && !state.initialized)
    return initialState(config.namespace, true);
  return state;
}

export async function saveState(config, state) {
  validateState(state, config.namespace);
  const directory = dirname(config.statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${config.statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, config.statePath);
  await chmod(config.statePath, 0o600);
}

export function planNotification(
  config,
  previousState,
  failures,
  now = new Date(),
) {
  const state = structuredClone(previousState);
  const at = now.toISOString();
  state.lastObservedAt = at;
  const fingerprint = hash(failures.join("\n"));
  let notification = null;
  if (failures.length) {
    if (state.incident?.fingerprint !== fingerprint) {
      state.incident = {
        fingerprint,
        failures,
        startedAt: at,
        lastSeenAt: at,
        lastNotifiedAt: null,
        notifications: 0,
      };
    }
    state.incident.lastSeenAt = at;
    const incident = state.incident;
    if (
      !incident.lastNotifiedAt ||
      now.getTime() - Date.parse(incident.lastNotifiedAt) >= config.reminderMs
    ) {
      notification = {
        kind: incident.lastNotifiedAt ? "reminder" : "failure",
        ...incident,
      };
    }
  } else if (state.lastDeliveredIncident) {
    // A changed failure set may still have an undelivered notification. Keep
    // recovery tied to the last alarm the owner actually received.
    notification = { kind: "recovery", ...state.lastDeliveredIncident };
  } else {
    state.incident = null;
  }
  return { state, notification };
}

export function notificationEmail(config, notification) {
  const label = {
    failure: "FAILURE",
    reminder: "REMINDER",
    recovery: "RECOVERED",
    test: "TEST — no production incident",
  }[notification.kind];
  const messageKey = `${config.namespace}:${notification.fingerprint}:${notification.startedAt}:${notification.kind}:${notification.notifications}`;
  return {
    from: config.from,
    to: config.owner,
    subject: `[Shario operations ${config.namespace}] ${label}`,
    messageId: `<${hash(messageKey)}@operations.shario.io>`,
    ...(config.keepMessageId ? { headers: { "X-PM-KeepID": "true" } } : {}),
    text: [
      `Environment: ${config.namespace}`,
      `State: ${label}`,
      `Incident began: ${notification.startedAt}`,
      `Incident fingerprint: ${notification.fingerprint}`,
      "",
      "Checks:",
      ...notification.failures.map((key) => `- ${key}`),
      "",
      notification.kind === "test"
        ? "This is a synthetic delivery check requested by the operational owner. It does not indicate a production incident and did not change any customer data. SMTP acceptance does not confirm inbox receipt."
        : notification.kind === "recovery"
          ? "All configured checks are healthy again."
          : "Review the operations runbook and the monitor workflow. No customer data or credentials are included in this message.",
    ].join("\n"),
  };
}

export async function sendNotification(
  config,
  notification,
  { timeoutMs = 20000 } = {},
) {
  let socket;
  let cancelled = false;
  let cancelConnect = () => {};
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: !config.testMode && config.smtpPort === 465,
    requireTLS: !config.testMode && config.smtpPort !== 465,
    ignoreTLS: config.testMode,
    ...(config.smtpUser
      ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
      : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
    tls: { rejectUnauthorized: true },
    // SMTPTransport.close() does not abort an active send. Own the underlying
    // TCP socket so the overall deadline also cancels connecting, implicit TLS
    // and STARTTLS traffic. Nodemailer still performs TLS and certificate checks.
    getSocket(options, callback) {
      if (cancelled) return callback(new MonitorError("notification-timeout"));
      socket = createConnection({ host: options.host, port: options.port });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        socket.removeListener("connect", connected);
        socket.removeListener("error", failed);
        cancelConnect = () => {};
        if (error) {
          socket.destroy();
          callback(error);
        } else callback(null, { connection: socket });
      };
      const connected = () => finish();
      const failed = (error) => finish(error);
      const connectTimer = setTimeout(
        () => finish(new MonitorError("smtp-connect-timeout")),
        5000,
      );
      cancelConnect = () => finish(new MonitorError("notification-timeout"));
      socket.once("connect", connected);
      socket.once("error", failed);
    },
  });
  let timer;
  try {
    const result = await Promise.race([
      transport.sendMail(notificationEmail(config, notification)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          // Reject with the stable error before aborting pending callbacks.
          reject(new MonitorError("notification-timeout"));
          cancelConnect();
          socket?.destroy();
        }, timeoutMs);
      }),
    ]);
    if (!result.accepted?.includes(config.owner) || result.rejected?.length) {
      throw new MonitorError("notification-rejected");
    }
  } finally {
    clearTimeout(timer);
    cancelled = true;
    cancelConnect();
    socket?.destroy();
    transport.close();
  }
}

export async function runMonitor(
  config,
  {
    initialize = false,
    now = new Date(),
    fetcher = fetch,
    notify = sendNotification,
  } = {},
) {
  const previous = await loadState(config, { initialize });
  const failures = previous.initialized
    ? await observe(config, fetcher)
    : ["monitor.state-unavailable"];
  const { state, notification } = planNotification(
    config,
    previous,
    failures,
    now,
  );
  // Persist the observation before delivery. A failed/ambiguous SMTP attempt
  // retains its stable Message-ID and is retried on the next run.
  await saveState(config, state);
  let deliveryFailed = false;
  if (notification) {
    try {
      await notify(config, notification);
      if (notification.kind === "recovery") {
        state.incident = null;
        state.lastDeliveredIncident = null;
      } else {
        state.incident.lastNotifiedAt = now.toISOString();
        state.incident.notifications += 1;
        state.lastDeliveredIncident = structuredClone(state.incident);
      }
      await saveState(config, state);
    } catch {
      deliveryFailed = true;
    }
  }
  return {
    code: deliveryFailed ? 2 : failures.length ? 1 : 0,
    status: deliveryFailed
      ? "notification-failed"
      : failures.length
        ? "unhealthy"
        : "healthy",
    notification: notification?.kind ?? "none",
    stateWritten: true,
  };
}

async function main() {
  try {
    const unsupported = process.argv
      .slice(2)
      .filter((arg) => arg !== "--initialize-state");
    if (unsupported.length) throw new MonitorError("unsupported-argument");
    const config = readConfiguration();
    const result = await runMonitor(config, {
      initialize: process.argv.includes("--initialize-state"),
    });
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, "state_written=true\n");
    console.log(
      `OPERATIONS_MONITOR ${result.status} notification=${result.notification}`,
    );
    process.exitCode = result.code;
  } catch (error) {
    // Never print fetch/SMTP errors: providers can include credentials or PII.
    console.error(
      `OPERATIONS_MONITOR_FAILED ${error instanceof MonitorError ? error.code : "configuration-or-state-error"}`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
