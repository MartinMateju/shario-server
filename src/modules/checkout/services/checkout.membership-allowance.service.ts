import { membershipRepository } from "@/modules/membership/membership.repository.js";
import { membershipAllowsLocation } from "@/modules/membership/membership.location-policy.js";
import { resolveProductKindV2 } from "@/modules/product/product.utils.js";
import { getWorkshopBookingType, getWorkshopPeople } from "../checkout.utils.js";
import { badRequest } from "@/shared/http/httpErrors.js";

/** The request's quantity is never an authority for what a booking consumes. */
export const resolveCheckoutMembershipAllowance = async ({ tenantId, userId, benefitKey, cartItems, productById, totalAmountMinor, currency }: {
  tenantId: string; userId: string; benefitKey: string; cartItems: any[];
  productById: Map<string, any>; totalAmountMinor: number; currency: string;
}) => {
  const membership = await membershipRepository.findActiveUserMembership(tenantId, userId);
  const now = Date.now();
  const periodStart = membership?.currentPeriodStart
    ? new Date(membership.currentPeriodStart).getTime() : Number.NaN;
  const periodEnd = membership?.currentPeriodEnd
    ? new Date(membership.currentPeriodEnd).getTime() : Number.NaN;
  // This service also handles direct cart checkout. A previously displayed
  // option is not authority to spend a pending, paused or unpaid allowance.
  if (!membership || !["active", "cancel_scheduled"].includes(membership.status) ||
      !Number.isFinite(periodStart) || !Number.isFinite(periodEnd) ||
      periodStart > now || periodEnd <= now) {
    badRequest({ code: "MEMBERSHIP_NOT_ACTIVE", message: "A current paid membership is required to use its allowance." });
  }
  const benefit = membership?.planSnapshot?.benefits?.find((item: any) => item.key === benefitKey && item.type === "allowance");
  if (!benefit) badRequest({ code: "MEMBERSHIP_ENTITLEMENT_INVALID", message: "Membership allowance is unavailable." });
  if (!cartItems.every((item) => membershipAllowsLocation(membership, String(item.locationId || "")))) {
    badRequest({ code: "MEMBERSHIP_LOCATION_NOT_ALLOWED", message: "This membership does not cover the selected studio." });
  }
  if (benefit.unit === "money_minor") {
    if (String(benefit.currency).toUpperCase() !== currency.toUpperCase()) badRequest({ code: "MEMBERSHIP_ENTITLEMENT_CURRENCY_MISMATCH", message: "Membership currency does not match the booking." });
    return { quantity: totalAmountMinor, bookingContext: undefined };
  }
  const personal = ["minute", "hour"].includes(benefit.unit) || benefit.usageScope === "open_studio" || benefit.memberOnly === true;
  if (!personal && ["booking", "session", "visit"].includes(benefit.unit)) return { quantity: cartItems.length, bookingContext: undefined };
  // Personal time/visit allowances cannot buy courses, private hire, guests or
  // a mixed cart. The customer can pay for companions separately.
  if (cartItems.length !== 1) badRequest({ code: "MEMBERSHIP_PERSONAL_BOOKING_REQUIRED", message: "Use membership hours for one personal studio booking at a time." });
  const item = cartItems[0];
  const product = productById.get(String(item.product?._id ?? item.product));
  if (!product || resolveProductKindV2(product) !== "open-studio" || getWorkshopBookingType(item, product) !== "public" || item.bookingExtension) {
    badRequest({ code: "MEMBERSHIP_OPEN_STUDIO_ONLY", message: "Membership hours cover shared Open Studio only." });
  }
  if (getWorkshopPeople(item) !== 1 || (item.guests?.length ?? 0) > 0) badRequest({ code: "MEMBERSHIP_MEMBER_ONLY", message: "Membership hours cover only the member; book companions separately." });
  const durationMinutes = (new Date(item.end).getTime() - new Date(item.start).getTime()) / 60_000;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) badRequest({ code: "MEMBERSHIP_BOOKING_DURATION_INVALID", message: "A valid whole-minute booking duration is required." });
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || new Date(item.start).getTime() < periodStart || new Date(item.end).getTime() > periodEnd) {
    badRequest({ code: "MEMBERSHIP_OUTSIDE_PAID_PERIOD", message: "Membership hours cover visits within the current paid membership period." });
  }
  const quantity = benefit.unit === "minute" ? durationMinutes : benefit.unit === "hour" ? Math.ceil(durationMinutes / 60) : ["booking", "session", "visit"].includes(benefit.unit) ? 1 : null;
  if (!quantity) badRequest({ code: "MEMBERSHIP_ENTITLEMENT_INVALID", message: "This allowance cannot fund a booking." });
  return { quantity, bookingContext: { productKind: "open_studio" as const, bookingMode: "public" as const, participantCount: 1, durationMinutes } };
};
