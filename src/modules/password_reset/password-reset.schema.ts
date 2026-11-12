import mongoose from "mongoose";

import { PASSWORD_RESET_STATUS } from "./password-reset.constants.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const passwordResetSchema = new mongoose.Schema(
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

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      index: true,
    },

    otpHash: {
      type: String,
      required: true,
      select: false,
    },

    resetTokenHash: {
      type: String,
      default: undefined,
      select: false,
    },

    resetTokenExpiresAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(PASSWORD_RESET_STATUS),
      default: PASSWORD_RESET_STATUS.PENDING,
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxAttempts: {
      type: Number,
      default: 5,
      min: 1,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    usedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

passwordResetSchema.index({ tenant: 1, user: 1, status: 1 });
passwordResetSchema.index({ tenant: 1, email: 1, status: 1 });
passwordResetSchema.index(
  {
    tenant: 1,
    resetTokenHash: 1,
    status: 1,
  },
  {
    name: "tenant_reset_token_status",
    partialFilterExpression: {
      resetTokenHash: {
        $type: "string",
      },
    },
  },
);
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
