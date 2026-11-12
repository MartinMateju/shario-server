import mongoose from "mongoose";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

const schema = new mongoose.Schema(
  {
    // One cancellation intent per paid order and booking, independent of indexes.
    _id: { type: String, required: true },
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    reason: { type: String, required: true, maxlength: 1000, immutable: true },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      immutable: true,
    },
    amountMinor: {
      type: Number,
      min: 0,
      required: true,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    voucherAmountMinor: {
      type: Number,
      min: 0,
      required: true,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    voucherQuantity: {
      type: Number,
      min: 0,
      required: true,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    cardAmountMinor: {
      type: Number,
      min: 0,
      required: true,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    paymentIntentId: { type: String, default: "", immutable: true },
    connectedAccountId: { type: String, default: "", immutable: true },
    livemode: { type: Boolean, default: null, immutable: true },
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "provider_pending",
        "succeeded",
        "review_required",
      ],
      required: true,
    },
    refundId: { type: String, default: "" },
    providerStatus: { type: String, default: "" },
    failureEventId: { type: String, default: "", maxlength: 255 },
    failureRecordedAt: { type: Date, default: null },
    claimToken: { type: String, default: "" },
    claimExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    firstProviderAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: "", maxlength: 1000 },
  },
  { timestamps: true },
);
schema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
  { name: "booking_payment_refund_due" },
);
schema.index(
  { tenant: 1, order: 1, booking: 1 },
  { name: "booking_payment_refund_order" },
);

export const BookingPaymentRefund: mongoose.Model<any> =
  mongoose.models.BookingPaymentRefund ??
  mongoose.model("BookingPaymentRefund", schema);
