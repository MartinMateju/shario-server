import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The repository only needs these collection names for the aggregation. Keep
// this integration focused on real voucher/ledger/order storage and transactions.
vi.mock("@/modules/product/product.model.js", async () => {
  const { default: m } = await import("mongoose");
  const Product = m.models.Product || m.model("Product", new m.Schema({ tenant: m.Schema.Types.ObjectId, name: String, price: Number }));
  return { default: Product, Product };
});
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));

import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { appendVoucherLedgerEntry, reserveVoucherInSession, voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";

let replicaSet: MongoMemoryReplSet;
const tenantId = new mongoose.Types.ObjectId();
const secondTenant = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();

async function valueCoupon(extra: Record<string, unknown> = {}) {
  return Coupon.create({
    tenant: tenantId, product: productId, promoCode: "FOUNDATION-TEST-001",
    valueMinorSnapshot: 10000, currencySnapshot: "CZK", lifecycleVersion: 1,
    voucherTypeSnapshot: "value", remainingValueMinor: 10000,
    voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "months", months: 12 } },
    expiresAt: new Date(Date.now() + 60_000), ...extra,
  });
}
const reservation = (couponId: mongoose.Types.ObjectId, op: string, amountMinor = 7000) => ({
  tenantId: String(tenantId), couponId, operationId: op, amountMinor,
  currency: "CZK" as const, referenceId: "booking-1", eligibleProductId: String(productId),
});
const settlement = (couponId: mongoose.Types.ObjectId, reservationId: string, op: string) => ({
  tenantId: String(tenantId), couponId, reservationId, operationId: op,
  currency: "CZK" as const, referenceId: "booking-1",
});

