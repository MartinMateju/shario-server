import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type { moneyCreditSchema } from "./money-credit.schema.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

export type MoneyCredit = InferSchemaType<typeof moneyCreditSchema>;
export type MoneyCreditDocument = HydratedDocument<MoneyCredit>;

export type CreditBalanceResult = {
  userId: string;
  balance: number;
  balanceMinor: number;
  currency: StudioCommerceCurrency;
};

export type CreditTransactionReference = {
  relatedOrder?: Types.ObjectId | null;
  relatedBooking?: Types.ObjectId | null;
  relatedCoupon?: Types.ObjectId | null;
  adminId?: Types.ObjectId | null;
  adminName?: string;
  reason?: string;
};
