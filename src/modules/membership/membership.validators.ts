import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_APP_LOCALE,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import {
  DEFAULT_MEMBERSHIP_LIMIT,
  DEFAULT_MEMBERSHIP_PAGE,
  MAX_MEMBERSHIP_BENEFIT_ADJUSTMENT,
  MAX_MEMBERSHIP_LIMIT,
  MEMBERSHIP_ADJUSTMENT_REASON,
  MEMBERSHIP_ASSIGNMENT_REASON,
  MEMBERSHIP_ALLOWANCE_UNIT,
  MEMBERSHIP_BILLING_INTERVAL,
  MEMBERSHIP_CANCELLATION_EFFECTIVE,
  MEMBERSHIP_CANCELLATION_REASON,
  MEMBERSHIP_LIMIT_UNIT,
  MEMBERSHIP_PERCENTAGE_APPLIES_TO,
  MEMBERSHIP_PLAN_STATUS,
  MEMBERSHIP_STATUS,
} from "./membership.constants.js";

export const objectIdSchema = (fieldName: string) =>
  z.string().trim().refine(
    (value) => mongoose.Types.ObjectId.isValid(value),
    `${fieldName} must be a valid object id.`,
  );

const idempotencyKeySchema = z.string().trim().min(8).max(160);
const benefitKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/);
const currencySchema = z.string().trim().toUpperCase().pipe(z.enum(STUDIO_COMMERCE_CURRENCIES));
const safeNonnegativeInteger = z.coerce.number().int().nonnegative().safe();
const safePositiveInteger = z.coerce.number().int().positive().safe();
const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const translationLocaleSchema = z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES);
const membershipTranslationsSchema = z.partialRecord(translationLocaleSchema, z.object({
  name: z.string().trim().max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(10_000).optional(),
}).strict());
const benefitTranslationsSchema = z.partialRecord(translationLocaleSchema, z.object({
  label: z.string().trim().max(120).optional(),
}).strict());

const allowanceBenefitSchema = z.object({
  key: benefitKeySchema,
  label: z.string().trim().min(1).max(120),
  translations: benefitTranslationsSchema.optional(),
  type: z.literal("allowance"),
  unit: z.enum(Object.values(MEMBERSHIP_ALLOWANCE_UNIT)),
  quantity: safeNonnegativeInteger,
  currency: currencySchema.optional(),
  expiresAfterDays: z.coerce.number().int().min(1).max(3650).optional(),
  adjustable: z.boolean().optional().default(true),
  usageScope: z.literal("open_studio").optional(),
  memberOnly: z.literal(true).optional(),
  rolloverPercent: z.coerce.number().int().min(0).max(25).optional(),
}).strict().superRefine((benefit, ctx) => {
  const isTime = benefit.unit === "minute" || benefit.unit === "hour";
  if ((benefit.usageScope || benefit.memberOnly || benefit.rolloverPercent !== undefined) && !isTime) {
    ctx.addIssue({ code: "custom", message: "Personal studio hours and rollover require a time allowance." });
  }
  if (benefit.usageScope && benefit.memberOnly !== true) {
    ctx.addIssue({ code: "custom", path: ["memberOnly"], message: "Studio hours are personal to the member." });
  }
  if (benefit.rolloverPercent && (benefit.unit !== "minute" || benefit.usageScope !== "open_studio" || benefit.memberOnly !== true || benefit.expiresAfterDays)) {
    ctx.addIssue({ code: "custom", path: ["rolloverPercent"], message: "Rollover requires personal Open Studio minutes expiring at the billing period end." });
  }
  if (benefit.unit === MEMBERSHIP_ALLOWANCE_UNIT.MONEY_MINOR && !benefit.currency) {
    ctx.addIssue({ code: "custom", path: ["currency"], message: "Money allowances require currency." });
  }
  if (benefit.unit !== MEMBERSHIP_ALLOWANCE_UNIT.MONEY_MINOR && benefit.currency) {
    ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency is only valid for money allowances." });
  }
});

