import mongoose, { Schema } from "mongoose";

export const CHECKOUT_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const checkoutOperationSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    kind: {
      type: String,
      enum: ["card", "credits"],
      required: true,
      immutable: true,
    },
    keyHash: { type: String, required: true, immutable: true },
    requestHash: { type: String, required: true, immutable: true },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      immutable: true,
    },
    cartId: {
      type: Schema.Types.ObjectId,
      ref: "Cart",
      required: true,
      immutable: true,
    },
    state: {
      type: String,
      enum: ["processing", "completed"],
      required: true,
      default: "processing",
    },
    leaseToken: { type: String, required: true },
    leaseExpiresAt: { type: Date, required: true },
    response: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: "checkout_operations",
    timestamps: true,
    strict: true,
    versionKey: false,
  },
);

checkoutOperationSchema.index(
  { tenant: 1, user: 1, kind: 1, keyHash: 1 },
  { unique: true, name: "checkout_operation_idempotency_unique" },
);
checkoutOperationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "checkout_operation_expiry_ttl" },
);

export const CheckoutOperationModel: mongoose.Model<any> =
  (mongoose.models.CheckoutOperation as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("CheckoutOperation", checkoutOperationSchema);

export default CheckoutOperationModel;
