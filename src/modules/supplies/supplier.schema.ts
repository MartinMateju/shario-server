import mongoose from "mongoose";

import { EMAIL_REGEX } from "./supply-order.constants.js";

export const supplierSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },

    ico: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
    },

    dic: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
    },

    contactPerson: {
      type: String,
      trim: true,
      default: "",
      maxlength: 180,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      default: "",
      maxlength: 254,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
      maxlength: 60,
    },

    address: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },

    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 4000,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

supplierSchema.index({ tenant: 1, name: 1 }, { unique: true });
supplierSchema.index({ tenant: 1, isActive: 1 });
supplierSchema.index({ tenant: 1, email: 1 });
