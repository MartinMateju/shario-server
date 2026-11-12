import mongoose from "mongoose";
import { Coupon, CouponOrder } from "./coupon.model.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import {
  physicalDeliveryStatus,
  physicalDispatchBlocker,
} from "./voucher-physical-delivery.policy.js";

type DispatchInput = {
  tenantId: string;
  couponOrderId: string;
  actorId: string;
  operationId: string;
};

export const voucherPhysicalDeliveryService = {
  async dispatch(input: DispatchInput) {
    return mongoose.connection.transaction(async (session) => {
      // Serialize against voucher issuance/refund/revocation, not only this order.
      await acquireVoucherTenantMutationLock(input.tenantId, session);
      const order = await CouponOrder.findOne({
        tenant: input.tenantId,
        _id: input.couponOrderId,
      }).session(session).lean().exec();
      if (!order) notFound({ code: "VOUCHER_ORDER_NOT_FOUND", message: "Voucher order not found." });
      // Retrying the irreversible dispatch action must never rewrite its audit data.
      if (physicalDeliveryStatus(order) === "dispatched") return order;
      const coupons = await Coupon.find({
        tenant: input.tenantId,
        order: input.couponOrderId,
      }).session(session).lean().exec();
      const reason = physicalDispatchBlocker(order, coupons);
      if (reason) conflict({
        code: "VOUCHER_DISPATCH_UNAVAILABLE",
        message: "This voucher order cannot be marked dispatched.",
        details: { reason },
      });
      const saved = await CouponOrder.findOneAndUpdate({
        _id: order._id,
        tenant: input.tenantId,
        sendPost: true,
        dispatchedAt: null,
        paidAt: { $ne: null },
        processedAt: { $ne: null },
        refundState: { $in: [null, "none"] },
        refundedAmountMinor: { $in: [null, 0] },
        refundFailureReviewRequired: { $ne: true },
      }, {
        $set: {
          dispatchedAt: new Date(),
          dispatchedBy: new mongoose.Types.ObjectId(input.actorId),
          dispatchOperationId: input.operationId,
        },
      }, { session, returnDocument: "after" }).lean().exec();
      if (!saved) conflict({
        code: "VOUCHER_DISPATCH_CHANGED",
        message: "The voucher order changed. Reload it before dispatching.",
      });
      return saved;
    });
  },
};
