import { createHash } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { Coupon } from "./coupon.model.js";
import { VoucherLedger, VoucherReservation, VOUCHER_LEDGER_KINDS } from "./voucher-ledger.model.js";
import { AppError } from "@/shared/http/AppError.js";
import { fromCurrencyMinorUnits, type StudioCommerceCurrency } from "@/shared/money/currency.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";

export class VoucherLifecycleError extends AppError {
  constructor(code: string, message: string, statusCode = 409) {
    super({ message, code, statusCode });
    this.name = "VoucherLifecycleError";
  }
}
const fail = (code: string, message: string, status = 409): never => { throw new VoucherLifecycleError(code, message, status); };
const objectId = (id: string | mongoose.Types.ObjectId) => {
  if (!mongoose.isValidObjectId(id)) fail("VOUCHER_ID_INVALID", "Invalid voucher identifier.", 400);
  return new mongoose.Types.ObjectId(String(id));
};
const operationId = (id: string) => {
  if (typeof id !== "string" || !id.trim() || id.length > 160) fail("VOUCHER_OPERATION_INVALID", "An operation id is required.", 400);
  return id;
};
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;

export type VoucherLedgerInput = {
  tenantId: string;
  couponId: string | mongoose.Types.ObjectId;
  operationId: string;
  kind: (typeof VOUCHER_LEDGER_KINDS)[number];
  currency: StudioCommerceCurrency | null;
  amountMinor?: number;
  quantity?: number;
  referenceId?: string;
  reservationId?: string;
  actorId?: string | null;
  reason?: string;
};

function ledgerData(input: VoucherLedgerInput) {
  if (!integer(input.amountMinor ?? 0) || !integer(input.quantity ?? 0)) fail("VOUCHER_AMOUNT_INVALID", "Voucher amounts must be nonnegative integers.", 400);
  return {
    tenant: objectId(input.tenantId), coupon: objectId(input.couponId),
    operationId: operationId(input.operationId), kind: input.kind, currency: input.currency,
    amountMinor: input.amountMinor ?? 0, quantity: input.quantity ?? 0,
    referenceId: input.referenceId ?? "", reservationId: input.reservationId ?? "",
    actor: input.actorId ? objectId(input.actorId) : null, reason: input.reason?.trim() ?? "",
  };
}

export async function appendVoucherLedgerEntry(input: VoucherLedgerInput, session: ClientSession) {
  if (!session?.inTransaction()) fail("VOUCHER_TRANSACTION_REQUIRED", "Voucher ledger writes require a transaction.");
  const data = ledgerData(input);
  const existing = await VoucherLedger.findOne({ tenant: data.tenant, operationId: data.operationId }).session(session).lean().exec();
  if (existing) {
    for (const key of Object.keys(data)) {
      if (String(existing[key] ?? "") !== String(data[key] ?? "")) fail("VOUCHER_OPERATION_CONFLICT", "This operation id was already used for a different action.");
    }
    return existing;
  }
  const [entry] = await VoucherLedger.create([data], { session });
  return entry;
}

const hasReservation = (coupon: any) => Boolean(
  coupon.reservedAt || coupon.reservedOrder || coupon.reservedBy || coupon.reservedUntil ||
  coupon.reservedValueMinor > 0 || coupon.reservedQuantity > 0,
);
export const hasVoucherBeenUsed = (coupon: any) => Boolean(
  coupon.redeemedAt || coupon.redeemedBy ||
  (coupon.lifecycleVersion === 1 && (
    coupon.voucherTypeSnapshot === "experience"
      ? coupon.remainingQuantity !== coupon.voucherSettingsSnapshot?.experienceQuantity
      : coupon.remainingValueMinor !== coupon.valueMinorSnapshot
  )),
);

export type RevokeVoucherInput = {
  tenantId: string;
  couponId: string | mongoose.Types.ObjectId;
  operationId: string;
  actorId?: string | null;
  reason: string;
};

