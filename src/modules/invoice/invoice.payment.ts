import { badRequest } from "@/shared/http/httpErrors.js";

import {
  INVOICE_PAYMENT_STATUS,
  type InvoicePaymentStatus,
} from "./invoice.constants.js";
import { assertMinorAmount } from "./invoice.money.js";

export type PaymentStateAllocation = {
  amountMinor: number;
  reversedAt?: Date | string | null;
};

export const calculateInvoicePaymentState = ({
  totalAmountMinor,
  creditedAmountMinor = 0,
  allocations,
}: {
  totalAmountMinor: number;
  creditedAmountMinor?: number;
  allocations: readonly PaymentStateAllocation[];
}): {
  amountPaidMinor: number;
  amountDueMinor: number;
  paymentStatus: InvoicePaymentStatus;
} => {
  const total = assertMinorAmount(totalAmountMinor, "Invoice total");
  const credited = assertMinorAmount(creditedAmountMinor, "Credited amount");
  if (credited > total) {
    badRequest("Credited amount cannot exceed the invoice total.");
  }

  const amountPaidMinor = allocations.reduce((sum, allocation) => {
    if (allocation.reversedAt) return sum;
    const next = sum + assertMinorAmount(allocation.amountMinor, "Payment amount");
    if (!Number.isSafeInteger(next)) {
      badRequest("Payment total exceeds the supported amount range.");
    }
    return next;
  }, 0);
  if (amountPaidMinor > total) {
    badRequest("Recorded payments cannot exceed the invoice total.");
  }

  const paymentStatus: InvoicePaymentStatus =
    amountPaidMinor === 0
      ? INVOICE_PAYMENT_STATUS.UNPAID
      : amountPaidMinor === total
        ? INVOICE_PAYMENT_STATUS.PAID
        : INVOICE_PAYMENT_STATUS.PARTIALLY_PAID;

  return {
    amountPaidMinor,
    amountDueMinor: Math.max(0, total - credited - amountPaidMinor),
    paymentStatus,
  };
};
