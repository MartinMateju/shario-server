import mongoose, { type InferSchemaType, type Model } from "mongoose";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

export const VOUCHER_LEDGER_KINDS = [
  "issue", "wallet_redeem", "reserve", "commit", "release", "reverse", "revoke", "archive", "restore",
] as const;

export const voucherLedgerSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true, immutable: true },
  operationId: { type: String, required: true, maxlength: 160, immutable: true },
  kind: { type: String, enum: VOUCHER_LEDGER_KINDS, required: true, immutable: true },
  currency: { type: String, enum: [...STUDIO_COMMERCE_CURRENCIES, null], default: null, immutable: true },
  amountMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger, immutable: true },
  quantity: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger, immutable: true },
  referenceId: { type: String, default: "", maxlength: 160, immutable: true },
  reservationId: { type: String, default: "", maxlength: 160, immutable: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
  reason: { type: String, default: "", maxlength: 1000, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false, strict: true });

voucherLedgerSchema.pre("validate", function () {
  const visibilityEvent = this.kind === "archive" || this.kind === "restore";
  if (visibilityEvent && (this.amountMinor !== 0 || this.quantity !== 0)) {
    this.invalidate("amountMinor", "Code archival cannot move voucher value or quantity.");
  }
  if (!this.currency && ((!visibilityEvent && this.kind !== "revoke") || this.amountMinor !== 0)) {
    this.invalidate("currency", "Only nonfinancial or legacy revocation audit entries may have unknown currency.");
  }
});
voucherLedgerSchema.index({ tenant: 1, operationId: 1 }, { unique: true });
voucherLedgerSchema.index({ tenant: 1, coupon: 1, createdAt: 1 });
// Corrections append a compensating entry. Ordinary application writes cannot
// rewrite audit history; deliberately do not expose raw-collection mutations.
voucherLedgerSchema.pre("save", function () {
  if (!this.isNew) throw new Error("Voucher ledger entries cannot be changed.");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  voucherLedgerSchema.pre(operation, function () {
    throw new Error("Voucher ledger entries cannot be changed or deleted.");
  });
}

type VoucherLedgerDocument = InferSchemaType<typeof voucherLedgerSchema>;
export const VoucherLedger: Model<VoucherLedgerDocument> = (mongoose.models.VoucherLedger as Model<VoucherLedgerDocument> | undefined) || mongoose.model<VoucherLedgerDocument>("VoucherLedger", voucherLedgerSchema);

export const voucherReservationSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true, immutable: true },
  operationId: { type: String, required: true, maxlength: 160, immutable: true },
  referenceId: { type: String, required: true, maxlength: 160, immutable: true },
  eligibleProductId: { type: String, required: true, immutable: true },
  currency: { type: String, enum: STUDIO_COMMERCE_CURRENCIES, required: true, immutable: true },
  amountMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger, immutable: true },
  quantity: { type: Number, required: true, min: 0, validate: Number.isSafeInteger, immutable: true },
  reversedAmountMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  reversedQuantity: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  status: { type: String, enum: ["held", "committed", "released", "reversed"], default: "held", required: true },
  // This is diagnostic only. A time limit must never release a payment that may settle.
  reviewAfter: { type: Date, default: null },
  settledAt: { type: Date, default: null },
}, { timestamps: true, strict: true });
voucherReservationSchema.index({ tenant: 1, operationId: 1 }, { unique: true });
voucherReservationSchema.index({ tenant: 1, coupon: 1, status: 1 });
type VoucherReservationDocument = InferSchemaType<typeof voucherReservationSchema>;
export const VoucherReservation: Model<VoucherReservationDocument> = (mongoose.models.VoucherReservation as Model<VoucherReservationDocument> | undefined) || mongoose.model<VoucherReservationDocument>("VoucherReservation", voucherReservationSchema);
