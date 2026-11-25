import mongoose, { Schema } from "mongoose";

export const refundSummarySchema = new Schema({
  reconciliationId: { type: String, required: true },
  status: { type: String, enum: ["none", "pending", "partial", "full", "failed", "review"], required: true },
  succeededAmountMinor: { type: Number, min: 0, required: true },
  pendingAmountMinor: { type: Number, min: 0, required: true },
  failedAmountMinor: { type: Number, min: 0, required: true },
  reviewRequired: { type: Boolean, required: true },
  reviewReason: { type: String, default: "" },
  snapshotVersion: { type: String, required: true },
  updatedAt: { type: Date, required: true },
}, { _id: false });
export type RefundSummary = mongoose.InferSchemaType<typeof refundSummarySchema>;

const schema = new Schema({
  _id: { type: String, required: true },
  tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
  connectedAccountId: { type: String, required: true, immutable: true },
  paymentIntentId: { type: String, required: true, immutable: true },
  livemode: { type: Boolean, required: true, immutable: true },
  chargeId: String,
  order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  membership: { type: Schema.Types.ObjectId, ref: "UserMembership", default: null },
  stripeInvoiceId: { type: String, default: "" },
  currency: { type: String, default: "" },
  paidAmountMinor: { type: Number, default: 0 },
  summary: { type: refundSummarySchema, default: null },
  refunds: { type: [{ _id: false, id: String, amountMinor: Number, status: String }], default: [] },
  reviewRequired: { type: Boolean, default: true, index: true },
  reviewReason: { type: String, default: "reconciliation_incomplete" },
  // Repeated deliveries do not grow arrays. Each provider-state transition has
  // its own observation document (including the event that caused the read).
  snapshotVersion: { type: String, default: "" },
  lastEventId: { type: String, default: "" },
  lastObservedAt: Date,
  claimToken: { type: String, default: "" },
  claimExpiresAt: { type: Date, default: null },
  allocationCheckRevision: { type: Number, default: 0 },
  resolution: { type: new Schema({ actor: Schema.Types.ObjectId, note: String, evidence: String, snapshotVersion: String, resolvedAt: Date }, { _id: false }), default: null },
}, { timestamps: true });
schema.index({ tenant: 1, reviewRequired: 1, updatedAt: -1 });
schema.index({ connectedAccountId: 1, paymentIntentId: 1 }, { unique: true });
export const PaymentRefundReconciliation: mongoose.Model<any> = mongoose.models.PaymentRefundReconciliation ?? mongoose.model("PaymentRefundReconciliation", schema);
const observationSchema = new Schema({
  _id: String, reconciliation: { type: String, required: true }, tenant: { type: Schema.Types.ObjectId, required: true },
  eventId: String, snapshotVersion: String, summary: refundSummarySchema,
  refunds: [{ _id: false, id: String, amountMinor: Number, status: String }],
}, { timestamps: true });
export const PaymentRefundObservation: mongoose.Model<any> = mongoose.models.PaymentRefundObservation ?? mongoose.model("PaymentRefundObservation", observationSchema);

const resolutionSchema = new Schema({
  _id: String, reconciliation: { type: String, required: true }, tenant: { type: Schema.Types.ObjectId, required: true },
  actor: { type: Schema.Types.ObjectId, required: true }, note: { type: String, required: true }, evidence: { type: String, required: true },
  snapshotVersion: { type: String, required: true }, resolvedAt: { type: Date, required: true },
}, { timestamps: true });
export const PaymentRefundReviewResolution: mongoose.Model<any> = mongoose.models.PaymentRefundReviewResolution ?? mongoose.model("PaymentRefundReviewResolution", resolutionSchema);

let preparing: Promise<void> | undefined;
/** Only these three new collections/indexes; never sync/drop existing indexes. */
export const preparePaymentRefundCollections = (): Promise<void> => preparing ??= (async () => {
  for (const model of [PaymentRefundReconciliation, PaymentRefundObservation, PaymentRefundReviewResolution]) {
    await model.createCollection();
    await model.createIndexes();
  }
})().catch((error) => { preparing = undefined; throw error; });
