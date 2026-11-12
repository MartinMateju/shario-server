import type { Request, Response } from "express";

/**
 * Historical DELETE /bookings used a document hard-delete and could orphan
 * paid orders, invoices, access-code notifications and audit history. Keep a
 * non-mutating tombstone so older clients receive a deterministic migration
 * response and must use the transactional cancellation workflow.
 */
export const deleteBookingRequiresCancellation = (
  _req: Request,
  res: Response,
): void => {
  res.status(410).json({
    message:
      "Bookings cannot be deleted. Use the cancellation workflow so payment and booking history remain consistent.",
    code: "BOOKING_DELETE_REQUIRES_CANCELLATION",
    cancellationEndpoint: "PATCH /bookings/cancel",
  });
};
