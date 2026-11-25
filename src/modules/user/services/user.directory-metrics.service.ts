import mongoose, { type PipelineStage } from "mongoose";
import { applyReconciledRefund } from "@/shared/money/recorded-refund.js";

import Booking from "@/modules/booking/booking.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import Order from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import { buildOrderLocationScopeFilter } from "@/modules/order/order.access.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import {
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
} from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import {
  fromCurrencyMinorUnits,
  isStudioCommerceCurrency,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

type CurrencyTotal = { currency: StudioCommerceCurrency; amountMinor: number };
export type DirectorySpendingPeriod = {
  spendFrom?: string;
  spendTo?: string;
  timeZone: string;
};
export type CustomerDirectoryMetrics = {
  lastBookingAt: string | null;
  totalSpent: number | null;
  totalSpentCurrency: StudioCommerceCurrency | null;
  totalSpentByCurrency: CurrencyTotal[] | null;
  periodSpentCurrency?: StudioCommerceCurrency | null;
  periodSpentByCurrency?: CurrencyTotal[] | null;
};

const emptyMetrics = (): CustomerDirectoryMetrics => ({
  lastBookingAt: null,
  totalSpent: null,
  totalSpentCurrency: null,
  totalSpentByCurrency: null,
});
const validMinor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const currencyCode = (value: unknown): StudioCommerceCurrency | null => {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return isStudioCommerceCurrency(code) ? code : null;
};

export const canReadCustomerSpending = (
  tenantId: string,
  access?: ResolvedWorkspaceAccess | null,
) =>
  access?.tenantId === tenantId &&
  access.status === "active" &&
  getAllowedWorkspaceLocationIds(access) === null &&
  [
    WORKSPACE_PERMISSION.ORDERS_VIEW,
    WORKSPACE_PERMISSION.PAYMENTS_VIEW,
    WORKSPACE_PERMISSION.VOUCHERS_VIEW,
    WORKSPACE_PERMISSION.MEMBERSHIPS_VIEW,
  ].every((permission) => hasWorkspacePermission(access, permission));

export const getCustomerDirectoryCurrency = async (tenantId: string) => {
  const tenant = await Tenant.findById(tenantId)
    .select("settings.currency")
    .lean();
  return currencyCode(tenant?.settings?.currency);
};

// Cash collected, not product revenue: stored-value purchases count here;
// their later redemption (paidAmountMinor=0) does not count a second time.
// Only locally recorded, confirmed external refunds are deducted. Wallet
// credits and voucher reversals are not external cash refunds.
export const getRecordedOrderCash = (order: any): number | null => {
  if (!validMinor(order.paidAmountMinor) || !currencyCode(order.currency))
    return null;
  const refunds: number[] = [];
  const pieceRefund = order.pieceCheckout?.refundedAmountMinor;
  if (pieceRefund !== undefined) {
    if (!validMinor(pieceRefund)) return null;
    if (pieceRefund > 0) refunds.push(pieceRefund);
  }
  if (order.waitlistRefund?.status === "succeeded") {
    if (!validMinor(order.waitlistRefund.amountMinor)) return null;
    if (order.waitlistRefund.amountMinor > 0)
      refunds.push(order.waitlistRefund.amountMinor);
  }
  let bookingRefund = 0;
  for (const refund of order.cashRefunds ?? []) {
    if (
      !validMinor(refund.cardAmountMinor) ||
      currencyCode(refund.currency) !== currencyCode(order.currency) ||
      String(refund.customer) !== String(order.createdBy)
    )
      return null;
    bookingRefund += refund.cardAmountMinor;
    if (!Number.isSafeInteger(bookingRefund)) return null;
  }
  if (bookingRefund > 0) refunds.push(bookingRefund);
  // These refund flows belong to different order types. Conflicting evidence
  // cannot safely be summed or silently clamped to the original payment.
  if (refunds.length > 1) return null;
  const refunded = refunds[0] ?? 0;
  return refunded <= order.paidAmountMinor
    ? order.paidAmountMinor - refunded
    : null;
};

const latestBookings = async ({
  tenantId,
  userIds,
  allowedLocationIds,
  now,
}: {
  tenantId: mongoose.Types.ObjectId;
  userIds: mongoose.Types.ObjectId[];
  allowedLocationIds: readonly string[] | null;
  now: Date;
}) => {
  // "Last booking" is the latest visit that has started, including an ongoing
  // visit. Future reservations, drafts, expired holds and cancellations do not
  // move this date. Customer ownership matches the customer-history endpoint.
  const bookingScope = {
    tenant: tenantId,
    start: { $type: "date", $lte: now },
    end: { $type: "date" },
    $expr: { $gte: ["$end", "$start"] },
    status: {
      $in: [
        BOOKING_STATUS.PROCESSED,
        BOOKING_STATUS.DELIVERED,
        BOOKING_STATUS.COMPLETED,
      ],
    },
    ...(allowedLocationIds === null
      ? {}
      : {
          location: {
            $in: allowedLocationIds.map(
              (id) => new mongoose.Types.ObjectId(id),
            ),
          },
        }),
  };
  const [studio, courses] = await Promise.all([
    Booking.aggregate<{ _id: mongoose.Types.ObjectId; lastBookingAt: Date }>([
      {
        $match: {
          ...bookingScope,
          createdBy: { $in: userIds },
          tag: { $in: OPEN_STUDIO_BOOKING_TAGS },
          paymentStatus: { $in: [null, "", /^CONFIRMED$/i] },
        },
      },
      { $group: { _id: "$createdBy", lastBookingAt: { $max: "$start" } } },
    ]),
    Order.aggregate<{ _id: mongoose.Types.ObjectId; lastBookingAt: Date }>([
      {
        $match: {
          tenant: tenantId,
          createdBy: { $in: userIds },
          isPaid: true,
          status: ORDER_STATUS.PROCESSED,
          "courseBookings.0": { $exists: true },
        },
      },
      { $unwind: "$courseBookings" },
      {
        $match: {
          "courseBookings.quantity": { $gt: 0 },
          $expr: {
            $gt: [
              "$courseBookings.quantity",
              {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $ifNull: ["$courseCancellations", []] },
                        as: "cancellation",
                        cond: {
                          $eq: [
                            "$$cancellation.bookingId",
                            "$courseBookings.bookingId",
                          ],
                        },
                      },
                    },
                    as: "cancellation",
                    in: "$$cancellation.quantity",
                  },
                },
              },
            ],
          },
        },
      },
      {
        $lookup: {
          from: Booking.collection.name,
          localField: "courseBookings.bookingId",
          foreignField: "_id",
          pipeline: [
            { $match: { ...bookingScope, tag: { $in: CLASS_BOOKING_TAGS } } },
            { $project: { start: 1 } },
          ],
          as: "booking",
        },
      },
      { $unwind: "$booking" },
      {
        $group: {
          _id: "$createdBy",
          lastBookingAt: { $max: "$booking.start" },
        },
      },
    ]),
  ]);
  const result = new Map<string, Date>();
  for (const row of [...studio, ...courses]) {
    const id = String(row._id);
    if (!result.has(id) || result.get(id)! < row.lastBookingAt)
      result.set(id, row.lastBookingAt);
  }
  return result;
};

