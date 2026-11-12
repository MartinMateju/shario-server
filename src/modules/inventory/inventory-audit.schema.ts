import mongoose from "mongoose";

import { INVENTORY_AUDIT_STATUS } from "./inventory.constants.js";
import type {
  InventoryAuditDocument,
  InventoryAuditModel,
} from "./inventory.types.js";

const inventoryAuditItemSchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
    },
    expectedQuantity: {
      type: Number,
      default: 0,
    },
    actualQuantity: {
      type: Number,
      default: 0,
    },
    difference: {
      type: Number,
      default: 0,
    },
    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
  },
  { _id: false },
);

export const inventoryAuditSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    auditDate: {
      type: Date,
      required: true,
      index: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(INVENTORY_AUDIT_STATUS),
      default: INVENTORY_AUDIT_STATUS.DRAFT,
      index: true,
    },
    items: {
      type: [inventoryAuditItemSchema],
      default: [],
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
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

inventoryAuditSchema.index({ tenant: 1, auditDate: -1 });
inventoryAuditSchema.index({ tenant: 1, location: 1, auditDate: -1 });
inventoryAuditSchema.index({ tenant: 1, status: 1 });
inventoryAuditSchema.index({ tenant: 1, createdBy: 1 });

inventoryAuditSchema.pre("validate", function calculateDifferences() {
  this.items.forEach((item) => {
    item.difference =
      Number(item.actualQuantity || 0) -
      Number(item.expectedQuantity || 0);
  });
});

export const InventoryAudit =
  (mongoose.models.InventoryAudit as InventoryAuditModel | undefined) ??
  mongoose.model<InventoryAuditDocument, InventoryAuditModel>(
    "InventoryAudit",
    inventoryAuditSchema,
  );