import mongoose from "mongoose";
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
import { voucherArchiveService } from "@/modules/coupon/voucher-archive.service.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
import { issuedVoucherStatus } from "@/modules/coupon/voucher-management-policy.js";
import { voucherManagementDto } from "@/modules/coupon/voucher-record.js";

let repl: MongoMemoryReplSet;
const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const otherProduct = new mongoose.Types.ObjectId();
const actor = new mongoose.Types.ObjectId();
const now = new Date();
let sequence = 0;
const createCode = (extra: Record<string, unknown> = {}) => Coupon.create({
  tenant, product, promoCode: `COURSE-CODE-${++sequence}`,
  productNameSnapshot: "Wheel throwing course",
  valueMinorSnapshot: 10180050, currencySnapshot: "CZK", lifecycleVersion: 1,
  voucherTypeSnapshot: "value", remainingValueMinor: 10180050,
  voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "none" } },
  ...extra,
});
const list = (extra: Record<string, unknown> = {}) => couponRepository.listCoupons({
  tenantId: String(tenant), page: 1, limit: 100, sortOrder: "desc",
  isActive: "all", ...extra,
});
const action = (couponId: mongoose.Types.ObjectId, operationId: string) => ({
  tenantId: String(tenant), couponId: String(couponId),
  actorId: String(actor), operationId,
});
const financialState = (coupon: any) => ({
  isActive: coupon.isActive, expiresAt: coupon.expiresAt,
  valueMinorSnapshot: coupon.valueMinorSnapshot,
  remainingValueMinor: coupon.remainingValueMinor,
  reservedValueMinor: coupon.reservedValueMinor,
  walletRedeemedValueMinor: coupon.walletRedeemedValueMinor,
  voucherSettingsSnapshot: coupon.voucherSettingsSnapshot,
  redeemedAt: coupon.redeemedAt, revokedAt: coupon.revokedAt,
});