export async function revokeVoucherInSession(input: RevokeVoucherInput, session: ClientSession) {
  if (!session?.inTransaction()) fail("VOUCHER_TRANSACTION_REQUIRED", "Voucher revocation requires a transaction.");
  await acquireVoucherTenantMutationLock(input.tenantId, session);
  operationId(input.operationId);
  if (!input.reason?.trim() || input.reason.length > 1000) fail("VOUCHER_REASON_REQUIRED", "Provide a revocation reason (up to 1000 characters).", 400);
  const query = { tenant: objectId(input.tenantId), _id: objectId(input.couponId) };
  const coupon = await Coupon.findOne(query).session(session).exec();
  if (!coupon) fail("VOUCHER_NOT_FOUND", "Voucher not found.", 404);
  if (coupon.revokedAt) {
    if (coupon.revocationOperationId !== input.operationId || coupon.revocationReason !== input.reason.trim() || String(coupon.revokedBy ?? "") !== String(input.actorId ?? "")) {
      fail("VOUCHER_ALREADY_REVOKED", "This voucher was already revoked.");
    }
    return coupon;
  }
  if (hasVoucherBeenUsed(coupon)) fail("VOUCHER_RECONCILIATION_REQUIRED", "Used vouchers require refund reconciliation; account credits are preserved.");
  if (hasReservation(coupon)) fail("VOUCHER_PAYMENT_PENDING", "Resolve the voucher's pending payment before revoking it.");
  if (coupon.refundReviewRequired) fail("VOUCHER_RECONCILIATION_REQUIRED", "Resolve the pending voucher refund before revoking it.");
  if (!coupon.isActive) fail("VOUCHER_INACTIVE", "The voucher is already inactive.");
  coupon.isActive = false;
  coupon.revokedAt = new Date();
  coupon.revokedBy = input.actorId ? objectId(input.actorId) : null;
  coupon.revocationReason = input.reason.trim();
  coupon.revocationOperationId = input.operationId;
  await coupon.save({ session });
  // Legacy records can lack currency/value snapshots. Revocation must still be
  // possible, with null currency and zero monetary amount in the audit entry.
  await appendVoucherLedgerEntry({
    ...input, kind: "revoke", currency: coupon.currencySnapshot ?? null,
    amountMinor: !coupon.currencySnapshot || coupon.voucherTypeSnapshot === "experience" ? 0 : (coupon.remainingValueMinor ?? coupon.valueMinorSnapshot ?? 0),
    quantity: coupon.voucherTypeSnapshot === "experience" ? (coupon.remainingQuantity ?? 0) : 0,
  }, session);
  return coupon;
}

export type ReserveVoucherInput = Omit<VoucherLedgerInput, "kind" | "reservationId"> & {
  referenceId: string;
  eligibleProductId: string;
  currency: StudioCommerceCurrency;
  reviewAfter?: Date;
};
export type SettlementInput = {
  tenantId: string;
  couponId: string | mongoose.Types.ObjectId;
  reservationId: string;
  operationId: string;
  currency: StudioCommerceCurrency;
  referenceId: string;
  actorId?: string;
};
export type ReverseVoucherInput = SettlementInput & { reason: string; amountMinor?: number; quantity?: number };

function assertReservationIdentity(row: any, input: SettlementInput) {
  if (String(row.coupon) !== String(input.couponId) || row.currency !== input.currency || row.referenceId !== input.referenceId) {
    fail("VOUCHER_RESERVATION_MISMATCH", "Reservation does not match the checkout, voucher, or currency.");
  }
}

