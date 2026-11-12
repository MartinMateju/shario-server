import { z } from "zod";

import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { badRequest } from "@/shared/http/httpErrors.js";
import {
  DEFAULT_APP_LOCALE,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import { PLATFORM_BILLING_CURRENCIES } from "@/shared/money/currency.js";

import { BILLING_INTERVAL } from "./tenant-subscription.constants.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

export const checkoutSchema = z
  .object({
    plan: z.enum([
      TENANT_PLAN.STARTER,
      TENANT_PLAN.PROFESSIONAL,
      TENANT_PLAN.STUDIO_PLUS,
      TENANT_PLAN.ENTERPRISE,
    ]),
    billingInterval: z.enum([
      BILLING_INTERVAL.MONTHLY,
      BILLING_INTERVAL.YEARLY,
    ]),
    billingCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(z.enum(PLATFORM_BILLING_CURRENCIES))
      .optional(),
    locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
  })
  .strict();

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const planChangeSchema = checkoutSchema.omit({ locale: true });

export type PlanChangeInput = z.infer<typeof planChangeSchema>;

export const portalSchema = z
  .object({
    locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
    flow: z.enum(["home", "payment_method_update"]).default("home"),
  })
  .strict();

export const cancelSubscriptionSchema = z
  .object({
    feedback: z
      .enum([
        "customer_service",
        "low_quality",
        "missing_features",
        "other",
        "switched_service",
        "too_complex",
        "too_expensive",
        "unused",
      ])
      .optional(),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

export const invoiceListSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    startingAfter: z.string().trim().min(1).optional(),
  })
  .strict();

export const validateSubscriptionBody = <T>(
  schema: z.ZodType<T>,
  body: unknown,
): T => {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    badRequest({
      message: "Invalid subscription request.",
      details: z.flattenError(parsed.error).fieldErrors,
    });
  }

  return parsed.data;
};
