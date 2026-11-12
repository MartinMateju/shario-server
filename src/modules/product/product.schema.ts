import mongoose from "mongoose";
import { courseContentStorageSchema } from "./product.course-content.js";
import { OPEN_STUDIO_LOCATION_INDEX_KEY, OPEN_STUDIO_LOCATION_INDEX_OPTIONS } from "./open-studio-location-index.js";
import {
  PRODUCT_LOCATION_NAME_INDEX_KEY,
  PRODUCT_LOCATION_NAME_INDEX_OPTIONS,
} from "./product-location-name-index.js";
import { voucherDesignSchema } from "@/modules/coupon/voucher-design.js";

import {
  DEFAULT_PRODUCT_CURRENCY,
  MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_IMAGE_SRC_LENGTH,
  MAX_PRODUCT_LABEL_LENGTH,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_PARTICIPANTS,
  MAX_PRODUCT_SKU_LENGTH,
  MAX_PRODUCT_TEMPLATE_KEY_LENGTH,
  MIN_PRODUCT_PARTICIPANTS,
  PRODUCT_TYPES,
  PRODUCT_CURRENCY,
} from "./product.constants.js";
import {
  PRODUCT_OPEN_STUDIO_BOOKING_MODES,
  PRODUCT_KIND_CONTRACT_VERSION,
  PRODUCT_KINDS,
} from "./product-kind-v2.contract.js";
import type { ProductAttributes, ProductModel } from "./product.types.js";

const openStudioPolicySchema = new mongoose.Schema(
  {
    publicCapacityMode: { type: String, enum: ["fixed", "activity"], required: true },
    publicCapacityLimit: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: (value: number | null) => value === null || Number.isSafeInteger(value),
        message: "Public capacity must be a positive whole number.",
      },
      required: function (this: { publicCapacityMode: string }) {
        return this.publicCapacityMode === "fixed";
      },
    },
    privateBookingSurcharge: { type: Number, min: 0, required: true, validate: Number.isFinite },
  },
  { _id: false },
);

const voucherSettingsSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true },
  type: { type: String, enum: ["value", "experience"], required: true },
  validity: {
    type: new mongoose.Schema({
      mode: { type: String, enum: ["months", "date", "none"], required: true },
      months: { type: Number, min: 1, max: 120, validate: Number.isSafeInteger },
      date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    }, { _id: false }),
    required: true,
  },
  experienceProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
  experienceQuantity: { type: Number, min: 1, max: 100, validate: Number.isSafeInteger },
  eligibleProductIds: { type: [mongoose.Schema.Types.ObjectId], ref: "Product", default: undefined },
  physicalDelivery: {
    type: new mongoose.Schema({
      enabled: { type: Boolean, default: false },
      postageFeeMinor: { type: Number, required: true, min: 0, max: 100_000_000, validate: Number.isSafeInteger },
    }, { _id: false }),
    default: undefined,
  },
}, { _id: false });

const productImportMetadataSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["csv", "xlsx"], required: true },
    importId: { type: String, required: true, maxlength: 64 },
    importKey: { type: String, required: true, maxlength: 160 },
    externalId: { type: String, default: undefined, maxlength: 120 },
    fingerprint: { type: String, default: undefined, maxlength: 64 },
    lastMutationKey: { type: String, default: undefined, maxlength: 160 },
    importedAt: { type: Date, required: true },
    importedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rolledBackAt: { type: Date, default: null },
    rolledBackBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rollbackMutationKey: { type: String, default: undefined, maxlength: 200 },
  },
  { _id: false },
);

const waitlistDefaultsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    autoPromote: { type: Boolean, default: true },
    offerWindowHours: { type: Number, default: 24, min: 1, max: 168 },
    cutoffHours: { type: Number, default: 2, min: 0, max: 168 },
  },
  { _id: false },
);

export const productSchema = new mongoose.Schema<
  ProductAttributes,
  ProductModel
