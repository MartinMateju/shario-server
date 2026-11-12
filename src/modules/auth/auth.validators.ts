import { z } from "zod";

import { TENANT_SLUG_REGEX } from "@/modules/tenants/tenant.validators.js";
import { PLATFORM_BILLING_CURRENCIES } from "@/shared/money/currency.js";
import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(254, "Email address is too long.");

const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Workspace address is too short.")
  .max(80, "Workspace address is too long.")
  .regex(
    TENANT_SLUG_REGEX,
    "Workspace address may only contain lowercase letters, numbers and hyphens.",
  );

const newPasswordSchema = z
  .string()
  .min(8, "Password must contain at least 8 characters.")
  .max(128, "Password is too long.")
  .regex(
    /\d/,
    "Password must contain at least one number.",
  );

export const registerTenantSchema = z
  .object({
    firstname: z
      .string()
      .trim()
      .min(1, "First name is required.")
      .max(80, "First name is too long."),

    lastname: z
      .string()
      .trim()
      .min(1, "Last name is required.")
      .max(80, "Last name is too long."),

    email: emailSchema,

    password: newPasswordSchema,

    tenantName: z
      .string()
      .trim()
      .min(1, "Studio name is required.")
      .max(120, "Studio name is too long."),

    slug: tenantSlugSchema,
    locale: rolloutEligibleLocaleSchema.optional(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
    currency: z.string().trim().toUpperCase()
      .pipe(z.enum(PLATFORM_BILLING_CURRENCIES)).optional(),
    timezone: z.string().trim().min(1).max(100).refine((timezone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
        return true;
      } catch {
        return false;
      }
    }, "Enter a valid IANA timezone.").optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    email: emailSchema,

    // Do not apply registration password requirements during login.
    // Existing accounts may have been created under older rules.
    password: z
      .string()
      .min(1, "Password is required.")
      .max(128, "Password is too long."),
  })
  .strict();

export const registerSchema = z
  .object({
    firstname: z
      .string()
      .trim()
      .min(1, "First name is required.")
      .max(80, "First name is too long."),

    lastname: z
      .string()
      .trim()
      .min(1, "Last name is required.")
      .max(80, "Last name is too long."),

    email: emailSchema,
    password: newPasswordSchema,

    phone: z
      .string()
      .trim()
      .max(40, "Phone number is too long.")
      .optional(),

    // Public clients call the central API host, so the workspace slug must be
    // carried in the request when hostname middleware has not resolved it.
    tenantSlug: tenantSlugSchema.optional(),

    // Restored only after server-side allow-list validation in verification.
    next: z
      .string()
      .trim()
      .max(2_000)
      .optional(),

    // Preserved in the verification route, but never passed to user storage.
    locale:
      rolloutEligibleLocaleSchema.optional(),
  })
  .strict();

export const passwordResetRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const verifyOtpSchema = z
  .object({
    email: emailSchema,

    otp: z
      .string()
      .trim()
      .min(4, "Verification code is too short.")
      .max(12, "Verification code is too long."),
  })
  .strict();

export const passwordResetSchema = verifyOtpSchema
  .extend({
    password: newPasswordSchema,
  })
  .strict();

export const validateBody = <T>(
  schema: z.ZodSchema<T>,
  body: unknown,
): T => {
  const result = schema.safeParse(body);

  if (!result.success) {
    const error = new Error("Invalid request body.") as Error & {
      statusCode?: number;
      details?: unknown;
    };

    error.statusCode = 400;
    error.details = result.error.flatten();

    throw error;
  }

  return result.data;
};
