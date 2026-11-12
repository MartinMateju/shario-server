import { logger } from "@/config/logger.js";
import { BOOKING_STATUS } from "@/modules/booking/booking.constants.js";
import Booking from "@/modules/booking/booking.model.js";

const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const ONE_YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000;

export async function markProcessedBookingsAsDelivered(): Promise<number> {
    const now = new Date();

    const deliveryCutoffDate = new Date(now.getTime() - ONE_HOUR_IN_MS);
    const oldestAllowedDate = new Date(now.getTime() - ONE_YEAR_IN_MS);

    try {
        const result = await Booking.updateMany(
            {
                status: BOOKING_STATUS.PROCESSED,
                start: {
                    $lte: deliveryCutoffDate,
                    $gte: oldestAllowedDate,
                },
            },
            {
                $set: {
                    status: BOOKING_STATUS.DELIVERED,
                    updatedAt: now,
                },
            },
        ).exec();

        logger.info(
            {
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount,
            },
            "Processed bookings marked as delivered.",
        );

        return result.modifiedCount;
    } catch (error) {
        logger.error(
            {
                err: error,
            },
            "Failed to mark processed bookings as delivered.",
        );

        throw error;
    }
}