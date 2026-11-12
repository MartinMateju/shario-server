import mongoose from "mongoose";

import { supplyOrderSchema } from "./supply-order.schema.js";
import type {
  SupplyOrder as SupplyOrderAttributes,
  SupplyOrderModel,
} from "./supply-order.types.js";

export const SupplyOrder =
  (mongoose.models.SupplyOrder as SupplyOrderModel | undefined) ??
  mongoose.model<SupplyOrderAttributes, SupplyOrderModel>(
    "SupplyOrder",
    supplyOrderSchema,
  );

export default SupplyOrder;