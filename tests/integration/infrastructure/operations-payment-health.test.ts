import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readPaymentHealth, PAYMENT_HEALTH_AGE_MS, PAYMENT_HEALTH_COUNT_LIMIT } from "@/infrastructure/operations/payment-health.js";
import { Order } from "@/modules/order/order.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { VoucherManagementRefund } from "@/modules/coupon/voucher-management-refund.model.js";
import { PaymentRefundReconciliation } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";

const now = Date.parse("2026-11-01T12:00:00.000Z");
const overdue = new Date(now - PAYMENT_HEALTH_AGE_MS - 1);
const future = new Date(now + 60_000);
const collections = [Order.collection, CouponOrder.collection, BookingPaymentRefund.collection, VoucherManagementRefund.collection, PaymentRefundReconciliation.collection];
// These outboxes intentionally use deterministic string primary keys. The
// generic mongoose collection defaults to ObjectId, so type the native fixture
// collection explicitly instead of pretending those IDs are ObjectIds.
const refundCollection = (collection: mongoose.Collection) => mongoose.connection.db!.collection<{ _id: string; [key: string]: unknown }>(collection.collectionName);
let server: MongoMemoryServer;

describe("read-only payment operational health", () => {
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri(), { autoIndex: false });
  });
  beforeEach(async () => { await Promise.all(collections.map((collection) => collection.deleteMany({}))); });
  afterAll(async () => { await mongoose.disconnect(); await server?.stop(); });

  it("keeps an empty database healthy and detects stale paid orders without exposing records", async () => {
    expect((await readPaymentHealth(now)).every((check) => check.status === "ok" && check.count === 0)).toBe(true);
    await Order.collection.insertMany([
      { isPaid: true, status: "pending_order", updatedAt: overdue, email: "private@example.test", stripe: { paymentIntentId: "pi_private" } },
      { isPaid: true, status: "pending_order", updatedAt: new Date(now) },
      { isPaid: false, status: "pending_order", updatedAt: overdue },
      { isPaid: true, status: "processed_order", updatedAt: overdue },
    ]);
    const result = await readPaymentHealth(now);
    expect(result[0]).toMatchObject({ status: "unhealthy", count: 1, countCapped: false });
    expect(JSON.stringify(result)).not.toMatch(/private|pi_|_id|email|stripe/);
    expect(await Order.collection.countDocuments()).toBe(4);
  });

  it("finds review-required booking, voucher and order records across independent tenants", async () => {
    const tenantA = new mongoose.Types.ObjectId();
    const tenantB = new mongoose.Types.ObjectId();
    await refundCollection(BookingPaymentRefund.collection).insertMany([{ _id: "a", tenant: tenantA, status: "review_required", lastError: "private provider failure" }, { _id: "b", tenant: tenantB, status: "succeeded" }]);
    await refundCollection(VoucherManagementRefund.collection).insertOne({ _id: "c", tenant: tenantB, status: "review_required" });
    await CouponOrder.collection.insertOne({ tenant: tenantB, refundFailureReviewRequired: true });
    await Order.collection.insertOne({ tenant: tenantA, waitlistRefund: { status: "failed" } });
    const result = await readPaymentHealth(now);
    expect(result[1]).toMatchObject({ status: "unhealthy", count: 4 });
    expect(JSON.stringify(result)).not.toMatch(/private|tenant|lastError/);
  });

  it("alerts on unresolved Dashboard refund reviews including incomplete reconciliations", async () => {
    await refundCollection(PaymentRefundReconciliation.collection).insertMany([
      { _id: "dashboard-refund", reviewRequired: true, summary: { status: "partial" }, paymentIntentId: "pi_private" },
      { _id: "unmapped-refund", reviewRequired: true, summary: null, reviewReason: "private mapping details" },
      { _id: "reviewed-refund", reviewRequired: false, summary: { status: "full" } },
    ]);
    const result = await readPaymentHealth(now);
    expect(result[1]).toMatchObject({ status: "unhealthy", count: 2 });
    expect(JSON.stringify(result)).not.toMatch(/dashboard-refund|unmapped-refund|private|paymentIntent/);
    expect(await refundCollection(PaymentRefundReconciliation.collection).countDocuments()).toBe(3);
  });

  it("uses overdue retry/claim times, allowing old provider-pending refunds with a future retry", async () => {
    await refundCollection(BookingPaymentRefund.collection).insertMany([
      { _id: "old-but-retrying", status: "provider_pending", createdAt: new Date(now - 86_400_000), nextAttemptAt: future },
      { _id: "due-retry", status: "provider_pending", nextAttemptAt: overdue },
      { _id: "expired-claim", status: "processing", claimExpiresAt: overdue },
      { _id: "active-claim", status: "processing", claimExpiresAt: future },
      { _id: "done", status: "succeeded", nextAttemptAt: overdue },
    ]);
    await refundCollection(VoucherManagementRefund.collection).insertMany([
      { _id: "voucher-pending", status: "pending", nextAttemptAt: overdue },
      { _id: "voucher-claimed", status: "submitting", claimExpiresAt: overdue },
      { _id: "voucher-active", status: "submitting", claimExpiresAt: future },
    ]);
    expect((await readPaymentHealth(now))[2]).toMatchObject({ status: "unhealthy", count: 4 });
    expect(await refundCollection(BookingPaymentRefund.collection).findOne({ _id: "due-retry" })).toMatchObject({ status: "provider_pending", nextAttemptAt: overdue });
  });

  it("caps scans/results and applies both server and driver time budgets", async () => {
    await Order.collection.insertMany(Array.from({ length: PAYMENT_HEALTH_COUNT_LIMIT + 5 }, () => ({ isPaid: true, status: "pending_order", updatedAt: overdue })));
    const find = vi.spyOn(Order.collection, "find");
    expect((await readPaymentHealth(now))[0]).toMatchObject({ count: PAYMENT_HEALTH_COUNT_LIMIT, countCapped: true });
    expect(find).toHaveBeenCalledWith(expect.any(Object), { projection: { _id: 1 }, limit: PAYMENT_HEALTH_COUNT_LIMIT + 1, maxTimeMS: 1_000, timeoutMS: 1_500 });
  });

  it("reports query failures as unavailable without emitting raw errors", async () => {
    vi.spyOn(Order.collection, "find").mockImplementation(() => { throw new Error("mongodb://secret@private-host"); });
    const result = await readPaymentHealth(now);
    expect(result[0]).toMatchObject({ status: "unavailable", reason: "query_unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-host|mongodb:/);
  });
});
