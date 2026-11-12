import mongoose from "mongoose";
import { z } from "zod";
import { PROMO_CODE_REGEX } from "@/modules/coupon/coupon.constants.js";
import { voucherQuoteExpectationSchema } from "@/modules/checkout/checkout.voucher.validation.js";

import {
  DEFAULT_APP_LOCALE,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const objectIdSchema = z
  .string()
  .trim()
  .refine((value) => mongoose.isValidObjectId(value), "Invalid identifier.");

const instantSchema = z
  .string()
  .trim()
  .max(80)
  .refine((value) => Number.isFinite(new Date(value).getTime()), {
    message: "Enter a valid ISO date and time.",
  });

const localeSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const locale = normalizeRolloutEligibleAppLocale(value);

    if (!locale) {
      ctx.addIssue({
        code: "custom",
        message: "Unsupported locale.",
      });
      return z.NEVER;
    }

    return locale;
  });

export const createBookingIntentSchema = z
  .object({
    productId: objectIdSchema,
    locationId: objectIdSchema.optional(),
    courseSlotId: objectIdSchema.optional(),
    courseSessionId: objectIdSchema.optional(),
    start: instantSchema.optional(),
    end: instantSchema.optional(),
    quantity: z.coerce.number().int().min(1).max(100).default(1),
    numberOfGuests: z.coerce.number().int().min(1).max(100).default(1),
    bookingMode: z.enum(["public", "private"]).optional(),
    bookingType: z.enum(["public", "private"]).optional(),
    plannedActivity: z
      .enum(["WORKSTATION", "SHARED_TABLE", "UNDEFINED"])
      .default("UNDEFINED"),
    locale: localeSchema.default(DEFAULT_APP_LOCALE),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.courseSlotId &&
      value.courseSessionId &&
      value.courseSlotId !== value.courseSessionId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["courseSlotId"],
        message: "Class session identifiers do not match.",
      });
    }
  })
  .transform(({ courseSessionId, ...value }) => {
    const bookingMode = value.bookingMode ?? value.bookingType;

    return {
      ...value,
      bookingMode,
      bookingType: bookingMode,
      courseSlotId: value.courseSlotId ?? courseSessionId,
    };
  });

export const bookingIntentTokenParamsSchema = z
  .object({
    token: z.string().trim().min(40).max(4096),
  })
  .strict();

export const checkoutBookingIntentSchema = z
  .object({
    paymentMethod: z
      .enum(["card", "money_credits", "membership_credits", "credits"])
      .transform((value) =>
        value === "credits" ? ("money_credits" as const) : value,
      ),
    membershipBenefitKey: z.string().trim().min(1).max(80).optional(),
    voucherCode: z.string().trim().toUpperCase().regex(PROMO_CODE_REGEX).optional(),
    expectedVoucherQuote: voucherQuoteExpectationSchema.optional(),
    termsAccepted: z.literal(true),
    locale: localeSchema.optional(),
    origin: z.string().trim().url().max(2048).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.voucherCode && value.paymentMethod !== "card") ctx.addIssue({ code: "custom", path: ["voucherCode"], message: "Use a voucher with card checkout; account or membership credits cannot be combined with it." });
    if (value.expectedVoucherQuote && !value.voucherCode) ctx.addIssue({ code: "custom", path: ["expectedVoucherQuote"], message: "An accepted voucher quote requires a voucher code." });
    if (value.voucherCode && !value.expectedVoucherQuote) ctx.addIssue({ code: "custom", path: ["expectedVoucherQuote"], message: "Check the voucher payment amounts before confirming." });
  });

export const quoteBookingIntentVoucherSchema = z.object({
  voucherCode: z.string().trim().toUpperCase().regex(PROMO_CODE_REGEX),
}).strict();

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Idempotency-Key is required.")
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/, "Idempotency-Key contains invalid characters.");

export type CreateBookingIntentInput = z.infer<
  typeof createBookingIntentSchema
>;
export type CheckoutBookingIntentInput = z.infer<
  typeof checkoutBookingIntentSchema
>;
