import { z } from "zod";
import { portalAppearancePatchSchema } from "@/shared/appearance/portal-appearance.validators.js";

import { PASSWORD_MIN_LENGTH } from "@/modules/user/user.constants.js";
import {
  normalizeRolloutEligibleAppLocale,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
} from "@/shared/i18n/locales.js";

export const customerPreferencesSchema = z
  .object({
    defaultLanguage: z
      .preprocess(
        (value) =>
          typeof value === "string"
            ? (normalizeRolloutEligibleAppLocale(value) ?? value)
            : value,
        z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES).nullable(),
      )
      .optional(),
    portalAppearance: portalAppearancePatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one customer preference must be provided.",
  });

export const accountProfileSchema = z
  .object({
    firstname: z.string().trim().min(1).max(80).optional(),
    lastname: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().max(40).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one profile field must be provided.",
  });

export const accountPasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(256),
    confirmPassword: z.string().min(1),
  })
  .strict()
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: "The new password must be different from the current password.",
    path: ["newPassword"],
  });

export type AccountProfileInput = z.infer<typeof accountProfileSchema>;
export type AccountPasswordInput = z.infer<typeof accountPasswordSchema>;
export type CustomerPreferencesInput = z.infer<
  typeof customerPreferencesSchema
>;
