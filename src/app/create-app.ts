import compression from "compression";
import cookieParser from "cookie-parser";
import cors, { type CorsOptions } from "cors";
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";

import { apiRouter } from "@/app/routes.js";
import { isCorsOriginAllowed } from "@/config/cors-origin.js";
import { isE2ETestMode } from "@/config/e2e-mode.js";
import { env } from "@/config/env.js";
import webhookRoutes from "@/modules/checkout/checkout.webhook.routes.js";
import postmarkOutboundWebhookRoutes from "@/modules/communications/routes/postmark-outbound-webhook.routes.js";
import tenantPaymentConnectWebhookRoutes from "@/modules/tenant-payments/routes/tenant-payment-connect.webhook.routes.js";
import tenantSubscriptionWebhookRoutes from "@/modules/tenant-subscription/routes/tenant-subscription.webhook.routes.js";
import { errorHandler, notFound } from "@/shared/http/errorHandler.js";

export type CreateAppOptions = {
  /**
   * The E2E harness supplies this router. Passing it anywhere except the
   * doubly-guarded test mode is a startup error, not a silent no-op.
   */
  testControlRouter?: Router;
  /** Runs after response transforms so the harness can drain aborted handlers. */
  testRequestMiddleware?: RequestHandler;
};

const createCorsError = (origin: string): Error =>
  Object.assign(new Error(`CORS not allowed for origin: ${origin}`), {
    statusCode: 403,
    status: "fail",
    code: "CORS_ORIGIN_DENIED",
    isOperational: true,
  });

const corsConfig: CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    void isCorsOriginAllowed(origin)
      .then((allowed) => {
        callback(allowed ? null : createCorsError(origin), allowed);
      })
      .catch(() => {
        callback(createCorsError(origin), false);
      });
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Idempotency-Key",
    "X-E2E-Key",
  ],
  exposedHeaders: ["Content-Type", "Content-Disposition"],
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: env.NODE_ENV === "production" ? 86400 : 600,
};

/**
 * Constructs the real API without connecting databases, opening a listener,
 * starting queues, or registering cron jobs.
 */
export const createApp = (options: CreateAppOptions = {}) => {
  if ((options.testControlRouter || options.testRequestMiddleware) && !isE2ETestMode()) {
    throw new Error(
      "Refusing to mount E2E test controls outside guarded test mode.",
    );
  }

  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(cors(corsConfig));
  app.use(compression());
  if (options.testRequestMiddleware) app.use(options.testRequestMiddleware);
  app.use(cookieParser());

  /*
   * Provider webhooks stay before JSON parsing because Stripe handlers consume
   * the raw request body when validating signatures. The Postmark status route
   * owns a much smaller authenticated JSON parser. Customer inbound email,
   * WhatsApp, and Instagram webhooks are intentionally not mounted in this
   * outbound-only email release.
   */
  app.use("/webhook", webhookRoutes);
  app.use(
    "/webhooks/stripe/tenant-subscriptions",
    tenantSubscriptionWebhookRoutes,
  );
  app.use("/webhooks/stripe/connect", tenantPaymentConnectWebhookRoutes);
  app.use("/webhooks/postmark/outbound", postmarkOutboundWebhookRoutes);

  app.use(
    express.urlencoded({
      extended: true,
      limit: "10mb",
    }),
  );
  app.use(
    express.json({
      limit: "10mb",
    }),
  );

  if (options.testControlRouter) {
    app.use("/__e2e", options.testControlRouter);
  }

  app.use(apiRouter);
  app.use(notFound);
  app.use(errorHandler as ErrorRequestHandler);

  return app;
};

export default createApp;
