import mongoose from "mongoose";
import { z } from "zod";
import { courseContentInputSchema } from "./product.course-content.js";
import { voucherDesignSchema } from "@/modules/coupon/voucher-design.js";

import {
  BOOKABLE_PRODUCT_TYPES,
  DEFAULT_PRODUCT_LIMIT,
  MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_IMAGE_SRC_LENGTH,
  MAX_PRODUCT_LABEL_LENGTH,
  MAX_PRODUCT_LIMIT,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_PARTICIPANTS,
  MAX_PRODUCT_SEARCH_LENGTH,
  MAX_PRODUCT_SKU_LENGTH,
  MAX_PRODUCT_TEMPLATE_KEY_LENGTH,
  MIN_PRODUCT_PARTICIPANTS,
  PRODUCT_CURRENCY,
  PRODUCT_TYPES,
} from "./product.constants.js";
import {
  getLegacyCompatibilityTypeForKind,
  normalizeProductKindV2,
  PRODUCT_OPEN_STUDIO_BOOKING_MODES,
  PRODUCT_KIND,
  PRODUCT_KINDS,
  resolveLegacyProductTypeV2,
} from "./product-kind-v2.contract.js";

const productTypeValues = PRODUCT_TYPES as [string, ...string[]];
const productKindValues = PRODUCT_KINDS as [string, ...string[]];
const openStudioBookingModeValues = PRODUCT_OPEN_STUDIO_BOOKING_MODES as [
  string,
  ...string[],
];
const currencyValues = Object.values(PRODUCT_CURRENCY) as [string, ...string[]];
const bookableProductTypes = new Set<string>(BOOKABLE_PRODUCT_TYPES);

/**
 * `z.coerce.boolean()` uses JavaScript truthiness, which turns the multipart
 * value "false" into `true`. Product forms and query strings need semantic
 * boolean parsing instead.
 */
const requestBooleanSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
  }

  return value;
}, z.boolean());

const participantCapacitySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}, z.number().finite().int("Participant capacity must be a whole number.").min(MIN_PRODUCT_PARTICIPANTS).max(MAX_PRODUCT_PARTICIPANTS).nullable());

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

export const productTypeSchema = z.enum(productTypeValues);
export const productKindSchema = z.enum(productKindValues);
export const openStudioBookingModeSchema = z.enum(openStudioBookingModeValues);

export const productCurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(currencyValues));

export const openStudioPolicyFieldsSchema = z.object({
  publicCapacityMode: z.enum(["fixed", "activity"]),
  publicCapacityLimit: z.number().int().positive().nullable(),
  privateBookingSurcharge: z.number().finite().min(0),
}).strict();

const openStudioPolicyInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}, openStudioPolicyFieldsSchema.partial().nullable());

const voucherDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 9998 && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

export const voucherValiditySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("months"), months: z.number().int().min(1).max(120) }).strict(),
  z.object({ mode: z.literal("date"), date: voucherDateSchema }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);

export const voucherSettingsSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.object({
  version: z.literal(1),
  type: z.enum(["value", "experience"]),
  validity: voucherValiditySchema,
  experienceProductId: objectIdSchema("experience product id").nullable().optional(),
  experienceQuantity: z.number().int().min(1).max(100).optional(),
  eligibleProductIds: z.array(objectIdSchema("eligible product id")).max(100).optional(),
  physicalDelivery: z.object({
    enabled: z.boolean(),
    postageFeeMinor: z.number().int().min(0).max(100_000_000),
  }).strict().optional(),
}).strict().superRefine((settings, ctx) => {
  if (settings.type === "experience" && (!settings.experienceProductId || !settings.experienceQuantity)) {
    ctx.addIssue({ code: "custom", path: ["experienceProductId"], message: "Select an experience and the number of places covered." });
  }
  if (settings.type === "value" && (settings.experienceProductId || settings.experienceQuantity !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["type"], message: "Value vouchers cannot carry an experience entitlement." });
  }
  if (settings.type === "experience" && settings.eligibleProductIds?.length) {
    ctx.addIssue({ code: "custom", path: ["eligibleProductIds"], message: "Experience vouchers are scoped to their selected experience." });
  }
}));

const productBaseSchema = z.object({
  courseContent: z.preprocess(value => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, courseContentInputSchema).optional(),
  locationId: objectIdSchema("location id").nullable().optional(),
  name: z.string().trim().min(1).max(MAX_PRODUCT_NAME_LENGTH),
  description: z
    .string()
    .trim()
    .max(MAX_PRODUCT_DESCRIPTION_LENGTH)
    .default(""),
  classCategory: z
    .string()
    .trim()
    .max(MAX_PRODUCT_CLASS_CATEGORY_LENGTH)
    .optional(),
  sku: z.string().trim().max(MAX_PRODUCT_SKU_LENGTH).default(""),
  type: productTypeSchema.optional(),
  kind: productKindSchema.optional(),
  bookingMode: openStudioBookingModeSchema.nullable().optional(),
  openStudioPolicy: openStudioPolicyInputSchema.optional(),
  price: z.coerce.number().finite().min(0),
  extraCharge: z.coerce.number().finite().min(0).default(0),
  maxNumberOfParticipants: participantCapacitySchema,
  currency: productCurrencySchema.optional(),
  imageSrc: z.string().trim().max(MAX_PRODUCT_IMAGE_SRC_LENGTH).default(""),
  label: z.string().trim().max(MAX_PRODUCT_LABEL_LENGTH).default(""),
  voucherTemplate: z
    .string()
    .trim()
    .max(MAX_PRODUCT_TEMPLATE_KEY_LENGTH)
    .default(""),
  couponProduct: objectIdSchema("coupon product id").nullable().optional(),
  voucherSettings: voucherSettingsSchema.optional(),
  voucherDesign: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, voucherDesignSchema.nullable()).optional(),
  studioFlow: z.never().optional(),
  isActive: requestBooleanSchema.default(true),
  sortOrder: z.coerce.number().int().default(0),
});

