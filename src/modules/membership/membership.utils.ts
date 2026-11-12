import mongoose from "mongoose";

import { badRequest } from "../../shared/http/httpErrors.js";
import { DEFAULT_MEMBERSHIP_RENEWAL_DAYS } from "./membership.constants.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";

export const toObjectId = (value: string): mongoose.Types.ObjectId => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    badRequest("Invalid object id.");
  }

  return new mongoose.Types.ObjectId(value);
};

export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

export const getDefaultRenewalDate = (from = new Date()): Date => {
  return addDays(from, DEFAULT_MEMBERSHIP_RENEWAL_DAYS);
};

export const normalizeCurrency = (currency: string): string => {
  return normalizeStudioCommerceCurrency(currency);
};
