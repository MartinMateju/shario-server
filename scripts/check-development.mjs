import { readFile } from "node:fs/promises";
import { setServers } from "node:dns";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filled = (value) => typeof value === "string" && value.trim().length > 0;
const placeholder = (value) =>
  /replace[_ -]?me|replace[-_ ]with|change[-_ ]?me|placeholder|<[^>]+>|(?:^|[_-])your[_-]|^(?:0+|password|secret)$/i.test(
    value,
  ) || /(?:^|[.@/])example\.(?:com|net|org|invalid)(?:[/:?#]|$)/i.test(value);
const secret = (minimum) => (value) =>
  Buffer.byteLength(value, "utf8") >= minimum;
const httpUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const httpsUrl = (value) =>
  httpUrl(value) && new URL(value).protocol === "https:";
const email = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const mongoUri = (value) =>
  /^mongodb(?:\+srv)?:\/\/[^/?]+\/[^?\s/]+(?:\?.*)?$/.test(value);

const groups = [
  {
    name: "Application",
    required: true,
    fields: {
      SERVER_URL: httpUrl,
      CLIENT_URL: httpUrl,
      MONGO_URI: mongoUri,
      REDIS_URL: (value) => /^rediss?:\/\//.test(value),
      ACCESS_TOKEN_SECRET: secret(32),
      REFRESH_TOKEN_SECRET: secret(32),
      AUTH_EMAIL: email,
      EMAIL_SECRET_KEY: secret(16),
      COMMUNICATION_SECRET_KEY: secret(32),
      COMMUNICATION_SCHEDULER_INTERVAL_MS: (value) =>
        Number.isInteger(Number(value)) && Number(value) > 0,
    },
  },
  {
    name: "R2 uploads",
    required: true,
    fields: {
      R2_ACCOUNT_ID: (value) => /^[a-f0-9]{32}$/i.test(value),
      R2_ACCESS_KEY_ID: null,
      R2_SECRET_ACCESS_KEY: null,
      R2_BUCKET: null,
      R2_PUBLIC_URL: httpsUrl,
    },
  },
  {
    name: "Stripe payments",
    required: true,
    fields: {
      STRIPE_KEY: (value) => /^(?:sk|rk)_(?:test|live)_\S+$/.test(value),
      WEBHOOK_SECRET: (value) => /^whsec_\S+$/.test(value),
      STRIPE_CONNECT_WEBHOOK_SECRET: (value) => /^whsec_\S+$/.test(value),
      STRIPE_BILLING_WEBHOOK_SECRET: (value) => /^whsec_\S+$/.test(value),
    },
  },
  {
    name: "System SMTP",
    required: true,
    fields: {
      EMAIL_USER: email,
      EMAIL_PASSWORD: null,
    },
  },
  {
    name: "Managed tenant email",
    required: false,
    fields: {
      POSTMARK_ACCOUNT_TOKEN: null,
      POSTMARK_SYSTEM_SERVER_TOKEN: null,
      POSTMARK_SYSTEM_FROM_EMAIL: email,
      POSTMARK_OUTBOUND_WEBHOOK_URL: httpsUrl,
      POSTMARK_OUTBOUND_WEBHOOK_USERNAME: (value) =>
        value.length >= 8 && !value.includes(":"),
      POSTMARK_OUTBOUND_WEBHOOK_PASSWORD: secret(32),
    },
  },
  {
    name: "Custom-domain authentication",
    required: false,
    fields: {
      AUTH_FIRST_PARTY_PROXY_SECRET: secret(32),
      AUTH_SESSION_HANDOFF_SECRET: secret(32),
    },
  },
];

export const inspectConfiguration = (configuration) => {
  const checks = groups.map(({ name, required, fields }) => {
    const issues = Object.entries(fields).flatMap(([key, validate]) => {
      const value = configuration[key];
      const reason = !filled(value)
        ? "missing"
        : placeholder(value)
          ? "placeholder"
          : validate && !validate(value.trim())
            ? "invalid format"
            : null;
      return reason ? [{ key, reason }] : [];
    });
    return {
      name,
      required,
      issues,
      status: issues.length ? "attention" : "ok",
    };
  });
  const application = checks[0];
  if (!filled(configuration.MONGO_URI) && filled(configuration.MONGODB_URI)) {
    application.issues.push({
      key: "MONGODB_URI",
      reason: "unused; set MONGO_URI with an explicit application database",
    });
  }
  const dns = configuration.DNS_SERVERS?.trim();
  if (dns && dns.split(",").some((server) => !isIP(server.trim()))) {
    application.issues.push({
      key: "DNS_SERVERS",
      reason: "must be comma-separated IP addresses",
    });
    application.status = "attention";
  }
  const r2 = checks.find((check) => check.name === "R2 uploads");
  if (
    filled(configuration.R2_JURISDICTION) &&
    !["eu", "fedramp"].includes(
      configuration.R2_JURISDICTION.trim().toLowerCase(),
    )
  ) {
    r2.issues.push({
      key: "R2_JURISDICTION",
      reason: "must be eu or fedramp when set",
    });
  }
  if (filled(configuration.R2_ENDPOINT)) {
    const account = String(configuration.R2_ACCOUNT_ID || "")
      .trim()
      .toLowerCase();
    const jurisdiction = configuration.R2_JURISDICTION?.trim().toLowerCase();
    let valid = false;
    try {
      const endpoint = new URL(configuration.R2_ENDPOINT);
      const allowed = jurisdiction ? [jurisdiction] : [null, "eu", "fedramp"];
      valid =
        httpsUrl(configuration.R2_ENDPOINT) &&
        !endpoint.port &&
        !endpoint.search &&
        !endpoint.hash &&
        endpoint.pathname === "/" &&
        allowed.some(
          (region) =>
            endpoint.hostname ===
            `${account}${region ? `.${region}` : ""}.r2.cloudflarestorage.com`,
        );
    } catch {
      /* Report only the key, never the supplied URL. */
    }
    if (!valid)
      r2.issues.push({
        key: "R2_ENDPOINT",
        reason: "must match the configured R2 account and jurisdiction",
      });
  }
  r2.status = r2.issues.length ? "attention" : "ok";
  const customAuth = checks.find(
    (check) => check.name === "Custom-domain authentication",
  );
  if (
    filled(configuration.AUTH_FIRST_PARTY_PROXY_SECRET) &&
    configuration.AUTH_FIRST_PARTY_PROXY_SECRET ===
      configuration.AUTH_SESSION_HANDOFF_SECRET
  ) {
    customAuth.issues.push({
      key: "AUTH_SESSION_HANDOFF_SECRET",
      reason: "must differ from the proxy secret",
    });
    customAuth.status = "attention";
  }
  return checks;
};

export const MONGO_CHECK_OPTIONS = Object.freeze({
  autoIndex: false,
  autoCreate: false,
  bufferCommands: false,
  maxPoolSize: 1,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 5000,
  waitQueueTimeoutMS: 5000,
  appName: "shario-development-doctor",
});

const safeMongoFailure = (error) => {
  if (error?.code === 18 || error?.codeName === "AuthenticationFailed")
    return "MongoDB authentication failed. Check the database user and credentials privately.";
  if (error?.code === 13 || error?.codeName === "Unauthorized")
    return "MongoDB permission check failed. The user needs access to the configured application database.";
  return "MongoDB check failed. Check the URI, DNS, Atlas network access, database credentials and availability privately.";
};

export const inspectMongo = async (uri, { createConnection } = {}) => {
  let connection;
  try {
    if (!createConnection) {
      const { Mongoose } = await import("mongoose");
      const isolated = new Mongoose();
      isolated.set("debug", false);
      createConnection = (value, options) =>
        isolated.createConnection(value, options);
    }
    connection = createConnection(uri, { ...MONGO_CHECK_OPTIONS });
    await connection.asPromise();
    const db = connection.db;
    await db.command({ ping: 1 }, { maxTimeMS: 3000 });
    const topology = await db.command({ hello: 1 }, { maxTimeMS: 3000 });
    const collections = await db
      .listCollections(
        {},
        {
          nameOnly: true,
          authorizedCollections: true,
          maxTimeMS: 3000,
        },
      )
      .toArray();
    const transactionsSupported =
      Boolean(topology.setName) || topology.msg === "isdbgrid";
    return {
      status: transactionsSupported ? "ok" : "attention",
      detail: transactionsSupported
        ? "Ping succeeded; transaction-capable topology detected."
        : "Ping succeeded, but registration and booking require Atlas or a replica set.",
      visibleCollections: collections.length,
    };
  } catch (error) {
    return { status: "attention", detail: safeMongoFailure(error) };
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch {
        /* Never expose driver errors. */
      }
    }
  }
};

export const runDoctor = async (
  configuration,
  { offline = false, createConnection } = {},
) => {
  const checks = inspectConfiguration(configuration);
  const mongoBlocked = checks[0].issues.some(({ key }) =>
    ["MONGO_URI", "DNS_SERVERS"].includes(key),
  );
  let mongo = {
    status: "skipped",
    detail: offline
      ? "Offline mode; database was not contacted."
      : "Set a valid MONGO_URI with an explicit application database before probing.",
  };
  if (!offline && !mongoBlocked) {
    if (configuration.DNS_SERVERS?.trim())
      setServers(
        configuration.DNS_SERVERS.split(",").map((value) => value.trim()),
      );
    mongo = await inspectMongo(configuration.MONGO_URI, { createConnection });
  }
  return {
    checks,
    mongo,
    exitCode:
      checks.some((check) => check.required && check.status !== "ok") ||
      mongo.status === "attention"
        ? 1
        : 0,
  };
};

export const formatReport = ({ checks, mongo }) =>
  [
    "Shario development doctor",
    ...checks.map((check) =>
      check.status === "ok"
        ? `PASS ${check.name}: required values are present.`
        : `${check.required ? "FAIL" : "WARN"} ${check.name}: ${check.issues.map(({ key, reason }) => `${key} (${reason})`).join(", ")}.`,
    ),
    `${mongo.status === "ok" ? "PASS" : mongo.status === "skipped" ? "SKIP" : "FAIL"} MongoDB: ${mongo.detail}`,
    ...(mongo.visibleCollections === undefined
      ? []
      : [
          `Visible collections: ${mongo.visibleCollections}. Names are not printed; document data was not read.`,
        ]),
    "Provider credentials are checked locally for missing/placeholder values only; external provider access and Redis connectivity are not tested.",
  ].join("\n");

export const main = async (args = process.argv.slice(2)) => {
  if (args.includes("--help")) {
    console.log(
      "Usage: npm run doctor [-- --offline]\nReads .env with shell environment overrides. MongoDB checks are read-only. No app, workers or provider requests are started.",
    );
    return 0;
  }
  if (args.some((arg) => arg !== "--offline")) {
    console.error("Unsupported option. Use npm run doctor -- --help.");
    return 1;
  }
  let fileEnvironment = {};
  try {
    fileEnvironment = parse(await readFile(resolve(root, ".env"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(
        "Cannot read the server .env file. Check its permissions privately.",
      );
      return 1;
    }
  }
  const report = await runDoctor(
    { ...fileEnvironment, ...process.env },
    { offline: args.includes("--offline") },
  );
  console.log(formatReport(report));
  return report.exitCode;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        "Development diagnostics could not finish. No raw configuration or error details were printed.",
      );
      process.exitCode = 1;
    });
}
