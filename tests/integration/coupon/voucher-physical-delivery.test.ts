import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/product/product.model.js", async () => {
  const { default: m } = await import("mongoose");
  const Product = m.models.Product || m.model("Product", new m.Schema({
    tenant: m.Schema.Types.ObjectId, name: String, price: Number,
  }));
  return { default: Product, Product };
});
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));

import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { voucherPhysicalDeliveryService } from "@/modules/coupon/voucher-physical-delivery.service.js";
import {
  buildPhysicalDeliveryDto,
  physicalDeliveryStatus,
  physicalStatusFilter,
} from "@/modules/coupon/voucher-physical-delivery.policy.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";

let repl: MongoMemoryReplSet;
const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const otherProduct = new mongoose.Types.ObjectId();
const actor = new mongoose.Types.ObjectId();
const now = new Date();
let sequence = 0;
const fixture = async (extra: Record<string, unknown> = {}, codeExtra: Record<string, unknown> = {}) => {
  const id = new mongoose.Types.ObjectId();
  const coupon = await Coupon.create({
    tenant, product, order: id, promoCode: `POSTAL-${++sequence}`,
    valueMinorSnapshot: 200000, currencySnapshot: "CZK",
    lifecycleVersion: 1, voucherTypeSnapshot: "value", remainingValueMinor: 200000,
    voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "none" } },
    ...codeExtra,
  });
  const order = await CouponOrder.create({
    _id: id, tenant, product, email: "buyer@example.test",
    productNameSnapshot: "Course gift", unitPriceSnapshot: 2000, currencySnapshot: "CZK",
    quantity: 1, shippingFeeSnapshot: 89.50, expectedAmountMinor: 208950,
    sendPost: true, firstname: "Eva", lastname: "Test", street: "Test street 1",
    city: "Prague", postalCode: "11000", countryCode: "cz",
    paidAt: now, processedAt: now, status: "processed_coupon",
    coupons: [coupon._id], promoCodesSnapshot: [coupon.promoCode],
    voucherSettingsSnapshot: {
      version: 1, type: "value", validity: { mode: "none" },
      physicalDelivery: { enabled: true, postageFeeMinor: 8950 },
    },
    ...extra,
  });
  return { order, coupon };
};
const dispatch = (id: mongoose.Types.ObjectId, extra: Record<string, string> = {}) =>
  voucherPhysicalDeliveryService.dispatch({
    tenantId: String(tenant), couponOrderId: String(id), actorId: String(actor),
    operationId: randomUUID(), ...extra,
  });

