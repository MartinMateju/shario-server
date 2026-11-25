import mongoose from "mongoose";

import User from "@/modules/user/user.model.js";
import Order from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import { calculateManagementPayments } from "./dashboard-management.payments.js";
import type { ManagementClient } from "./dashboard-management.types.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "@/modules/user/user.constants.js";
import { isValidUserMemberNumber } from "@/modules/user/user-member-number.service.js";

const MAX_ROWS = 20_000;
export type ManagementCustomerDetails = {
  memberNumber: number | null;
  spentMonthMinor: number | null;
  spentTotalMinor: number | null;
  spentMonthComplete?: boolean;
};
const emptyDetails = (): ManagementCustomerDetails => ({
  memberNumber: null,
  spentMonthMinor: null,
  spentTotalMinor: null,
});

/**
 * Same cash basis as the customer directory, for the visible ranked customers.
 * Financial reads are workspace-wide only after the caller has checked full
 * finance permissions and unrestricted location access. Never attribute shared
 * voucher or membership purchases to an arbitrary selected studio.
 */
export const getManagementCustomerDetails = async ({
  tenantId,
  customerIds,
  canViewSpending,
  currency,
  monthStart,
  asOf,
  now,
}: {
  tenantId: string;
  customerIds: string[];
  canViewSpending: boolean;
  currency: string;
  monthStart: Date;
  asOf: Date;
  now: Date;
}) => {
  const ids = [...new Set(customerIds)].filter(mongoose.isValidObjectId);
  const details = new Map(customerIds.map((id) => [id, emptyDetails()]));
  if (!ids.length) return { details, queryLimitExceeded: false };
  const users = await User.find({ tenant: tenantId, _id: { $in: ids } })
    .select("_id memberNumber")
    .lean();
  for (const user of users) {
    const row = details.get(String(user._id));
    if (row && isValidUserMemberNumber(user.memberNumber))
      row.memberNumber = user.memberNumber;
  }
  if (!canViewSpending) return { details, queryLimitExceeded: false };

  const read = async (model: any, filter: Record<string, unknown>, fields: string) =>
    model.find({ tenant: tenantId, ...filter })
      .select(fields).limit(MAX_ROWS + 1).lean() as Promise<any[]>;
  const [orders, vouchers, invoices] = await Promise.all([
    read(Order, { createdBy: { $in: ids }, isPaid: true },
      "_id createdBy currency paidAt paidAmountMinor pieceCheckout.refundedAmountMinor waitlistRefund refund"),
    read(CouponOrder, { createdBy: { $in: ids }, $or: [
      { paidAt: { $type: "date" } }, { status: { $in: ["processed_coupon", "shipped_coupon"] } },
    ] },
      "createdBy currencySnapshot paidAt expectedAmountMinor refundedAmountMinor refundFailureReviewRequired"),
    read(MembershipInvoice, {
      user: { $in: ids },
      $or: [{ paidAt: { $type: "date" } }, { amountPaidMinor: { $gt: 0 } }],
    }, "user currency paidAt amountPaidMinor refund"),
  ]);
  if ([orders, vouchers, invoices].some((rows) => rows.length > MAX_ROWS))
    return { details, queryLimitExceeded: true };
  const refunds = orders.length ? await read(BookingPaymentRefund, {
    order: { $in: orders.map((order) => order._id) }, status: "succeeded",
  }, "order customer currency cardAmountMinor completedAt") : [];
  if (refunds.length > MAX_ROWS) return { details, queryLimitExceeded: true };
  const payments = calculateManagementPayments({ orders, refunds, vouchers, invoices, currency,
    periodStart: monthStart, asOf, now });
  for (const id of ids) {
    const amounts = payments.byCustomer.get(id);
    const hasKnownPartial = amounts?.spentMonthMinor === null && amounts.knownPaymentCount > 0;
    Object.assign(details.get(id)!, {
      spentMonthMinor: hasKnownPartial ? amounts.knownPeriodMinor : amounts?.spentMonthMinor ?? (amounts ? null : 0),
      spentTotalMinor: amounts?.spentTotalMinor ?? (amounts ? null : 0),
      ...(hasKnownPartial ? { spentMonthComplete: false } : {}),
    });
  }
  return { details, queryLimitExceeded: false };
};

