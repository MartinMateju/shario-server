import type { Server } from "node:http";

import dotenv from "dotenv";
import type mongooseType from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  markRuntimeReady,
  markRuntimeShuttingDown,
} from "@/infrastructure/lifecycle/runtime-readiness.js";
import { e2eRequestBarrier } from "./e2e-request-barrier.js";
import { E2E_REDIS_URL } from "./e2e-redis.js";
import { E2E_STRIPE_KEY, installE2EStripeTransport } from "./e2e-stripe-transport.js";
import { installE2ER2Transport } from "./e2e-r2-transport.js";

dotenv.config({
  path: ".env.e2e",
  override: false,
});

const configureSafeEnvironment = (): void => {
  /*
   * These values are intentionally forced. The E2E command must not inherit a
   * production mode, port, provider key, or live-delivery setting from .env.
   */
  process.env.NODE_ENV = "test";
  process.env.E2E_TEST_MODE = "true";
  process.env.E2E_TEST_KEY =
    process.env.E2E_TEST_KEY?.trim() ||
    "shario-e2e-local-key";
  process.env.PORT = "4311";
  process.env.TZ = "UTC";
  process.env.SERVER_URL =
    "http://api.shario.localhost:4311";
  process.env.CLIENT_URL =
    "http://shario.localhost:4310";
  process.env.DEVELOPMENT_ROOT_DOMAIN =
    "shario.localhost";
  process.env.CORS_ALLOWED_ORIGINS = [
    "http://localhost:4310",
    "http://127.0.0.1:4310",
    "http://shario.localhost:4310",
    "http://studio-alpha.shario.localhost:4310",
    "http://studio-beta.shario.localhost:4310",
    "http://studio-alpha.test:4310",
  ].join(",");

  process.env.ACCESS_TOKEN_SECRET =
    "e2e-access-token-secret-at-least-32-characters";
  process.env.REFRESH_TOKEN_SECRET =
    "e2e-refresh-token-secret-at-least-32-characters";
  process.env.AUTH_EMAIL =
    "auth@shario-e2e.test";

  process.env.REDIS_URL = E2E_REDIS_URL;

  process.env.STRIPE_KEY =
    E2E_STRIPE_KEY;
  process.env.WEBHOOK_SECRET =
    "whsec_e2e_legacy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET =
    "whsec_e2e_connect";
  process.env.STRIPE_BILLING_WEBHOOK_SECRET =
    "whsec_e2e_billing";
  process.env.LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED =
    "false";

  process.env.EMAIL_USER =
    "mail@shario-e2e.test";
  process.env.EMAIL_PASSWORD =
    "e2e-no-smtp";
  process.env.EMAIL_HOST =
    "127.0.0.1";
  process.env.EMAIL_PORT = "1025";
  process.env.EMAIL_SECURE = "false";
  process.env.EMAIL_ALLOW_SELF_SIGNED =
    "false";
  process.env.EMAIL_FROM_NAME =
    "shario.io E2E";
  process.env.EMAIL_REPLY_TO =
    "support@shario-e2e.test";
  process.env.TENANT_BILLING_EMAILS_ENABLED =
    "false";
  process.env.EMAIL_SECRET_KEY =
    "e2e-email-secret-key";

  process.env.COMMUNICATION_SCHEDULER_INTERVAL_MS =
    "60000";
  process.env.COMMUNICATION_DELIVERY_MODE =
    "local";
  process.env.COMMUNICATION_SECRET_KEY =
    "e2e-communication-secret-key-at-least-32-chars";
  process.env.COMMUNICATION_WEBHOOK_SECRET =
    "e2e-communication-webhook-secret";
  process.env.EMAIL_INBOUND_WEBHOOK_SECRET =
    "e2e-email-inbound-webhook-secret";

  delete process.env.OPENAI_API_KEY;
  delete process.env.COMMUNICATION_AI_URL;
  delete process.env.COMMUNICATION_AI_TOKEN;
  process.env.OPENAI_BASE_URL =
    "https://api.openai.com/v1";

  process.env.INSTAGRAM_OAUTH_STATE_SECRET =
    "e2e-instagram-oauth-state-secret-at-least-32";
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_ACCOUNT_ID;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  process.env.INSTAGRAM_WEBHOOK_SECRET =
    "e2e-instagram-webhook-secret";
  process.env.INSTAGRAM_VERIFY_TOKEN =
    "e2e-instagram-verify-token";
  process.env.COMMUNICATION_ALLOW_PLATFORM_INSTAGRAM_TOKEN =
    "false";
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_WEBHOOK_SECRET =
    "e2e-whatsapp-webhook-secret";
  process.env.WHATSAPP_VERIFY_TOKEN =
    "e2e-whatsapp-verify-token";
  process.env.COMMUNICATION_ALLOW_PLATFORM_WHATSAPP_TOKEN =
    "false";

  process.env.R2_ACCOUNT_ID =
    "00000000000000000000000000000000";
  process.env.R2_ACCESS_KEY_ID =
    "e2e-access-key";
  process.env.R2_SECRET_ACCESS_KEY =
    "e2e-secret-key";
  process.env.R2_BUCKET = "e2e-bucket";
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_JURISDICTION;
  process.env.R2_PUBLIC_URL =
    "https://e2e.invalid";
};

