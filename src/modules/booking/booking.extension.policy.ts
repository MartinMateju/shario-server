export const canExtendBooking = (booking: any, now = new Date()) =>
  booking.archive !== true &&
  ["open-studio", "workshop"].includes(String(booking.tag)) &&
  ["processed", "delivered"].includes(booking.status) &&
  booking.paymentStatus === "CONFIRMED" &&
  new Date(booking.end).getTime() > now.getTime() &&
  !(new Date(booking.extensionPaymentPendingUntil).getTime() > now.getTime());
