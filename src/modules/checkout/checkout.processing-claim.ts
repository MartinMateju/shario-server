export const STRIPE_ORDER_PROCESSING_LEASE_MS = 10 * 60 * 1000;

export const buildStripeOrderLeaseAvailabilityFilter = (now: Date) => ({
  $or: [
    { "stripe.processingClaimToken": { $exists: false } },
    { "stripe.processingClaimToken": "" },
    { "stripe.processingLeaseExpiresAt": null },
    { "stripe.processingLeaseExpiresAt": { $lte: now } },
  ],
});

export const getStripeOrderLeaseExpiry = (now: Date): Date =>
  new Date(now.getTime() + STRIPE_ORDER_PROCESSING_LEASE_MS);
