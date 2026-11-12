import MembershipEntitlementBalanceModel from "@/modules/membership/membership-entitlement-balance.schema.js";
import { membershipRepository } from "@/modules/membership/membership.repository.js";
import { resolveCheckoutMembershipAllowance } from "./checkout.membership-allowance.service.js";

/** Quote the same allowance rules enforced by checkout, without consuming it. */
export const getCartMembershipPaymentOptions = async ({
  tenantId, userId, cartItems, productById, totalAmountMinor, currency,
}: {
  tenantId: string; userId: string; cartItems: any[];
  productById: Map<string, any>; totalAmountMinor: number; currency: string;
}) => {
  const membership = await membershipRepository.findActiveUserMembership(tenantId, userId);
  const now = new Date();
  const start = new Date(membership?.currentPeriodStart).getTime();
  const end = new Date(membership?.currentPeriodEnd).getTime();
  if (!membership || !membership.currentPeriodStart || !membership.currentPeriodEnd ||
    !["active", "cancel_scheduled"].includes(membership.status) ||
    !Number.isFinite(start) || !Number.isFinite(end) || start > now.getTime() || end <= now.getTime()) return [];

  const balances = await MembershipEntitlementBalanceModel.find({
    tenant: tenantId, user: userId, membership: membership._id,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).lean().exec();
  const byKey = new Map(balances.map((balance) => [String(balance.benefitKey), balance]));
  const options = [];
  for (const benefit of membership.planSnapshot?.benefits || []) {
    if (benefit.type !== "allowance" || !["minute", "hour", "visit", "session", "booking", "money_minor"].includes(benefit.unit)) continue;
    const balance = byKey.get(String(benefit.key));
    // A rollover bucket can expire before the balance document's final expiry.
    const available = balance?.timeBucketVersion === 1
      ? (balance.timeBuckets || []).filter((bucket) => new Date(bucket.expiresAt) > now)
        .reduce((sum, bucket) => sum + Number(bucket.available || 0), 0)
      : Number(balance?.available || 0);
    let required = 0;
    let unavailableReason: string | undefined;
    try {
      const allowance = await resolveCheckoutMembershipAllowance({
        tenantId, userId, benefitKey: benefit.key, cartItems, productById, totalAmountMinor, currency,
      });
      required = allowance.quantity;
      if (required <= 0) unavailableReason = "membership_entitlement_invalid";
      else if (available < required) unavailableReason = "membership_insufficient_hours";
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Only eligibility failures belong in the quote; infrastructure errors
      // must fail visibly instead of silently removing a purchased benefit.
      if (!code?.startsWith("MEMBERSHIP_")) throw error;
      unavailableReason = code.toLowerCase();
    }
    options.push({
      method: "membership_credits" as const, benefitKey: String(benefit.key),
      label: String(benefit.label || benefit.key), unit: String(benefit.unit),
      required, available, coversTotal: !unavailableReason,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }
  return options;
};
