import mongoose from "mongoose";

import { REORDER_PRIORITY, REORDER_STATUS } from "./inventory.constants.js";
import type {
  ReorderRequestDocument,
  ReorderRequestModel,
} from "./inventory.types.js";

export const reorderRequestSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
      index: true,
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    currentQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    recommendedQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    requestedQuantity: {
      type: Number,
      required: true,
      min: Number.EPSILON,
    },
    priority: {
      type: String,
      enum: Object.values(REORDER_PRIORITY),
      default: REORDER_PRIORITY.MEDIUM,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(REORDER_STATUS),
      default: REORDER_STATUS.OPEN,
      index: true,
    },
    source: {
      type: String,
      enum: ["automatic", "manual", "ai"],
      default: "manual",
      index: true,
    },
    aiActionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiAction",
      default: null,
      index: true,
      select: false,
    },
    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    receivedQuantity: {
      type: Number,
      min: Number.EPSILON,
      default: null,
    },
    receivedMovement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryMovement",
      default: null,
    },
  },
  { timestamps: true },
);

reorderRequestSchema.index({ tenant: 1, createdAt: -1 });
reorderRequestSchema.index({ tenant: 1, status: 1, priority: 1 });
reorderRequestSchema.index({ tenant: 1, item: 1 });
reorderRequestSchema.index({ tenant: 1, supplier: 1 });
reorderRequestSchema.index({ tenant: 1, location: 1 });
reorderRequestSchema.index(
  { tenant: 1, aiActionId: 1 },
  {
    unique: true,
    partialFilterExpression: { aiActionId: { $type: "objectId" } },
  },
);
reorderRequestSchema.index(
  { tenant: 1, item: 1, location: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: REORDER_STATUS.OPEN },
  },
);

export const ReorderRequest =
  (mongoose.models.ReorderRequest as ReorderRequestModel | undefined) ??
  mongoose.model<ReorderRequestDocument, ReorderRequestModel>(
    "ReorderRequest",
    reorderRequestSchema,
  );
