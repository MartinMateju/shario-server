import mongoose from "mongoose";
import Product from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import { getReportPlanEntitlement } from "./report-plan-entitlements.js";
import Order from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import {
  canReadCustomerSpending,
  getRecordedOrderCash,
} from "@/modules/user/services/user.directory-metrics.service.js";
import { applyReconciledRefund } from "@/shared/money/recorded-refund.js";
import {
  isStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION as P } from "@/modules/tenant-access/tenant-access.permissions.js";
import { orderLocationFilter } from "./reports.scope.js";
import { allocateOrderForReport } from "./reports.allocation.js";
import type { ReportContext, ReportLocationScope } from "./reports.types.js";

export const validCashMinor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const currency = (value: unknown): string | null => {
  const code = typeof value === "string" ? value.toUpperCase() : "";
  return isStudioCommerceCurrency(code) ? code : null;
};
const date = (value: unknown): Date | null =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value : null;

export type ReportCashSources = {
  orders: boolean;
  vouchers: boolean;
  memberships: boolean;
  limitations: string[];
  courseOnly: boolean;
  allowLocationless: boolean;
  complete: boolean;
};
export const resolveReportCashSources = ({
  context,
  scope,
  tenant,
}: {
  context: ReportContext;
  scope: ReportLocationScope;
  tenant: any;
}): ReportCashSources => {
  const entitlement = getReportPlanEntitlement({
    plan: tenant?.plan,
    planVersion: Number(tenant?.planVersion ?? 1),
  });
  const courseOnly = entitlement.courseOnly;
  const orders =
    tenant?.modules?.payments === true &&
    entitlement.tier !== "none" &&
    context.access.tenantId === context.tenantId &&
    context.access.status === "active" &&
    hasWorkspacePermission(context.access, P.ORDERS_VIEW) &&
    hasWorkspacePermission(context.access, P.PAYMENTS_VIEW);
  const full =
    orders &&
    !courseOnly &&
    scope.unrestricted &&
    !scope.requestedLocationId &&
    canReadCustomerSpending(context.tenantId, context.access);
  return {
    orders,
    vouchers: full && tenant?.modules?.vouchers === true,
    memberships: full && tenant?.modules?.memberships === true,
    courseOnly,
    allowLocationless: full,
    complete:
      orders &&
      (full ||
        !scope.unrestricted ||
        Boolean(scope.requestedLocationId) ||
        courseOnly),
    limitations: full
      ? []
      : [
          "Cash receipts without an immutable studio allocation (including vouchers and membership invoices) are included only in all-studio reports with full financial access.",
        ],
  };
};

const cashOrderScope = (
  scope: ReportLocationScope,
  sources: ReportCashSources,
) => ({
  ...orderLocationFilter(scope),
  ...(sources.allowLocationless ? {} : { "locationIds.0": { $exists: true } }),
});

export type ReportCashReceipt = {
  source: "order" | "voucher" | "membership";
  sourceId: string;
  customerId: string | null;
  paidAt: Date | null;
  currency: string | null;
  paidMinor: number | null;
  cashMinor: number | null;
  /** Server-side only. Never serialize this raw payment snapshot. */
  order?: any;
  courseProductIds?: string[];
};

/** Shared allocation for reports and filtered customer analytics. Cash is
 * split using immutable order line/location weights, never mutable products. */
export const allocateReportReceiptCash = (
  receipt: ReportCashReceipt,
  scope: ReportLocationScope,
  linePredicate?: (line: any) => boolean,
) => {
  const limitations = new Set<string>();
  if (!receipt.order)
    return {
      cashMinor: receipt.cashMinor,
      paidMinor: receipt.paidMinor,
      allocation: null,
      limitations,
    };
  const predicate =
    linePredicate ??
    (receipt.courseProductIds
      ? (line: any) =>
          receipt.courseProductIds!.includes(String(line.product ?? ""))
      : undefined);
  const allocation = allocateOrderForReport(
    receipt.order,
    scope,
    { available: new Set(), unavailable: [], limitations },
    predicate,
  );
  if (!allocation)
    return { cashMinor: null, paidMinor: null, allocation: null, limitations };
  if (
    (!scope.unrestricted || scope.requestedLocationId) &&
    receipt.cashMinor !== null &&
    receipt.paidMinor !== null &&
    receipt.cashMinor < receipt.paidMinor
  ) {
    limitations.add(
      "Studio-level cash after refunds is allocated using immutable order-line value and studio weights; provider refunds are not independent studio-specific receipts.",
    );
  }
  return {
    cashMinor:
      receipt.cashMinor === null
        ? null
        : allocation.allocateMinorUnits(receipt.cashMinor),
    paidMinor:
      receipt.paidMinor === null
        ? null
        : allocation.allocateMinorUnits(receipt.paidMinor),
    allocation,
    limitations,
  };
};

