import { z } from "zod";

import { badRequest } from "@/shared/http/httpErrors.js";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import {
  TENANT_STORED_BOOKING_TYPES,
  normalizeTenantBookingTypes,
} from "./tenant-onboarding.constants.js";

const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Timezone is required.")
  .max(100, "Timezone is too long.")
  .refine((timezone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
      return true;
    } catch {
      return false;
    }
  }, "Enter a valid IANA timezone.");

const businessTypeSchema = z.enum([
  "coworking_space",
  "rehearsal_space",
  "community_space",
  "art_studio",
  "photography_studio",
  "wellness_studio",
  "other",
]);

const teamSizeSchema = z.enum(["just_me", "2_5", "6_15", "16_plus"]);

const bookingTypeSchema = z.enum(TENANT_STORED_BOOKING_TYPES);

const confirmationModeSchema = z.enum(["instant", "manual"]);

const studioProfileStepSchema = z
  .object({
    step: z.literal(1),
    tenantName: z.string().trim().min(1).max(120),
    businessType: businessTypeSchema,
    // Team size is useful metadata, but it is not required to launch a studio.
    // Keep accepting it from older clients while allowing the essentials-only
    // Launch Center profile to omit it.
    teamSize: teamSizeSchema.optional(),
  })
  .strict();

const businessDetailsStepSchema = z
  .object({
    step: z.literal(2),
    businessDetails: z
      .object({
        country: z.string().trim().min(1).max(80),
        city: z.string().trim().max(120).optional(),
        address: z.string().trim().max(240).optional(),
        phone: z.string().trim().max(40).optional(),
      })
      .strict(),
    settings: z
      .object({
        currency: z
          .string()
          .trim()
          .toUpperCase()
          .pipe(z.enum(STUDIO_COMMERCE_CURRENCIES)),
        timezone: timezoneSchema,
      })
      .strict(),
  })
  .strict();

const bookingStepSchema = z
  .object({
    step: z.literal(3),
    bookingSetup: z
      .object({
        /*
         * Booking setup is intentionally optional. A workspace may use only
         * firings, courses, inventory, or communications and should not have
         * to invent a booking workflow during onboarding.
         */
        bookingTypes: z
          .array(bookingTypeSchema)
          .max(4)
          .default([])
          .transform(normalizeTenantBookingTypes),
        confirmationMode: confirmationModeSchema.optional(),
      })
      .strict()
      .default({ bookingTypes: [] }),
  })
  .strict();

export const saveTenantOnboardingStepSchema = z.discriminatedUnion("step", [
  studioProfileStepSchema,
  businessDetailsStepSchema,
  bookingStepSchema,
]);

export type SaveTenantOnboardingStepInput = z.infer<
  typeof saveTenantOnboardingStepSchema
>;

export const validateOnboardingBody = <T>(
  schema: z.ZodType<T>,
  body: unknown,
): T => {
  const result = schema.safeParse(body);

  if (!result.success) {
    return badRequest({
      message: "Invalid launch details.",
      details: z.flattenError(result.error).fieldErrors,
    });
  }

  return result.data;
};
