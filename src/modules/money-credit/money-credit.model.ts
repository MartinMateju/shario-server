import mongoose, { type Model } from "mongoose";

import { moneyCreditSchema } from "./money-credit.schema.js";
import type { MoneyCreditDocument } from "./money-credit.types.js";

type MoneyCreditModel = Model<MoneyCreditDocument>;

export const MoneyCredit =
  (mongoose.models.MoneyCredit as MoneyCreditModel | undefined) ||
  mongoose.model<MoneyCreditDocument, MoneyCreditModel>(
    "MoneyCredit",
    moneyCreditSchema,
  );