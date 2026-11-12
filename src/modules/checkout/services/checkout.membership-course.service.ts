import mongoose from "mongoose";
import Claim from "@/modules/membership/membership-course-discount-claim.model.js";
import { Order } from "@/modules/order/order.model.js";
import Booking from "@/modules/booking/booking.model.js";
import { conflict } from "@/shared/http/httpErrors.js";

export const unavailablePersonalCourseDiscounts = async ({ tenantId, userId, bookingIds, orderId }: {
  tenantId: string; userId: string; bookingIds: string[]; orderId?: string;
}): Promise<Set<string>> => {
  if (!bookingIds.length) return new Set();
  const [claims, orders, attended] = await Promise.all([
    Claim.find({ tenant: tenantId, user: userId, booking: { $in: bookingIds }, ...(orderId ? { order: { $ne: orderId } } : {}) }).select("booking order").lean().exec(),
    Order.find({ tenant: new mongoose.Types.ObjectId(tenantId), createdBy: new mongoose.Types.ObjectId(userId), isPaid: true, "courseBookings.bookingId": { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) }, ...(orderId ? { _id: { $ne: new mongoose.Types.ObjectId(orderId) } } : {}) } as Record<string, unknown>).select("courseBookings").lean().exec(),
    Booking.find({ tenant: tenantId, _id: { $in: bookingIds }, participants: { $elemMatch: { customer: userId, attendanceStatus: { $ne: "removed" } } } }).select("_id").lean().exec(),
  ]);
  const cancelled = claims.length ? await Order.find({ tenant: tenantId, _id: { $in: claims.map((claim: any) => claim.order) }, isPaid: false, status: "cancelled_order" }).select("_id").lean().exec() : [];
  const cancelledIds = new Set(cancelled.map((order: any) => String(order._id)));
  return new Set([...claims.filter((claim: any) => !cancelledIds.has(String(claim.order))).map((claim: any) => String(claim.booking)), ...orders.flatMap((order: any) => (order.courseBookings || []).map((slot: any) => String(slot.bookingId))), ...attended.map((booking: any) => String(booking._id))]);
};

/** Must commit with the Order, so no orphan claim can block future checkout. */
export const reservePersonalCourseDiscounts = async ({ tenantId, userId, orderId, bookingIds, session }: {
  tenantId: string; userId: string; orderId: string; bookingIds: string[]; session: mongoose.ClientSession;
}) => {
  for (const bookingId of new Set(bookingIds)) {
    const key = `${tenantId}:${userId}:${bookingId}`;
    const previous = await Claim.findById(key).session(session).lean().exec();
    if (previous && String(previous.order) !== orderId) {
      const cancelled = await Order.exists({ _id: previous.order, tenant: tenantId, isPaid: false, status: "cancelled_order" }).session(session).exec();
      if (cancelled) await Claim.deleteOne({ _id: key, order: previous.order }, { session }).exec();
    }
    try {
      await Claim.updateOne({ _id: key, order: orderId }, { $setOnInsert: { tenant: tenantId, user: userId, booking: bookingId, order: orderId } }, { upsert: true, session }).exec();
    } catch (error: any) {
      if (error?.code === 11000) conflict({ code: "MEMBERSHIP_COURSE_DISCOUNT_ALREADY_USED", message: "Your personal course discount is already reserved or used. Review the updated price." });
      throw error;
    }
  }
};

/** Only terminal, unpaid orders can release a discount; never use a local TTL. */
export const releaseCancelledPersonalCourseDiscounts = async (tenantId: string, orderId: string) => {
  const cancelled = await Order.exists({ _id: orderId, tenant: tenantId, isPaid: false, status: "cancelled_order" }).exec();
  if (cancelled) await Claim.deleteMany({ tenant: tenantId, order: orderId }).exec();
};
