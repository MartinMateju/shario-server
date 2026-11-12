import mongoose, { Schema } from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import { MEMBERSHIP_INVOICE_STATUS } from "./membership.constants.js";

const isSafeStripeDocumentUrl = (value: string): boolean => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "stripe.com" ||
        url.hostname.endsWith(".stripe.com") ||
        url.hostname.endsWith(".stripeusercontent.com"))
    );
  } catch {
    return false;
  }
};

export const membershipInvoiceSchema = new Schema(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    membership: { type: Schema.Types.ObjectId, ref: "UserMembership", required: true, immutable: true },
    connectedAccountId: { type: String, required: true, trim: true, immutable: true, select: false },
    stripeInvoiceId: { type: String, required: true, trim: true, immutable: true, select: false },
    number: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: Object.values(MEMBERSHIP_INVOICE_STATUS),
      required: true,
      default: MEMBERSHIP_INVOICE_STATUS.DRAFT,
    },
    currency: { type: String, enum: STUDIO_COMMERCE_CURRENCIES, required: true },
    totalAmountMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    amountPaidMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    amountDueMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    // Kept server-side for authenticated proxy/download integrations. API
    // serializers return only local membership invoice URLs.
    hostedInvoiceUrl: {
      type: String,
      trim: true,
      default: "",
      select: false,
      validate: isSafeStripeDocumentUrl,
    },
    invoicePdfUrl: {
      type: String,
      trim: true,
      default: "",
      select: false,
      validate: isSafeStripeDocumentUrl,
    },
    lastStripeEventCreated: { type: Number, required: true, min: 0, default: 0, select: false },
    lastStripeEventId: { type: String, trim: true, default: "", select: false },
  },
  { timestamps: true, strict: true },
);

membershipInvoiceSchema.index({ connectedAccountId: 1, stripeInvoiceId: 1 }, { unique: true });
membershipInvoiceSchema.index({ tenant: 1, user: 1, issuedAt: -1 });

type MembershipInvoiceRecord = mongoose.InferSchemaType<typeof membershipInvoiceSchema>;
export const MembershipInvoiceModel: mongoose.Model<MembershipInvoiceRecord> =
  (mongoose.models.MembershipInvoice as mongoose.Model<MembershipInvoiceRecord> | undefined) ??
  mongoose.model<MembershipInvoiceRecord>("MembershipInvoice", membershipInvoiceSchema);

export default MembershipInvoiceModel;