export async function reserveVoucherInSession(input: ReserveVoucherInput, session: ClientSession) {
  if (!session?.inTransaction()) fail("VOUCHER_TRANSACTION_REQUIRED", "Voucher reservation requires a transaction.");
  await acquireVoucherTenantMutationLock(input.tenantId, session);
  const data = ledgerData({ ...input, kind: "reserve" });
  if (!input.referenceId || input.referenceId.length > 160) fail("VOUCHER_REFERENCE_REQUIRED", "A checkout reference is required.", 400);
  const existing = await VoucherReservation.findOne({ tenant: data.tenant, operationId: data.operationId }).session(session).exec();
  if (existing) {
    assertReservationIdentity(existing, { ...input, reservationId: data.operationId });
    if (existing.eligibleProductId !== input.eligibleProductId || existing.amountMinor !== data.amountMinor || existing.quantity !== data.quantity) fail("VOUCHER_OPERATION_CONFLICT", "This operation id has different amounts.");
    await appendVoucherLedgerEntry({ ...input, kind: "reserve", reservationId: data.operationId }, session);
    return existing;
  }
  const coupon = await Coupon.findOne({ _id: data.coupon, tenant: data.tenant }).session(session).exec();
  if (!coupon) fail("VOUCHER_NOT_FOUND", "Voucher not found.", 404);
  if (coupon.lifecycleVersion !== 1) fail("VOUCHER_LEGACY_REDEMPTION_REQUIRED", "Legacy vouchers use the existing credit redemption flow.");
  if (coupon.refundReviewRequired) fail("VOUCHER_RECONCILIATION_REQUIRED", "Voucher refund requires manual review.");
  if (!coupon.isActive || coupon.revokedAt || coupon.redeemedAt) fail("VOUCHER_UNAVAILABLE", "Voucher is unavailable.");
  if (coupon.expiresAt && coupon.expiresAt <= new Date()) fail("VOUCHER_EXPIRED", "Voucher has expired.");
  if (coupon.currencySnapshot !== input.currency) fail("VOUCHER_CURRENCY_MISMATCH", "Voucher and checkout currencies differ.");
  if (coupon.reservedAt || coupon.reservedOrder || coupon.reservedBy || coupon.reservedUntil) fail("VOUCHER_PAYMENT_PENDING", "Voucher has a pending legacy reservation.");
  const settings = coupon.voucherSettingsSnapshot;
  if (settings?.eligibleProductIds?.length && !settings.eligibleProductIds.some(id => String(id) === input.eligibleProductId)) fail("VOUCHER_INELIGIBLE", "Voucher is not valid for this product.");
  const experience = coupon.voucherTypeSnapshot === "experience";
  if (experience && String(settings?.experienceProductId) !== input.eligibleProductId) fail("VOUCHER_INELIGIBLE", "Voucher does not cover this experience.");
  if (experience ? data.amountMinor !== 0 || data.quantity < 1 : data.quantity !== 0 || data.amountMinor < 1) fail("VOUCHER_AMOUNT_INVALID", "Provide value or experience quantity matching the voucher type.", 400);
  if (!integer(experience ? coupon.remainingQuantity : coupon.remainingValueMinor) || !integer(coupon.reservedValueMinor) || !integer(coupon.reservedQuantity)) fail("VOUCHER_BALANCE_INCONSISTENT", "Voucher balance needs reconciliation.");
  if (experience) {
    if (coupon.remainingQuantity - coupon.reservedQuantity < data.quantity) fail("VOUCHER_INSUFFICIENT_BALANCE", "Insufficient voucher quantity.");
    coupon.reservedQuantity += data.quantity;
  } else {
    if (coupon.remainingValueMinor - coupon.reservedValueMinor < data.amountMinor) fail("VOUCHER_INSUFFICIENT_BALANCE", "Insufficient voucher balance.");
    coupon.reservedValueMinor += data.amountMinor;
  }
  // Writing the shared coupon counter causes competing MongoDB transactions to
  // conflict and retry; the retried callback rechecks the available balance.
  await coupon.save({ session });
  const [reservation] = await VoucherReservation.create([{
    tenant: data.tenant, coupon: data.coupon, operationId: data.operationId,
    referenceId: data.referenceId, eligibleProductId: input.eligibleProductId, currency: data.currency,
    amountMinor: data.amountMinor, quantity: data.quantity, reviewAfter: input.reviewAfter ?? null,
  }], { session });
  await appendVoucherLedgerEntry({ ...input, kind: "reserve", reservationId: data.operationId }, session);
  return reservation;
}

