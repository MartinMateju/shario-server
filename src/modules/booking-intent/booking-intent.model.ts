import mongoose, { Schema } from "mongoose";

import {
  normalizeRolloutEligibleAppLocale,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
} from "@/shared/i18n/locales.js";

const checkoutSchema = new Schema(
  {
    idempotencyKey: { type: String, trim: true, default: "" },
    requestHash: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["idle", "processing", "completed", "manual_review"],
      default: "idle",
    },
    leaseToken: { type: String, trim: true, default: "" },
    leaseExpiresAt: { type: Date, default: null },
    response: { type: Schema.Types.Mixed, default: null },
    lastErrorCode: { type: String, trim: true, default: "" },
  },
  { _id: false, strict: true },
);

const bookingIntentSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
      index: true,
    },
    tenantSlug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      immutable: true,
    },
    jti: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      unique: true,
    },
    payload: {
      productId: {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true,
        immutable: true,
      },
      locationId: {
        type: Schema.Types.ObjectId,
        ref: "Location",
        default: null,
        immutable: true,
      },
      courseSlotId: {
        type: Schema.Types.ObjectId,
        ref: "Booking",
        default: null,
        immutable: true,
      },
      start: { type: Date, default: null, immutable: true },
      end: { type: Date, default: null, immutable: true },
      quantity: { type: Number, required: true, min: 1, immutable: true },
      numberOfGuests: { type: Number, required: true, min: 1, immutable: true },
      bookingType: { type: String, required: true, immutable: true },
      bookingMode: {
        type: String,
        enum: ["public", "private"],
        default: null,
        immutable: true,
      },
      plannedActivity: { type: String, required: true, immutable: true },
      locale: {
        type: String,
        enum: [...ROLLOUT_ELIGIBLE_APP_LOCALES],
        required: true,
        immutable: true,
        set: (value: unknown) =>
          normalizeRolloutEligibleAppLocale(value) ?? value,
      },
    },
    claimedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
    },
    checkout: {
      type: checkoutSchema,
      default: () => ({}),
    },
  },
  { timestamps: true, strict: true },
);

bookingIntentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
bookingIntentSchema.index({ tenant: 1, claimedBy: 1, expiresAt: 1 });

export const BookingIntentModel: mongoose.Model<any> =
  (mongoose.models.BookingIntent as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("BookingIntent", bookingIntentSchema);

export default BookingIntentModel;
