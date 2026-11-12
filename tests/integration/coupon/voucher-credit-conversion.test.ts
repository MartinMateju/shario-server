import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise actual coupon, reservation, ledger and wallet transactions without
// sending a notification or contacting a payment provider.
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerVoucherRedeemedNotificationSafely: vi.fn(),
}));

import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import { couponService } from "@/modules/coupon/coupon.service.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import Product from "@/modules/product/product.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import UserMemberNumberCounter from "@/modules/user/user-member-number-counter.model.js";

const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const offering = new mongoose.Types.ObjectId();
const otherClass = new mongoose.Types.ObjectId();
const models = [Coupon, CouponOrder, VoucherLedger, VoucherReservation, MoneyCredit, Product, Tenant, User, UserMemberNumberCounter];
const claim = (overrides: Record<string, unknown> = {}) => ({
  tenantId: String(tenant),
  userId: String(customer),
  input: { promoCode: "COURSE-VALUE-001" },
  ...overrides,
});

async function voucher(extra: Record<string, unknown> = {}) {
  return Coupon.create({
    tenant, product: offering, promoCode: "COURSE-VALUE-001",
    lifecycleVersion: 1, voucherTypeSnapshot: "value",
    currencySnapshot: "CZK", valueMinorSnapshot: 10000, remainingValueMinor: 10000,
    productNameSnapshot: "Modelling course",
    voucherSettingsSnapshot: {
      version: 1, type: "value", validity: { mode: "none" },
    },
    ...extra,
  });
}

async function spend(couponId: mongoose.Types.ObjectId, amountMinor = 7000) {
  await voucherLifecycleService.reserve({
    tenantId: String(tenant), couponId, operationId: "booking-hold",
    currency: "CZK", referenceId: "booking-1",
    eligibleProductId: String(otherClass), amountMinor,
  });
  await voucherLifecycleService.commit({
    tenantId: String(tenant), couponId, operationId: "booking-paid",
    reservationId: "booking-hold", currency: "CZK",
    referenceId: "booking-1", paymentState: "paid",
  });
}