const percentageBenefitSchema = z.object({
  key: benefitKeySchema,
  label: z.string().trim().min(1).max(120),
  translations: benefitTranslationsSchema.optional(),
  type: z.literal("percentage"),
  percentageBps: z.coerce.number().int().min(0).max(10_000),
  appliesTo: z.enum(Object.values(MEMBERSHIP_PERCENTAGE_APPLIES_TO)),
  productScope: z.enum(["all", "courses"]).optional(),
  eligibleProductIds: z.array(objectIdSchema("productId")).max(1000).optional(),
  memberOnly: z.literal(true).optional(),
}).strict().superRefine((benefit, ctx) => {
  if (benefit.productScope === "courses" && (benefit.memberOnly !== true || benefit.appliesTo !== "products")) {
    ctx.addIssue({ code: "custom", message: "Course discounts must apply to the member's own course seat." });
  }
  if (benefit.eligibleProductIds?.length && benefit.productScope !== "courses") {
    ctx.addIssue({ code: "custom", path: ["eligibleProductIds"], message: "Selected products require a course discount." });
  }
  if (new Set(benefit.eligibleProductIds ?? []).size !== (benefit.eligibleProductIds ?? []).length) {
    ctx.addIssue({ code: "custom", path: ["eligibleProductIds"], message: "Course selections must be unique." });
  }
  if (
    (benefit.appliesTo === MEMBERSHIP_PERCENTAGE_APPLIES_TO.PRODUCTS ||
      benefit.appliesTo === MEMBERSHIP_PERCENTAGE_APPLIES_TO.ALL) &&
    (benefit.percentageBps < 1 || benefit.percentageBps > 9_900)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["percentageBps"],
      message: "Product discounts must be between 0.01% and 99%.",
    });
  }
});

const limitBenefitSchema = z.object({
  key: benefitKeySchema,
  label: z.string().trim().min(1).max(120),
  translations: benefitTranslationsSchema.optional(),
  type: z.literal("limit"),
  limit: safeNonnegativeInteger,
  unit: z.enum(Object.values(MEMBERSHIP_LIMIT_UNIT)),
}).strict();

const booleanBenefitSchema = z.object({
  key: benefitKeySchema,
  label: z.string().trim().min(1).max(120),
  translations: benefitTranslationsSchema.optional(),
  type: z.literal("boolean"),
  enabled: z.boolean(),
}).strict();

export const membershipBenefitSchema = z.union([
  allowanceBenefitSchema,
  percentageBenefitSchema,
  limitBenefitSchema,
  booleanBenefitSchema,
]);

const recurringBillingSchema = z.object({
  type: z.literal("recurring"),
  interval: z.enum(Object.values(MEMBERSHIP_BILLING_INTERVAL)),
  intervalCount: z.coerce.number().int().min(1).max(12).default(1),
}).strict();

const fixedBillingSchema = z.object({
  type: z.literal("fixed"),
  durationDays: z.coerce.number().int().min(1).max(3650),
}).strict();

export const membershipBillingSchema = z.union([recurringBillingSchema, fixedBillingSchema]);

export const membershipLocationScopeSchema = z.union([
  z.object({
    type: z.literal("all"),
    locationIds: z.array(objectIdSchema("locationId")).max(0).optional().default([]),
  }).strict(),
  z.object({
    type: z.literal("selected"),
    locationIds: z.array(objectIdSchema("locationId")).min(1).max(100),
  }).strict(),
  z.object({
    type: z.literal("shared_selected"),
    locationIds: z.array(objectIdSchema("locationId")).min(1).max(100),
  }).strict(),
]);