const validateProduct = (
  data: {
    type?: string;
    kind?: string;
    bookingMode?: string | null;
    openStudioPolicy?: {
      publicCapacityMode?: "fixed" | "activity";
      publicCapacityLimit?: number | null;
      privateBookingSurcharge?: number;
    } | null;
    label?: string;
    price?: number;
    extraCharge?: number;
    maxNumberOfParticipants?: number | null;
    isActive?: boolean;
  },
  ctx: z.RefinementCtx,
) => {
  const explicitKind = normalizeProductKindV2(data.kind);
  const legacyResolution = resolveLegacyProductTypeV2(data.type);
  const inferredKind =
    explicitKind ??
    (legacyResolution.status === "mapped" ? legacyResolution.kind : null);

  if (!data.type && !explicitKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: "Select a product kind.",
    });
    return;
  }

  if (explicitKind && data.type) {
    const compatibilityType = getLegacyCompatibilityTypeForKind(explicitKind);
    const suppliedResolution = resolveLegacyProductTypeV2(data.type);

    if (
      !compatibilityType ||
      suppliedResolution.status !== "mapped" ||
      suppliedResolution.kind !== explicitKind
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: "Legacy product type conflicts with product kind.",
      });
    }
  }

  if (inferredKind === PRODUCT_KIND.VOUCHER && !data.label) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["label"],
      message: "Voucher products require a label.",
    });
  }

  if (explicitKind === PRODUCT_KIND.OPEN_STUDIO && !data.bookingMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bookingMode"],
      message: "Open Studio requires a shared, exclusive, or customer-choice booking mode.",
    });
  }

  if (inferredKind !== PRODUCT_KIND.OPEN_STUDIO && data.bookingMode != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bookingMode"],
      message: "Booking mode is only available for Open Studio.",
    });
  }

  if (data.openStudioPolicy != null &&
    (inferredKind !== PRODUCT_KIND.OPEN_STUDIO || data.bookingMode !== "customer-choice")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["openStudioPolicy"],
      message: "Sharing options are only available for customer-choice Open Studio products.",
    });
  }

  if (data.openStudioPolicy?.publicCapacityMode === "fixed" &&
    data.openStudioPolicy.publicCapacityLimit == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["openStudioPolicy", "publicCapacityLimit"],
      message: "Enter the maximum total number of people for public bookings.",
    });
  }

  if (inferredKind === PRODUCT_KIND.PRIVATE_STUDIO) {
    if (data.price !== 0 || (data.extraCharge ?? 0) !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price"],
        message: "Private Studio is internal and cannot have a price.",
      });
    }

    if (data.maxNumberOfParticipants != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxNumberOfParticipants"],
        message: "Private Studio does not expose customer capacity.",
      });
    }
  }

  if (
    (inferredKind === PRODUCT_KIND.OPEN_STUDIO ||
      inferredKind === PRODUCT_KIND.CLASS ||
      (data.type && bookableProductTypes.has(data.type))) &&
    data.isActive !== false &&
    data.maxNumberOfParticipants == null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxNumberOfParticipants"],
      message: "Bookable products require a participant capacity.",
    });
  }
};

export const createProductSchema =
  productBaseSchema.superRefine(validateProduct);

export const updateProductSchema = productBaseSchema.partial().extend({
  id: objectIdSchema("product id"),
});

export const deleteProductSchema = z.object({
  id: objectIdSchema("product id"),
  deleteConfirmation: z.string().max(100).optional(),
});

export const productListQuerySchema = z.object({
  locationId: objectIdSchema("location id").optional(),
  includeUnassigned: requestBooleanSchema.optional(),
  type: productTypeSchema.optional(),
  isActive: requestBooleanSchema.optional(),
  search: z.string().trim().max(MAX_PRODUCT_SEARCH_LENGTH).default(""),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PRODUCT_LIMIT)
    .default(DEFAULT_PRODUCT_LIMIT),
});

export const publicProductListQuerySchema = productListQuerySchema.pick({
  locationId: true,
  search: true,
  page: true,
  limit: true,
});

export const publicProductParamsSchema = z.object({
  productId: objectIdSchema("product id"),
});

const publicDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD.");

export const publicCourseSessionsQuerySchema = z
  .object({
    locationId: objectIdSchema("location id").optional(),
    from: publicDateSchema.optional(),
    to: publicDateSchema.optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export const couponTemplateUploadSchema = z.object({
  productName: z.string().trim().default("coupon-template"),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type DeleteProductInput = z.infer<typeof deleteProductSchema>;
export type ProductListQueryInput = z.infer<typeof productListQuerySchema>;
export type PublicProductListQueryInput = z.infer<
  typeof publicProductListQuerySchema
>;
export type CouponTemplateUploadInput = z.infer<
  typeof couponTemplateUploadSchema
>;
