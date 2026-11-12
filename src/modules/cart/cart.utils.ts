import mongoose from "mongoose";

import { badRequest } from "../../shared/http/httpErrors.js";

export const toObjectId = (value: string, fieldName = "id"): mongoose.Types.ObjectId => {
  const id = String(value || "").trim();

  if (!mongoose.isValidObjectId(id)) {
    badRequest(`Invalid ${fieldName}.`);
  }

  return new mongoose.Types.ObjectId(id);
};

export const normalizeSessionId = (value: unknown): string => {
  return String(value || "").trim();
};

export const calculateCartItemTotal = ({
  basePrice,
  extraCharge = 0,
  quantity = 1,
}: {
  basePrice: number;
  extraCharge?: number;
  quantity?: number;
}): number => {
  const safeBasePrice = Math.max(0, Number(basePrice || 0));
  const safeExtraCharge = Math.max(0, Number(extraCharge || 0));
  const safeQuantity = Math.max(1, Number(quantity || 1));

  return (safeBasePrice + safeExtraCharge) * safeQuantity;
};