const pricesSchema = z.array(z.object({
  currency: currencySchema,
  amountMinor: safePositiveInteger,
}).strict()).min(1).max(STUDIO_COMMERCE_CURRENCIES.length).superRefine((prices, ctx) => {
  const currencies = prices.map((price) => price.currency);
  if (new Set(currencies).size !== currencies.length) {
    ctx.addIssue({ code: "custom", message: "Each currency may appear only once." });
  }
});

export const membershipVersionConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(""),
  terms: z.string().trim().max(10_000).default(""),
  sourceLanguage: translationLocaleSchema.optional(),
  translations: membershipTranslationsSchema.optional(),
  prices: pricesSchema,
  billing: membershipBillingSchema,
  locationScope: membershipLocationScopeSchema,
  benefits: z.array(membershipBenefitSchema).max(100).default([]),
}).strict().superRefine((config, ctx) => {
  if (config.benefits.some((benefit) => benefit.type === "allowance" && (benefit.rolloverPercent ?? 0) > 0) &&
      (config.billing.type !== "recurring" || config.billing.interval !== "month" || config.billing.intervalCount !== 1)) {
    ctx.addIssue({ code: "custom", path: ["billing"], message: "Hour rollover requires monthly recurring billing." });
  }
  const keys = config.benefits.map((benefit) => benefit.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", path: ["benefits"], message: "Benefit keys must be unique." });
  }
  const legacyCreditAllowances = config.benefits.filter(
    (benefit) => benefit.type === "allowance" && benefit.unit === "credit",
  );
  if (legacyCreditAllowances.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["benefits"],
      message: "A plan may contain at most one credit allowance.",
    });
  }
  const productDiscounts = config.benefits.filter(
    (benefit) =>
      benefit.type === "percentage" &&
      ["products", "all"].includes(benefit.appliesTo),
  );
  if (productDiscounts.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["benefits"],
      message: "A plan may contain at most one product discount.",
    });
  }
});

export const createMembershipPlanSchema = membershipVersionConfigSchema.safeExtend({
  sortOrder: z.coerce.number().int().default(0),
}).strict();

export const updateMembershipPlanSchema = z.object({
  id: objectIdSchema("id"),
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(10_000).optional(),
  sourceLanguage: translationLocaleSchema.optional(),
  translations: membershipTranslationsSchema.optional(),
  prices: pricesSchema.optional(),
  billing: membershipBillingSchema.optional(),
  locationScope: membershipLocationScopeSchema.optional(),
  benefits: z.array(membershipBenefitSchema).max(100).optional(),
  sortOrder: z.coerce.number().int().optional(),
}).strict().superRefine((config, ctx) => {
  if (config.benefits) {
    const keys = config.benefits.map((benefit) => benefit.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["benefits"], message: "Benefit keys must be unique." });
    }
    if (config.benefits.filter(
      (benefit) => benefit.type === "allowance" && benefit.unit === "credit",
    ).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["benefits"],
        message: "A plan may contain at most one credit allowance.",
      });
    }
    if (config.benefits.filter(
      (benefit) =>
        benefit.type === "percentage" &&
        ["products", "all"].includes(benefit.appliesTo),
    ).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["benefits"],
        message: "A plan may contain at most one product discount.",
      });
    }
  }
});

export const listMembershipPlansSchema = z.object({
  locationId: objectIdSchema("locationId").optional(),
  includeInactive: z.coerce.boolean().default(false),
  status: z.enum(Object.values(MEMBERSHIP_PLAN_STATUS)).optional(),
  page: z.coerce.number().int().positive().default(DEFAULT_MEMBERSHIP_PAGE),
  limit: z.coerce.number().int().positive().max(MAX_MEMBERSHIP_LIMIT).default(DEFAULT_MEMBERSHIP_LIMIT),
}).strict();

export const membershipIdParamsSchema = z.object({ id: objectIdSchema("id") });
export const membershipInvoiceParamsSchema = z.object({ invoiceId: objectIdSchema("invoiceId") });
export const listMembershipInvoicesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
}).strict();
export const publicTenantMembershipParamsSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
export const publicMembershipCatalogQuerySchema = z.object({
  locationId: objectIdSchema("locationId").optional(),
}).strict();

