import mongoose from "mongoose";
import { z } from "zod";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  ALLOWED_CREDIT_PURCHASE_AMOUNTS,
  DEFAULT_CREDIT_LIMIT,
  DEFAULT_CREDIT_PAGE,
  MAX_CREDIT_LIMIT,
} from "./money-credit.constants.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}.`,
    });

const positiveAmountSchema = z.coerce
  .number()
  .finite()
  .positive("Amount must be positive.");

export const userIdParamsSchema = z.object({
  userId: objectIdSchema("user id"),
});

export const transactionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(DEFAULT_CREDIT_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_CREDIT_LIMIT)
    .default(DEFAULT_CREDIT_LIMIT),
});

export const addCreditsSchema = z.object({
  userId: objectIdSchema("user id"),
  amount: positiveAmountSchema,
  description: z.string().trim().default("Credits added"),
});

export const useCreditsSchema = z.object({
  userId: objectIdSchema("user id"),
  amount: positiveAmountSchema,
  description: z.string().trim().default("Credits used"),
});

export const refundCreditsSchema = z.object({
  userId: objectIdSchema("user id"),
  amount: positiveAmountSchema,
  description: z.string().trim().default("Credits refunded"),
});

export const purchaseCreditsSchema = z.object({
  amount: z.coerce.number().refine(
    (value) => ALLOWED_CREDIT_PURCHASE_AMOUNTS.includes(value as never),
    {
      message: `Amount must be one of: ${ALLOWED_CREDIT_PURCHASE_AMOUNTS.join(
        ", ",
      )}.`,
    },
  ),
  // Optional for compatibility with older clients. The service always derives
  // the authoritative currency from the tenant and only uses this as a
  // mismatch guard.
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(STUDIO_COMMERCE_CURRENCIES))
    .optional(),
  origin: z.string().trim().optional(),
  locationReference: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/)
    .optional(),
  locale:
    rolloutEligibleLocaleSchema.optional(),
});

export const adminGrantCreditsSchema = z.object({
  targetUserId: objectIdSchema("target user id"),
  amount: positiveAmountSchema,
  reason: z.string().trim().min(1, "Reason is required."),
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
});

export type AddCreditsInput = z.infer<typeof addCreditsSchema>;
export type UseCreditsInput = z.infer<typeof useCreditsSchema>;
export type RefundCreditsInput = z.infer<typeof refundCreditsSchema>;
export type PurchaseCreditsInput = z.infer<typeof purchaseCreditsSchema>;
export type AdminGrantCreditsInput = z.infer<typeof adminGrantCreditsSchema>;