export const isKnownCashlessOrder = (row: any): boolean => {
  if (row.paidAmountMinor === 0) return true;
  if (row.paidAmountMinor !== null && row.paidAmountMinor !== undefined)
    return false;
  return (
    Array.isArray(row.paymentAllocations) &&
    row.paymentAllocations.length > 0 &&
    row.paymentAllocations.every(
      (allocation: any) =>
        ["free", "credits", "membership_credit", "voucher"].includes(
          allocation.method,
        ) && validCashMinor(allocation.amountMinor),
    )
  );
};

const voucherProviderPaymentMatch = () => ({
  $or: [{ stripeSessionId: /^cs_/ }, { stripePaymentIntentId: /^pi_/ }],
});
const legacyVoucherPaymentMatch = () => ({
  expectedAmountMinor: { $in: [0, null] },
  ...voucherProviderPaymentMatch(),
});

export const recordedVoucherPaidMinor = (row: any): number | null => {
  if (validCashMinor(row.expectedAmountMinor) && row.expectedAmountMinor > 0)
    return row.expectedAmountMinor;
  if (row.expectedAmountMinor != null && row.expectedAmountMinor !== 0)
    return null;
  const hasProviderPayment =
    (typeof row.stripeSessionId === "string" &&
      /^cs_/.test(row.stripeSessionId)) ||
    (typeof row.stripePaymentIntentId === "string" &&
      /^pi_/.test(row.stripePaymentIntentId));
  if (!hasProviderPayment) return row.expectedAmountMinor === 0 ? 0 : null;
  // The supported legacy webhook verifies the captured amount against this
  // purchase total when its expected snapshot is zero/missing. Manual voucher
  // issuance also stores a positive face value, but has no provider payment.
  const code = currency(row.currencySnapshot);
  if (!code || !isStudioCommerceCurrency(code)) return null;
  try {
    return toCurrencyMinorUnits(row.totalSnapshot, code);
  } catch {
    return null;
  }
};

export const recordedVoucherCash = (row: any): number | null => {
  const paid = recordedVoucherPaidMinor(row);
  const returned =
    row.refundedAmountMinor === undefined ? 0 : row.refundedAmountMinor;
  return !row.refundFailureReviewRequired &&
    row.refundState !== "manual_review" &&
    paid !== null &&
    validCashMinor(returned) &&
    returned <= paid
    ? paid - returned
    : null;
};

/** The payment date selects receipts. Successful external refunds recorded at
 * calculation time reduce that original receipt, even if returned later. This
 * is neither historical cash-flow-by-refund-date nor profit. Stored-value and
 * benefit redemption orders collect zero new cash and are never counted twice. */
