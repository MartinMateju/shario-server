import mongoose, { Schema } from "mongoose";

import {
  TENANT_PAYMENT_CONTROLLER,
  TENANT_PAYMENT_DASHBOARD_TYPE,
  TENANT_PAYMENT_ONBOARDING_STATUS,
} from "./tenant-payment-account.constants.js";
import type {
  TenantPaymentAccount,
  TenantPaymentAccountModel as TenantPaymentAccountMongooseModel,
} from "./tenant-payment-account.types.js";

const requirementsSchema = new Schema(
  {
    currentlyDue: { type: [String], default: [] },
    eventuallyDue: { type: [String], default: [] },
    pastDue: { type: [String], default: [] },
    pendingVerification: { type: [String], default: [] },
    disabledReason: { type: String, trim: true, default: undefined },
  },
  { _id: false },
);

const controllerSchema = new Schema(
  {
    feesPayer: {
      type: String,
      enum: [TENANT_PAYMENT_CONTROLLER.feesPayer],
      default: TENANT_PAYMENT_CONTROLLER.feesPayer,
      immutable: true,
    },
    lossesPayments: {
      type: String,
      enum: [TENANT_PAYMENT_CONTROLLER.lossesPayments],
      default: TENANT_PAYMENT_CONTROLLER.lossesPayments,
      immutable: true,
    },
    requirementCollection: {
      type: String,
      enum: [TENANT_PAYMENT_CONTROLLER.requirementCollection],
      default: TENANT_PAYMENT_CONTROLLER.requirementCollection,
      immutable: true,
    },
    dashboardType: {
      type: String,
      enum: Object.values(TENANT_PAYMENT_DASHBOARD_TYPE),
      default: TENANT_PAYMENT_DASHBOARD_TYPE.FULL,
      immutable: true,
    },
  },
  { _id: false },
);

export const tenantPaymentAccountSchema = new Schema<
  TenantPaymentAccount,
  TenantPaymentAccountMongooseModel
>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      unique: true,
      immutable: true,
    },
    stripeAccountId: {
      type: String,
      trim: true,
      default: undefined,
      // Attached after Stripe creates the account. Repository compare-and-set
      // filters enforce write-once semantics; Mongoose `immutable` would strip
      // the initial attachment from findOneAndUpdate.
    },
    accountCreateIdempotencyKey: {
      type: String,
      trim: true,
      required: true,
      // Rotated under repository compare-and-set guards whenever a fresh
      // provisioning attempt is claimed. It must remain mutable so a
      // definitive Stripe rejection cannot poison every later retry.
    },
    provisioningStartedAt: Date,
    onboardingStatus: {
      type: String,
      enum: Object.values(TENANT_PAYMENT_ONBOARDING_STATUS),
      default: TENANT_PAYMENT_ONBOARDING_STATUS.NOT_STARTED,
      required: true,
    },
    detailsSubmitted: { type: Boolean, default: false, required: true },
    chargesEnabled: { type: Boolean, default: false, required: true },
    payoutsEnabled: { type: Boolean, default: false, required: true },
    country: { type: String, uppercase: true, trim: true, default: undefined },
    defaultCurrency: {
      type: String,
      lowercase: true,
      trim: true,
      default: undefined,
    },
    livemode: Boolean,
    controller: {
      type: controllerSchema,
      default: () => ({ ...TENANT_PAYMENT_CONTROLLER }),
      required: true,
    },
    requirements: {
      type: requirementsSchema,
      default: () => ({}),
      required: true,
    },
    lastStripeEventCreatedAt: Number,
    lastSyncedAt: Date,
    lastSyncErrorCode: { type: String, trim: true, default: undefined },
  },
  {
    timestamps: true,
    strict: true,
  },
);

tenantPaymentAccountSchema.index(
  { stripeAccountId: 1 },
  { unique: true, sparse: true },
);
tenantPaymentAccountSchema.index({ onboardingStatus: 1, updatedAt: 1 });

export const TenantPaymentAccountModel =
  (mongoose.models.TenantPaymentAccount as
    | TenantPaymentAccountMongooseModel
    | undefined) ??
  mongoose.model<TenantPaymentAccount, TenantPaymentAccountMongooseModel>(
    "TenantPaymentAccount",
    tenantPaymentAccountSchema,
  );

export default TenantPaymentAccountModel;