export const publishMembershipPlanSchema = z.object({}).strict();
export const duplicateMembershipPlanSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
}).strict();

export const membershipStatusSchema = z.enum(Object.values(MEMBERSHIP_STATUS));
export const listUserMembershipsSchema = z.object({
  search: z.string().trim().max(120).optional(),
  userId: objectIdSchema("userId").optional(),
  planId: objectIdSchema("planId").optional(),
  status: membershipStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(DEFAULT_MEMBERSHIP_PAGE),
  limit: z.coerce.number().int().positive().max(MAX_MEMBERSHIP_LIMIT).default(DEFAULT_MEMBERSHIP_LIMIT),
}).strict();

export const assignMembershipSchema = z.object({
  userId: objectIdSchema("userId"),
  planId: objectIdSchema("planId"),
  planVersionId: objectIdSchema("planVersionId").optional(),
  currency: currencySchema,
  locationId: objectIdSchema("locationId").optional(),
  renewsAt: z.coerce.date().refine(
    (value) => value.getTime() > Date.now(),
    "renewsAt must be in the future.",
  ).optional(),
  autoRenew: z.boolean().default(false),
  reason: z.enum(Object.values(MEMBERSHIP_ASSIGNMENT_REASON)),
  note: z.string().trim().max(1000).default(""),
}).strict();

export const adjustmentSchema = z.object({
  benefitKey: benefitKeySchema,
  delta: z.coerce.number().int().safe().refine(
    (value) => value !== 0 && Math.abs(value) <= MAX_MEMBERSHIP_BENEFIT_ADJUSTMENT,
    `delta must be non-zero and no greater than ${MAX_MEMBERSHIP_BENEFIT_ADJUSTMENT}.`,
  ),
  reason: z.enum(Object.values(MEMBERSHIP_ADJUSTMENT_REASON)),
  note: z.string().trim().max(1000).default(""),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

export const cancellationSchema = z.object({
  effective: z.enum(Object.values(MEMBERSHIP_CANCELLATION_EFFECTIVE)).default("period_end"),
  reason: z.enum(Object.values(MEMBERSHIP_CANCELLATION_REASON)),
  comment: z.string().trim().max(1000).default(""),
}).strict();

export const customerCancellationSchema = cancellationSchema.omit({ effective: true });
export const checkoutSchema = z.object({
  planId: objectIdSchema("planId"),
  planVersionId: objectIdSchema("planVersionId").optional(),
  currency: currencySchema,
  locationId: objectIdSchema("locationId").optional(),
  locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
  origin: z.string().url().optional(),
  termsAccepted: z.literal(true),
}).strict();
export const checkoutStatusParamsSchema = z.object({
  sessionId: z.string().trim().regex(/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/),
});
export const membershipPlanChangeSchema = z.object({
  planId: objectIdSchema("planId"),
  planVersionId: objectIdSchema("planVersionId"),
  locationId: objectIdSchema("locationId").optional(),
  termsAccepted: z.literal(true),
  locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
}).strict();
export const billingPortalSchema = z.object({
  locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
  origin: z.string().url().optional(),
}).strict();

// Legacy aliases kept for route/controller compatibility.
export const cancelMembershipSchema = membershipIdParamsSchema;
export const userMembershipParamsSchema = z.object({ userId: objectIdSchema("userId") });

export type CreateMembershipPlanInput = z.infer<typeof createMembershipPlanSchema>;
export type UpdateMembershipPlanInput = z.infer<typeof updateMembershipPlanSchema>;
export type ListMembershipPlansInput = z.infer<typeof listMembershipPlansSchema>;
export type AssignMembershipInput = z.infer<typeof assignMembershipSchema>;
export type ListUserMembershipsInput = z.infer<typeof listUserMembershipsSchema>;
