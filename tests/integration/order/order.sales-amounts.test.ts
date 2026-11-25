import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it } from "vitest";

import { Order } from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { attachOrderSalesAmounts } from "@/modules/order/order.sales-amounts.js";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { autoIndex: false, autoCreate: false });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it("reconciles real scoped ledgers without counting unrelated or cross-tenant returns", async () => {
  const tenant = new mongoose.Types.ObjectId();
  const foreignTenant = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();
  const bookingId = new mongoose.Types.ObjectId();
  const otherOrderId = new mongoose.Types.ObjectId();
  const input = {
    _id: orderId, tenant, isPaid: true, currency: "CZK", grossAmountMinor: 80000,
    lineItems: [{ booking: bookingId, grossAmountMinor: 80000 }],
    cart: { totalPrice: 1000 },
    courseCancellations: [{ bookingId, refundAmountMinor: 20000, currency: "CZK" }],
  };
  const transaction = {
    _id: new mongoose.Types.ObjectId(), type: "refund", currency: "CZK",
    relatedOrder: orderId, relatedBooking: bookingId, amountMinor: 20000, amount: 200,
  };
  await MoneyCredit.collection.insertMany([
    { tenant, transactions: [
      transaction,
      { ...transaction, _id: new mongoose.Types.ObjectId(), type: "use", amountMinor: 80000 },
      { ...transaction, _id: new mongoose.Types.ObjectId(), relatedOrder: otherOrderId, amountMinor: 50000 },
    ] },
    { tenant: foreignTenant, transactions: [{ ...transaction, amountMinor: 70000 }] },
  ]);
  await BookingPaymentRefund.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), tenant: foreignTenant, order: orderId, booking: bookingId,
    currency: "CZK", status: "succeeded", amountMinor: 70000,
  });
  await Order.collection.insertOne({
    tenant: foreignTenant, isPaid: true, bookingExtension: { bookingId },
  });
  const [result] = await attachOrderSalesAmounts(String(tenant), [input]);
  expect(result.salesAmounts).toEqual({
    status: "available", currency: "CZK", grossAmountMinor: 80000,
    refundedAmountMinor: 20000, netAmountMinor: 60000, reason: null,
  });
  expect(Object.keys(result).sort()).toEqual([...Object.keys(input), "salesAmounts"].sort());

  // A same-tenant extension makes the combined booking-level credit refund
  // unallocatable, even when the aggregate is lower than the base order total.
  await Order.collection.insertOne({ tenant, isPaid: true, bookingExtension: { bookingId } });
  const [ambiguous] = await attachOrderSalesAmounts(String(tenant), [input]);
  expect(ambiguous.salesAmounts).toMatchObject({
    status: "unavailable", reason: "refund_allocation_unavailable", netAmountMinor: null,
  });
});
