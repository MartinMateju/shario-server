import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import {
  VoucherLedger,
  VoucherReservation,
} from "@/modules/coupon/voucher-ledger.model.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import UserMemberNumberCounter from "@/modules/user/user-member-number-counter.model.js";

const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const owner = new mongoose.Types.ObjectId();
const actor = new mongoose.Types.ObjectId();
const couponId = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const order = new mongoose.Types.ObjectId();
const expiry = new Date("2026-01-01T00:00:00Z");
const convertedAt = new Date("2025-12-01T00:00:00Z");
const models = [
  Coupon,
  VoucherLedger,
  VoucherReservation,
  MoneyCredit,
  Tenant,
  User,
  UserMemberNumberCounter,
];
const reversal = (extra = {}) => ({
  tenantId: String(tenant),
  couponId,
  reservationId: "original-booking",
  operationId: "booking-refund",
  currency: "CZK" as const,
  referenceId: String(order),
  actorId: String(actor),
  reason: "Booking cancelled",
  amountMinor: 7000,
  quantity: 0,
  ...extra,
});

describe("booking reversals after converting the voucher remainder to credits", () => {
  let replica: MongoMemoryReplSet;

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all(models.map((model) => model.createCollection()));
    await Promise.all([
      VoucherLedger.syncIndexes(),
      VoucherReservation.syncIndexes(),
      MoneyCredit.syncIndexes(),
    ]);
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertMany([
      { _id: tenant, settings: { currency: "CZK" } },
      { _id: otherTenant, settings: { currency: "CZK" } },
    ] as never);
    await User.create([
      {
        _id: owner,
        tenant,
        firstname: "Wallet",
        lastname: "Owner",
        memberNumber: 1,
        customId: "OWNER",
        moneyCredits: 30,
        moneyCreditsMinor: 3000,
      },
      {
        _id: actor,
        tenant,
        firstname: "Booking",
        lastname: "Customer",
        memberNumber: 2,
        customId: "ACTOR",
        moneyCredits: 0,
        moneyCreditsMinor: 0,
      },
    ]);
    // This fixture represents an issued 100 CZK voucher: 70 CZK funded a
    // booking, and its owner later converted the remaining 30 CZK to credits.
    await Coupon.create({
      _id: couponId,
      tenant,
      product,
      promoCode: "CONVERTED-VOUCHER",
      lifecycleVersion: 1,
      voucherTypeSnapshot: "value",
      valueMinorSnapshot: 10000,
      currencySnapshot: "CZK",
      remainingValueMinor: 0,
      reservedValueMinor: 0,
      reservedQuantity: 0,
      voucherSettingsSnapshot: {
        version: 1,
        type: "value",
        validity: { mode: "none" },
      },
      expiresAt: expiry,
      redeemedAt: convertedAt,
      redeemedBy: owner,
      isActive: false,
    });
    await VoucherReservation.create({
      tenant,
      coupon: couponId,
      operationId: "original-booking",
      referenceId: String(order),
      eligibleProductId: String(product),
      currency: "CZK",
      amountMinor: 7000,
      quantity: 0,
      status: "committed",
    });
    await VoucherLedger.create([
      {
        tenant,
        coupon: couponId,
        operationId: "issue",
        kind: "issue",
        currency: "CZK",
        amountMinor: 10000,
      },
      {
        tenant,
        coupon: couponId,
        operationId: "booking-commit",
        kind: "commit",
        currency: "CZK",
        amountMinor: 7000,
        reservationId: "original-booking",
        referenceId: String(order),
      },
      {
        tenant,
        coupon: couponId,
        operationId: `wallet-redeem:${couponId}`,
        kind: "wallet_redeem",
        currency: "CZK",
        amountMinor: 3000,
        actor: owner,
      },
    ]);
    await MoneyCredit.create({
      tenant,
      user: owner,
      currency: "CZK",
      balance: 30,
      balanceMinor: 3000,
      transactions: [
        {
          type: "coupon_redeemed",
          amount: 30,
          amountMinor: 3000,
          currency: "CZK",
          relatedCoupon: couponId,
        },
      ],
    });
  });

  it("returns the booking payment to the conversion owner and keeps the expired code claimed", async () => {
    await voucherLifecycleService.reverse(reversal());
    expect(await User.findById(owner).lean()).toMatchObject({
      moneyCredits: 100,
      moneyCreditsMinor: 10000,
      memberNumber: 1,
    });
    expect(await User.findById(actor).lean()).toMatchObject({
      moneyCreditsMinor: 0,
    });
    const wallet = await MoneyCredit.findOne({ tenant, user: owner }).lean();
    expect(wallet).toMatchObject({
      balance: 100,
      balanceMinor: 10000,
      currency: "CZK",
    });
    expect(wallet?.transactions).toHaveLength(2);
    expect(wallet?.transactions[1]).toMatchObject({
      type: "refund",
      amountMinor: 7000,
      relatedCoupon: couponId,
      relatedOrder: order,
    });
    expect(await Coupon.findById(couponId).lean()).toMatchObject({
      valueMinorSnapshot: 10000,
      remainingValueMinor: 0,
      isActive: false,
      expiresAt: expiry,
      redeemedAt: convertedAt,
      redeemedBy: owner,
    });
    expect(
      await VoucherReservation.findOne({ coupon: couponId }).lean(),
    ).toMatchObject({ status: "reversed", reversedAmountMinor: 7000 });
    expect(
      await VoucherLedger.countDocuments({
        kind: "reverse",
        amountMinor: 7000,
      }),
    ).toBe(1);
    expect(
      await VoucherLedger.findOne({
        kind: "wallet_redeem",
        amountMinor: 7000,
      }).lean(),
    ).toMatchObject({ actor: owner, reservationId: "original-booking" });
  });

  it("credits concurrent retries of one reversal exactly once with bounded ledger keys", async () => {
    const input = reversal({ operationId: "x".repeat(160) });
    await Promise.all(
      Array.from({ length: 5 }, () => voucherLifecycleService.reverse(input)),
    );
    const wallet = await MoneyCredit.findOne({ tenant, user: owner }).lean();
    expect(wallet?.balanceMinor).toBe(10000);
    expect(wallet?.transactions).toHaveLength(2);
    expect(wallet!.transactions[1].idempotencyKey.length).toBeLessThanOrEqual(
      160,
    );
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(1);
    expect(await VoucherLedger.countDocuments({ kind: "wallet_redeem" })).toBe(
      2,
    );
  });

  it("caps competing partial reversals at the original paid amount", async () => {
    const results = await Promise.allSettled([
      voucherLifecycleService.reverse(
        reversal({ operationId: "part-a", amountMinor: 5000 }),
      ),
      voucherLifecycleService.reverse(
        reversal({ operationId: "part-b", amountMinor: 5000 }),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (await MoneyCredit.findOne({ tenant, user: owner }).lean())?.balanceMinor,
    ).toBe(8000);
    await voucherLifecycleService.reverse(
      reversal({ operationId: "part-rest", amountMinor: 2000 }),
    );
    expect(
      (await MoneyCredit.findOne({ tenant, user: owner }).lean())?.balanceMinor,
    ).toBe(10000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(2);
    expect(await VoucherLedger.countDocuments({ kind: "wallet_redeem" })).toBe(
      3,
    );
  });

  it("rolls back the user balance, voucher and both ledgers when credit persistence fails", async () => {
    vi.spyOn(MoneyCredit.prototype, "save").mockRejectedValueOnce(
      new Error("Wallet ledger unavailable"),
    );
    await expect(voucherLifecycleService.reverse(reversal())).rejects.toThrow(
      "Wallet ledger unavailable",
    );
    expect((await User.findById(owner).lean())?.moneyCreditsMinor).toBe(3000);
    expect(
      (await MoneyCredit.findOne({ tenant, user: owner }).lean())?.transactions,
    ).toHaveLength(1);
    expect(
      await VoucherReservation.findOne({ coupon: couponId }).lean(),
    ).toMatchObject({ status: "committed", reversedAmountMinor: 0 });
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(0);
    expect(await VoucherLedger.countDocuments({ kind: "wallet_redeem" })).toBe(
      1,
    );
    expect((await Coupon.findById(couponId).lean())?.remainingValueMinor).toBe(
      0,
    );
  });

  it.each([
    "missing-owner",
    "missing-ledger",
    "mismatched-owner",
    "excess-value",
  ])("refuses unverifiable conversion state: %s", async (state) => {
    if (state === "missing-owner")
      await User.collection.updateOne(
        { _id: owner },
        { $set: { tenant: otherTenant } },
      );
    if (state === "missing-ledger")
      await VoucherLedger.collection.deleteOne({ kind: "wallet_redeem" });
    if (state === "mismatched-owner")
      await VoucherLedger.collection.updateOne(
        { kind: "wallet_redeem" },
        { $set: { actor } },
      );
    if (state === "excess-value")
      await VoucherLedger.collection.updateOne(
        { kind: "wallet_redeem" },
        { $set: { amountMinor: 4000 } },
      );
    await expect(voucherLifecycleService.reverse(reversal())).rejects.toThrow();
    expect(
      (await MoneyCredit.findOne({ tenant, user: owner }).lean())?.balanceMinor,
    ).toBe(3000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(0);
    expect(
      (await VoucherReservation.findOne({ coupon: couponId }).lean())
        ?.reversedAmountMinor,
    ).toBe(0);
  });

  it("rejects a different tenant without exposing or changing the wallet", async () => {
    await expect(
      voucherLifecycleService.reverse(
        reversal({ tenantId: String(otherTenant) }),
      ),
    ).rejects.toMatchObject({ code: "VOUCHER_RESERVATION_NOT_FOUND" });
    expect(
      (await MoneyCredit.findOne({ tenant, user: owner }).lean())?.balanceMinor,
    ).toBe(3000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(0);
  });
});