configureSafeEnvironment();
installE2EStripeTransport();
installE2ER2Transport();

let replSet:
  MongoMemoryReplSet | null = null;
let mongoose:
  typeof mongooseType | null = null;
let server: Server | null = null;
let closeRedis: (() => Promise<void>) | null = null;
let shutdownPromise:
  Promise<void> | null = null;

const stop = (): Promise<void> => {
  shutdownPromise ??= (async () => {
    markRuntimeShuttingDown();
    if (server) {
      await new Promise<void>(
        (resolve, reject) => {
          server?.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        },
      );
      server = null;
    }

    if (closeRedis) {
      await closeRedis();
      closeRedis = null;
    }

    if (mongoose) {
      await mongoose.disconnect();
      mongoose = null;
    }

    if (replSet) {
      await replSet.stop();
      replSet = null;
    }
  })();

  return shutdownPromise;
};

const start = async (): Promise<void> => {
  const externalMongoUri =
    process.env.E2E_MONGO_URI?.trim();

  if (externalMongoUri) {
    if (
      process.env.E2E_ALLOW_DATABASE_RESET !==
      "true"
    ) {
      throw new Error(
        "E2E_MONGO_URI requires E2E_ALLOW_DATABASE_RESET=true because the harness deletes every document in that database.",
      );
    }

    process.env.MONGO_URI =
      externalMongoUri;
  } else {
    replSet =
      await MongoMemoryReplSet.create({
        replSet: {
          count: 1,
          storageEngine: "wiredTiger",
        },
      });
    process.env.MONGO_URI =
      replSet.getUri("shario-e2e");
  }

  const [
    mongooseModule,
    { connectDB },
    { createApp },
    {
      createE2EControlRouter,
      resetE2EFixtures,
    },
  ] = await Promise.all([
    import("mongoose"),
    import(
      "@/infrastructure/database/connect-db.js"
    ),
    import("@/app/create-app.js"),
    import("./e2e-fixtures.js"),
  ]);

  mongoose = mongooseModule.default;
  closeRedis = (await import("@/infrastructure/redis/redis.js")).closeRedisConnection;
  await connectDB();

  const initialFixtures =
    await resetE2EFixtures();
  const app = createApp({
    testRequestMiddleware: e2eRequestBarrier.middleware,
    testControlRouter:
      createE2EControlRouter(),
  });

  server = await new Promise<Server>(
    (resolve, reject) => {
      const listener = app.listen(
        4311,
        "127.0.0.1",
        () => resolve(listener),
      );
      listener.once("error", reject);
    },
  );

  // The harness starts Express directly rather than using the production
  // bootstrap. Expose readiness only after Mongo, fixtures and HTTP are ready.
  markRuntimeReady();

  process.stdout.write(
    `${JSON.stringify({
      event: "e2e-backend-ready",
      port: 4311,
      tenants: {
        alpha:
          initialFixtures.tenants.alpha
            .slug,
        beta:
          initialFixtures.tenants.beta.slug,
      },
    })}\n`,
  );
};

for (const signal of [
  "SIGINT",
  "SIGTERM",
] as const) {
  process.once(signal, () => {
    void stop().finally(() => {
      process.exit(0);
    });
  });
}

void start().catch(async (error) => {
  console.error(
    "Failed to start the E2E backend.",
    error,
  );
  await stop().catch(() => undefined);
  process.exitCode = 1;
});