export const withCustomerDirectoryMetrics = async <
  T extends Record<string, unknown>,
>({
  tenantId,
  users,
  access,
  now = new Date(),
  spendingPeriod,
  includeBookings = true,
  includeSpending = true,
  defaultCurrency: providedCurrency,
}: {
  tenantId: string;
  users: T[];
  access?: ResolvedWorkspaceAccess | null;
  now?: Date;
  spendingPeriod?: DirectorySpendingPeriod;
  includeBookings?: boolean;
  includeSpending?: boolean;
  defaultCurrency?: StudioCommerceCurrency | null;
}): Promise<(T & CustomerDirectoryMetrics)[]> => {
  const summaries = new Map(
    users.map((user) => [
      String(user._id),
      {
        ...emptyMetrics(),
        ...(spendingPeriod
          ? { periodSpentCurrency: null, periodSpentByCurrency: null }
          : {}),
      } as CustomerDirectoryMetrics,
    ]),
  );
  const userIds = [...summaries.keys()]
    .filter(mongoose.isValidObjectId)
    .map((id) => new mongoose.Types.ObjectId(id));
  const allowedLocationIds = getAllowedWorkspaceLocationIds(access);
  const correctTenant = access?.tenantId === tenantId;
  const canViewBookings =
    includeBookings &&
    correctTenant &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.BOOKINGS_VIEW);
  // A workspace lifetime amount must never be a misleading partial location
  // total. Voucher purchases are locationless, so require complete finance scope.
  const canViewSpending =
    includeSpending && canReadCustomerSpending(tenantId, access);
  if (userIds.length && (canViewBookings || canViewSpending)) {
    const tenant = new mongoose.Types.ObjectId(tenantId);
    await Promise.all([
      canViewBookings
        ? latestBookings({
            tenantId: tenant,
            userIds,
            allowedLocationIds,
            now,
          }).then((dates) => {
            for (const [id, date] of dates)
              summaries.get(id)!.lastBookingAt = date.toISOString();
          })
        : Promise.resolve(),
      canViewSpending
        ? (async () => {
            const defaultCurrency =
              providedCurrency === undefined
                ? await getCustomerDirectoryCurrency(tenantId)
                : providedCurrency;
            const totals = new Map<
              string,
              Map<StudioCommerceCurrency, number>
            >();
            const unknown = new Set<string>();
            const periodTotals = new Map<
              string,
              Map<StudioCommerceCurrency, number>
            >();
            const periodUnknown = new Set<string>();
            const formatter = spendingPeriod
              ? new Intl.DateTimeFormat("en", {
                  timeZone: spendingPeriod.timeZone,
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                })
              : null;
            const accumulate = (
              buckets: typeof totals,
              unavailable: Set<string>,
              id: unknown,
              currency: unknown,
              amount: unknown,
            ) => {
              const key = String(id);
              const code = currencyCode(currency);
              if (!code || !validMinor(amount)) {
                unavailable.add(key);
                return;
              }
              const bucket =
                buckets.get(key) ?? new Map<StudioCommerceCurrency, number>();
              const sum = (bucket.get(code) ?? 0) + amount;
              if (!Number.isSafeInteger(sum)) {
                unavailable.add(key);
                return;
              }
              bucket.set(code, sum);
              buckets.set(key, bucket);
            };
            const add = (
              id: unknown,
              currency: unknown,
              amount: unknown,
              paidAt: unknown,
              lifetime = true,
            ) => {
              if (lifetime) accumulate(totals, unknown, id, currency, amount);
              if (!spendingPeriod || !formatter) return;
              // The period selects payments, then uses their current recorded net
              // cash, including later refunds. Never substitute creation/booking dates.
              if (
                !(paidAt instanceof Date) ||
                !Number.isFinite(paidAt.getTime())
              ) {
                periodUnknown.add(String(id));
                return;
              }
              const parts = Object.fromEntries(
                formatter
                  .formatToParts(paidAt)
                  .map(({ type, value }) => [type, value]),
              );
              const day = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
              if (spendingPeriod.spendFrom && day < spendingPeriod.spendFrom)
                return;
              if (spendingPeriod.spendTo && day > spendingPeriod.spendTo)
                return;
              accumulate(periodTotals, periodUnknown, id, currency, amount);
            };
            const pipeline: PipelineStage[] = [
              {
                $match: {
                  tenant,
                  createdBy: { $in: userIds },
                  isPaid: true,
                  ...buildOrderLocationScopeFilter(allowedLocationIds),
                },
              },
              {
                $project: {
                  createdBy: 1,
                  currency: 1,
                  paidAmountMinor: 1,
                  paidAt: 1,
                  refund: 1,
                  "pieceCheckout.refundedAmountMinor": 1,
                  waitlistRefund: 1,
                },
              },
              {
                $lookup: {
                  from: BookingPaymentRefund.collection.name,
                  localField: "_id",
                  foreignField: "order",
                  pipeline: [
                    { $match: { tenant, status: "succeeded" } },
                    {
                      $project: {
                        customer: 1,
                        currency: 1,
                        cardAmountMinor: 1,
                      },
                    },
                  ],
                  as: "cashRefunds",
                },
              },
            ];
            // One bounded-memory cursor for the whole page, never a query per user.
            for await (const order of Order.aggregate(pipeline).cursor({
              batchSize: 250,
            })) {
              add(
                order.createdBy,
                order.currency,
                applyReconciledRefund(
                  order.paidAmountMinor,
                  getRecordedOrderCash(order),
                  order.refund,
                  false,
                ),
                order.paidAt,
              );
            }
            // Voucher purchases have no immutable location scope. Like locationless
            // legacy orders, they are visible only to all-location finance staff.
            if (allowedLocationIds === null) {
              const vouchers = CouponOrder.find({
                tenant,
                createdBy: { $in: userIds },
                $or: [
                  { paidAt: { $exists: true, $ne: null } },
                  { processedAt: { $type: "date" } },
                  { status: { $in: ["processed_coupon", "shipped_coupon"] } },
                  { refundedAmountMinor: { $gt: 0 } },
                  { refundFailureReviewRequired: true },
                ],
              })
                .select(
                  "createdBy currencySnapshot expectedAmountMinor refundedAmountMinor refundFailureReviewRequired paidAt",
                )
                .lean()
                .cursor({ batchSize: 250 });
              for await (const order of vouchers) {
                // Evidence of a completed/refunded purchase without its confirmed
                // payment date is unavailable, not an unpaid customer's zero.
                if (
                  !(order.paidAt instanceof Date) ||
                  !Number.isFinite(order.paidAt.getTime())
                )
                  unknown.add(String(order.createdBy));
                const refunded =
                  order.refundedAmountMinor === undefined
                    ? 0
                    : order.refundedAmountMinor;
                const amount =
                  !order.refundFailureReviewRequired &&
                  validMinor(order.expectedAmountMinor) &&
                  validMinor(refunded) &&
                  refunded <= order.expectedAmountMinor
                    ? order.expectedAmountMinor - refunded
                    : null;
                add(
                  order.createdBy,
                  order.currencySnapshot,
                  amount,
                  order.paidAt,
                  order.paidAt instanceof Date,
                );
              }
            }
            // Membership invoice snapshots come from authenticated provider reads.
            // Keep their explicit customer link; neither contact/email matching nor
            // membership-credit redemptions are evidence of another cash payment.
            const invoices = MembershipInvoice.find({
              tenant,
              user: { $in: userIds },
              $or: [
                { paidAt: { $type: "date" } },
                { amountPaidMinor: { $gt: 0 } },
                { status: "paid" },
              ],
            })
              .select("user currency amountPaidMinor paidAt refund")
              .lean()
              .cursor({ batchSize: 250 });
            for await (const invoice of invoices) {
              add(
                invoice.user,
                invoice.currency,
                applyReconciledRefund(
                  invoice.amountPaidMinor,
                  validMinor(invoice.amountPaidMinor)
                    ? invoice.amountPaidMinor
                    : null,
                  invoice.refund,
                  false,
                ),
                invoice.paidAt,
              );
            }
            for (const [id, summary] of summaries) {
              if (spendingPeriod && !periodUnknown.has(id)) {
                const amounts = [...(periodTotals.get(id) ?? [])]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([currency, amountMinor]) => ({
                    currency,
                    amountMinor,
                  }));
                summary.periodSpentByCurrency = amounts;
                summary.periodSpentCurrency =
                  amounts.length === 0
                    ? defaultCurrency
                    : amounts.length === 1
                      ? amounts[0].currency
                      : null;
              }
              if (unknown.has(id)) continue;
              const amounts = [...(totals.get(id) ?? [])]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([currency, amountMinor]) => ({ currency, amountMinor }));
              summary.totalSpentByCurrency = amounts;
              // Older clients label the compatibility scalar as CZK. Keep
              // other currencies in the authoritative array during rollout.
              if (!amounts.length) {
                summary.totalSpent = defaultCurrency === "CZK" ? 0 : null;
                summary.totalSpentCurrency = defaultCurrency;
              } else if (amounts.length === 1) {
                summary.totalSpent =
                  amounts[0].currency === "CZK"
                    ? fromCurrencyMinorUnits(
                        amounts[0].amountMinor,
                        amounts[0].currency,
                      )
                    : null;
                summary.totalSpentCurrency = amounts[0].currency;
              }
            }
          })()
        : Promise.resolve(),
    ]);
  }
  return users.map((user) => ({
    ...user,
    ...summaries.get(String(user._id))!,
  }));
};