describe("course voucher remaining-value conversion with real wallet transactions", () => {
  let replica: MongoMemoryReplSet | undefined;

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all(models.map(model => model.createCollection()));
    await Promise.all([Coupon, VoucherLedger, VoucherReservation, MoneyCredit].map(model => model.createIndexes()));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });

  beforeEach(async () => {
    await Promise.all(models.map(model => model.collection.deleteMany({})));
    await Tenant.collection.insertMany([
      { _id: tenant, settings: { currency: "CZK" } },
      { _id: otherTenant, settings: { currency: "CZK" } },
    ] as never[]);
    await User.create({
      _id: customer, tenant, firstname: "Voucher", lastname: "Customer",
      customId: "VOUCHER-1", memberNumber: 42, moneyCredits: 0, moneyCreditsMinor: 0,
    });
    // The offering price has changed since issuance. The original snapshot
    // remains authoritative for conversion and the code is not course-bound.
    await Product.collection.insertOne({
      _id: offering, tenant, kind: "voucher", type: "coupon",
      name: { EN: "Modelling course" }, price: 999, currency: "CZK",
    } as never);
  });

  it("credits only the remaining value after use on a different class", async () => {
    const coupon = await voucher();
    await spend(coupon._id);
    await expect(couponService.redeemPromoCode(claim())).resolves.toMatchObject({
      creditsAdded: 30, newBalance: 30, currency: "CZK",
    });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      valueMinorSnapshot: 10000, remainingValueMinor: 0,
      walletRedeemedValueMinor: 3000, isActive: false, redeemedBy: customer,
    });
    expect(await User.findById(customer).lean()).toMatchObject({
      moneyCredits: 30, moneyCreditsMinor: 3000, memberNumber: 42,
    });
    expect(await VoucherLedger.findOne({ kind: "wallet_redeem" }).lean()).toMatchObject({
      amountMinor: 3000, actor: customer, currency: "CZK",
    });
    const wallet = await MoneyCredit.findOne({ tenant, user: customer }).lean();
    expect(wallet?.transactions).toHaveLength(1);
    expect(wallet?.transactions[0]).toMatchObject({
      type: "coupon_redeemed", amountMinor: 3000, relatedCoupon: coupon._id,
    });
    await expect(couponService.redeemPromoCode(claim())).rejects.toThrow("not active");
    expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(3000);
  });

  it("never converts a physical delivery surcharge into studio credit", async () => {
    const order = await CouponOrder.create({
      tenant, product: offering, productNameSnapshot: "Posted gift",
      email: "buyer@example.test", quantity: 1, unitPriceSnapshot: 100,
      currencySnapshot: "CZK", shippingFeeSnapshot: 90, expectedAmountMinor: 19000,
      sendPost: true, firstname: "Anna", lastname: "Novak", street: "Studio Street 1",
      city: "Brno", postalCode: "60200", countryCode: "CZ",
    });
    expect(order.totalSnapshot).toBe(190);
    const coupon = await voucher({ order: order._id });
    await expect(couponService.redeemPromoCode(claim())).resolves.toMatchObject({
      creditsAdded: 100, newBalance: 100, currency: "CZK",
    });
    expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(10000);
    expect((await Coupon.findById(coupon._id).lean())?.walletRedeemedValueMinor).toBe(10000);
    expect((await VoucherLedger.findOne({ kind: "wallet_redeem" }).lean())?.amountMinor).toBe(10000);
  });

  it("allows an archived code to convert without changing its original value", async () => {
    const coupon = await voucher({ archivedAt: new Date(), archivedBy: customer });
    await expect(couponService.redeemPromoCode(claim())).resolves.toMatchObject({
      creditsAdded: 100,
    });
    const saved = await Coupon.findById(coupon._id).lean();
    expect(saved?.archivedAt).toBeInstanceOf(Date);
    expect(saved?.valueMinorSnapshot).toBe(10000);
  });

  it("credits a partially spent code once under concurrent claims", async () => {
    const coupon = await voucher();
    await spend(coupon._id);
    const results = await Promise.allSettled([
      couponService.redeemPromoCode(claim()),
      couponService.redeemPromoCode(claim()),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(3000);
    expect(await VoucherLedger.countDocuments({ kind: "wallet_redeem" })).toBe(1);
    expect((await MoneyCredit.findOne({ tenant, user: customer }).lean())?.transactions).toHaveLength(1);
  });

  it("keeps an active booking reservation intact and does not credit its held value", async () => {
    const coupon = await voucher();
    await voucherLifecycleService.reserve({
      tenantId: String(tenant), couponId: coupon._id, operationId: "pending",
      currency: "CZK", referenceId: "pending-booking",
      eligibleProductId: String(otherClass), amountMinor: 7000,
    });
    await expect(couponService.redeemPromoCode(claim())).rejects.toMatchObject({
      code: "VOUCHER_BOOKING_REDEMPTION_IN_PROGRESS",
    });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 10000, reservedValueMinor: 7000, isActive: true,
    });
    expect(await MoneyCredit.countDocuments()).toBe(0);
  });

  it("preserves the full value when conversion races a previous booking's cancellation", async () => {
    const coupon = await voucher();
    await spend(coupon._id);
    await Promise.all([
      couponService.redeemPromoCode(claim()),
      voucherLifecycleService.reverse({
        tenantId: String(tenant), couponId: coupon._id,
        operationId: "cancel-prior-booking", reservationId: "booking-hold",
        currency: "CZK", referenceId: "booking-1", reason: "Booking canceled",
      }),
    ]);
    expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(10000);
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 0, isActive: false, redeemedBy: customer,
    });
    const walletEntries = await VoucherLedger.find({ kind: "wallet_redeem" }).lean();
    expect(walletEntries.reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(10000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(1);
  });

  it("rolls back consumption and voucher ledger when the wallet write fails", async () => {
    const coupon = await voucher();
    await spend(coupon._id);
    vi.spyOn(MoneyCredit.prototype, "save").mockRejectedValueOnce(new Error("Wallet ledger unavailable"));
    await expect(couponService.redeemPromoCode(claim())).rejects.toThrow("Wallet ledger unavailable");
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 3000, isActive: true, redeemedAt: null, walletRedeemedValueMinor: null,
    });
    expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(0);
    expect(await VoucherLedger.countDocuments({ kind: "wallet_redeem" })).toBe(0);
    expect(await MoneyCredit.countDocuments()).toBe(0);
  });

  it("rejects another tenant and invalid remaining balances without consuming the code", async () => {
    const coupon = await voucher();
    await expect(couponService.redeemPromoCode(claim({ tenantId: String(otherTenant) }))).rejects.toThrow("not found");
    for (const remainingValueMinor of [0, -1, 10001, 1.5]) {
      await Coupon.collection.updateOne({ _id: coupon._id }, { $set: { remainingValueMinor } });
      await expect(couponService.redeemPromoCode(claim())).rejects.toMatchObject({
        code: "VOUCHER_BALANCE_INCONSISTENT",
      });
    }
    expect(await MoneyCredit.countDocuments()).toBe(0);
    expect((await Coupon.findById(coupon._id).lean())?.redeemedAt).toBeNull();
  });
});
