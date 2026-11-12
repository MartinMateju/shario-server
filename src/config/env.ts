import "dotenv/config";

import { z } from "zod";

import { getStripeConnectWebhookConfigurationError } from "./env.rules.js";
import { addR2EnvironmentIssues, r2EnvironmentShape } from "./r2-env.js";

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

const emptyStringToUndefined = (value: unknown): unknown => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
};

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().url().optional(),
);

const optionalStripeId = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) =>
    value
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, ""),
  )
  .refine(
    (value) =>
      !value.includes("://") && !value.includes("/") && !value.includes(":"),
    {
      message: "Expected a hostname without protocol, path or port.",
    },
  );

/*
|--------------------------------------------------------------------------
| Environment schema
|--------------------------------------------------------------------------
*/

const envSchema = z
  .object({
    /*
    |--------------------------------------------------------------------------
    | Application
    |--------------------------------------------------------------------------
    */

    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    PORT: z.coerce.number().int().positive().default(4311),

    SERVER_URL: z.string().url(),

    CLIENT_URL: z.string().url(),

    /*
     * Development hostname shared by the platform,
     * tenants and API.
     *
     * Development:
     * local.shario.io
     *
     * Production does not need this value, but keeping
     * the default makes local startup predictable.
     */
    DEVELOPMENT_ROOT_DOMAIN: hostnameSchema.default("localhost"),

    /*
     * Exact exceptional CORS origins separated by commas.
     *
     * Example:
     * https://customer-domain.com,http://192.168.1.20:3000
     */
    CORS_ALLOWED_ORIGINS: optionalString,

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    NATIVE_INVOICES_ENABLED: z.preprocess(
      emptyStringToUndefined,
      z.enum(["true", "false"]).default("false"),
    ),

    /*
    |--------------------------------------------------------------------------
    | Database
    |--------------------------------------------------------------------------
    */

    MONGO_URI: z.string().trim().min(1),

    /*
    |--------------------------------------------------------------------------
    | Authentication
    |--------------------------------------------------------------------------
    */

    ACCESS_TOKEN_SECRET: z
      .string()
      .min(32, "ACCESS_TOKEN_SECRET must contain at least 32 characters."),

    REFRESH_TOKEN_SECRET: z
      .string()
      .min(32, "REFRESH_TOKEN_SECRET must contain at least 32 characters."),

    AUTH_FIRST_PARTY_PROXY_SECRET: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .trim()
        .refine(
          (value) => Buffer.byteLength(value, "utf8") >= 32,
          "AUTH_FIRST_PARTY_PROXY_SECRET must contain at least 32 bytes.",
        )
        .optional(),
    ),

    AUTH_SESSION_HANDOFF_SECRET: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .trim()
        .refine(
          (value) => Buffer.byteLength(value, "utf8") >= 32,
          "AUTH_SESSION_HANDOFF_SECRET must contain at least 32 bytes.",
        )
        .optional(),
    ),

    /*
     * Signs short-lived, single-tenant booking-intent tokens. When omitted the
     * access-token secret is used for backwards-compatible local deployments.
     * Production should use an independent secret so either key can be rotated
     * without invalidating the other token family.
     */
    BOOKING_INTENT_SECRET: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .min(32, "BOOKING_INTENT_SECRET must contain at least 32 characters.")
        .optional(),
    ),

    AUTH_EMAIL: z.string().trim().email(),

    /*
     * Centrally managed end-customer OAuth. These values are optional as a
     * feature, but each provider must be configured completely when enabled.
     */
    CUSTOMER_SOCIAL_STATE_SECRET: optionalString,

    GOOGLE_OAUTH_CLIENT_ID: optionalString,

    GOOGLE_OAUTH_CLIENT_SECRET: optionalString,

    GOOGLE_OAUTH_REDIRECT_URI: optionalUrl,

    APPLE_OAUTH_CLIENT_ID: optionalString,

    APPLE_OAUTH_TEAM_ID: optionalString,

    APPLE_OAUTH_KEY_ID: optionalString,

    APPLE_OAUTH_PRIVATE_KEY: optionalString,

    APPLE_OAUTH_REDIRECT_URI: optionalUrl,

    /*
    |--------------------------------------------------------------------------
    | Email
    |--------------------------------------------------------------------------
    */

    EMAIL_USER: z.string().trim().email(),

    EMAIL_PASSWORD: z.string().min(1),

    EMAIL_HOST: optionalString,

    EMAIL_PORT: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().positive().optional(),
    ),

    EMAIL_SECURE: z.preprocess(
      emptyStringToUndefined,
      z.enum(["true", "false"]).optional(),
    ),

    EMAIL_ALLOW_SELF_SIGNED: z.preprocess(
      emptyStringToUndefined,
      z.enum(["true", "false"]).optional(),
    ),

    EMAIL_FROM_NAME: optionalString,

    EMAIL_REPLY_TO: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().email().optional(),
    ),

    TENANT_BILLING_EMAILS_ENABLED: z.preprocess(
      emptyStringToUndefined,
      z.enum(["true", "false"]).default("false"),
    ),

    EMAIL_SECRET_KEY: z
      .string()
      .min(16, "EMAIL_SECRET_KEY must contain at least 16 characters."),

    /*
     * Optional during rollout so unrelated server processes can still start.
     * Every operation that stores or reveals a door code fails closed when
     * this independent key is absent.
     */
    ACCESS_CODE_ENCRYPTION_KEY: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .trim()
        .refine(
          (value) => Buffer.byteLength(value, "utf8") >= 32,
          "ACCESS_CODE_ENCRYPTION_KEY must contain at least 32 bytes.",
        )
        .optional(),
    ),

    /*
     * Managed tenant email. The account token is used only to provision an
     * isolated Postmark Server for a tenant. Each returned server token is
     * encrypted at rest on that tenant's RegisteredSenderEmail document.
     */
    POSTMARK_ACCOUNT_TOKEN: optionalString,

    POSTMARK_SYSTEM_SERVER_TOKEN: optionalString,

    POSTMARK_SYSTEM_FROM_EMAIL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().toLowerCase().email().optional(),
    ),

    POSTMARK_SYSTEM_FROM_NAME: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().max(180).default("shario.io"),
    ),

    POSTMARK_FROM_DOMAIN: hostnameSchema.default("notify.shario.io"),

    POSTMARK_TENANT_SERVER_PREFIX: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .trim()
        .toLowerCase()
        .max(24)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .optional(),
    ),

    POSTMARK_MESSAGE_STREAM: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().min(1).max(100).default("outbound"),
    ),

    POSTMARK_OUTBOUND_WEBHOOK_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().url().max(2_000).optional(),
    ),

    POSTMARK_OUTBOUND_WEBHOOK_USERNAME: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .trim()
        .min(8)
        .max(128)
        .refine((value) => !value.includes(":"), {
          message: "Basic Auth usernames cannot contain a colon.",
        })
        .optional(),
    ),

    POSTMARK_OUTBOUND_WEBHOOK_PASSWORD: z.preprocess(
      emptyStringToUndefined,
      z.string().min(32).max(256).optional(),
    ),

    POSTMARK_API_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().url().default("https://api.postmarkapp.com"),
    ),

    POSTMARK_REQUEST_TIMEOUT_MS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(3_000).max(60_000).default(15_000),
    ),

    REPLY_TO_VERIFICATION_TTL_SECONDS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(300).max(86_400).default(900),
    ),

    REPLY_TO_VERIFICATION_RESEND_SECONDS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(30).max(3_600).default(60),
    ),

    REPLY_TO_VERIFICATION_MAX_ATTEMPTS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(10).default(5),
    ),

    /*
    |--------------------------------------------------------------------------
    | Communication automation
    |--------------------------------------------------------------------------
    */

    COMMUNICATION_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive(),

    /*
    |--------------------------------------------------------------------------
    | OpenAI / tenant AI platform
    |--------------------------------------------------------------------------
    */

    OPENAI_API_KEY: optionalString,

    OPENAI_BASE_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().url().default("https://api.openai.com/v1"),
    ),

    OPENAI_MODEL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().default("gpt-5.6-terra"),
    ),

    OPENAI_FAST_MODEL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().default("gpt-5.6-luna"),
    ),

    OPENAI_EMBEDDING_MODEL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().default("text-embedding-3-small"),
    ),

    OPENAI_MODERATION_MODEL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().default("omni-moderation-latest"),
    ),

    OPENAI_TRANSCRIPTION_MODEL: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().default("gpt-4o-mini-transcribe"),
    ),

    OPENAI_TIMEOUT_MS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(3_000).max(120_000).default(30_000),
    ),

    OPENAI_MAX_RETRIES: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(0).max(4).default(2),
    ),

    AI_PENDING_RUN_STALE_MS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
    ),

    /*
    |--------------------------------------------------------------------------
    | Redis
    |--------------------------------------------------------------------------
    */

    REDIS_URL: z.string().trim().min(1),

    /*
    |--------------------------------------------------------------------------
    | Stripe
    |--------------------------------------------------------------------------
    */

    STRIPE_KEY: z.string().trim().min(1),

    STRIPE_TENANT_BILLING_MODE: z.preprocess(
      emptyStringToUndefined,
      z.enum(["test", "live"]).default("test"),
    ),

    WEBHOOK_SECRET: z.string().trim().min(1),

    LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED: z.preprocess(
      emptyStringToUndefined,
      z.enum(["true", "false"]).default("false"),
    ),

    STRIPE_CONNECT_WEBHOOK_SECRET: optionalString,

    STRIPE_BILLING_WEBHOOK_SECRET: optionalString,

    STRIPE_STARTER_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_MONTHLY_V1_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_YEARLY_V1_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_MONTHLY_V1_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_YEARLY_V1_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_MONTHLY_V1_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_YEARLY_V1_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_MONTHLY_V2_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_YEARLY_V2_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_MONTHLY_V2_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_YEARLY_V2_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_MONTHLY_V2_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_YEARLY_V2_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_MONTHLY_V3_PRICE_ID: optionalStripeId,

    STRIPE_STARTER_YEARLY_V3_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_MONTHLY_V3_PRICE_ID: optionalStripeId,

    STRIPE_PROFESSIONAL_YEARLY_V3_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_MONTHLY_V3_PRICE_ID: optionalStripeId,

    STRIPE_STUDIO_PLUS_YEARLY_V3_PRICE_ID: optionalStripeId,

    STRIPE_FOUNDING_2026_V1_STARTER_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_FOUNDING_2026_V1_STARTER_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_FOUNDING_2026_V1_PROFESSIONAL_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_FOUNDING_2026_V1_PROFESSIONAL_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_FOUNDING_2026_V1_STUDIO_PLUS_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_FOUNDING_2026_V1_STUDIO_PLUS_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_PLANS_V3_2026_V1_STARTER_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_PLANS_V3_2026_V1_STARTER_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_PLANS_V3_2026_V1_PROFESSIONAL_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_PLANS_V3_2026_V1_PROFESSIONAL_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_PLANS_V3_2026_V1_STUDIO_PLUS_MONTHLY_PRICE_ID: optionalStripeId,

    STRIPE_PLANS_V3_2026_V1_STUDIO_PLUS_YEARLY_PRICE_ID: optionalStripeId,

    STRIPE_AUTOMATIC_TAX_ENABLED: z.preprocess(
      emptyStringToUndefined,
      z.enum(["true", "false"]).optional(),
    ),

    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().startsWith("bpc_").optional(),
    ),

    STRIPE_BILLING_PORTAL_PRIVACY_POLICY_URL: optionalUrl,

    STRIPE_BILLING_PORTAL_TERMS_OF_SERVICE_URL: optionalUrl,

    /*
    |--------------------------------------------------------------------------
    | Cloudflare R2
    |--------------------------------------------------------------------------
    */

    ...r2EnvironmentShape,

    /*
    |--------------------------------------------------------------------------
    | Optional service URLs
    |--------------------------------------------------------------------------
    */

    // Available if additional services need an optional URL later.
    OPTIONAL_SERVICE_URL: optionalUrl,
  })
  .superRefine((value, context) => {
    addR2EnvironmentIssues(value, context);

    const customDomainAuthSecrets = [
      value.AUTH_FIRST_PARTY_PROXY_SECRET,
      value.AUTH_SESSION_HANDOFF_SECRET,
    ];
    const configuredCustomDomainAuthSecrets =
      customDomainAuthSecrets.filter(Boolean);

    if (
      configuredCustomDomainAuthSecrets.length > 0 &&
      configuredCustomDomainAuthSecrets.length !==
        customDomainAuthSecrets.length
    ) {
      if (!value.AUTH_FIRST_PARTY_PROXY_SECRET) {
        context.addIssue({
          code: "custom",
          path: ["AUTH_FIRST_PARTY_PROXY_SECRET"],
          message:
            "Custom-domain authentication requires both proxy and handoff secrets.",
        });
      }

      if (!value.AUTH_SESSION_HANDOFF_SECRET) {
        context.addIssue({
          code: "custom",
          path: ["AUTH_SESSION_HANDOFF_SECRET"],
          message:
            "Custom-domain authentication requires both proxy and handoff secrets.",
        });
      }
    }

    if (
      value.AUTH_FIRST_PARTY_PROXY_SECRET &&
      value.AUTH_SESSION_HANDOFF_SECRET &&
      value.AUTH_FIRST_PARTY_PROXY_SECRET === value.AUTH_SESSION_HANDOFF_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_SESSION_HANDOFF_SECRET"],
        message:
          "AUTH_SESSION_HANDOFF_SECRET must be different from AUTH_FIRST_PARTY_PROXY_SECRET.",
      });
    }

    for (const [path, secret] of [
      ["AUTH_FIRST_PARTY_PROXY_SECRET", value.AUTH_FIRST_PARTY_PROXY_SECRET],
      ["AUTH_SESSION_HANDOFF_SECRET", value.AUTH_SESSION_HANDOFF_SECRET],
    ] as const) {
      if (
        secret &&
        (secret === value.ACCESS_TOKEN_SECRET ||
          secret === value.REFRESH_TOKEN_SECRET)
      ) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} must be different from the JWT signing secrets.`,
        });
      }
    }

    const message = getStripeConnectWebhookConfigurationError({
      nodeEnv: value.NODE_ENV,
      webhookSecret: value.STRIPE_CONNECT_WEBHOOK_SECRET,
    });

    if (message) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_CONNECT_WEBHOOK_SECRET"],
        message,
      });
    }

    const tenantBillingStripePrefix =
      value.STRIPE_TENANT_BILLING_MODE === "live" ? "sk_live_" : "sk_test_";

    if (!value.STRIPE_KEY.startsWith(tenantBillingStripePrefix)) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_KEY"],
        message:
          `STRIPE_KEY must start with ${tenantBillingStripePrefix} when ` +
          `STRIPE_TENANT_BILLING_MODE=${value.STRIPE_TENANT_BILLING_MODE}.`,
      });
    }

    const requireCompleteGroup = ({
      keys,
      label,
    }: {
      keys: Array<keyof typeof value>;
      label: string;
    }) => {
      const configured = keys.filter((key) => Boolean(value[key]));

      if (configured.length > 0 && configured.length !== keys.length) {
        keys.forEach((key) => {
          if (!value[key]) {
            context.addIssue({
              code: "custom",
              path: [key],
              message: `${label} configuration is incomplete.`,
            });
          }
        });
      }

      if (
        configured.length === keys.length &&
        (!value.CUSTOMER_SOCIAL_STATE_SECRET ||
          value.CUSTOMER_SOCIAL_STATE_SECRET.length < 32)
      ) {
        context.addIssue({
          code: "custom",
          path: ["CUSTOMER_SOCIAL_STATE_SECRET"],
          message:
            "CUSTOMER_SOCIAL_STATE_SECRET must contain at least 32 characters when customer social sign-in is enabled.",
        });
      }
    };

    requireCompleteGroup({
      keys: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      label: "Google customer OAuth",
    });

    requireCompleteGroup({
      keys: [
        "APPLE_OAUTH_CLIENT_ID",
        "APPLE_OAUTH_TEAM_ID",
        "APPLE_OAUTH_KEY_ID",
        "APPLE_OAUTH_PRIVATE_KEY",
      ],
      label: "Apple customer OAuth",
    });

    const postmarkWebhookKeys = [
      "POSTMARK_OUTBOUND_WEBHOOK_URL",
      "POSTMARK_OUTBOUND_WEBHOOK_USERNAME",
      "POSTMARK_OUTBOUND_WEBHOOK_PASSWORD",
    ] as const;
    const configuredPostmarkWebhookKeys = postmarkWebhookKeys.filter((key) =>
      Boolean(value[key]),
    );
    if (
      configuredPostmarkWebhookKeys.length > 0 &&
      configuredPostmarkWebhookKeys.length !== postmarkWebhookKeys.length
    ) {
      postmarkWebhookKeys.forEach((key) => {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "Postmark outbound webhook configuration is incomplete.",
          });
        }
      });
    }
    if (value.POSTMARK_OUTBOUND_WEBHOOK_URL) {
      const webhookUrl = new URL(String(value.POSTMARK_OUTBOUND_WEBHOOK_URL));
      if (webhookUrl.username || webhookUrl.password) {
        context.addIssue({
          code: "custom",
          path: ["POSTMARK_OUTBOUND_WEBHOOK_URL"],
          message: "Keep Basic Auth credentials out of the webhook URL.",
        });
      }
      if (
        !webhookUrl.pathname
          .replace(/\/+$/, "")
          .endsWith("/webhooks/postmark/outbound")
      ) {
        context.addIssue({
          code: "custom",
          path: ["POSTMARK_OUTBOUND_WEBHOOK_URL"],
          message:
            "POSTMARK_OUTBOUND_WEBHOOK_URL must target /webhooks/postmark/outbound.",
        });
      }
      if (value.NODE_ENV === "production" && webhookUrl.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["POSTMARK_OUTBOUND_WEBHOOK_URL"],
          message: "Production Postmark webhooks require HTTPS.",
        });
      }
    }

    if (value.NODE_ENV === "production") {
      for (const key of [
        "POSTMARK_ACCOUNT_TOKEN",
        "POSTMARK_SYSTEM_SERVER_TOKEN",
        "POSTMARK_SYSTEM_FROM_EMAIL",
        "POSTMARK_TENANT_SERVER_PREFIX",
        "POSTMARK_OUTBOUND_WEBHOOK_URL",
        "POSTMARK_OUTBOUND_WEBHOOK_USERNAME",
        "POSTMARK_OUTBOUND_WEBHOOK_PASSWORD",
      ] as const) {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required for production managed email.`,
          });
        }
      }
    }
  });

/*
|--------------------------------------------------------------------------
| Parse and export
|--------------------------------------------------------------------------
*/

export const env = envSchema.parse(process.env);

export type Environment = z.infer<typeof envSchema>;

