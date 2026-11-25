import { applyReconciledRefund } from "@/shared/money/recorded-refund.js";
import { getRecordedOrderCash } from "@/modules/user/services/user.directory-metrics.service.js";

const validMinor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const dateValue = (value: unknown): number | null => {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const time = new Date(value).valueOf();
  return Number.isFinite(time) ? time : null;
};

export type ManagementPayments = {
  orders: any[];
  refunds: any[];
  vouchers: any[];
  invoices: any[];
  currency: string;
  periodStart: Date;
  asOf: Date;
  now: Date;
};

/** Cash paid once at purchase, net of recorded external refunds at the cutoff. */
export const calculateManagementPayments = ({
  orders, refunds, vouchers, invoices, currency, periodStart, asOf, now,
}: ManagementPayments) => {
  const ids = [...new Set([
    ...orders.map(row => String(row.createdBy ?? "")),
    ...vouchers.map(row => String(row.createdBy ?? "")),
    ...invoices.map(row => String(row.user ?? "")),
  ])];
  const details = new Map<string, { spentMonthMinor: number | null; spentTotalMinor: number | null; knownPeriodMinor: number; knownPaymentCount: number; unknownPaymentCount: number }>();
  for (const id of ids) details.set(id, { spentMonthMinor: 0, spentTotalMinor: 0, knownPeriodMinor: 0, knownPaymentCount: 0, unknownPaymentCount: 0 });
  const refundsByOrder = new Map<string, any[]>();
  for (const refund of refunds) {
    const key = String(refund.order);
    const rows = refundsByOrder.get(key) ?? [];
    rows.push(refund);
    refundsByOrder.set(key, rows);
  }
  const cutoff = asOf.valueOf();
  const start = periodStart.valueOf();
  const historical = cutoff < now.valueOf();
  const add = (id: unknown, paidAt: unknown, code: unknown, amount: unknown) => {
    const row = details.get(String(id ?? ""));
    if (!row) return;
    const paid = dateValue(paidAt);
    if (paid !== null && paid >= cutoff) return;
    const knownMoney = typeof code === "string" &&
      code.toUpperCase() === currency && validMinor(amount);
    if (paid === null || paid >= start) {
      if (paid !== null && knownMoney && Number.isSafeInteger(row.knownPeriodMinor + amount)) {
        row.knownPeriodMinor += amount;
        row.knownPaymentCount++;
      } else row.unknownPaymentCount++;
    }
    for (const field of ["spentMonthMinor", "spentTotalMinor"] as const) {
      if (field === "spentMonthMinor" && paid !== null && paid < start) continue;
      const knownDate = paid !== null || (field === "spentTotalMinor" && !historical);
      if (!knownMoney || !knownDate || row[field] === null || !Number.isSafeInteger(row[field]! + amount))
        row[field] = null;
      else row[field]! += amount;
    }
  };
  for (const order of orders) {
    const datedRefunds = refundsByOrder.get(String(order._id)) ?? [];
    const paymentTime = dateValue(order.paidAt);
    const unknownRefundTime = datedRefunds.some((refund) => {
      const completed = dateValue(refund.completedAt);
      return completed === null || (paymentTime !== null && completed < paymentTime);
    });
    // Cumulative piece/voucher refund snapshots and waitlist reconciliation
    // timestamps are not refund event history. Do not backdate them.
    const unknownHistoricalRefund = historical && (
      order.pieceCheckout?.refundedAmountMinor > 0 ||
      (order.waitlistRefund?.status === "succeeded" && order.waitlistRefund.amountMinor > 0)
    );
    const amount = unknownRefundTime || unknownHistoricalRefund ? null : getRecordedOrderCash({
      ...order,
      cashRefunds: datedRefunds.filter((refund) => dateValue(refund.completedAt)! < cutoff),
    });
    add(order.createdBy, order.paidAt, order.currency,
      applyReconciledRefund(order.paidAmountMinor, amount, order.refund, historical));
  }
  for (const voucher of vouchers) {
    const refunded = voucher.refundedAmountMinor === undefined ? 0 : voucher.refundedAmountMinor;
    const amount = !voucher.refundFailureReviewRequired &&
      !(historical && refunded > 0) && validMinor(voucher.expectedAmountMinor) &&
      validMinor(refunded) && refunded <= voucher.expectedAmountMinor
      ? voucher.expectedAmountMinor - refunded : null;
    add(voucher.createdBy, voucher.paidAt, voucher.currencySnapshot, amount);
  }
  for (const invoice of invoices)
    add(invoice.user, invoice.paidAt, invoice.currency,
      applyReconciledRefund(invoice.amountPaidMinor, validMinor(invoice.amountPaidMinor) ? invoice.amountPaidMinor : null,
        invoice.refund, historical));

  const sum = (field: "spentMonthMinor" | "spentTotalMinor") => {
    let total = 0;
    for (const row of details.values()) {
      if (row[field] === null || !Number.isSafeInteger(total + row[field]!)) return null;
      total += row[field]!;
    }
    return total;
  };
  const periodMinor = sum("spentMonthMinor");
  const knownPeriodMinor = [...details.values()].reduce((sum, row) => sum + row.knownPeriodMinor, 0);
  const knownPaymentCount = [...details.values()].reduce((sum, row) => sum + row.knownPaymentCount, 0);
  const unknownPaymentCount = [...details.values()].reduce((sum, row) => sum + row.unknownPaymentCount, 0);
  return { byCustomer: details, periodMinor, knownPeriodMinor: Number.isSafeInteger(knownPeriodMinor) ? knownPeriodMinor : null,
    knownPaymentCount, unknownPaymentCount, totalMinor: sum("spentTotalMinor"), complete: periodMinor !== null };
};
