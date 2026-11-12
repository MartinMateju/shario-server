import { z } from "zod";

import { badRequest } from "@/shared/http/httpErrors.js";
import {
  DEFAULT_APP_LOCALE,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

export const tenantPaymentConnectOnboardingSchema = z
  .object({
    locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
    setupStep: z.literal("payments").optional(),
  })
  .strict();

export type TenantPaymentConnectLocale = z.infer<
  typeof tenantPaymentConnectOnboardingSchema
>["locale"];

export type TenantPaymentConnectSetupStep = z.infer<
  typeof tenantPaymentConnectOnboardingSchema
>["setupStep"];

export const validateTenantPaymentInput = <T>(
  schema: z.ZodType<T>,
  value: unknown,
): T => {
  const result = schema.safeParse(value ?? {});

  if (!result.success) {
    badRequest({
      message: "Invalid request body.",
      code: "INVALID_REQUEST_BODY",
      details: result.error.flatten(),
    });
  }

  return result.data;
};
