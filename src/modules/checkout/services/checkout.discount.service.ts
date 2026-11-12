import { calculateInclusiveTax } from "@/modules/invoice/invoice.money.js";
import type { MembershipProductDiscount } from "@/modules/membership/services/membership-discount.service.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import { badRequest } from "@/shared/http/httpErrors.js";

export type CheckoutDiscountCandidate = {
  source: "membership" | "coupon";
  amountMinor: number;
  label: string;
  percentageBps?: number;
  membership?: MembershipProductDiscount;
  coupon?: {
    couponId: string | null;
    promoCode: string;
  };
};

const assertBasisPoints = (value: unknown): number => {
  const percentageBps = Number(value);

  if (
    !Number.isSafeInteger(percentageBps) ||
    percentageBps < 0 ||
    percentageBps > 10_000
  ) {
    badRequest({
      message: "Membership discount percentage is invalid.",
      code: "MEMBERSHIP_DISCOUNT_INVALID",
    });
  }

  return percentageBps;
};

const assertMinor = (value: unknown, label: string): number => {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 0) {
    badRequest({
      message: `${label} must be a nonnegative minor-unit integer.`,
      code: "CHECKOUT_DISCOUNT_AMOUNT_INVALID",
    });
  }

  return amount;
};

/** Uses integer arithmetic and rounds down to one minor unit. */
export const calculatePercentageDiscountMinor = ({
  amountMinor,
  percentageBps,
}: {
  amountMinor: number;
  percentageBps: number;
}): number => {
  const amount = assertMinor(amountMinor, "Discount base");
  const basisPoints = assertBasisPoints(percentageBps);

  return Number((BigInt(amount) * BigInt(basisPoints)) / 10_000n);
};

const lineMatchesSelectedLocation = (
  line: any,
  selectedLocationId: string | null,
): boolean => {
  if (!selectedLocationId) return true;

  return (line?.locationIds ?? []).some(
    (locationId: unknown) => String(locationId) === selectedLocationId,
  );
};

/**
 * Applies a percentage to immutable order-line prices. Discounting each unit
 * keeps `unitGrossMinor * quantity === grossAmountMinor`, which is required by
 * the invoicing audit snapshot and matches the amount sent to Stripe exactly.
 */
export const applyMembershipDiscountToOrderLines = ({
  lineItems,
  discount,
  eligibleCourseBookingIds = new Set<string>(),
  unavailableCourseBookingIds = new Set<string>(),
}: {
  lineItems: readonly any[];
  discount: MembershipProductDiscount | null;
  eligibleCourseBookingIds?: ReadonlySet<string>;
  unavailableCourseBookingIds?: ReadonlySet<string>;
}): {
  lineItems: any[];
  subtotalAmountMinor: number;
  amountMinor: number;
  totalAmountMinor: number;
  personalCourseBookingIds: string[];
} => {
  const percentageBps = discount
    ? assertBasisPoints(discount.percentageBps)
    : 0;
  let subtotalAmountMinor = 0;
  let amountMinor = 0;
  const personalCourseBookingIds = new Set<string>();

  const nextLines = lineItems.flatMap((line, sourceLineIndex) => {
    const quantity = Number(line.quantity);
    const unitGrossMinor = assertMinor(line.unitGrossMinor, "Order line price");

    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      badRequest({
        message: "Order line quantity is invalid.",
        code: "CHECKOUT_DISCOUNT_LINE_INVALID",
      });
    }

    const originalGrossMinor = unitGrossMinor * quantity;

    if (!Number.isSafeInteger(originalGrossMinor)) {
      badRequest({
        message: "Order line total exceeds the safe integer range.",
        code: "CHECKOUT_DISCOUNT_LINE_INVALID",
      });
    }

    subtotalAmountMinor += originalGrossMinor;

    const bookingId = String(line.booking || "");
    const eligible =
      discount &&
      lineMatchesSelectedLocation(line, discount.selectedLocationId) &&
      (!discount.allowedLocationIds || (line.locationIds || []).some((id: unknown) => discount.allowedLocationIds!.includes(String(id)))) &&
      (!discount.eligibleProductIds?.length || discount.eligibleProductIds.includes(String(line.product))) &&
      (discount.productScope !== "courses" || eligibleCourseBookingIds.has(bookingId)) &&
      (!discount.memberOnly || (eligibleCourseBookingIds.has(bookingId) && !unavailableCourseBookingIds.has(bookingId) && !personalCourseBookingIds.has(bookingId)));
    const unitDiscountMinor = eligible
      ? calculatePercentageDiscountMinor({
          amountMinor: unitGrossMinor,
          percentageBps,
        })
      : 0;
    const discountedQuantity = unitDiscountMinor > 0 ? (discount?.memberOnly ? 1 : quantity) : 0;
    if (discount?.memberOnly && discountedQuantity) personalCourseBookingIds.add(bookingId);
    amountMinor += unitDiscountMinor * discountedQuantity;
    return [
      { quantity: discountedQuantity, unitGrossMinor: unitGrossMinor - unitDiscountMinor },
      { quantity: quantity - discountedQuantity, unitGrossMinor },
    ].filter((part) => part.quantity > 0).map((part) => {
      const grossAmountMinor = part.unitGrossMinor * part.quantity;
      const tax = calculateInclusiveTax({ grossAmountMinor, taxRateBps: Number(line.taxRateBps ?? 0) });
      return { ...line, sourceLineIndex, ...part, grossAmountMinor, netAmountMinor: tax.netAmountMinor, taxAmountMinor: tax.taxAmountMinor };
    });
  });

  const totalAmountMinor = subtotalAmountMinor - amountMinor;

  if (
    !Number.isSafeInteger(subtotalAmountMinor) ||
    !Number.isSafeInteger(amountMinor) ||
    !Number.isSafeInteger(totalAmountMinor)
  ) {
    badRequest({
      message: "Discounted checkout total exceeds the safe integer range.",
      code: "CHECKOUT_DISCOUNT_AMOUNT_INVALID",
    });
  }

  return {
    lineItems: nextLines,
    subtotalAmountMinor,
    amountMinor,
    totalAmountMinor,
    personalCourseBookingIds: [...personalCourseBookingIds],
  };
};