>(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    courseContent: { type: courseContentStorageSchema, default: undefined },

    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_PRODUCT_NAME_LENGTH,
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: MAX_PRODUCT_DESCRIPTION_LENGTH,
    },

    classCategory: {
      type: String,
      default: "",
      trim: true,
      maxlength: MAX_PRODUCT_CLASS_CATEGORY_LENGTH,
    },

    sku: {
      type: String,
      default: "",
      trim: true,
      maxlength: MAX_PRODUCT_SKU_LENGTH,
    },

    type: {
      type: String,
      enum: PRODUCT_TYPES,
      required: true,
    },

    /**
     * Canonical tenant-facing taxonomy. Optional only for historical records
     * while the V2 backfill is rolling out; every new tenant write persists
     * this field together with the legacy `type` compatibility projection.
     */
    kind: {
      type: String,
      enum: PRODUCT_KINDS,
      default: undefined,
      index: true,
    },

    kindContractVersion: {
      type: Number,
      enum: [PRODUCT_KIND_CONTRACT_VERSION],
      default: undefined,
    },

    /**
     * Reservation policy for Open Studio. Party size never changes it.
     * Non-Open-Studio products persist null.
     */
    bookingMode: {
      type: String,
      enum: PRODUCT_OPEN_STUDIO_BOOKING_MODES,
      default: null,
    },

    openStudioPolicy: { type: openStudioPolicySchema, default: undefined },

    price: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    extraCharge: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    maxNumberOfParticipants: {
      type: Number,
      default: null,
      min: MIN_PRODUCT_PARTICIPANTS,
      max: MAX_PRODUCT_PARTICIPANTS,
      validate: {
        validator: (value: number | null): boolean =>
          value === null || Number.isSafeInteger(value),
        message: "Participant capacity must be a whole number.",
      },
    },

    /** Defaults copied to newly-created Class sessions; safe-off for legacy. */
    waitlistDefaults: {
      type: waitlistDefaultsSchema,
      default: undefined,
    },

    currency: {
      type: String,
      enum: Object.values(PRODUCT_CURRENCY),
      default: DEFAULT_PRODUCT_CURRENCY,
      uppercase: true,
      trim: true,
    },

    imageSrc: {
      type: String,
      default: "",
      trim: true,
      maxlength: MAX_PRODUCT_IMAGE_SRC_LENGTH,
    },

    label: {
      type: String,
      default: "",
      trim: true,
      maxlength: MAX_PRODUCT_LABEL_LENGTH,
    },

    stripeProductId: {
      type: String,
      default: "",
      trim: true,
      select: false,
    },

    stripePriceId: {
      type: String,
      default: "",
      trim: true,
      select: false,
    },

    voucherTemplate: {
      type: String,
      default: "",
      trim: true,
      maxlength: MAX_PRODUCT_TEMPLATE_KEY_LENGTH,
    },

    couponProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },

    voucherSettings: { type: voucherSettingsSchema, default: undefined },
    voucherDesign: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
      validate: {
        validator: (value: unknown) => value == null || voucherDesignSchema.safeParse(value).success,
        message: "Invalid voucher design.",
      },
    },

    importMetadata: {
      type: productImportMetadataSchema,
      default: undefined,
      select: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Server-owned historical archive; ordinary inactive products retain their slot.
    isArchived: { type: Boolean, default: false },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Product names are unique per location; global products use the null location.
 * API startup replaces the historical tenant/name index before serving traffic.
 */
productSchema.index(
  PRODUCT_LOCATION_NAME_INDEX_KEY,
  PRODUCT_LOCATION_NAME_INDEX_OPTIONS,
);
productSchema.index(OPEN_STUDIO_LOCATION_INDEX_KEY, OPEN_STUDIO_LOCATION_INDEX_OPTIONS);

/**
 * Main product listing.
 * Supports filtering by type + active state and sorting by display order.
 */
productSchema.index({
  tenant: 1,
  location: 1,
  kind: 1,
  isActive: 1,
  sortOrder: 1,
  createdAt: -1,
});

productSchema.index({
  tenant: 1,
  type: 1,
  isActive: 1,
  sortOrder: 1,
  createdAt: -1,
});

/**
 * Product listing without type filter.
 */
productSchema.index({
  tenant: 1,
  isActive: 1,
  sortOrder: 1,
  createdAt: -1,
});

/**
 * Managed class-category usage counts and safe-deletion checks.
 */
productSchema.index({
  tenant: 1,
  classCategory: 1,
  kind: 1,
  isActive: 1,
});

/**
 * SKU lookups.
 */
productSchema.index({
  tenant: 1,
  sku: 1,
});

productSchema.index(
  { tenant: 1, "importMetadata.importKey": 1 },
  {
    unique: true,
    name: "tenant_1_product_importKey_1",
    partialFilterExpression: {
      "importMetadata.importKey": { $type: "string" },
    },
  },
);
productSchema.index(
  { tenant: 1, "importMetadata.externalId": 1 },
  {
    unique: true,
    name: "tenant_1_product_externalId_1",
    partialFilterExpression: {
      "importMetadata.externalId": { $type: "string" },
    },
  },
);
productSchema.index(
  { tenant: 1, "importMetadata.fingerprint": 1 },
  {
    unique: true,
    name: "tenant_1_product_fingerprint_1",
    partialFilterExpression: {
      "importMetadata.fingerprint": { $type: "string" },
    },
  },
);
productSchema.index(
  { tenant: 1, "importMetadata.lastMutationKey": 1 },
  {
    unique: true,
    name: "tenant_1_product_lastMutationKey_1",
    partialFilterExpression: {
      "importMetadata.lastMutationKey": { $type: "string" },
    },
  },
);

/**
 * Products created by a specific user.
 */
productSchema.index({
  tenant: 1,
  createdBy: 1,
});