/** Rank all eligible customers by recorded monthly payments, independently of visits. */
export const getManagementSpendingRanking = async ({
  tenantId, canRankCustomers, enabled, currency, monthStart, comparisonStart, comparisonEnd, asOf, now,
}: {
  tenantId: string;
  canRankCustomers: boolean;
  enabled: boolean;
  currency: string;
  monthStart: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
  asOf: Date;
  now: Date;
}) => {
  const unavailable = { available: false, rankingAvailable: false, items: [] as ManagementClient[], complete: false,
    queryLimitExceeded: false, currentPaymentsMinor: null as number | null,
    comparisonPaymentsMinor: null as number | null, currentPaymentsComplete: false,
    comparisonPaymentsComplete: false, unknownPaymentCount: 0, rankingLimitExceeded: false };
  if (!enabled) return unavailable;
  const read = async (model: any, filter: Record<string, unknown>, fields: string) =>
    model.find({ tenant: tenantId, ...filter }).select(fields).limit(MAX_ROWS + 1).lean() as Promise<any[]>;
  // Include undated confirmed payments so incomplete history cannot become a fabricated total.
  const dates = { $or: [{ paidAt: { $gte: comparisonStart, $lt: asOf } }, { paidAt: null }] };
  const [orders, vouchers, invoices] = await Promise.all([
    read(Order, { isPaid: true, ...dates },
      "_id createdBy currency paidAt paidAmountMinor pieceCheckout.refundedAmountMinor waitlistRefund refund"),
    read(CouponOrder, { ...dates, $and: [{ $or: [{ paidAt: { $type: 'date' } }, { status: { $in: ['processed_coupon', 'shipped_coupon'] } }] }] },
      "createdBy currencySnapshot paidAt expectedAmountMinor refundedAmountMinor refundFailureReviewRequired"),
    read(MembershipInvoice, { ...dates, $and: [{ $or: [{ paidAt: { $type: 'date' } }, { amountPaidMinor: { $gt: 0 } }] }] },
      "user currency paidAt amountPaidMinor refund"),
  ]);
  if ([orders, vouchers, invoices].some(rows => rows.length > MAX_ROWS))
    return { ...unavailable, queryLimitExceeded: true };
  const refunds = orders.length ? await read(BookingPaymentRefund, {
    order: { $in: orders.map(row => row._id) }, status: "succeeded",
  }, "order customer currency cardAmountMinor completedAt") : [];
  if (refunds.length > MAX_ROWS) return { ...unavailable, queryLimitExceeded: true };
  const sources = { orders, refunds, vouchers, invoices, currency, now };
  const current = calculateManagementPayments({ ...sources, periodStart: monthStart, asOf });
  const previous = calculateManagementPayments({ ...sources, periodStart: comparisonStart, asOf: comparisonEnd });
  const candidateIds = [...current.byCustomer.keys()].filter(mongoose.isValidObjectId);
  const users = canRankCustomers && candidateIds.length ? await read(User, {
    _id: { $in: candidateIds }, tenantRole: TENANT_ROLE.CUSTOMER,
    platformRole: { $in: [PLATFORM_ROLE.NONE, null] },
  }, "_id firstname lastname memberNumber") : [];
  const rankingAvailable = canRankCustomers && users.length <= MAX_ROWS;
  const names = new Map<string, any>((rankingAvailable ? users : []).map(user => [String(user._id), user]));
  const eligible = new Set(names.keys());
  const ranked = [...current.byCustomer].filter(([id, row]) =>
    eligible.has(id) && row.knownPeriodMinor > 0)
    .sort(([a, left], [b, right]) => right.knownPeriodMinor - left.knownPeriodMinor || a.localeCompare(b))
    .slice(0, 5);
  const items = ranked.map(([id, row]): ManagementClient => ({
    id, name: [names.get(id)?.firstname, names.get(id)?.lastname].filter(Boolean).join(" "),
    visits: 0, revenueMinor: row.knownPeriodMinor, spentMonthMinor: row.knownPeriodMinor,
    spentMonthComplete: row.unknownPaymentCount === 0,
  }));
  return { available: true, rankingAvailable, items, queryLimitExceeded: false, rankingLimitExceeded: users.length > MAX_ROWS,
    complete: rankingAvailable && [...current.byCustomer].every(([id, row]) => !eligible.has(id) || row.spentMonthMinor !== null),
    currentPaymentsMinor: current.knownPaymentCount || !current.unknownPaymentCount ? current.knownPeriodMinor : null,
    comparisonPaymentsMinor: previous.knownPaymentCount || !previous.unknownPaymentCount ? previous.knownPeriodMinor : null,
    currentPaymentsComplete: current.complete, comparisonPaymentsComplete: previous.complete,
    unknownPaymentCount: current.unknownPaymentCount };
};
