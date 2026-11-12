import mongoose, { Schema } from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";
import { membershipBenefitTranslationsField, membershipTranslationsField } from "./membership.localization.js";
import {
  MEMBERSHIP_ALLOWANCE_UNIT,
  MEMBERSHIP_BENEFIT_TYPE,
  MEMBERSHIP_BILLING_INTERVAL,
  MEMBERSHIP_BILLING_TYPE,
  MEMBERSHIP_LIMIT_UNIT,
  MEMBERSHIP_LOCATION_SCOPE,
  MEMBERSHIP_PERCENTAGE_APPLIES_TO,
  MEMBERSHIP_PLAN_VERSION_STATUS,
} from "./membership.constants.js";

const priceSchema = new Schema(
  {
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      uppercase: true,
      trim: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Membership price must be an integer number of minor units.",
      },
    },
  },
  { _id: false, strict: true },
);

const benefitSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/,
      maxlength: 80,
    },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    translations: membershipBenefitTranslationsField(),
    type: {
      type: String,
      enum: Object.values(MEMBERSHIP_BENEFIT_TYPE),
      required: true,
    },
    unit: {
      type: String,
      enum: [
        ...Object.values(MEMBERSHIP_ALLOWANCE_UNIT),
        ...Object.values(MEMBERSHIP_LIMIT_UNIT),
      ],
      default: undefined,
    },
    quantity: { type: Number, min: 0, default: undefined },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      uppercase: true,
      default: undefined,
    },
    expiresAfterDays: { type: Number, min: 1, default: undefined },
    adjustable: { type: Boolean, default: undefined },
    usageScope: { type: String, enum: ["open_studio"], default: undefined },
    memberOnly: { type: Boolean, default: undefined },
    rolloverPercent: { type: Number, min: 0, max: 25, default: undefined },
    productScope: { type: String, enum: ["all", "courses"], default: undefined },
    eligibleProductIds: { type: [String], default: undefined },
    percentageBps: { type: Number, min: 0, max: 10_000, default: undefined },
    appliesTo: {
      type: String,
      enum: Object.values(MEMBERSHIP_PERCENTAGE_APPLIES_TO),
      default: undefined,
    },
    limit: { type: Number, min: 0, default: undefined },
    enabled: { type: Boolean, default: undefined },
  },
  { _id: false, strict: true },
);

const locationScopeSchema = new Schema(
  {
    type: {
      type: String,
      enum: Object.values(MEMBERSHIP_LOCATION_SCOPE),
      required: true,
    },
    locationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Location" }],
      default: [],
    },
  },
  { _id: false, strict: true },
);

export const membershipPlanVersionSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
      index: true,
    },
    plan: {
      type: Schema.Types.ObjectId,
      ref: "MembershipPlan",
      required: true,
      immutable: true,
      index: true,
    },
    version: { type: Number, required: true, min: 1, immutable: true },
    status: {
      type: String,
      enum: Object.values(MEMBERSHIP_PLAN_VERSION_STATUS),
      default: MEMBERSHIP_PLAN_VERSION_STATUS.DRAFT,
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, default: "", maxlength: 2000 },
    terms: { type: String, trim: true, default: "", maxlength: 10_000 },
    sourceLanguage: { type: String, enum: ROLLOUT_ELIGIBLE_APP_LOCALES, default: undefined },
    translations: membershipTranslationsField(),
    prices: { type: [priceSchema], required: true, default: [] },
    billing: {
      type: {
        type: String,
        enum: Object.values(MEMBERSHIP_BILLING_TYPE),
        required: true,
      },
      interval: {
        type: String,
        enum: Object.values(MEMBERSHIP_BILLING_INTERVAL),
        default: undefined,
      },
      intervalCount: { type: Number, min: 1, max: 12, default: undefined },
      durationDays: { type: Number, min: 1, max: 3650, default: undefined },
    },
    locationScope: {
      type: locationScopeSchema,
      required: true,
      default: () => ({ type: MEMBERSHIP_LOCATION_SCOPE.ALL, locationIds: [] }),
    },
    benefits: { type: [benefitSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true, optimisticConcurrency: true },
);

membershipPlanVersionSchema.index({ tenant: 1, plan: 1, version: 1 }, { unique: true });
membershipPlanVersionSchema.index({ tenant: 1, plan: 1, status: 1 });
membershipPlanVersionSchema.index({ tenant: 1, "locationScope.locationIds": 1 });

