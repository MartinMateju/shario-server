import { logger } from "@/config/logger.js";

import { removeExpiredTempBookings } from "../services/booking-cleanup.service.js";

export async function removeExpiredTempBookingsJob(): Promise<void> {
  const result = await removeExpiredTempBookings();

  if (result.aborted) {
    logger.warn(
      result,
      "Expired temporary booking cleanup aborted.",
    );

    return;
  }

  logger.info(
    result,
    "Expired temporary booking cleanup completed.",
  );
}