async function refundConvertedVoucherToWallet(
  coupon: any,
  input: SettlementInput,
  amountMinor: number,
  quantity: number,
  session: ClientSession,
) {
  if (
    coupon.lifecycleVersion !== 1 || coupon.voucherTypeSnapshot !== "value" ||
    !coupon.redeemedAt || !coupon.redeemedBy || quantity !== 0 || amountMinor < 1 ||
    coupon.remainingValueMinor !== 0 || coupon.reservedValueMinor !== 0 ||
    coupon.reservedQuantity !== 0 || coupon.currencySnapshot !== input.currency
  ) fail("VOUCHER_RECONCILIATION_REQUIRED", "The converted voucher needs reconciliation before its booking payment can be returned.");

  const conversions = await VoucherLedger.find({
    tenant: objectId(input.tenantId), coupon: coupon._id, kind: "wallet_redeem",
  }).select("operationId actor currency amountMinor").session(session).lean().exec();
  const initialConversion = conversions.find(entry => entry.operationId === `wallet-redeem:${coupon._id}`);
  const creditedMinor = conversions.reduce((total, entry) => total + entry.amountMinor, 0);
  if (
    !initialConversion || !integer(coupon.valueMinorSnapshot) ||
    !conversions.every(entry => integer(entry.amountMinor) && entry.amountMinor > 0 &&
      entry.currency === input.currency && String(entry.actor) === String(coupon.redeemedBy)) ||
    !Number.isSafeInteger(creditedMinor + amountMinor) ||
    creditedMinor + amountMinor > coupon.valueMinorSnapshot
  ) fail("VOUCHER_RECONCILIATION_REQUIRED", "The voucher's wallet conversion cannot be verified.");

  // The original voucher is permanently claimed by its conversion owner.
  // A later booking refund follows that claim without reactivating the code.
  const walletOperationId = `voucher-refund-wallet:${createHash("sha256")
    .update(JSON.stringify([input.tenantId, String(coupon._id), input.operationId]))
    .digest("hex")}`;
  const { moneyCreditService } = await import("@/modules/money-credit/services/money-credit.service.js");
  await moneyCreditService.incrementMoneyCredits({
    tenantId: input.tenantId,
    userId: String(coupon.redeemedBy),
    amount: fromCurrencyMinorUnits(amountMinor, input.currency),
    currency: input.currency,
    transaction: {
      type: MONEY_CREDIT_TRANSACTION_TYPE.REFUND,
      description: "Booking payment returned to the converted voucher's studio-credit wallet",
      relatedCoupon: coupon._id,
      ...(mongoose.isValidObjectId(input.referenceId) ? { relatedOrder: objectId(input.referenceId) } : {}),
      reason: "Booking refund after voucher conversion",
      idempotencyKey: walletOperationId,
    },
    session,
  });
  await appendVoucherLedgerEntry({
    ...input,
    operationId: walletOperationId,
    kind: "wallet_redeem",
    amountMinor,
    quantity: 0,
    actorId: String(coupon.redeemedBy),
    reason: "Returned booking value credited to the voucher conversion owner's wallet",
  }, session);
  coupon.isActive = false;
}