export async function* iterateReportCashReceipts({
  context,
  scope,
  period,
  now,
  customerIds,
  sources,
}: {
  context: ReportContext;
  scope: ReportLocationScope;
  period: { start: Date; endExclusive: Date };
  now: Date;
  customerIds?: string[];
  sources: ReportCashSources;
}): AsyncGenerator<ReportCashReceipt> {
  if (customerIds?.length === 0 || !sources.orders) return;
  const courseProductIds = sources.courseOnly
    ? (
        await Product.find({
          tenant: context.tenantId,
          type: { $in: COURSE_PRODUCT_TYPES },
        })
          .select("_id")
          .lean()
      ).map((row) => String(row._id))
    : undefined;
  const end = new Date(Math.min(period.endExclusive.valueOf(), now.valueOf()));
  const periodMatch: any = {
    $or: [
      { paidAt: { $gte: period.start, $lt: end } },
      // Settled legacy receipts with no reliable payment date cannot be assigned
      // to a month. Yield unknown evidence rather than silently understating it.
      { paidAt: { $not: { $type: "date" } } },
    ],
  };
  const owner = (field: string) =>
    customerIds ? { [field]: { $in: customerIds } } : {};
  const make = (
    source: ReportCashReceipt["source"],
    row: any,
    paid: unknown,
    net: number | null,
    code: unknown,
    customer: unknown,
  ): ReportCashReceipt => ({
    source,
    sourceId: String(row._id),
    customerId: customer ? String(customer) : null,
    paidAt: date(row.paidAt),
    currency: currency(code),
    paidMinor: validCashMinor(paid) ? paid : null,
    cashMinor: date(row.paidAt) && currency(code) ? net : null,
    ...(source === "order" ? { order: row, courseProductIds } : {}),
  });
  const orders = Order.find({
    tenant: context.tenantId,
    isPaid: true,
    paidAmountMinor: { $ne: 0 },
    ...owner("createdBy"),
    ...cashOrderScope(scope, sources),
    ...periodMatch,
  })
    .select(
      "_id createdBy paidAt currency grossAmountMinor paidAmountMinor expectedAmountMinor lineItems locationIds creditPurchase paymentAllocations refund pieceCheckout.refundedAmountMinor waitlistRefund bookingExtension",
    )
    .lean<any>()
    .cursor({ batchSize: 100 });
  const emitOrders = async (batch: any[]) => {
    const refunds = await BookingPaymentRefund.find({
      tenant: context.tenantId,
      order: { $in: batch.map((row) => row._id) },
      status: "succeeded",
    })
      .select("order customer currency cardAmountMinor")
      .lean();
    const grouped = new Map<string, any[]>();
    for (const refund of refunds) {
      const key = String(refund.order),
        rows = grouped.get(key) ?? [];
      rows.push(refund);
      grouped.set(key, rows);
    }
    return batch.map((row) => {
      let known = getRecordedOrderCash({
        ...row,
        cashRefunds: grouped.get(String(row._id)) ?? [],
      });
      // Added-time refunds predate provider reconciliation. Without a matching
      // cumulative provider total there is no safe cash deduction to infer.
      if (
        row.bookingExtension?.refundStatus === "succeeded" &&
        (!validCashMinor(row.expectedAmountMinor) ||
          row.expectedAmountMinor <= 0 ||
          !validCashMinor(row.refund?.succeededAmountMinor) ||
          row.refund.succeededAmountMinor < row.expectedAmountMinor)
      )
        known = null;
      const cash = applyReconciledRefund(
        row.paidAmountMinor,
        known,
        row.refund,
        false,
      );
      return make(
        "order",
        row,
        row.paidAmountMinor,
        cash,
        row.currency,
        row.createdBy,
      );
    });
  };
  try {
    let batch: any[] = [];
    for await (const row of orders) {
      if (isKnownCashlessOrder(row)) continue;
      if (
        courseProductIds &&
        Array.isArray(row.lineItems) &&
        row.lineItems.length &&
        row.lineItems.every((line: any) => line.product) &&
        !row.lineItems.some((line: any) =>
          courseProductIds.includes(String(line.product)),
        )
      )
        continue;
      batch.push(row);
      if (batch.length === 100) {
        yield* await emitOrders(batch);
        batch = [];
      }
    }
    if (batch.length) yield* await emitOrders(batch);
  } finally {
    await orders.close();
  }
  if (sources.vouchers) {
    const vouchers = CouponOrder.find({
      tenant: context.tenantId,
      ...owner("createdBy"),
      $or: [{ expectedAmountMinor: { $ne: 0 } }, legacyVoucherPaymentMatch()],
      $and: [
        periodMatch,
        {
          $or: [
            { paidAt: { $exists: true, $ne: null } },
            { processedAt: { $type: "date" } },
            { status: { $in: ["processed_coupon", "shipped_coupon"] } },
            { refundedAmountMinor: { $gt: 0 } },
            { refundFailureReviewRequired: true },
          ],
        },
      ],
    })
      .select(
        "_id createdBy paidAt currencySnapshot expectedAmountMinor totalSnapshot stripeSessionId stripePaymentIntentId refundedAmountMinor refundFailureReviewRequired refundState",
      )
      .lean<any>()
      .cursor({ batchSize: 100 });
    try {
      for await (const row of vouchers) {
        const paid = recordedVoucherPaidMinor(row);
        if (paid === 0) continue;
        yield make(
          "voucher",
          row,
          paid,
          recordedVoucherCash(row),
          row.currencySnapshot,
          row.createdBy,
        );
      }
    } finally {
      await vouchers.close();
    }
  }
  if (sources.memberships) {
    const invoices = MembershipInvoice.find({
      tenant: context.tenantId,
      ...owner("user"),
      amountPaidMinor: { $ne: 0 },
      $and: [
        periodMatch,
        {
          $or: [
            { paidAt: { $type: "date" } },
            { amountPaidMinor: { $gt: 0 } },
            { status: "paid" },
          ],
        },
      ],
    })
      .select("_id user paidAt currency amountPaidMinor refund")
      .lean<any>()
      .cursor({ batchSize: 100 });
    try {
      for await (const row of invoices)
        yield make(
          "membership",
          row,
          row.amountPaidMinor,
          applyReconciledRefund(
            row.amountPaidMinor,
            validCashMinor(row.amountPaidMinor) ? row.amountPaidMinor : null,
            row.refund,
            false,
          ),
          row.currency,
          row.user,
        );
    } finally {
      await invoices.close();
    }
  }
}

