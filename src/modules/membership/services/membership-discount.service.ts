import {
  MEMBERSHIP_PERCENTAGE_APPLIES_TO,
  MEMBERSHIP_STATUS,
} from "../membership.constants.js";
import { membershipRepository } from "../membership.repository.js";
import { membershipAllowsLocation } from "../membership.location-policy.js";

const DISCOUNT_ELIGIBLE_STATUSES = new Set<string>([
  MEMBERSHIP_STATUS.ACTIVE,
  MEMBERSHIP_STATUS.CANCEL_SCHEDULED,
]);

export type MembershipProductDiscount = {
  membershipId: string;
  planId: string;
  planVersionId: string;
  planVersion: number;
  benefitKey: string;
  benefitLabel: string;
  percentageBps: number;
  selectedLocationId: string | null;
  allowedLocationIds?: string[];
  productScope?: "all" | "courses";
  eligibleProductIds?: string[];
  memberOnly?: boolean;
};

const toId = (value: unknown): string =>
  String((value as { _id?: unknown } | null)?._id ?? value ?? "").trim();

const isCurrentPaidPeriod = (membership: any, now: Date): boolean => {
  if (!DISCOUNT_ELIGIBLE_STATUSES.has(String(membership?.status ?? ""))) {
    return false;
  }

  const periodStart = membership?.currentPeriodStart
    ? new Date(membership.currentPeriodStart)
    : null;
  const periodEnd = membership?.currentPeriodEnd
    ? new Date(membership.currentPeriodEnd)
    : null;

  if (!periodStart || Number.isNaN(periodStart.getTime()) || periodStart > now) {
    return false;
  }

  if (!periodEnd || Number.isNaN(periodEnd.getTime()) || periodEnd <= now || periodEnd <= periodStart) {
    return false;
  }

  return true;
};

export const selectBestProductDiscountBenefit = (
  benefits: readonly any[] = [],
): any | null => {
  const candidates = benefits
    .filter(
      (benefit) =>
        benefit?.type === "percentage" &&
        [
          MEMBERSHIP_PERCENTAGE_APPLIES_TO.PRODUCTS,
          MEMBERSHIP_PERCENTAGE_APPLIES_TO.ALL,
        ].includes(benefit?.appliesTo) &&
        Number.isSafeInteger(Number(benefit?.percentageBps)) &&
        Number(benefit.percentageBps) > 0 &&
        Number(benefit.percentageBps) <= 10_000,
    )
    .sort((left, right) => {
      const percentageDifference =
        Number(right.percentageBps) - Number(left.percentageBps);

      if (percentageDifference !== 0) return percentageDifference;

      return String(left.key ?? "").localeCompare(String(right.key ?? ""));
    });

  return candidates[0] ?? null;
};

/**
 * Resolves the immutable membership snapshot that may discount a checkout.
 *
 * Only an active, already-paid period is eligible. Pending, paused and
 * past-due memberships deliberately receive no commerce discount. Selected
 * location memberships must match at least one location represented by the
 * order; an empty location list therefore cannot bypass location scope.
 */
export const resolveMembershipProductDiscount = async ({
  tenantId,
  userId,
  orderLocationIds = [],
  now = new Date(),
}: {
  tenantId: string;
  userId: string;
  orderLocationIds?: readonly unknown[];
  now?: Date;
}): Promise<MembershipProductDiscount | null> => {
  if (!tenantId || !userId) return null;

  const membership = await membershipRepository.findActiveUserMembership(
    tenantId,
    userId,
  );

  if (!membership || !isCurrentPaidPeriod(membership, now)) return null;

  const snapshot = membership.planSnapshot;
  const selectedLocationId = toId(membership.selectedLocation) || null;

  if (snapshot?.locationScope?.type !== "all") {
    if (!orderLocationIds.some((id) => membershipAllowsLocation(membership, toId(id)))) return null;
  }

  const benefit = selectBestProductDiscountBenefit(snapshot?.benefits ?? []);

  if (!benefit) return null;

  return {
    membershipId: toId(membership),
    planId: toId(membership.plan),
    planVersionId: toId(membership.planVersion),
    planVersion: Math.max(1, Number(snapshot?.version) || 1),
    benefitKey: String(benefit.key),
    benefitLabel: String(benefit.label),
    percentageBps: Number(benefit.percentageBps),
    selectedLocationId: snapshot?.locationScope?.type === "selected" ? selectedLocationId : null,
    ...(snapshot?.locationScope?.type === "shared_selected"
      ? { allowedLocationIds: (snapshot.locationScope.locationIds || []).map(toId) }
      : {}),
    ...(benefit.productScope ? { productScope: benefit.productScope } : {}),
    ...(benefit.eligibleProductIds?.length ? { eligibleProductIds: benefit.eligibleProductIds.map(toId) } : {}),
    ...(benefit.memberOnly === true ? { memberOnly: true } : {}),
  };
};
