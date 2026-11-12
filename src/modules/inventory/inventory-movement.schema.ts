import mongoose from "mongoose";

import { roundDerivedCurrencyAmount } from "@/shared/money/amount.js";
import {
  isStudioCommerceCurrency,
  STUDIO_COMMERCE_CURRENCIES,
} from "@/shared/money/currency.js";

import {
  INVENTORY_MOVEMENT_REASON,
  INVENTORY_MOVEMENT_TYPE,
  VAT_RATES,
} from "./inventory.constants.js";
import type {
  InventoryMovementDocument,
  InventoryMovementModel,
} from "./inventory.types.js";

export const inventoryMovementSchema = new mongoose.Schema(
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
    type: {
      type: String,
      enum: Object.values(INVENTORY_MOVEMENT_TYPE),
      required: true,
      index: true,
    },
    reason: {
      type: String,
      enum: Object.values(INVENTORY_MOVEMENT_REASON),
      default: INVENTORY_MOVEMENT_REASON.OTHER,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    destinationLocation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    // Signed change for audit/adjustment traceability. `quantity` remains the
    // absolute amount for backward-compatible displays.
    quantityDelta: {
      type: Number,
      default: null,
    },
    audit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryAudit",
      default: null,
      index: true,
    },
    // Optional only so historical movements remain readable. Every new
    // service-layer write includes this immutable financial snapshot.
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      trim: true,
      uppercase: true,
      immutable: true,
      default: undefined,
    },
    unitCostWithoutVat: {
      type: Number,
      default: 0,
      min: 0,
    },
    vatRate: {
      type: Number,
      enum: VAT_RATES,
      default: 21,
    },
    totalWithoutVat: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWithVat: {
      type: Number,
      default: 0,
      min: 0,
    },
    invoiceNumber: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
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
  },
  { timestamps: true },
);

inventoryMovementSchema.index({ tenant: 1, createdAt: -1 });
inventoryMovementSchema.index({ tenant: 1, item: 1, createdAt: -1 });
inventoryMovementSchema.index({ tenant: 1, location: 1, createdAt: -1 });
inventoryMovementSchema.index({
  tenant: 1,
  destinationLocation: 1,
  createdAt: -1,
});
inventoryMovementSchema.index({ tenant: 1, supplier: 1, createdAt: -1 });
inventoryMovementSchema.index({ tenant: 1, type: 1, reason: 1 });
inventoryMovementSchema.index({ tenant: 1, createdBy: 1 });

inventoryMovementSchema.pre("validate", function calculateTotals() {
  const unroundedTotalWithoutVat =
    Number(this.quantity || 0) * Number(this.unitCostWithoutVat || 0);

  if (!isStudioCommerceCurrency(this.currency)) {
    // Do not assign or guess a denomination for legacy records. This branch
    // preserves their previous validation behaviour if they are ever saved.
    this.totalWithoutVat = unroundedTotalWithoutVat;
    this.totalWithVat =
      unroundedTotalWithoutVat * (1 + Number(this.vatRate || 0) / 100);
    return;
  }

  this.totalWithoutVat = roundDerivedCurrencyAmount(
    unroundedTotalWithoutVat,
    this.currency,
  );
  this.totalWithVat = roundDerivedCurrencyAmount(
    this.totalWithoutVat * (1 + Number(this.vatRate || 0) / 100),
    this.currency,
  );
});

export const InventoryMovement =
  (mongoose.models.InventoryMovement as InventoryMovementModel | undefined) ??
  mongoose.model<InventoryMovementDocument, InventoryMovementModel>(
    "InventoryMovement",
    inventoryMovementSchema,
  );
