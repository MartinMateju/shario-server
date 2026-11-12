import mongoose from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import { INVENTORY_CATEGORY, INVENTORY_UNIT } from "./inventory.constants.js";
import type {
  InventoryItemDocument,
  InventoryItemModel,
} from "./inventory.types.js";
import { synchronizeLegacyInventoryStock } from "./inventory-stock-levels.js";

const inventoryStockLevelSchema = new mongoose.Schema(
  {
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
    },
    currentQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    minimumQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false },
);

export const inventoryItemSchema = new mongoose.Schema(
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
      maxlength: 160,
    },
    sku: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 80,
      default: undefined,
    },
    category: {
      type: String,
      enum: Object.values(INVENTORY_CATEGORY),
      default: INVENTORY_CATEGORY.OTHER,
      index: true,
    },
    unit: {
      type: String,
      enum: Object.values(INVENTORY_UNIT),
      default: INVENTORY_UNIT.PCS,
    },
    locations: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Location",
      },
    ],
    stockLevels: {
      type: [inventoryStockLevelSchema],
      default: [],
      validate: {
        validator: (
          levels: Array<{ location?: mongoose.Types.ObjectId }> = [],
        ) => {
          const locationIds = levels
            .map((level) => String(level.location || ""))
            .filter(Boolean);

          return new Set(locationIds).size === locationIds.length;
        },
        message: "Stock levels must use unique locations.",
      },
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    currentQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    minimumQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Optional for legacy rows. New and safely re-denominated zero-cost items
    // receive a server-derived tenant currency.
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      trim: true,
      uppercase: true,
      default: undefined,
    },
    averageUnitCostWithoutVat: {
      type: Number,
      default: 0,
      min: 0,
    },
    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

inventoryItemSchema.index({ tenant: 1, name: 1 });
inventoryItemSchema.index(
  { tenant: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $type: "string" } },
  },
);
inventoryItemSchema.index({ tenant: 1, category: 1 });
inventoryItemSchema.index({ tenant: 1, locations: 1 });
inventoryItemSchema.index({ tenant: 1, "stockLevels.location": 1 });
inventoryItemSchema.index({ tenant: 1, supplier: 1 });
inventoryItemSchema.index({ tenant: 1, isActive: 1 });

inventoryItemSchema.pre("validate", function synchronizeStockFields() {
  synchronizeLegacyInventoryStock(this);
});

export const InventoryItem =
  (mongoose.models.InventoryItem as InventoryItemModel | undefined) ??
  mongoose.model<InventoryItemDocument, InventoryItemModel>(
    "InventoryItem",
    inventoryItemSchema,
  );
