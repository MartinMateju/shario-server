import mongoose from "mongoose";

import { METADATA_TAGS } from "./metadata.constants.js";

export const metadataSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Tenant",
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      ref: "Order",
      index: true,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      ref: "Product",
      index: true,
    },

    booking: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      ref: "Booking",
      index: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    tag: {
      type: String,
      enum: METADATA_TAGS,
      default: undefined,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

metadataSchema.index({ tenant: 1, createdAt: -1 });
metadataSchema.index({ tenant: 1, createdBy: 1, createdAt: -1 });
metadataSchema.index({ tenant: 1, order: 1 });
metadataSchema.index({ tenant: 1, product: 1 });
metadataSchema.index({ tenant: 1, booking: 1 });
metadataSchema.index({ tenant: 1, tag: 1, createdAt: -1 });
