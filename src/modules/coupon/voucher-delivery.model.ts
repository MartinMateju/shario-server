import mongoose, { type InferSchemaType } from "mongoose";

export const VOUCHER_DELIVERY_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "ambiguous",
  "skipped",
  "suppressed",
] as const;
export type VoucherDeliveryStatus = (typeof VOUCHER_DELIVERY_STATUSES)[number];
export type VoucherDeliveryChannel = "customer" | "admin";

export const voucherDeliverySchema = new mongoose.Schema(
  {
    // A deterministic primary key makes enqueue idempotent even before optional
    // operational indexes are applied. No PDF bytes or bearer codes live here.
    _id: { type: String, required: true },
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    couponOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CouponOrder",
      required: true,
    },
    channel: { type: String, enum: ["customer", "admin"], required: true },
    generation: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    status: {
      type: String,
      enum: VOUCHER_DELIVERY_STATUSES,
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    claimToken: { type: String, default: "", select: false },
    claimExpiresAt: { type: Date, default: null },
    providerAttemptStartedAt: { type: Date, default: null },
    providerMessageId: {
      type: String,
      default: "",
      maxlength: 500,
      select: false,
    },
    sentAt: { type: Date, default: null },
    lastError: { type: String, default: "", maxlength: 2000, select: false },
  },
  { timestamps: true, strict: true },
);

voucherDeliverySchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
  { name: "voucher_delivery_due" },
);
voucherDeliverySchema.index(
  { status: 1, claimExpiresAt: 1 },
  { name: "voucher_delivery_claims" },
);
voucherDeliverySchema.index(
  { tenant: 1, couponOrder: 1, channel: 1, generation: -1 },
  { name: "voucher_delivery_order" },
);

export type VoucherDelivery = InferSchemaType<typeof voucherDeliverySchema>;
export const VoucherDeliveryModel: mongoose.Model<VoucherDelivery> =
  (mongoose.models.VoucherDelivery as
    mongoose.Model<VoucherDelivery> | undefined) ||
  mongoose.model<VoucherDelivery>("VoucherDelivery", voucherDeliverySchema);
