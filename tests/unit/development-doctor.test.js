import { describe, expect, it, vi } from "vitest";
import {
  formatReport,
  inspectConfiguration,
  inspectMongo,
  MONGO_CHECK_OPTIONS,
  runDoctor,
} from "../../scripts/check-development.mjs";

const configured = () => ({
  SERVER_URL: "http://api.shario.localhost:4311",
  CLIENT_URL: "http://shario.localhost:4310",
  MONGO_URI: "mongodb://private-user:private-password@db.internal/shario",
  REDIS_URL: "redis://private-user:private-redis-password@cache.internal:6381",
  ACCESS_TOKEN_SECRET: "private-access-token-key-with-32-characters",
  REFRESH_TOKEN_SECRET: "private-refresh-token-key-with-32-characters",
  AUTH_EMAIL: "auth@shario.io",
  EMAIL_SECRET_KEY: "private-email-encryption-material",
  COMMUNICATION_SECRET_KEY: "private-communication-encryption-material",
  COMMUNICATION_SCHEDULER_INTERVAL_MS: "60000",
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_ACCESS_KEY_ID: "private-r2-access-key",
  R2_SECRET_ACCESS_KEY: "private-r2-secret-key",
  R2_BUCKET: "private-bucket",
  R2_PUBLIC_URL: "https://uploads.shario.io",
  STRIPE_KEY: "sk_test_private-stripe-key",
  WEBHOOK_SECRET: "whsec_private-legacy-hook",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_private-connect-hook",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_private-billing-hook",
  EMAIL_USER: "system@shario.io",
  EMAIL_PASSWORD: "private-smtp-password",
});

const mongoConnection = ({
  topology = { setName: "private-replica-name" },
  commandError,
} = {}) => {
  const db = {
    command: vi.fn(async (command) => {
      if (commandError) throw commandError;
      return command.hello ? topology : { ok: 1 };
    }),
    listCollections: vi.fn(() => ({
      toArray: async () => [{ name: "private-customer-collection" }],
    })),
  };
  return {
    db,
    asPromise: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
};

describe("development doctor", () => {
  it("identifies missing and template credentials without including any configured values", async () => {
    const configuration = {
      ...configured(),
      R2_ACCOUNT_ID: "replace_me",
      STRIPE_KEY: "sk_test_replace_me",
      EMAIL_USER: "mail@example.com",
      EMAIL_PASSWORD: "",
    };
    const report = await runDoctor(configuration, { offline: true });
    const output = formatReport(report);
    expect(report.exitCode).toBe(1);
    expect(output).toContain("R2_ACCOUNT_ID (placeholder)");
    expect(output).toContain("STRIPE_KEY (placeholder)");
    expect(output).toContain("EMAIL_USER (placeholder)");
    expect(output).toContain("EMAIL_PASSWORD (missing)");
    expect(output).toContain("POSTMARK_ACCOUNT_TOKEN (missing)");
    for (const value of Object.values(configuration).filter(Boolean)) {
      expect(output).not.toContain(value);
    }
  });

  it("requires the correct Mongo key and explicit application database without probing an alias", async () => {
    const createConnection = vi.fn();
    const aliasReport = await runDoctor(
      { MONGODB_URI: configured().MONGO_URI },
      { createConnection },
    );
    expect(formatReport(aliasReport)).toContain(
      "MONGODB_URI (unused; set MONGO_URI",
    );
    const missingDatabase = await runDoctor(
      { ...configured(), MONGO_URI: "mongodb://db.internal/?retryWrites=true" },
      { createConnection },
    );
    expect(missingDatabase.mongo.status).toBe("skipped");
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("checks only Mongo metadata with model creation/indexes disabled and a single bounded pool", async () => {
    const connection = mongoConnection();
    const createConnection = vi.fn(() => connection);
    const report = await runDoctor(configured(), { createConnection });
    expect(report.exitCode).toBe(0);
    expect(createConnection).toHaveBeenCalledWith(
      configured().MONGO_URI,
      MONGO_CHECK_OPTIONS,
    );
    expect(MONGO_CHECK_OPTIONS).toMatchObject({
      autoIndex: false,
      autoCreate: false,
      bufferCommands: false,
      maxPoolSize: 1,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    });
    expect(connection.db.command.mock.calls).toEqual([
      [{ ping: 1 }, { maxTimeMS: 3000 }],
      [{ hello: 1 }, { maxTimeMS: 3000 }],
    ]);
    expect(connection.db.listCollections).toHaveBeenCalledExactlyOnceWith(
      {},
      {
        nameOnly: true,
        authorizedCollections: true,
        maxTimeMS: 3000,
      },
    );
    expect(report.mongo.visibleCollections).toBe(1);
    expect(connection.close).toHaveBeenCalledOnce();
    const output = formatReport(report);
    for (const value of [
      ...Object.values(configured()),
      "private-replica-name",
      "private-customer-collection",
    ]) {
      expect(output).not.toContain(value);
    }
  });

  it("does not connect in offline mode", async () => {
    const createConnection = vi.fn();
    const report = await runDoctor(configured(), {
      offline: true,
      createConnection,
    });
    expect(report.exitCode).toBe(0);
    expect(report.mongo.status).toBe("skipped");
    expect(createConnection).not.toHaveBeenCalled();
  });

  it.each([18, 13, undefined])(
    "redacts raw Mongo failures and closes the connection (code %s)",
    async (code) => {
      const error = Object.assign(
        new Error(`Credential failure ${configured().MONGO_URI}`),
        { code },
      );
      const connection = mongoConnection({ commandError: error });
      const result = await inspectMongo(configured().MONGO_URI, {
        createConnection: () => connection,
      });
      expect(result.status).toBe("attention");
      expect(JSON.stringify(result)).not.toContain("private-");
      expect(connection.close).toHaveBeenCalledOnce();
      expect(connection.db.listCollections).not.toHaveBeenCalled();
    },
  );

  it("reports a standalone topology without attempting a transaction or a write", async () => {
    const connection = mongoConnection({
      topology: { isWritablePrimary: true },
    });
    const result = await inspectMongo(configured().MONGO_URI, {
      createConnection: () => connection,
    });
    expect(result.status).toBe("attention");
    expect(result.detail).toContain("replica set");
    expect(connection.db.command).toHaveBeenCalledTimes(2);
  });

  it("reports invalid R2 endpoint and DNS settings without echoing either value", () => {
    const checks = inspectConfiguration({
      ...configured(),
      R2_ENDPOINT: "https://private-user:private-password@untrusted.internal/",
      DNS_SERVERS: "private-invalid-dns-value",
    });
    expect(
      checks.find(({ name }) => name === "R2 uploads").issues,
    ).toContainEqual({
      key: "R2_ENDPOINT",
      reason: "must match the configured R2 account and jurisdiction",
    });
    expect(JSON.stringify(checks)).not.toContain("private-");
    expect(checks[0].issues.some(({ key }) => key === "DNS_SERVERS")).toBe(
      true,
    );
  });
});
