import mongoose from "mongoose";

import { Order } from "@/modules/order/order.model.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "@/modules/user/user.constants.js";
import UserModel from "@/modules/user/user.model.js";

type PublicGuestIdentity = {
  _id?: unknown;
  customId?: unknown;
  isAccessGranted?: unknown;
  tenantRole?: unknown;
  platformRole?: unknown;
};

const isGeneratedPublicGuest = (
  user: PublicGuestIdentity,
  hasWorkspaceMembership = false,
): boolean =>
  user.isAccessGranted === false &&
  /^G-[a-f0-9]{20}$/i.test(String(user.customId ?? "")) &&
  String(user.tenantRole ?? "").toLowerCase() === TENANT_ROLE.CUSTOMER &&
  String(user.platformRole ?? "").toLowerCase() === PLATFORM_ROLE.NONE &&
  !hasWorkspaceMembership;

export const getPublicGuestCourseOrderStatus = async ({
  tenantId,
  orderId,
}: {
  tenantId: string;
  orderId: string;
}) => {
  if (!mongoose.isValidObjectId(orderId)) return null;

  const order = await Order.findOne({
    _id: orderId,
    tenant: tenantId,
    "courseBookings.0": { $exists: true },
    "creditPurchase.amount": { $not: { $gt: 0 } },
    guestCourseCheckout: { $exists: false },
  })
    .select("_id createdBy status isPaid")
    .lean()
    .exec();

  if (!order?.createdBy || (order as any).guestCourseCheckout) return null;

  const user = await UserModel.findOne({
    _id: order.createdBy,
    tenant: tenantId,
  })
    .select("customId isAccessGranted +tenantRole +platformRole")
    .lean()
    .exec();

  if (!user || !isGeneratedPublicGuest(user)) return null;

  const status = String(order.status || "pending_order");

  return {
    orderId: String(order._id),
    status,
    isPaid: order.isPaid === true,
    terminal: status !== "pending_order",
    processing: status === "pending_order" && order.isPaid === true,
    orderType: "guest-course",
  };
};
