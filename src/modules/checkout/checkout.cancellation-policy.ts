import mongoose from "mongoose";

/** Only ordinary Open Studio card holds use the customer cancellation flow.
 * Use durable order snapshots: expiry may already have removed the cart/booking.
 */
export const isCancellableOpenStudioCardOrder = (
  order: Record<string, any>,
): boolean => {
  const bookingIds = Array.isArray(order.workshopBookings)
    ? order.workshopBookings.map(String)
    : [];
  const lines = Array.isArray(order.lineItems) ? order.lineItems : [];

  return (
    order.isPaid === false &&
    ["pending_order", "cancelled_order"].includes(order.status) &&
    !order.legacyOrder &&
    !order.stripe?.paymentIntentId &&
    !order.stripe?.processingClaimToken &&
    String(order.stripe?.sessionId || "").startsWith("cs_") &&
    String(order.stripe?.connectedAccountId || "").startsWith("acct_") &&
    typeof order.stripe?.livemode === "boolean" &&
    Number.isSafeInteger(order.expectedAmountMinor) &&
    order.expectedAmountMinor > 0 &&
    order.expectedAmountMinor === order.grossAmountMinor &&
    bookingIds.length > 0 &&
    bookingIds.every((id: string) => mongoose.isValidObjectId(id)) &&
    lines.length > 0 &&
    lines.every((line: any) => bookingIds.includes(String(line.booking))) &&
    !(order.courseBookings?.length || order.guestIncreaseBookings?.length) &&
    !(order.voucherRedemptions?.length || order.appliedCoupons?.length) &&
    (order.paymentAllocations || []).every((allocation: any) =>
      allocation.method === "stripe" &&
      allocation.providerReference === order.stripe.sessionId &&
      allocation.amountMinor === order.expectedAmountMinor,
    ) &&
    !(order.creditPurchase?.amount > 0) &&
    !(order.credits?.appliedMajor > 0 || order.credits?.requestedMajor > 0 || order.credits?.couponId) &&
    !order.membershipRedemption?.membershipId &&
    !order.bookingExtension &&
    !order.pieceCheckout &&
    !order.waitlist?.entryId &&
    !order.guestCourseCheckout
  );
};
