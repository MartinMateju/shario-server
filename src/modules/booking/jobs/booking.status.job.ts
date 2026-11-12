import { logger } from "@/config/logger.js";

import { markProcessedBookingsAsDelivered } from "@/modules/booking/services/booking.status.service.js";

export async function markBookingsAsDelivered(): Promise<void> {
  const modifiedCount =
    await markProcessedBookingsAsDelivered();

  logger.info(
    {
      modifiedCount,
    },
    "Booking delivery job finished.",
  );
}