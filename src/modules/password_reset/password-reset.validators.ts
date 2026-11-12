import { TENANT_SLUG_REGEX } from "@/modules/tenants/tenant.validators.js";
import { z } from "zod";

import { resolveCommunicationContentLocale } from "@/shared/i18n/communication-locales.js";
import { normalizeRolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

import { PASSWORD_RESET_OTP_LENGTH } from "./password-reset.constants.js";

const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(TENANT_SLUG_REGEX);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/\d/, "Password must contain at least one number.");

const passwordResetContentLocaleSchema = z.preprocess((value) => {
  const locale = normalizeRolloutEligibleAppLocale(value);
  return locale ? resolveCommunicationContentLocale(locale) : value;
}, z.enum(["cs", "en"]));

export const requestPasswordResetSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    email: emailSchema,
    locale: passwordResetContentLocaleSchema.optional(),
  })
  .strict();

export const verifyPasswordResetOtpSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    email: emailSchema,
    otp: z
      .string()
      .trim()
      .length(PASSWORD_RESET_OTP_LENGTH)
      .regex(/^\d+$/),
  })
  .strict();

export const resetPasswordWithOtpSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    resetToken: z.string().trim().regex(/^[a-f0-9]{64}$/i),
    password: passwordSchema,
  })
  .strict();

export type RequestPasswordResetInput = z.infer<
  typeof requestPasswordResetSchema
>;

export type VerifyPasswordResetOtpInput = z.infer<
  typeof verifyPasswordResetOtpSchema
>;

export type ResetPasswordWithOtpInput = z.infer<
  typeof resetPasswordWithOtpSchema
>;