async function settleInSession(input: SettlementInput & { amountMinor?: number; quantity?: number }, kind: "commit" | "release" | "reverse", session: ClientSession, reason = "") {
  if (!session?.inTransaction()) fail("VOUCHER_TRANSACTION_REQUIRED", "Voucher settlement requires a transaction.");
  await acquireVoucherTenantMutationLock(input.tenantId, session);
  operationId(input.operationId);
  const reservation = await VoucherReservation.findOne({ tenant: objectId(input.tenantId), operationId: input.reservationId }).session(session).exec();
  if (!reservation) fail("VOUCHER_RESERVATION_NOT_FOUND", "Voucher reservation not found.", 404);
  assertReservationIdentity(reservation, input);
  const amountMinor = kind === "reverse" ? input.amountMinor ?? reservation.amountMinor : reservation.amountMinor;
  const quantity = kind === "reverse" ? input.quantity ?? reservation.quantity : reservation.quantity;
  if (!integer(amountMinor) || !integer(quantity) || (kind === "reverse" && amountMinor === 0 && quantity === 0)) fail("VOUCHER_AMOUNT_INVALID", "Reversal requires a positive original payment amount or experience quantity.", 400);
  const ledgerInput: VoucherLedgerInput = {
    ...input, kind, amountMinor, quantity, reason,
  };
  const target = kind === "commit" ? "committed" : kind === "release" ? "released" : "reversed";
  const existing = await VoucherLedger.findOne({ tenant: objectId(input.tenantId), operationId: input.operationId }).session(session).lean().exec();
  if (existing) {
    await appendVoucherLedgerEntry(ledgerInput, session); // rejects key reuse with different intent
    return reservation;
  }
  if (reservation.status === target) fail("VOUCHER_OPERATION_CONFLICT", "The reservation was already settled with another operation id.");
  if (reservation.status !== (kind === "reverse" ? "committed" : "held")) fail("VOUCHER_RESERVATION_SETTLED", "This reservation cannot make that transition.");
  const coupon = await Coupon.findOne({ tenant: objectId(input.tenantId), _id: objectId(input.couponId) }).session(session).exec();
  if (!coupon) fail("VOUCHER_NOT_FOUND", "Voucher not found.", 404);
  if (coupon.revokedAt) fail("VOUCHER_RECONCILIATION_REQUIRED", "Revoked vouchers require manual reconciliation.");
  if (kind !== "release" && coupon.refundReviewRequired) fail("VOUCHER_RECONCILIATION_REQUIRED", "Voucher refund requires manual review before settling value.");
  if (kind !== "reverse") {
    if (coupon.reservedValueMinor < reservation.amountMinor || coupon.reservedQuantity < reservation.quantity) fail("VOUCHER_BALANCE_INCONSISTENT", "Voucher reservation totals need reconciliation.");
    coupon.reservedValueMinor -= reservation.amountMinor;
    coupon.reservedQuantity -= reservation.quantity;
  }
  if (kind === "commit") {
    if ((reservation.amountMinor && coupon.remainingValueMinor < reservation.amountMinor) || (reservation.quantity && coupon.remainingQuantity < reservation.quantity)) fail("VOUCHER_BALANCE_INCONSISTENT", "Voucher balance needs reconciliation.");
    if (reservation.amountMinor) coupon.remainingValueMinor -= reservation.amountMinor;
    if (reservation.quantity) coupon.remainingQuantity -= reservation.quantity;
    if (coupon.voucherTypeSnapshot === "experience" ? coupon.remainingQuantity === 0 : coupon.remainingValueMinor === 0) coupon.isActive = false;
  }
  if (kind === "reverse") {
    const reversedAmountMinor = reservation.reversedAmountMinor ?? 0;
    const reversedQuantity = reservation.reversedQuantity ?? 0;
    if (!integer(reversedAmountMinor) || !integer(reversedQuantity) || amountMinor > reservation.amountMinor - reversedAmountMinor || quantity > reservation.quantity - reversedQuantity) fail("VOUCHER_REVERSAL_EXCEEDS_PAYMENT", "Reversal exceeds the remaining original voucher payment.");
    if (coupon.redeemedAt || coupon.redeemedBy) {
      await refundConvertedVoucherToWallet(coupon, input, amountMinor, quantity, session);
    } else {
      if (amountMinor) coupon.remainingValueMinor += amountMinor;
      if (quantity) coupon.remainingQuantity += quantity;
      if ((coupon.remainingValueMinor ?? 0) > coupon.valueMinorSnapshot || (coupon.remainingQuantity ?? 0) > (coupon.voucherSettingsSnapshot?.experienceQuantity ?? 0)) fail("VOUCHER_BALANCE_INCONSISTENT", "Reversal exceeds the original entitlement.");
      coupon.isActive = !coupon.expiresAt || coupon.expiresAt > new Date();
    }
    reservation.reversedAmountMinor = reversedAmountMinor + amountMinor;
    reservation.reversedQuantity = reversedQuantity + quantity;
    // Keep the original expiry. A reversal is not an implicit extension.
  }
  await coupon.save({ session });
  reservation.status = kind === "reverse" && (reservation.reversedAmountMinor < reservation.amountMinor || reservation.reversedQuantity < reservation.quantity) ? "committed" : target;
  reservation.settledAt = new Date();
  await reservation.save({ session });
  await appendVoucherLedgerEntry(ledgerInput, session);
  return reservation;
}

