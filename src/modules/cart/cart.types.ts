import type { HydratedDocument, Model, Types } from "mongoose";

import type { CartStatus } from "./cart.constants.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

export type ObjectIdLike = string | Types.ObjectId;

export type CartItem = {
  _id?: Types.ObjectId;
  product: Types.ObjectId;
  quantity: number;
  basePrice: number;
  extraCharge: number;
  totalPrice: number;
  numberOfPeople: number;
};

export type Cart = {
  tenant: Types.ObjectId;
  user?: Types.ObjectId | null;
  sessionId: string;
  cartItems: CartItem[];
  currency: StudioCommerceCurrency;
  totalPrice: number;
  expectedAmountMinor: number;
  status: CartStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CartDocument = HydratedDocument<Cart>;
export type CartModel = Model<Cart>;

export type CartIdentity = {
  tenantId: string;
  userId?: string;
  sessionId?: string;
};

export type AddCartItemInput = {
  productId: string;
  quantity?: number;
  basePrice: number;
  extraCharge?: number;
  numberOfPeople?: number;
};

export type UpdateCartItemInput = {
  quantity?: number;
  basePrice?: number;
  extraCharge?: number;
  numberOfPeople?: number;
};

export type CheckCreditsInput = {
  tenantId: string;
  userId: string;
  cartTotal: number;
};

export type CreditCheckResult = {
  canAfford: boolean;
  availableCredits: number;
  requiredAmount: number;
  deficit: number;
};
