import mongoose from "mongoose";
import { z } from "zod";
import validator from "validator";
import { voucherGiftMessageSchema } from "./voucher-delivery-design.js";

import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  COUPON_SORT_FIELD,
  COUPON_STATUS,
  DEFAULT_COUPON_LIMIT,
  DEFAULT_COUPON_PAGE,
  MAX_COUPON_LIMIT,
  PROMO_CODE_REGEX,
  SORT_ORDER,
} from "./coupon.constants.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}`,
    });

export const promoCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PROMO_CODE_REGEX, "Invalid promo code format.");

export const PUBLIC_VOUCHER_CHECKOUT_LIMITS = Object.freeze({
  quantity: 20,
  origin: 2_048,
  name: 80,
  email: 254,
  street: 200,
  city: 120,
  postalCode: 40,
  note: 2_000,
  giftMessage: 240,
});

export const couponCheckoutSchema = z
  .object({
    origin: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.origin)
      .optional(),
    locale:
      rolloutEligibleLocaleSchema.optional(),
    productId: objectIdSchema("productId"),
    giftMessage: voucherGiftMessageSchema.optional(),
    quantity: z.coerce
      .number()
      .int()
      .positive()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.quantity)
      .default(1),

    firstname: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.name)
      .default(""),
    lastname: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.name)
      .default(""),
    email: z
      .email()
      .trim()
      .toLowerCase()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.email),

    sendPost: z.boolean().default(false),
    street: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.street)
      .default(""),
    city: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.city)
      .default(""),
    postalCode: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.postalCode)
      .default(""),
    countryCode: z
      .string()
      .trim()
      .toUpperCase()
      .max(2)
      .refine((value) => value === "" || validator.isISO31661Alpha2(value), {
        message: "Use a valid two-letter country code.",
      })
      .optional(),
    note: z
      .string()
      .trim()
      .max(PUBLIC_VOUCHER_CHECKOUT_LIMITS.note)
      .default(""),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.sendPost) {
      return;
    }

    for (const field of [
      "firstname",
      "lastname",
      "street",
      "city",
      "postalCode",
      "countryCode",
    ] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for post delivery.`,
        });
      }
    }
  });

export const redeemCouponSchema = z.object({
  promoCode: promoCodeSchema,
});

export const couponOrderFilterSchema = z.object({
  search: z.string().trim().default(""),
  userCustomId: z.string().trim().default(""),
  userEmail: z.string().trim().toLowerCase().default(""),
  productType: z.string().trim().default(""),
  productId: objectIdSchema("productId").optional(),
  physicalStatus: z.enum([
    "all", "awaiting_payment", "awaiting_dispatch", "dispatched", "cancelled", "review_required",
  ]).default("all"),

  status: z.enum(COUPON_STATUS).optional(),

  sendPost: z.preprocess(
    (value) => value === "true" ? true : value === "false" ? false : value,
    z.union([z.literal("all"), z.boolean()]),
  ).default("all"),

  page: z.coerce.number().int().positive().default(DEFAULT_COUPON_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_COUPON_LIMIT)
    .default(DEFAULT_COUPON_LIMIT),

  sortBy: z.enum(COUPON_SORT_FIELD).default(COUPON_SORT_FIELD.CREATED_AT),

  sortOrder: z.enum(SORT_ORDER).default(SORT_ORDER.DESC),
});

export const couponFilterSchema = z.object({
  search: z.string().trim().default(""),
  productId: objectIdSchema("productId").optional(),
  archiveState: z.enum(["unarchived", "archived", "all"]).default("unarchived"),
  status: z.enum([
    "all", "active", "partially_redeemed", "reserved", "redeemed",
    "expired", "revoked", "review_required", "inactive",
  ]).default("all"),

  isActive: z.union([z.literal("all"), z.coerce.boolean()]).default(true),

  page: z.coerce.number().int().positive().default(DEFAULT_COUPON_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_COUPON_LIMIT)
    .default(DEFAULT_COUPON_LIMIT),

  sortOrder: z.enum(SORT_ORDER).default(SORT_ORDER.DESC),
});

export const manualPromoCodeSchema = z.object({
  productId: objectIdSchema("productId"),
  email: z.email().trim().toLowerCase(),
  note: z.string().trim().default(""),
  operationId: z.uuid().optional(),
});

export const revokeVoucherSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  operationId: z.uuid(),
}).strict();

export const updateCouponOrderStatusSchema = z.object({
  couponOrderId: objectIdSchema("couponOrderId"),
  newStatus: z.enum(COUPON_STATUS),
});

export const couponIdParamsSchema = z.object({
  id: objectIdSchema("coupon order id"),
});

export type CouponCheckoutInput = z.infer<typeof couponCheckoutSchema>;
export type RedeemCouponInput = z.infer<typeof redeemCouponSchema>;
export type CouponOrderFilterInput = z.infer<typeof couponOrderFilterSchema>;
export type CouponFilterInput = z.infer<typeof couponFilterSchema>;
export type ManualPromoCodeInput = z.infer<typeof manualPromoCodeSchema>;
export type UpdateCouponOrderStatusInput = z.infer<
  typeof updateCouponOrderStatusSchema
>;
