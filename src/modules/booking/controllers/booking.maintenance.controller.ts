import { removeExpiredTempBookings as removeExpiredTempBookingsService } from "../services/booking-cleanup.service.js";

type RemoveExpiredTempBookingsArgs = {
    tenantId?: string | null;
};

export const removeExpiredTempBookings = ({
    tenantId,
}: RemoveExpiredTempBookingsArgs = {}) => {
    return removeExpiredTempBookingsService({ tenantId });
};