export function commitVoucherInSession(input: SettlementInput & { paymentState: "paid" | "not_required" }, session: ClientSession) {
  if (!["paid", "not_required"].includes(input.paymentState)) fail("VOUCHER_PAYMENT_UNCONFIRMED", "Payment must be confirmed before redemption.");
  return settleInSession(input, "commit", session);
}
export function releaseVoucherInSession(input: SettlementInput & { paymentState: "expired" | "canceled" | "not_started"; reason: string }, session: ClientSession) {
  if (!["expired", "canceled", "not_started"].includes(input.paymentState) || !input.reason?.trim()) fail("VOUCHER_PAYMENT_PENDING", "Confirm that payment cannot settle before releasing voucher value.");
  return settleInSession(input, "release", session, input.reason.trim());
}
export function reverseVoucherInSession(input: ReverseVoucherInput, session: ClientSession) {
  if (!input.reason?.trim() || input.reason.length > 1000) fail("VOUCHER_REASON_REQUIRED", "A reversal reason of up to 1000 characters is required.", 400);
  return settleInSession(input, "reverse", session, input.reason.trim());
}

// Internal foundation only: booking/Stripe adapters must supply authenticated,
// server-verified settlement outcomes. These functions are not public endpoints.
export const voucherLifecycleService = {
  revoke: (input: RevokeVoucherInput) => mongoose.connection.transaction(session => revokeVoucherInSession(input, session)),
  reserve: (input: ReserveVoucherInput) => mongoose.connection.transaction(session => reserveVoucherInSession(input, session)),
  commit: (input: SettlementInput & { paymentState: "paid" | "not_required" }) => {
    if (!["paid", "not_required"].includes(input.paymentState)) fail("VOUCHER_PAYMENT_UNCONFIRMED", "Payment must be confirmed before redemption.");
    return mongoose.connection.transaction(session => settleInSession(input, "commit", session));
  },
  release: (input: SettlementInput & { paymentState: "expired" | "canceled" | "not_started"; reason: string }) => {
    if (!["expired", "canceled", "not_started"].includes(input.paymentState) || !input.reason?.trim()) fail("VOUCHER_PAYMENT_PENDING", "Confirm that payment cannot settle before releasing voucher value.");
    return mongoose.connection.transaction(session => settleInSession(input, "release", session, input.reason.trim()));
  },
  reverse: (input: ReverseVoucherInput) => {
    if (!input.reason?.trim()) fail("VOUCHER_REASON_REQUIRED", "A reversal reason is required.", 400);
    return mongoose.connection.transaction(session => reverseVoucherInSession(input, session));
  },
};