describe("voucher code list visibility and archive audit", () => {
  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(repl.getUri());
    await mongoose.connection.createCollection("tenants");
    await Promise.all([Coupon.init(), CouponOrder.init(), VoucherLedger.init(), VoucherReservation.init()]);
  }, 60_000);
  beforeEach(async () => {
    await Promise.all([
      Coupon.collection.deleteMany({}), CouponOrder.collection.deleteMany({}),
      VoucherLedger.collection.deleteMany({}), VoucherReservation.collection.deleteMany({}),
    ]);
    await mongoose.connection.collection("tenants").deleteMany({});
    await mongoose.connection.collection("tenants").insertMany([{ _id: tenant }, { _id: otherTenant }]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (repl) await repl.stop();
  });

  it("filters by the exact original offering and archive state before paginating, retaining deleted-offering history", async () => {
    const visible = await createCode({ remainingValueMinor: 420050 });
    await Coupon.collection.updateOne({ _id: visible._id }, { $unset: { archivedAt: "" } });
    const archived = await createCode({ archivedAt: now, archivedBy: actor });
    await createCode({ product: otherProduct });
    await createCode({ tenant: otherTenant });

    const result = await list({ productId: String(product), limit: 1 });
    expect(result.totalCount).toBe(1);
    expect(result.coupons).toHaveLength(1);
    expect(result.coupons[0]).toMatchObject({
      _id: visible._id, productId: String(product),
      product: { name: "Wheel throwing course", price: 101800.50, currency: "CZK" },
      status: "partially_redeemed", originalValueMinor: 10180050,
      remainingValueMinor: 420050, reservedValueMinor: 0,
      archivedAt: null, canArchive: true, canRestore: false,
    });
    const all = await list({ productId: String(product), archiveState: "all", limit: 1 });
    expect(all.totalCount).toBe(2);
    expect(all.coupons).toHaveLength(1);
    const onlyArchived = await list({ productId: String(product), archiveState: "archived" });
    expect(onlyArchived.coupons.map((item: any) => String(item._id))).toEqual([String(archived._id)]);
    expect(onlyArchived.coupons[0]).toMatchObject({
      status: "active", archivedAt: now.toISOString(), archivedBy: String(actor),
      canArchive: false, canRestore: true,
    });
    expect((await list({ search: visible.promoCode })).totalCount).toBe(1);
    expect((await list({ productId: String(new mongoose.Types.ObjectId()) })).totalCount).toBe(0);
  });

  it("matches the detailed lifecycle status and applies status before counts, independent of archive visibility", async () => {
    const cases = [
      ["active", {}],
      ["partially_redeemed", { remainingValueMinor: 100 }],
      ["reserved", { remainingValueMinor: 100, reservedValueMinor: 50 }],
      ["redeemed", { remainingValueMinor: 0, isActive: false, walletRedeemedValueMinor: 100 }],
      ["expired", { expiresAt: new Date(0), reservedValueMinor: 50 }],
      ["revoked", { revokedAt: now, expiresAt: new Date(0), isActive: false }],
      ["review_required", { refundReviewRequired: true, revokedAt: now }],
      ["inactive", { isActive: false }],
    ] as const;
    for (const [status, extra] of cases) {
      const coupon = await createCode(extra);
      expect(issuedVoucherStatus(coupon)).toBe(status);
    }
    for (const [status] of cases) {
      // Specific statuses override the old active-only filter.
      const result = await list({ status, isActive: true, limit: 1 });
      expect(result.totalCount).toBe(1);
      expect(result.coupons[0].status).toBe(status);
    }
    const redeemed = (await list({ status: "redeemed" })).coupons[0];
    expect(redeemed.walletRedeemedValueMinor).toBe(100);
    expect(redeemed.originalValueMinor).toBe(10180050);
    expect(voucherManagementDto(redeemed).walletRedeemedValueMinor).toBe(100);
  });

  it("audits archive/restore exactly once, fences stale retries and keeps financial terms unchanged", async () => {
    const coupon = await createCode({ remainingValueMinor: 900, reservedValueMinor: 300 });
    const before = financialState(coupon.toObject());
    const archive = action(coupon._id, "11111111-1111-4111-8111-111111111111");
    await Promise.all([voucherArchiveService.archive(archive), voucherArchiveService.archive(archive)]);
    let current = (await Coupon.findById(coupon._id).lean())!;
    expect(financialState(current)).toEqual(before);
    expect(current.archivedAt).toBeInstanceOf(Date);
    expect(String(current.archivedBy)).toBe(String(actor));
    expect(await VoucherLedger.countDocuments()).toBe(1);
    const archiveEvent = (await VoucherLedger.findOne().lean())!;
    expect(archiveEvent).toMatchObject({
      kind: "archive", amountMinor: 0, quantity: 0, actor, coupon: coupon._id,
    });

    const restore = action(coupon._id, "22222222-2222-4222-8222-222222222222");
    await voucherArchiveService.restore(restore);
    await voucherArchiveService.archive(archive);
    current = (await Coupon.findById(coupon._id).lean())!;
    expect(current.archivedAt).toBeNull();
    expect(current.archivedBy).toBeNull();
    expect(financialState(current)).toEqual(before);
    expect(await VoucherLedger.countDocuments()).toBe(2);
    await expect(voucherArchiveService.archive(restore)).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    await expect(voucherArchiveService.archive({ ...archive, tenantId: String(otherTenant) })).rejects.toMatchObject({ code: "VOUCHER_NOT_FOUND" });
    expect(await VoucherLedger.countDocuments({ tenant: otherTenant })).toBe(0);
  });

  it("keeps archived codes eligible for wallet conversion and booking use, without allowing double spending", async () => {
    const wallet = await createCode();
    await voucherArchiveService.archive(action(wallet._id, "33333333-3333-4333-8333-333333333333"));
    const redeem = () => mongoose.connection.transaction((session) => couponRepository.redeemCouponAtomically({
      tenantId: String(tenant), couponId: wallet._id, promoCode: wallet.promoCode,
      userId: String(actor), expectedRemainingValueMinor: 10180050,
      walletRedeemedValueMinor: 10180050, session,
    }));
    expect(await redeem()).not.toBeNull();
    expect(await redeem()).toBeNull();
    const converted = (await Coupon.findById(wallet._id).lean())!;
    expect(converted.archivedAt).toBeInstanceOf(Date);
    expect(converted.remainingValueMinor).toBe(0);
    expect(converted.walletRedeemedValueMinor).toBe(10180050);

    const booking = await createCode();
    await voucherArchiveService.archive(action(booking._id, "44444444-4444-4444-8444-444444444444"));
    await voucherLifecycleService.reserve({
      tenantId: String(tenant), couponId: booking._id, operationId: "reserve-archived",
      amountMinor: 2000, currency: "CZK", referenceId: "booking",
      eligibleProductId: String(otherProduct),
    });
    expect((await Coupon.findById(booking._id))?.reservedValueMinor).toBe(2000);
  });

  it("allows harmless archival of legacy unknown-value and already revoked codes", async () => {
    const coupon = await createCode({
      lifecycleVersion: undefined, valueMinorSnapshot: null, currencySnapshot: null,
      remainingValueMinor: undefined, isActive: false, revokedAt: now,
    });
    const result = await voucherArchiveService.archive(action(coupon._id, "55555555-5555-4555-8555-555555555555"));
    expect(result).toMatchObject({ status: "revoked", valueMinor: null, currency: null, canRestore: true });
    expect(await VoucherLedger.findOne().lean()).toMatchObject({ kind: "archive", currency: null, amountMinor: 0 });
    await expect(VoucherLedger.create({
      tenant, coupon: coupon._id, operationId: "bad-archive-value",
      kind: "archive", amountMinor: 100, currency: "CZK",
    })).rejects.toThrow("Code archival cannot move voucher value");
  });
});
