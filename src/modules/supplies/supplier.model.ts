import mongoose from "mongoose";

import { supplierSchema } from "./supplier.schema.js";
import type {
  Supplier as SupplierAttributes,
  SupplierModel,
} from "./supply-order.types.js";

export const Supplier =
  (mongoose.models.Supplier as SupplierModel | undefined) ??
  mongoose.model<SupplierAttributes, SupplierModel>("Supplier", supplierSchema);

export default Supplier;