describe("voucher lifecycle with MongoDB replica-set transactions", () => {
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
    await mongoose.connection.createCollection("tenants");
    await Promise.all([Coupon.init(), CouponOrder.init(), VoucherLedger.init(), VoucherReservation.init()]);
  }, 60_000);
  beforeEach(async () => {
    await Promise.all([Coupon.collection.deleteMany({}), CouponOrder.collection.deleteMany({}), VoucherLedger.collection.deleteMany({}), VoucherReservation.collection.deleteMany({})]);
    await mongoose.connection.collection("tenants").deleteMany({});
    await mongoose.connection.collection("tenants").insertMany([
      { _id: tenantId, slug: "voucher-lifecycle-primary" },
      { _id: secondTenant, slug: "voucher-lifecycle-secondary" },
    ]);
  });
  afterAll(async () => { await mongoose.disconnect(); if (replicaSet) await replicaSet.stop(); });

  it("prevents two checkouts from reserving more than the real available value", async () => {
    const coupon = await valueCoupon();
    const results = await Promise.allSettled([
      voucherLifecycleService.reserve(reservation(coupon._id, "reserve-a")),
      voucherLifecycleService.reserve({ ...reservation(coupon._id, "reserve-b"), referenceId: "booking-2" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(7000);
    expect(await VoucherReservation.countDocuments()).toBe(1);
    expect(await VoucherLedger.countDocuments()).toBe(1);
  });

  it("makes repeated reserve/commit/reversal operations idempotent and restores only the original value", async () => {
    const coupon = await valueCoupon();
    const reserveInput = reservation(coupon._id, "reserve-a");
    await Promise.all([voucherLifecycleService.reserve(reserveInput), voucherLifecycleService.reserve(reserveInput)]);
    const commit = { ...settlement(coupon._id, "reserve-a", "commit-a"), paymentState: "paid" as const };
    await Promise.all([voucherLifecycleService.commit(commit), voucherLifecycleService.commit(commit)]);
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(3000);
    const reverse = { ...settlement(coupon._id, "reserve-a", "reverse-a"), reason: "Booking canceled" };
    await voucherLifecycleService.reverse(reverse);
    await voucherLifecycleService.reverse(reverse);
    const restored = await Coupon.findById(coupon._id);
    expect(restored?.remainingValueMinor).toBe(10000);
    expect(restored?.reservedValueMinor).toBe(0);
    expect(await VoucherLedger.countDocuments()).toBe(3);
  });

  it("does not free an aged hold while payment may still settle", async () => {
    const coupon = await valueCoupon();
    await voucherLifecycleService.reserve({ ...reservation(coupon._id, "reserve-a"), reviewAfter: new Date(0) });
    expect(() => voucherLifecycleService.release({ ...settlement(coupon._id, "reserve-a", "release-a"), paymentState: "failed" as never, reason: "Attempt failed, intent retryable" })).toThrow("Confirm that payment cannot settle");
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(7000);
    await voucherLifecycleService.release({ ...settlement(coupon._id, "reserve-a", "release-a"), paymentState: "canceled", reason: "Payment intent canceled" });
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(0);
  });

  it("serializes partial cancellation reversals against the remaining paid amount", async () => {
    const coupon = await valueCoupon();
    await voucherLifecycleService.reserve(reservation(coupon._id, "reserve-parts"));
    await voucherLifecycleService.commit({ ...settlement(coupon._id, "reserve-parts", "commit-parts"), paymentState: "paid" });
    const reverse = { ...settlement(coupon._id, "reserve-parts", "part-a"), reason: "Partial cancellation", amountMinor: 5000, quantity: 0 };
    const results = await Promise.allSettled([
      voucherLifecycleService.reverse(reverse),
      voucherLifecycleService.reverse({ ...reverse, operationId: "part-b" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(8000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(1);
    expect(await VoucherReservation.findOne({ operationId: "reserve-parts" })).toMatchObject({ status: "committed", reversedAmountMinor: 5000 });
    await voucherLifecycleService.reverse({ ...reverse, operationId: "part-rest", amountMinor: 2000 });
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(10000);
    expect(await VoucherReservation.findOne({ operationId: "reserve-parts" })).toMatchObject({ status: "reversed", reversedAmountMinor: 7000 });
  });

  it("prevents competing wallet conversion and booking reservation from both consuming a code", async () => {
    const coupon = await valueCoupon();
    const wallet = mongoose.connection.transaction(async session => {
      await acquireVoucherTenantMutationLock(String(tenantId), session);
      return couponRepository.redeemCouponAtomically({ tenantId: String(tenantId), couponId: coupon._id, promoCode: coupon.promoCode, userId: String(actorId), session });
    });
    const results = await Promise.allSettled([wallet, voucherLifecycleService.reserve(reservation(coupon._id, "reserve-race"))]);
    expect(results.filter(result => result.status === "fulfilled" && result.value)).toHaveLength(1);
    const saved = await Coupon.findById(coupon._id);
    expect(Boolean(saved?.redeemedAt) !== Boolean(saved?.reservedValueMinor)).toBe(true);
  });

  it("rolls back an externally composed checkout transaction after reservation succeeds", async () => {
    const coupon = await valueCoupon();
    await expect(mongoose.connection.transaction(async session => {
      await reserveVoucherInSession(reservation(coupon._id, "rolled-back-checkout"), session);
      throw new Error("Booking capacity could not be committed");
    })).rejects.toThrow("Booking capacity could not be committed");
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(0);
    expect(await VoucherLedger.countDocuments()).toBe(0);
    expect(await VoucherReservation.countDocuments()).toBe(0);
  });

  it("blocks wrong tenant, currency, expired codes, and same operation id with different intent", async () => {
    const coupon = await valueCoupon();
    await expect(voucherLifecycleService.reserve({ ...reservation(coupon._id, "reserve-a"), tenantId: String(secondTenant) })).rejects.toMatchObject({ code: "VOUCHER_NOT_FOUND" });
    await expect(voucherLifecycleService.reserve({ ...reservation(coupon._id, "reserve-a"), currency: "EUR" })).rejects.toMatchObject({ code: "VOUCHER_CURRENCY_MISMATCH" });
    await voucherLifecycleService.reserve(reservation(coupon._id, "reserve-a"));
    await expect(voucherLifecycleService.reserve(reservation(coupon._id, "reserve-a", 1000))).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    await Coupon.updateOne({ _id: coupon._id }, { expiresAt: new Date(0) });
    await expect(voucherLifecycleService.reserve(reservation(coupon._id, "reserve-b", 1000))).rejects.toMatchObject({ code: "VOUCHER_EXPIRED" });
  });

  it("redeems an experience against the matching product and reverses one entitlement", async () => {
    const coupon = await valueCoupon({ voucherTypeSnapshot: "experience", remainingValueMinor: undefined, remainingQuantity: 1, voucherSettingsSnapshot: { version: 1, type: "experience", validity: { mode: "none" }, experienceProductId: productId, experienceQuantity: 1 } });
    await expect(voucherLifecycleService.reserve({ ...reservation(coupon._id, "experience", 0), quantity: 1, eligibleProductId: String(new mongoose.Types.ObjectId()) })).rejects.toMatchObject({ code: "VOUCHER_INELIGIBLE" });
    await voucherLifecycleService.reserve({ ...reservation(coupon._id, "experience", 0), quantity: 1 });
    await voucherLifecycleService.commit({ ...settlement(coupon._id, "experience", "commit"), paymentState: "not_required" });
    expect((await Coupon.findById(coupon._id))?.isActive).toBe(false);
    await voucherLifecycleService.reverse({ ...settlement(coupon._id, "experience", "reverse"), reason: "Canceled" });
    expect((await Coupon.findById(coupon._id))?.remainingQuantity).toBe(1);
  });

  it("revokes unused codes once, rejects held or used codes, and preserves converted wallet value", async () => {
    const coupon = await valueCoupon();
    const revoke = { tenantId: String(tenantId), couponId: coupon._id, operationId: "revoke-a", actorId: String(actorId), reason: "Purchase refunded" };
    await voucherLifecycleService.reserve(reservation(coupon._id, "reserve-a"));
    await expect(voucherLifecycleService.revoke(revoke)).rejects.toMatchObject({ code: "VOUCHER_PAYMENT_PENDING" });
    await voucherLifecycleService.release({ ...settlement(coupon._id, "reserve-a", "release-a"), paymentState: "canceled", reason: "Canceled" });
    await Promise.all([voucherLifecycleService.revoke(revoke), voucherLifecycleService.revoke(revoke)]);
    expect(await VoucherLedger.countDocuments({ kind: "revoke" })).toBe(1);
    expect((await Coupon.findById(coupon._id))?.isActive).toBe(false);
    const redeemed = await valueCoupon({ promoCode: "REDEEMED-CODE", redeemedAt: new Date(), redeemedBy: actorId, isActive: false, remainingValueMinor: 0 });
    await expect(voucherLifecycleService.revoke({ ...revoke, couponId: redeemed._id, operationId: "revoke-used" })).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    expect((await Coupon.findById(redeemed._id))?.redeemedBy).toEqual(actorId);
  });

  it("scopes admin order lookup by tenant and honors an explicit relationship over a reused code", async () => {
    const directId = new mongoose.Types.ObjectId();
    const coupon = await valueCoupon({ order: directId, productNameSnapshot: "Purchased experience" });
    const order = { product: productId, unitPriceSnapshot: 100, currencySnapshot: "CZK" as const, email: "buyer@example.com", promoCodesSnapshot: [coupon.promoCode] };
    await CouponOrder.create({ ...order, tenant: secondTenant, email: "private@other-tenant.example" });
    await CouponOrder.create({ ...order, tenant: tenantId, email: "wrong-order@example.com", coupons: [coupon._id] });
    await CouponOrder.create({ ...order, tenant: tenantId, _id: directId, promoCodesSnapshot: [], email: "correct@example.com" });
    const result = await couponRepository.listCoupons({ tenantId: String(tenantId), page: 1, limit: 10, sortOrder: "asc" });
    expect(result.coupons[0].order.email).toBe("correct@example.com");
    await CouponOrder.deleteOne({ _id: directId });
    const orphan = await couponRepository.listCoupons({ tenantId: String(tenantId), page: 1, limit: 10, sortOrder: "asc" });
    expect(orphan.coupons[0].order).toBeUndefined();
  });

  it("rolls back voucher mutation if an operation id belongs to another entry", async () => {
    const coupon = await valueCoupon();
    await mongoose.connection.transaction(session => appendVoucherLedgerEntry({ tenantId: String(tenantId), couponId: coupon._id, operationId: "reused", kind: "issue", currency: "CZK", amountMinor: 10000 }, session));
    await expect(voucherLifecycleService.reserve(reservation(coupon._id, "reused"))).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(0);
    expect(await VoucherReservation.countDocuments()).toBe(0);
    await expect(VoucherLedger.updateOne({}, { amountMinor: 1 })).rejects.toThrow("cannot be changed");
  });
});
