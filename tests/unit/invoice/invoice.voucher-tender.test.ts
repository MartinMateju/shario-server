import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { InvoiceModel } from "@/modules/invoice/invoice.schema.js";
import { calculateInvoicePaymentState } from "@/modules/invoice/invoice.payment.js";
import { assertManualInvoicePaymentReversible } from "@/modules/invoice/invoice.service.js";
import { recordInvoicePaymentSchema } from "@/modules/invoice/invoice.validators.js";
import {
  buildOrderInvoicePaymentAllocations,
  buildOrderLineSnapshots,
  hasTrustedOrderInvoiceSnapshot,
} from "@/modules/invoice/order-invoice-snapshot.service.js";
import { allocateOrderForReport } from "@/modules/reports/reports.service.js";

const ORDER_ID = new mongoose.Types.ObjectId();
const PRODUCT_ID = new mongoose.Types.ObjectId();
const LOCATION_ID = new mongoose.Types.ObjectId();
const COUPON_ID = new mongoose.Types.ObjectId();
const PAID_AT = new Date("2026-09-15T12:00:00Z");

const paidOrder = (voucherAmount: number) => ({
  _id: ORDER_ID,
  grossAmountMinor: 12_100,
  // The existing paidAmountMinor metric records card collection, not tender.
  expectedAmountMinor: 12_100 - voucherAmount,
  paidAmountMinor: 12_100 - voucherAmount,
  currency: "CZK",
  paidAt: PAID_AT,
  isPaid: true,
  paymentAllocations: [
    {
      method: "voucher",
      amountMinor: voucherAmount,
      providerReference: String(COUPON_ID),
    },
    ...(voucherAmount < 12_100
      ? [
          {
            method: "stripe",
            amountMinor: 12_100 - voucherAmount,
            providerReference: "cs_test_remainder",
          },
        ]
      : []),
  ],
  lineItems: buildOrderLineSnapshots({
    sourceCartItems: [{ product: PRODUCT_ID, locationId: LOCATION_ID }],
    pricedCartItems: [
      { product: PRODUCT_ID, quantity: 1, basePrice: 121, extraCharge: 0 },
    ],
    productById: new Map([[String(PRODUCT_ID), { name: "Studio booking" }]]),
    currency: "CZK",
    defaultTaxRateBps: 2_100,
    pricesIncludeTax: true,
  }),
});

describe("voucher tender accounting", () => {
  it.each([5_000, 12_100])(
    "settles the full invoice using %i of voucher tender without reducing tax",
    (voucherAmount) => {
      const order = paidOrder(voucherAmount);
      expect(hasTrustedOrderInvoiceSnapshot(order)).toBe(true);
      expect(order.lineItems[0]).toMatchObject({
        grossAmountMinor: 12_100,
        netAmountMinor: 10_000,
        taxAmountMinor: 2_100,
      });

      const allocations = buildOrderInvoicePaymentAllocations({
        orderId: order._id,
        allocations: order.paymentAllocations,
        paidAt: order.paidAt,
      });
      const invoice = new InvoiceModel({ paymentAllocations: allocations });
      expect(invoice.validateSync(["paymentAllocations"])).toBeUndefined();
      expect(invoice.paymentAllocations[0]).toMatchObject({
        method: "voucher",
        amountMinor: voucherAmount,
        providerReference: String(COUPON_ID),
        idempotencyKey: `order:${ORDER_ID}:voucher:${COUPON_ID}`,
      });
      expect(
        calculateInvoicePaymentState({
          totalAmountMinor: order.grossAmountMinor,
          allocations: invoice.paymentAllocations,
        }),
      ).toEqual({
        amountPaidMinor: 12_100,
        amountDueMinor: 0,
        paymentStatus: "paid",
      });
      expect(
        buildOrderInvoicePaymentAllocations({
          orderId: order._id,
          allocations: order.paymentAllocations,
          paidAt: order.paidAt,
        }),
      ).toEqual(allocations);
    },
  );

  it("rejects a paid snapshot containing only the card remainder", () => {
    const order = paidOrder(5_000);
    expect(
      hasTrustedOrderInvoiceSnapshot({
        ...order,
        paymentAllocations: order.paymentAllocations.filter(
          (allocation) => allocation.method === "stripe",
        ),
      }),
    ).toBe(false);
    expect(
      hasTrustedOrderInvoiceSnapshot({
        ...order,
        grossAmountMinor: order.expectedAmountMinor,
      }),
    ).toBe(false);
  });

  it.each([5_000, 12_100])(
    "reports the full booking sale with %i voucher tender and the actual card collection",
    (voucherAmount) => {
      const order = paidOrder(voucherAmount);
      const allocation = allocateOrderForReport(
        order,
        {
          requestedLocationId: null,
          locationIds: [String(LOCATION_ID)],
          allowedLocationIds: null,
          unrestricted: true,
        },
        { available: new Set(), unavailable: [], limitations: new Set() },
      );
      expect(allocation).toMatchObject({
        grossSalesMinor: 12_100,
        discountsMinor: 0,
        netSalesMinor: 10_000,
        taxMinor: 2_100,
        paidAmountMinor: 12_100 - voucherAmount,
      });
      expect(allocation?.allocateMinorUnits(voucherAmount)).toBe(voucherAmount);
    },
  );

  it("does not allow invoice APIs to forge or undo voucher spending", () => {
    expect(
      recordInvoicePaymentSchema.safeParse({
        method: "voucher",
        amountMinor: 5_000,
        idempotencyKey: "payment:voucher:1",
      }).success,
    ).toBe(false);
    expect(() => assertManualInvoicePaymentReversible("voucher")).toThrowError(
      expect.objectContaining({
        code: "INVOICE_PAYMENT_PROVIDER_REVERSAL_NOT_ALLOWED",
        message:
          "Voucher payments must be restored through the booking refund workflow.",
      }),
    );
  });
});
