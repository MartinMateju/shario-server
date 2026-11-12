import mongoose, { type InferSchemaType, type Model } from "mongoose";

export const VOUCHER_REFUND_PENDING_REASON =
  "A full purchase refund was requested in shario.io. Vouchers are held until the payment outcome is reconciled.";

/** One durable full-purchase refund intent per tenant/order. The primary key,
 * rather than an optional operational index, prevents duplicate requests. */
export const voucherManagementRefundSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    couponOrder: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    operationId: { type: String, required: true, immutable: true },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    reason: { type: String, required: true, maxlength: 1000, immutable: true },
    accountId: { type: String, required: true, immutable: true },
    paymentIntentId: { type: String, required: true, immutable: true },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    currency: { type: String, required: true, immutable: true },
    livemode: { type: Boolean, required: true, immutable: true },
    status: {
      type: String,
      enum: ["pending", "submitting", "succeeded", "review_required"],
      default: "pending",
      required: true,
    },
    stripeRefundId: { type: String, default: "" },
    attempts: { type: Number, default: 0, min: 0 },
    firstProviderAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: Date.now },
    claimToken: { type: String, default: "" },
    claimExpiresAt: { type: Date, default: null },
    reviewReason: { type: String, default: "", maxlength: 1000 },
  },
  { timestamps: true, strict: true },
);

voucherManagementRefundSchema.index(
  { status: 1, nextAttemptAt: 1, claimExpiresAt: 1 },
  { name: "voucher_refund_due" },
);
// The deterministic primary key is also the Stripe idempotency identity.
export const voucherManagementRefundId = (tenantId: string, orderId: string) =>
  `voucher-refund:${tenantId}:${orderId}`;

type RefundIntent = InferSchemaType<typeof voucherManagementRefundSchema>;
export const VoucherManagementRefund: Model<RefundIntent> =
  (mongoose.models.VoucherManagementRefund as
    Model<RefundIntent> | undefined) ||
  mongoose.model<RefundIntent>(
    "VoucherManagementRefund",
    voucherManagementRefundSchema,
  );
