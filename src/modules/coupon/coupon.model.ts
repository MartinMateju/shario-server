import mongoose, { type Model } from "mongoose";

import { couponOrderSchema, couponSchema } from "./coupon.schema.js";
import type { Coupon as CouponType, CouponOrder as CouponOrderType } from "./coupon.types.js";

type CouponModel = Model<CouponType>;
type CouponOrderModel = Model<CouponOrderType>;

export const Coupon =
  (mongoose.models.Coupon as CouponModel | undefined) ||
  mongoose.model<CouponType, CouponModel>("Coupon", couponSchema);

export const CouponOrder =
  (mongoose.models.CouponOrder as CouponOrderModel | undefined) ||
  mongoose.model<CouponOrderType, CouponOrderModel>(
    "CouponOrder",
    couponOrderSchema,
  );