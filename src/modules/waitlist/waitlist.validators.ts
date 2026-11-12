import { z } from "zod";

import {
  DEFAULT_APP_LOCALE,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const objectId = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Enter a valid identifier.");
const token = z.string().trim().min(32).max(256);
const locale = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const canonical = normalizeRolloutEligibleAppLocale(value);

    if (!canonical) {
      ctx.addIssue({ code: "custom", message: "Unsupported locale." });
      return z.NEVER;
    }

    return canonical;
  })
  .default(DEFAULT_APP_LOCALE);

export const joinCustomerWaitlistSchema = z
  .object({ sessionId: objectId, locale })
  .strict();

export const guestWaitlistRequestSchema = z
  .object({
    sessionId: objectId,
    email: z.string().trim().email().max(320),
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    locale: locale.optional(),
  })
  .strict();

export const waitlistTokenSchema = z.object({ token }).strict();
export const guestWaitlistCheckoutSchema = z
  .object({
    token,
    email: z.string().trim().email().max(320),
    checkout: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const waitlistSessionParamsSchema = z
  .object({ sessionId: objectId })
  .strict();
export const waitlistEntryParamsSchema = z
  .object({ sessionId: objectId, entryId: objectId })
  .strict();
export const customerWaitlistEntryParamsSchema = z
  .object({ entryId: objectId })
  .strict();
export const customerWaitlistQuerySchema = z
  .object({ sessionId: objectId.optional() })
  .strict();

export const waitlistSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoPromote: z.boolean().optional(),
    offerWindowHours: z.number().int().min(1).max(168).optional(),
    cutoffHours: z.number().int().min(0).max(168).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one waitlist setting is required.",
  });

export const waitlistAdminActionSchema = z
  .object({
    reason: z.string().trim().max(500).default(""),
    overrideFifo: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.overrideFifo && !value.reason) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is required when overriding FIFO order.",
      });
    }
  });

export const waitlistAdminRemovalSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
