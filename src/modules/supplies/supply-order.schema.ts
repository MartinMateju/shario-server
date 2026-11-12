import mongoose from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import {
  EMAIL_REGEX,
  SUPPLY_ORDER_PRIORITY,
  SUPPLY_ORDER_STATUS,
} from "./supply-order.constants.js";

export const supplyOrderSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },

    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      index: true,
    },

    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },

    customerEmail: {
      type: String,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      default: "",
      maxlength: 254,
    },

    customerPhone: {
      type: String,
      trim: true,
      default: "",
      maxlength: 60,
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    registeredAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    deadline: {
      type: Date,
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(SUPPLY_ORDER_STATUS),
      default: SUPPLY_ORDER_STATUS.NEW,
      index: true,
    },

    priority: {
      type: String,
      enum: Object.values(SUPPLY_ORDER_PRIORITY),
      default: SUPPLY_ORDER_PRIORITY.NORMAL,
      index: true,
    },

    // Optional for legacy records. New orders receive the tenant currency in
    // the service layer; clients cannot choose or change it.
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      trim: true,
      uppercase: true,
      default: undefined,
    },

    price: {
      type: Number,
      default: 0,
      min: 0,
    },

    depositPaid: {
      type: Number,
      default: 0,
      min: 0,
    },

    units: {
      type: Number,
      default: 1,
      min: 1,
    },

    unitLabel: {
      type: String,
      default: "ks",
      trim: true,
      maxlength: 40,
    },

    publicNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 4000,
    },

    internalNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 4000,
      select: false,
    },

    requestedByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

supplyOrderSchema.index({ tenant: 1, registeredAt: -1 });
supplyOrderSchema.index({ tenant: 1, status: 1, deadline: 1 });
supplyOrderSchema.index({ tenant: 1, priority: 1, status: 1 });
supplyOrderSchema.index({ tenant: 1, assignedTo: 1, status: 1 });
supplyOrderSchema.index({ tenant: 1, location: 1, status: 1 });
supplyOrderSchema.index({ tenant: 1, customerEmail: 1 });
supplyOrderSchema.index({ tenant: 1, requestedByUser: 1 });
