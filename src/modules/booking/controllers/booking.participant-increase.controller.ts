import type { Request, Response } from "express";

/**
 * Compatibility tombstone for the legacy participant-increase endpoint.
 *
 * Participant increases affect both capacity and payment, so they must be
 * created through the checkout flow. Keeping this authenticated endpoint for
 * one compatibility window gives older clients a deterministic migration
 * response without preserving the direct booking mutation.
 */
export const participantIncreaseRequiresCheckout = (
  _req: Request,
  res: Response,
) => {
  res.status(410).json({
    message:
      "Booking participant increases must be completed through checkout.",
    code: "BOOKING_PARTICIPANT_INCREASE_REQUIRES_CHECKOUT",
    checkoutRequired: true,
  });
};
