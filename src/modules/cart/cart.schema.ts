import mongoose, { type SchemaDefinition } from "mongoose";

import { CART_STATUS } from "./cart.constants.js";
import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  STUDIO_COMMERCE_CURRENCIES,
} from "@/shared/money/currency.js";
import type { Cart } from "./cart.types.js";
import { fromCurrencyMinorUnits } from "@/shared/money/currency.js";

const cartItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Product",
    },

    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },

    basePrice: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    extraCharge: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalPrice: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    numberOfPeople: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  { _id: true },
);

const cartSchemaDefinition: SchemaDefinition<Cart> = {
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tenant",
    required: true,
    index: true,
  },

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
    default: null,
    index: true,
  },

  sessionId: {
    type: String,
    trim: true,
    default: "",
    index: true,
  },

  cartItems: {
    type: [cartItemSchema],
    default: [],
  },

  currency: {
    type: String,
    enum: STUDIO_COMMERCE_CURRENCIES,
    uppercase: true,
    trim: true,
    required: true,
    immutable: true,
    default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
  },

  totalPrice: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },

  expectedAmountMinor: {
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    default: 0,
  },

  status: {
    type: String,
    enum: Object.values(CART_STATUS),
    default: CART_STATUS.ACTIVE,
    index: true,
  },
};

export const cartSchema = new mongoose.Schema<Cart>(cartSchemaDefinition, {
  timestamps: true,
});

cartSchema.index({ tenant: 1, user: 1, status: 1 });
cartSchema.index({ tenant: 1, sessionId: 1, status: 1 });
cartSchema.index({ tenant: 1, status: 1, updatedAt: -1 });
cartSchema.index({ tenant: 1, createdAt: -1 });

cartSchema.pre("validate", function calculateTotals() {
  this.cartItems = this.cartItems.map((item) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const basePrice = Math.max(0, Number(item.basePrice || 0));
    const extraCharge = Math.max(0, Number(item.extraCharge || 0));
    const numberOfPeople = Math.max(1, Number(item.numberOfPeople || 1));

    item.quantity = quantity;
    item.basePrice = basePrice;
    item.extraCharge = extraCharge;
    item.numberOfPeople = numberOfPeople;
    item.totalPrice = (basePrice + extraCharge) * quantity;

    return item;
  });

  this.totalPrice = this.cartItems.reduce(
    (sum, item) => sum + Number(item.totalPrice || 0),
    0,
  );
});