membershipPlanVersionSchema.pre("validate", function validateSnapshot() {
  const currencies = (this.prices ?? []).map((price: any) => price.currency);
  if (!currencies.length || new Set(currencies).size !== currencies.length) {
    this.invalidate("prices", "Membership prices must contain unique currencies.");
  }

  if (this.locationScope?.type === MEMBERSHIP_LOCATION_SCOPE.ALL) {
    this.locationScope.locationIds = [] as any;
  } else if (!this.locationScope?.locationIds?.length) {
    this.invalidate("locationScope.locationIds", "Selected location scope requires a location.");
  }

  if (this.billing?.type === MEMBERSHIP_BILLING_TYPE.FIXED) {
    if (!this.billing.durationDays) {
      this.invalidate("billing.durationDays", "Fixed memberships require durationDays.");
    }
    this.billing.interval = undefined as any;
    this.billing.intervalCount = undefined as any;
  } else if (!this.billing?.interval || !this.billing?.intervalCount) {
    this.invalidate("billing", "Recurring memberships require interval and intervalCount.");
  }

  for (const [index, benefit] of (this.benefits ?? []).entries()) {
    if ((benefit as any).unit === "money_minor" && !(benefit as any).currency) {
      this.invalidate(`benefits.${index}.currency`, "Money benefits require a currency.");
    }
    if ((benefit as any).rolloverPercent > 0 &&
        (benefit.unit !== "minute" || (benefit as any).usageScope !== "open_studio" ||
         (benefit as any).memberOnly !== true || benefit.expiresAfterDays ||
         this.billing?.type !== "recurring" || this.billing.interval !== "month" || this.billing.intervalCount !== 1)) {
      this.invalidate(`benefits.${index}.rolloverPercent`, "Rollover requires personal studio minutes and monthly billing.");
    }
  }

  const keys = (this.benefits ?? []).map((benefit: any) => benefit.key);
  if (new Set(keys).size !== keys.length) {
    this.invalidate("benefits", "Membership benefit keys must be unique.");
  }
  if ((this.benefits ?? []).filter(
    (benefit: any) => benefit.type === "allowance" && benefit.unit === "credit",
  ).length > 1) {
    this.invalidate("benefits", "A plan may contain at most one credit allowance.");
  }
  const productDiscounts = (this.benefits ?? []).filter(
    (benefit: any) =>
      benefit.type === "percentage" &&
      ["products", "all"].includes(benefit.appliesTo),
  );
  if (productDiscounts.length > 1) {
    this.invalidate("benefits", "A plan may contain at most one product discount.");
  }
  for (const [index, benefit] of productDiscounts.entries()) {
    if (benefit.percentageBps < 1 || benefit.percentageBps > 9_900) {
      this.invalidate(
        `benefits.${index}.percentageBps`,
        "Product discounts must be between 0.01% and 99%.",
      );
    }
  }
});

// A draft may be edited and transitioned once. A persisted published snapshot
// can never be edited, replaced or removed through model update operations.
membershipPlanVersionSchema.pre("save", async function protectPublishedVersion() {
  if (this.isNew) return;
  const existing = await (this.constructor as mongoose.Model<any>)
    .findById(this._id)
    .select("status")
    .lean()
    .exec();
  if (existing?.status === MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED) {
    throw new Error("Published membership plan versions are immutable.");
  }
});

const protectPublishedQuery = async function (this: mongoose.Query<any, any>) {
  const publishedExists = await this.model.exists({
    $and: [
      this.getFilter(),
      { status: MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED },
    ],
  });
  if (publishedExists) {
    throw new Error("Published membership plan versions are immutable.");
  }
};

membershipPlanVersionSchema.pre("findOneAndUpdate", protectPublishedQuery);
membershipPlanVersionSchema.pre("findOneAndReplace", protectPublishedQuery);
membershipPlanVersionSchema.pre("findOneAndDelete", protectPublishedQuery);
membershipPlanVersionSchema.pre("updateOne", protectPublishedQuery);
membershipPlanVersionSchema.pre("updateMany", protectPublishedQuery);
membershipPlanVersionSchema.pre("replaceOne", protectPublishedQuery);
membershipPlanVersionSchema.pre("deleteOne", protectPublishedQuery);
membershipPlanVersionSchema.pre("deleteMany", protectPublishedQuery);
membershipPlanVersionSchema.pre(
  "deleteOne",
  { document: true, query: false },
  async function protectPublishedDocument() {
    if (this.status === MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED) {
      throw new Error("Published membership plan versions are immutable.");
    }
  },
);
