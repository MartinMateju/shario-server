import mongoose from "mongoose";

import { orderSchema } from "./order.schema.js";
import type { Order, OrderModel } from "./order.types.js";

export const OrderModelInstance =
  (mongoose.models.Order as OrderModel | undefined) ||
  mongoose.model<Order, OrderModel>("Order", orderSchema);

export { OrderModelInstance as Order };
export default OrderModelInstance;
