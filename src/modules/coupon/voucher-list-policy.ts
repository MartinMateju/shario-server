export type IssuedVoucherStatus =
  | "active"
  | "partially_redeemed"
  | "reserved"
  | "redeemed"
  | "expired"
  | "revoked"
  | "review_required"
  | "inactive";

const present = (field: string) => ({
  $ne: [{ $ifNull: [`$${field}`, null] }, null],
});
const count = (field: string) => ({ $ifNull: [`$${field}`, 0] });
const remaining = {
  $cond: [
    { $eq: ["$voucherTypeSnapshot", "experience"] },
    "$remainingQuantity",
    "$remainingValueMinor",
  ],
};
const original = {
  $cond: [
    { $eq: ["$voucherTypeSnapshot", "experience"] },
    "$voucherSettingsSnapshot.experienceQuantity",
    "$valueMinorSnapshot",
  ],
};

/** Same precedence as issuedVoucherStatus, applied before pagination/counting. */
export const issuedVoucherStatusAggregation = (now: Date) => ({
  $switch: {
    branches: [
      { case: { $eq: ["$refundReviewRequired", true] }, then: "review_required" },
      { case: present("revokedAt"), then: "revoked" },
      {
        case: { $or: [present("redeemedAt"), present("redeemedBy")] },
        then: "redeemed",
      },
      {
        case: { $and: [present("expiresAt"), { $lte: ["$expiresAt", now] }] },
        then: "expired",
      },
      {
        case: {
          $or: [
            ...["reservedAt", "reservedOrder", "reservedBy", "reservedUntil"].map(present),
            { $gt: [count("reservedValueMinor"), 0] },
            { $gt: [count("reservedQuantity"), 0] },
          ],
        },
        then: "reserved",
      },
      {
        case: { $and: [{ $eq: ["$lifecycleVersion", 1] }, { $eq: [remaining, 0] }] },
        then: "redeemed",
      },
      {
        case: {
          $and: [
            { $eq: ["$lifecycleVersion", 1] },
            { $ne: [{ $ifNull: [remaining, null] }, { $ifNull: [original, null] }] },
          ],
        },
        then: "partially_redeemed",
      },
    ],
    default: { $cond: ["$isActive", "active", "inactive"] },
  },
});
