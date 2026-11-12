import mongoose from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import {
  DEFAULT_CREDIT_CURRENCY,
  MONEY_CREDIT_TRANSACTION_TYPE,
} from "./money-credit.constants.js";

const moneyCreditTransactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: Object.values(MONEY_CREDIT_TRANSACTION_TYPE),
      required: true,
    },

    amount: {
      type: Number,
      required: true,
    },

    amountMinor: {
      type: Number,
      default: null,
      min: 0,
    },

    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      default: DEFAULT_CREDIT_CURRENCY,
      uppercase: true,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },

    relatedOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },

    relatedBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },

    relatedCoupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },

    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    adminName: {
      type: String,
      trim: true,
      default: "",
    },

    reason: {
      type: String,
      trim: true,
      default: "",
    },

    idempotencyKey: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
      immutable: true,
    },
  },
  { timestamps: true },
);

export const moneyCreditSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },

    balance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    // Integer minor units are authoritative once populated. balance remains
    // a major-unit compatibility mirror for older readers during rollout.
    balanceMinor: {
      type: Number,
      default: null,
      min: 0,
    },

    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      default: DEFAULT_CREDIT_CURRENCY,
      uppercase: true,
      trim: true,
    },

    transactions: {
      type: [moneyCreditTransactionSchema],
      default: [],
    },
  },
  { timestamps: true },
);

moneyCreditSchema.pre("validate", function normalizeLegacyCurrencySnapshots() {
  const currency = String(this.currency || DEFAULT_CREDIT_CURRENCY)
    .trim()
    .toUpperCase();

  this.currency = currency as typeof this.currency;

  for (const transaction of this.transactions || []) {
    transaction.currency = String(transaction.currency || currency)
      .trim()
      .toUpperCase() as typeof transaction.currency;
  }
});

moneyCreditSchema.index({ tenant: 1, user: 1 }, { unique: true });
moneyCreditSchema.index({ tenant: 1, balance: 1 });
moneyCreditSchema.index({ tenant: 1, "transactions.createdAt": -1 });
moneyCreditSchema.index({ tenant: 1, "transactions.type": 1 });
