import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
vi.mock("@/modules/product/voucher-offering.policy.js", () => ({ acquireVoucherTenantMutationLock: vi.fn() }));

const tenant = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const actor = new mongoose.Types.ObjectId();
const session = { inTransaction: () => true } as mongoose.ClientSession;
let coupon: any;
let ledger: any[];
let reservations: any[];
const queryResult = (value: any) => ({ session: () => ({ lean: () => ({ exec: async () => value }), exec: async () => value }) });
const reserve = (extra = {}) => ({ tenantId: String(tenant), couponId: coupon._id, operationId: "reserve", amountMinor: 7000, currency: "CZK" as const, referenceId: "booking", eligibleProductId: String(product), ...extra });
const settle = (extra = {}) => ({ tenantId: String(tenant), couponId: coupon._id, reservationId: "reserve", operationId: "settle", currency: "CZK" as const, referenceId: "booking", ...extra });
const revoke = (extra = {}) => ({ tenantId: String(tenant), couponId: coupon._id, operationId: "revoke", actorId: String(actor), reason: "Purchase refunded", ...extra });

// These tests exercise business transitions and validation with mocked I/O.
// The separate integration suite tests genuine MongoDB races and rollback.
describe("voucher lifecycle business rules", () => {
  beforeEach(() => {
    coupon = new Coupon({ tenant, product, promoCode: "UNIT-CODE-001", valueMinorSnapshot: 10000, currencySnapshot: "CZK", lifecycleVersion: 1, voucherTypeSnapshot: "value", remainingValueMinor: 10000, voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "months", months: 12 } }, expiresAt: new Date(Date.now() + 10000) });
    vi.spyOn(coupon, "save").mockResolvedValue(coupon);
    ledger = []; reservations = [];
    vi.spyOn(mongoose.connection, "transaction").mockImplementation(async callback => callback(session));
    vi.spyOn(Coupon, "findOne").mockImplementation((filter: any) => queryResult(String(filter.tenant) === String(tenant) && String(filter._id) === String(coupon._id) ? coupon : null) as never);
    vi.spyOn(VoucherLedger, "findOne").mockImplementation((filter: any) => queryResult(ledger.find(row => String(row.tenant) === String(filter.tenant) && row.operationId === filter.operationId)) as never);
    vi.spyOn(VoucherLedger, "create").mockImplementation(async (rows: any) => { ledger.push(...rows); return rows; });
    vi.spyOn(VoucherReservation, "findOne").mockImplementation((filter: any) => queryResult(reservations.find(row => String(row.tenant) === String(filter.tenant) && row.operationId === filter.operationId)) as never);
    vi.spyOn(VoucherReservation, "create").mockImplementation(async (rows: any) => {
      const row: any = { ...rows[0], status: "held" }; row.save = vi.fn().mockResolvedValue(row); reservations.push(row); return [row];
    });
  });

  it("leaves old vouchers without new lifecycle or expiration defaults", async () => {
    const legacy = new Coupon({ tenant, product, promoCode: "LEGACY-001" });
    expect(legacy.lifecycleVersion).toBeUndefined();
    expect(legacy.voucherSettingsSnapshot).toBeUndefined();
    expect(legacy.remainingValueMinor).toBeUndefined();
    expect(legacy.expiresAt).toBeNull();
    await expect(legacy.validate()).resolves.toBeUndefined();
  });

  it("rejects a different tenant, wrong currency, expired value, and overdraw", async () => {
    await expect(voucherLifecycleService.reserve(reserve({ tenantId: String(new mongoose.Types.ObjectId()) }))).rejects.toMatchObject({ code: "VOUCHER_NOT_FOUND" });
    await expect(voucherLifecycleService.reserve(reserve({ currency: "EUR" }))).rejects.toMatchObject({ code: "VOUCHER_CURRENCY_MISMATCH" });
    await expect(voucherLifecycleService.reserve(reserve({ amountMinor: 11000 }))).rejects.toMatchObject({ code: "VOUCHER_INSUFFICIENT_BALANCE" });
    coupon.expiresAt = new Date(0);
    await expect(voucherLifecycleService.reserve(reserve())).rejects.toMatchObject({ code: "VOUCHER_EXPIRED" });
    expect(ledger).toHaveLength(0);
  });

  it("reserves and commits only once, then reverses without changing expiry", async () => {
    const expiry = coupon.expiresAt;
    await voucherLifecycleService.reserve(reserve());
    await voucherLifecycleService.reserve(reserve());
    expect(coupon.reservedValueMinor).toBe(7000);
    await voucherLifecycleService.commit({ ...settle(), paymentState: "paid" });
    await voucherLifecycleService.commit({ ...settle(), paymentState: "paid" });
    expect(coupon.remainingValueMinor).toBe(3000);
    expect(coupon.reservedValueMinor).toBe(0);
    await voucherLifecycleService.reverse({ ...settle({ operationId: "reverse" }), reason: "Cancellation" });
    await voucherLifecycleService.reverse({ ...settle({ operationId: "reverse" }), reason: "Cancellation" });
    expect(coupon.remainingValueMinor).toBe(10000);
    expect(coupon.expiresAt).toEqual(expiry);
    expect(ledger.map(row => row.kind)).toEqual(["reserve", "commit", "reverse"]);
  });

  it("holds value after a retryable payment failure and only releases after terminal cancellation", async () => {
    await voucherLifecycleService.reserve(reserve());
    expect(() => voucherLifecycleService.release({ ...settle(), paymentState: "failed" as never, reason: "Attempt failed" })).toThrow("Confirm that payment cannot settle");
    expect(coupon.reservedValueMinor).toBe(7000);
    await voucherLifecycleService.release({ ...settle(), paymentState: "canceled", reason: "Intent canceled" });
    expect(coupon.reservedValueMinor).toBe(0);
    expect(coupon.remainingValueMinor).toBe(10000);
  });

  it("restores partial cancellations once each without exceeding the original payment", async () => {
    await voucherLifecycleService.reserve(reserve());
    await voucherLifecycleService.commit({ ...settle(), paymentState: "paid" });
    const partial = { ...settle({ operationId: "cancel-part-one" }), amountMinor: 2000, quantity: 0, reason: "One participant canceled" };
    await voucherLifecycleService.reverse(partial);
    await voucherLifecycleService.reverse(partial);
    expect(coupon.remainingValueMinor).toBe(5000);
    expect(reservations[0]).toMatchObject({ status: "committed", reversedAmountMinor: 2000, reversedQuantity: 0 });
    await expect(voucherLifecycleService.reverse({ ...partial, amountMinor: 3000 })).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    await expect(voucherLifecycleService.reverse({ ...partial, operationId: "too-much", amountMinor: 5001 })).rejects.toMatchObject({ code: "VOUCHER_REVERSAL_EXCEEDS_PAYMENT" });
    await voucherLifecycleService.reverse({ ...partial, operationId: "cancel-rest", amountMinor: 5000 });
    expect(coupon.remainingValueMinor).toBe(10000);
    expect(reservations[0]).toMatchObject({ status: "reversed", reversedAmountMinor: 7000 });
    expect(ledger.filter(row => row.kind === "reverse")).toHaveLength(2);
  });

  it("restores experience quantities incrementally and preserves their original entitlement", async () => {
    coupon.voucherTypeSnapshot = "experience";
    coupon.voucherSettingsSnapshot = { version: 1, type: "experience", experienceProductId: product, experienceQuantity: 3, validity: { mode: "months", months: 12 } };
    coupon.remainingValueMinor = 0;
    coupon.remainingQuantity = 3;
    await voucherLifecycleService.reserve(reserve({ amountMinor: 0, quantity: 3 }));
    await voucherLifecycleService.commit({ ...settle(), paymentState: "not_required" });
    expect(coupon.isActive).toBe(false);
    await voucherLifecycleService.reverse({ ...settle({ operationId: "quantity-one" }), amountMinor: 0, quantity: 1, reason: "One place canceled" });
    expect(coupon.remainingQuantity).toBe(1);
    expect(coupon.isActive).toBe(true);
    await expect(voucherLifecycleService.reverse({ ...settle({ operationId: "quantity-excess" }), amountMinor: 0, quantity: 3, reason: "Too many places" })).rejects.toMatchObject({ code: "VOUCHER_REVERSAL_EXCEEDS_PAYMENT" });
  });

  it("restores expired value for accounting without reactivating or extending it", async () => {
    await voucherLifecycleService.reserve(reserve());
    await voucherLifecycleService.commit({ ...settle(), paymentState: "paid" });
    coupon.expiresAt = new Date(0);
    await voucherLifecycleService.reverse({ ...settle({ operationId: "expired-reverse" }), reason: "Booking canceled" });
    expect(coupon.remainingValueMinor).toBe(10000);
    expect(coupon.isActive).toBe(false);
    expect(coupon.expiresAt).toEqual(new Date(0));
  });

  it("requires reconciliation before restoring a refunded or revoked voucher", async () => {
    await voucherLifecycleService.reserve(reserve());
    await voucherLifecycleService.commit({ ...settle(), paymentState: "paid" });
    coupon.refundReviewRequired = true;
    await expect(voucherLifecycleService.reverse({ ...settle({ operationId: "review-reverse" }), reason: "Booking canceled" })).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    expect(coupon.remainingValueMinor).toBe(3000);
    coupon.refundReviewRequired = false;
    coupon.revokedAt = new Date();
    await expect(voucherLifecycleService.reverse({ ...settle({ operationId: "revoked-reverse" }), reason: "Booking canceled" })).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    expect(ledger.filter(row => row.kind === "reverse")).toHaveLength(0);
  });

  it("rejects reuse of a reservation operation with different value or eligible product", async () => {
    await voucherLifecycleService.reserve(reserve());
    await expect(voucherLifecycleService.reserve(reserve({ amountMinor: 1000 }))).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    await expect(voucherLifecycleService.reserve(reserve({ eligibleProductId: String(actor) }))).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    expect(coupon.reservedValueMinor).toBe(7000);
  });

  it("revokes an unused code idempotently and records the actor, reason, and remaining value", async () => {
    await voucherLifecycleService.revoke(revoke());
    await voucherLifecycleService.revoke(revoke());
    expect(coupon.isActive).toBe(false);
    expect(coupon.revokedBy).toEqual(actor);
    expect(coupon.remainingValueMinor).toBe(10000);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "revoke", actor, reason: "Purchase refunded", amountMinor: 10000 });
    await expect(voucherLifecycleService.revoke(revoke({ reason: "Different reason" }))).rejects.toMatchObject({ code: "VOUCHER_ALREADY_REVOKED" });
  });

  it("refuses revocation of held, partially used, or wallet-converted vouchers", async () => {
    coupon.reservedValueMinor = 1000;
    await expect(voucherLifecycleService.revoke(revoke())).rejects.toMatchObject({ code: "VOUCHER_PAYMENT_PENDING" });
    coupon.reservedValueMinor = 0; coupon.remainingValueMinor = 9000;
    await expect(voucherLifecycleService.revoke(revoke())).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    coupon.remainingValueMinor = 0; coupon.redeemedBy = actor; coupon.redeemedAt = new Date();
    await expect(voucherLifecycleService.revoke(revoke())).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    expect(coupon.redeemedBy).toEqual(actor);
    expect(ledger).toHaveLength(0);
  });

  it("blocks new reservations while refund reconciliation is required", async () => {
    coupon.refundReviewRequired = true;
    await expect(voucherLifecycleService.reserve(reserve())).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    expect(coupon.reservedValueMinor).toBe(0);
  });

  it("blocks commit after refund quarantine while allowing the hold to be released", async () => {
    await voucherLifecycleService.reserve(reserve());
    coupon.refundReviewRequired = true;
    await expect(voucherLifecycleService.commit({ ...settle(), paymentState: "paid" })).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
    expect(coupon.remainingValueMinor).toBe(10000);
    expect(coupon.reservedValueMinor).toBe(7000);
    await voucherLifecycleService.release({ ...settle(), paymentState: "canceled", reason: "Quarantined payment canceled" });
    expect(coupon.reservedValueMinor).toBe(0);
    expect(coupon.refundReviewRequired).toBe(true);
  });

  it("treats a legacy reservedBy or reservedUntil field as a hold requiring reconciliation", async () => {
    coupon.reservedBy = actor;
    await expect(voucherLifecycleService.reserve(reserve())).rejects.toMatchObject({ code: "VOUCHER_PAYMENT_PENDING" });
    coupon.reservedBy = null;
    coupon.reservedUntil = new Date(0);
    await expect(voucherLifecycleService.reserve(reserve())).rejects.toMatchObject({ code: "VOUCHER_PAYMENT_PENDING" });
    expect(coupon.reservedValueMinor).toBe(0);
  });

  it("restricts currency-less ledger entries to nonmonetary legacy revocation audit", async () => {
    const invalid = new VoucherLedger({ tenant, coupon: coupon._id, operationId: "invalid", kind: "issue", currency: null, amountMinor: 1000 });
    await expect(invalid.validate()).rejects.toThrow("unknown currency");
    const valid = new VoucherLedger({ tenant, coupon: coupon._id, operationId: "audit", kind: "revoke", currency: null, amountMinor: 0 });
    await expect(valid.validate()).resolves.toBeUndefined();
    await expect(VoucherLedger.updateOne({}, { amountMinor: 0 })).rejects.toThrow("cannot be changed");
    await expect(VoucherLedger.deleteMany({})).rejects.toThrow("cannot be changed");
  });
});