describe("voucher physical fulfillment", () => {
  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(repl.getUri());
    await mongoose.connection.createCollection("tenants");
    await Promise.all([Coupon.init(), CouponOrder.init()]);
  }, 60_000);
  beforeEach(async () => {
    await Promise.all([Coupon.collection.deleteMany({}), CouponOrder.collection.deleteMany({})]);
    await mongoose.connection.collection("tenants").deleteMany({});
    await mongoose.connection.collection("tenants").insertMany([{ _id: tenant }, { _id: otherTenant }]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (repl) await repl.stop();
  });

  it("records one concurrent dispatch, retains original value/address and keeps digital delivery/payment state independent", async () => {
    const { order, coupon } = await fixture();
    const before = order.toObject();
    const operationId = randomUUID();
    const [first, second] = await Promise.all([
      dispatch(order._id, { operationId }), dispatch(order._id, { operationId }),
    ]);
    expect(first.dispatchedAt).toEqual(second.dispatchedAt);
    expect(first.dispatchedBy).toEqual(actor);
    const saved = (await CouponOrder.findById(order._id).lean())!;
    const afterRetry = await dispatch(order._id, { actorId: String(new mongoose.Types.ObjectId()) });
    expect(afterRetry.dispatchedAt).toEqual(saved.dispatchedAt);
    expect(afterRetry.dispatchedBy).toEqual(actor);
    expect(afterRetry.dispatchOperationId).toBe(operationId);
    expect(saved).toMatchObject({
      countryCode: "CZ", status: before.status, paidAt: before.paidAt,
      shippingFeeSnapshot: 89.50, totalSnapshot: 2089.50,
      customerEmailSent: false, adminEmailSent: false,
    });
    expect(saved.voucherSettingsSnapshot?.physicalDelivery).toMatchObject({
      enabled: true, postageFeeMinor: 8950,
    });
    expect((await Coupon.findById(coupon._id).lean())?.remainingValueMinor).toBe(200000);
    const dto = buildPhysicalDeliveryDto(saved, [coupon]);
    expect(dto).toMatchObject({
      requested: true, status: "dispatched", postageFeeMinor: 8950,
      canDispatch: false, dispatchedBy: String(actor), address: { countryCode: "CZ" },
    });
    const publicDto = buildPhysicalDeliveryDto(saved, undefined, { public: true });
    expect(publicDto).not.toHaveProperty("address");
    expect(publicDto).not.toHaveProperty("dispatchedBy");
    expect(publicDto).not.toHaveProperty("canDispatch");
    await CouponOrder.updateOne({ _id: order._id }, { $set: { countryCode: "US" } });
    expect((await CouponOrder.findById(order._id).lean())?.countryCode).toBe("CZ");
  });

  it.each([
    ["not_paid", { paidAt: null, processedAt: null, status: "pending_coupon_payment" }, {}],
    ["cancelled", { paidAt: null, processedAt: null, status: "expired_coupon_payment" }, {}],
    ["not_issued", { processedAt: null }, {}],
    ["not_requested", { sendPost: false }, {}],
    ["cancelled", { refundState: "revoked" }, {}],
    ["cancelled", { refundedAmountMinor: 1 }, {}],
    ["review_required", { refundState: "manual_review" }, {}],
    ["review_required", { refundFailureReviewRequired: true }, {}],
    ["voucher_unavailable", {}, { revokedAt: now }],
    ["voucher_unavailable", {}, { refundReviewRequired: true }],
    ["voucher_expired", { expiresAtSnapshot: new Date(0) }, {}],
    ["voucher_expired", {}, { expiresAt: new Date(0) }],
    ["address_incomplete", { street: "" }, {}],
    ["issuance_inconsistent", { promoCodesSnapshot: ["DIFFERENT-CODE"] }, {}],
  ])("blocks %s without modifying the order", async (reason, orderExtra, codeExtra) => {
    const { order } = await fixture(orderExtra, codeExtra);
    await expect(dispatch(order._id)).rejects.toMatchObject({
      statusCode: 409, code: "VOUCHER_DISPATCH_UNAVAILABLE", details: { reason },
    });
    expect((await CouponOrder.findById(order._id).lean())?.dispatchedAt).toBeNull();
  });

  it("does not expose or dispatch another tenant's order", async () => {
    const { order } = await fixture();
    await expect(dispatch(order._id, { tenantId: String(otherTenant) })).rejects.toMatchObject({
      statusCode: 404, code: "VOUCHER_ORDER_NOT_FOUND",
    });
    expect((await CouponOrder.findById(order._id).lean())?.dispatchedAt).toBeNull();
  });

  it.each([
    { reservedValueMinor: 500 },
    { remainingValueMinor: 100 },
    { isActive: false, remainingValueMinor: 0, redeemedAt: now },
  ])("fulfills the paid postal purchase after digital use without replenishing or changing code value", async (codeExtra) => {
    const { order, coupon } = await fixture({}, codeExtra);
    const before = coupon.toObject();
    expect((await dispatch(order._id)).dispatchedAt).toBeInstanceOf(Date);
    const after = await Coupon.findById(coupon._id).lean();
    expect(after).toEqual(before);
  });

  it("serializes dispatch behind an in-flight refund and refuses the refunded order", async () => {
    const { order } = await fixture();
    const session = await mongoose.startSession();
    session.startTransaction();
    await acquireVoucherTenantMutationLock(String(tenant), session);
    await CouponOrder.updateOne({ _id: order._id }, { $set: { refundState: "revoked" } }, { session });
    const result = dispatch(order._id).then(() => null, (error) => error);
    await session.commitTransaction();
    await session.endSession();
    expect(await result).toMatchObject({
      code: "VOUCHER_DISPATCH_UNAVAILABLE", details: { reason: "cancelled" },
    });
    expect((await CouponOrder.findById(order._id).lean())?.dispatchedAt).toBeNull();
  });

  it("matches list filters to the returned physical status including legacy shipments and tenant/product scope", async () => {
    await fixture({ paidAt: null, processedAt: null, status: "pending_coupon_payment" });
    await fixture();
    await fixture({ refundState: "manual_review", refundedAmountMinor: 1 });
    await fixture({ paidAt: null, status: "expired_coupon_payment" });
    await fixture({ dispatchedAt: now, refundState: "revoked" });
    const { order: legacy } = await fixture({ status: "shipped_coupon" });
    const { order: olderLegacy } = await fixture();
    await CouponOrder.collection.updateOne({ _id: olderLegacy._id }, { $set: { status: "shipped_coupon_order" } });
    await fixture({ sendPost: false });
    await fixture({ tenant: otherTenant });
    await fixture({ product: otherProduct });
    const expected = { awaiting_payment: 1, awaiting_dispatch: 1, review_required: 1, cancelled: 1, dispatched: 3 };
    for (const [status, count] of Object.entries(expected)) {
      const rows = await CouponOrder.find({
        tenant, product, ...physicalStatusFilter(status as keyof typeof expected),
      }).lean();
      expect(rows).toHaveLength(count);
      expect(rows.every((row) => physicalDeliveryStatus(row) === status)).toBe(true);
      const list = await couponRepository.listCouponOrders({
        tenantId: String(tenant), productId: String(product),
        physicalStatus: status as keyof typeof expected,
        page: 1, limit: 1, sortBy: "createdAt", sortOrder: "desc",
      });
      expect(list.totalCount).toBe(count);
      expect(list.couponOrders).toHaveLength(1);
      expect(list.couponOrders[0].physicalDelivery.status).toBe(status);
    }
    expect((await dispatch(legacy._id)).dispatchedAt).toBeNull();
    expect((await dispatch(olderLegacy._id)).dispatchedAt).toBeNull();
  });
});
