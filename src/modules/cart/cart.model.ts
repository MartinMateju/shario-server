import { cartSchema } from "@/modules/cart/cart.schema.js";
import mongoose from "mongoose";

import type {
  Cart as CartAttributes,
  CartModel,
} from "@/modules/cart/cart.types.js";

export const Cart =
  (mongoose.models.Cart as CartModel | undefined) ??
  mongoose.model<CartAttributes, CartModel>("Cart", cartSchema);

export default Cart;