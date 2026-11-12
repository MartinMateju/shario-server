import mongoose from "mongoose";

import {
  VERIFICATION_PURPOSE,
  VERIFICATION_STATUS,
} from "./user-verification.constants.js";

export const verificationTokenSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    purpose: {
      type: String,
      enum: Object.values(VERIFICATION_PURPOSE),
      default: VERIFICATION_PURPOSE.EMAIL_VERIFICATION,
      required: true,
      index: true,
    },

    hashedToken: {
      type: String,
      required: true,
      select: false,
    },

    status: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.PENDING,
      index: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

// Used for cleanup/queries by expiration and status
verificationTokenSchema.index({
  tenant: 1,
  expiresAt: 1,
  status: 1,
});
verificationTokenSchema.index(
  {
    tenant: 1,
    purpose: 1,
    hashedToken: 1,
  },
  {
    unique: true,
    name:
      "tenant_verification_token_unique",
  },
);

// Only one pending verification token per user/purpose
verificationTokenSchema.index(
  {
    tenant: 1,
    user: 1,
    purpose: 1,
    status: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      status: VERIFICATION_STATUS.PENDING,
    },
  },
);