/**
 * Coupon and membership discounts are alternatives, never additive. On an
 * exact tie membership wins so a limited-use coupon is not consumed without
 * giving the customer a larger saving.
 */
export const chooseBestCheckoutDiscount = ({
  subtotalAmountMinor,
  membership,
  coupon = null,
}: {
  subtotalAmountMinor: number;
  membership: CheckoutDiscountCandidate | null;
  coupon?: CheckoutDiscountCandidate | null;
}): CheckoutDiscountCandidate | null => {
  const subtotal = assertMinor(subtotalAmountMinor, "Checkout subtotal");
  const candidates = [membership, coupon]
    .filter((candidate): candidate is CheckoutDiscountCandidate => Boolean(candidate))
    .map((candidate) => ({
      ...candidate,
      amountMinor: Math.min(
        subtotal,
        assertMinor(candidate.amountMinor, "Checkout discount"),
      ),
    }))
    .filter((candidate) => candidate.amountMinor > 0)
    .sort((left, right) => {
      const amountDifference = right.amountMinor - left.amountMinor;

      if (amountDifference !== 0) return amountDifference;

      if (left.source === right.source) return 0;

      return left.source === "membership" ? -1 : 1;
    });

  return candidates[0] ?? null;
};

export const buildMembershipDiscountSnapshot = ({
  discount,
  subtotalAmountMinor,
  amountMinor,
  currency,
  appliedAt = new Date(),
}: {
  discount: MembershipProductDiscount | null;
  subtotalAmountMinor: number;
  amountMinor: number;
  currency: StudioCommerceCurrency;
  appliedAt?: Date;
}) => {
  if (!discount || amountMinor <= 0) return null;

  return {
    source: "membership" as const,
    label: discount.benefitLabel,
    currency,
    subtotalAmountMinor: assertMinor(subtotalAmountMinor, "Checkout subtotal"),
    amountMinor: assertMinor(amountMinor, "Membership discount"),
    percentageBps: assertBasisPoints(discount.percentageBps),
    membership: {
      membershipId: discount.membershipId,
      planId: discount.planId,
      planVersionId: discount.planVersionId,
      planVersion: discount.planVersion,
      benefitKey: discount.benefitKey,
      benefitLabel: discount.benefitLabel,
    },
    coupon: null,
    appliedAt,
  };
};
