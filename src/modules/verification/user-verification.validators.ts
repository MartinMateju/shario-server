import { z } from "zod";

import { TENANT_SLUG_REGEX } from "@/modules/tenants/tenant.validators.js";
import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(TENANT_SLUG_REGEX);

export const requestEmailVerificationSchema =
  z
    .object({
      tenantSlug: tenantSlugSchema,
      email: z
        .string()
        .trim()
        .toLowerCase()
        .email()
        .max(254),
      next: z
        .string()
        .trim()
        .max(2_000)
        .optional(),
      locale:
        rolloutEligibleLocaleSchema.optional(),
    })
    .strict();

export const verifyEmailSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    token: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

// Compatibility export for the previous resend controller.
export const resendVerificationSchema =
  requestEmailVerificationSchema;

export type RequestEmailVerificationInput =
  z.infer<
    typeof requestEmailVerificationSchema
  >;
export type VerifyEmailInput = z.infer<
  typeof verifyEmailSchema
>;