/** A grouped minimum returns one bounded row per requested customer, rather
 * than materializing their entire order history. All amounts/identity remain
 * tenant scoped; the same source/visibility policy as receipt collection applies. */
export const firstReportPaymentDates = async ({
  context,
  scope,
  customerIds,
  sources,
}: {
  context: ReportContext;
  scope: ReportLocationScope;
  customerIds: string[];
  sources: ReportCashSources;
}) => {
  const result = new Map<string, Date>();
  // Limited-plan lifecycle remains unavailable: a simple first-order date
  // cannot establish first allocated course cash for mixed historical orders.
  if (sources.courseOnly) return result;
  const tenant = new mongoose.Types.ObjectId(context.tenantId);
  for (let offset = 0; offset < customerIds.length; offset += 100) {
    const ids = customerIds
      .slice(offset, offset + 100)
      .filter(mongoose.isValidObjectId)
      .map((value) => new mongoose.Types.ObjectId(value));
    if (!ids.length) continue;
    const run = async (model: any, owner: string, extra: any) => {
      // find().cast retains the existing order location policy for aggregate IDs.
      const query = model.find({
        tenant,
        [owner]: { $in: ids },
        paidAt: { $type: "date" },
        ...extra,
      });
      const match = query.cast(model);
      const rows = await model.aggregate([
        { $match: match },
        { $group: { _id: `$${owner}`, paidAt: { $min: "$paidAt" } } },
      ]);
      for (const row of rows) {
        const key = String(row._id);
        if (!result.has(key) || result.get(key)! > row.paidAt)
          result.set(key, row.paidAt);
      }
    };
    await run(Order, "createdBy", {
      isPaid: true,
      paidAmountMinor: { $gt: 0 },
      ...cashOrderScope(scope, sources),
    });
    if (sources.vouchers) {
      await run(CouponOrder, "createdBy", { expectedAmountMinor: { $gt: 0 } });
      // Validate legacy currency precision with the same conversion as cash
      // collection. Stream only these compatibility rows; memory remains
      // bounded by the requested customer batch, not their receipt history.
      const legacy = CouponOrder.find({
        tenant,
        createdBy: { $in: ids },
        paidAt: { $type: "date" },
        ...legacyVoucherPaymentMatch(),
      })
        .select(
          "createdBy paidAt currencySnapshot expectedAmountMinor totalSnapshot stripeSessionId stripePaymentIntentId",
        )
        .lean<any>()
        .cursor({ batchSize: 100 });
      try {
        for await (const row of legacy) {
          const paid = recordedVoucherPaidMinor(row);
          if (paid === null || paid <= 0) continue;
          const key = String(row.createdBy);
          if (!result.has(key) || result.get(key)! > row.paidAt)
            result.set(key, row.paidAt);
        }
      } finally {
        await legacy.close();
      }
    }
    if (sources.memberships)
      await run(MembershipInvoice, "user", { amountPaidMinor: { $gt: 0 } });
  }
  return result;
};
