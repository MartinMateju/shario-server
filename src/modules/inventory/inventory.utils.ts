import mongoose from "mongoose";

import { roundDerivedCurrencyAmount } from "@/shared/money/amount.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

export const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

export const escapeRegex = (value = ""): string => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

export const getPagination = (page = 1, limit = 50) => {
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit,
  };
};

export const calculateAverageCost = ({
  currentQuantity,
  currentAverageCost,
  addedQuantity,
  addedUnitCost,
  currency,
}: {
  currentQuantity: number;
  currentAverageCost: number;
  addedQuantity: number;
  addedUnitCost: number;
  currency: StudioCommerceCurrency;
}): number => {
  const newQuantity = currentQuantity + addedQuantity;

  if (newQuantity <= 0) {
    return roundDerivedCurrencyAmount(addedUnitCost, currency);
  }

  return roundDerivedCurrencyAmount(
    (
      currentQuantity * currentAverageCost +
      addedQuantity * addedUnitCost
    ) / newQuantity,
    currency,
  );
};
