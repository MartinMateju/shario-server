import { createHash, randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import type Stripe from "stripe";
import { Order } from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { resolveOriginalPaymentRefund } from "@/modules/booking/services/booking-payment-refund.service.js";
import UserMembership from "@/modules/membership/user-membership.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import { conflict } from "@/shared/http/httpErrors.js";
import { findTenantPaymentAccountByStripeAccount } from "../tenant-payment-account.repository.js";
import { getConnectedAccountRequestOptions, getTenantPaymentStripe, getTenantPaymentStripeLivemode } from "../tenant-payment.stripe.gateway.js";
import { PaymentRefundObservation, PaymentRefundReconciliation, preparePaymentRefundCollections, type RefundSummary } from "../payment-refund-reconciliation.model.js";

const REFUND_EVENTS = new Set(["charge.refunded", "refund.created", "refund.updated", "refund.failed"]);
const id = (value: any): string => String(value?.id ?? value?._id ?? value ?? "");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeMinor = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const paymentRefundKey = (account: string, paymentIntent: string) => hash([account, paymentIntent]);

export { serializeRefundSummary } from "../payment-refund-summary.js";

/** A provider refund is allocated only by the saved cancellation outbox, never
 * by editable Stripe metadata. Check current outbox state when cancelling so a
 * webhook which beat the worker's success write does not leave a permanent
 * whole-order block. Financial summaries and fulfillment guards remain intact. */
async function hasOnlySettledBookingRefunds(order: any, tenantId: string, session: ClientSession): Promise<boolean> {
  const summary = order.refund;
  if (!order.isPaid || order.status !== "processed_order" ||
      !["partial", "full"].includes(summary.status) || !safeMinor(summary.succeededAmountMinor) || summary.succeededAmountMinor <= 0 ||
      summary.pendingAmountMinor !== 0 || summary.failedAmountMinor !== 0) return false;
  const row = await PaymentRefundReconciliation.findOne({
    _id: summary.reconciliationId, tenant: tenantId, order: order._id,
    connectedAccountId: order.stripe?.connectedAccountId, paymentIntentId: order.stripe?.paymentIntentId,
    livemode: order.stripe?.livemode, snapshotVersion: summary.snapshotVersion,
  }).session(session).lean().exec() as any;
  if (!row || row.claimToken || row.paidAmountMinor !== order.expectedAmountMinor || row.currency !== order.currency ||
      row.reviewRequired !== summary.reviewRequired || row.reviewReason !== summary.reviewReason ||
      !["", "benefit_review_required"].includes(row.reviewReason) ||
      !["reconciliationId", "status", "succeededAmountMinor", "pendingAmountMinor", "failedAmountMinor", "snapshotVersion", "reviewRequired", "reviewReason"]
        .every((key) => row.summary?.[key] === summary[key])) return false;
  const refunds = row.refunds ?? [];
  if (!Array.isArray(refunds) || !refunds.length || refunds.length > 1000 || refunds.some((refund: any) =>
      refund.status !== "succeeded" || !refund.id || !safeMinor(refund.amountMinor) || refund.amountMinor <= 0) ||
      new Set(refunds.map((refund: any) => refund.id)).size !== refunds.length ||
      refunds.reduce((total: number, refund: any) => total + refund.amountMinor, 0) !== summary.succeededAmountMinor) return false;
  // Include other orders in the lookup so duplicate local associations for the
  // same account/refund ID cannot be used as two independently valid proofs.
  const records = await BookingPaymentRefund.find({ tenant: tenantId,
    connectedAccountId: row.connectedAccountId, refundId: { $in: refunds.map((refund: any) => refund.id) },
  }).limit(refunds.length + 1).session(session).lean().exec();
  if (records.length !== refunds.length) return false;
  const validated: any[] = [];
  for (const refund of refunds) {
    const matches = records.filter((record) => record.refundId === refund.id);
    if (matches.length !== 1) return false;
    const record = matches[0];
    if (String(record.order) !== String(order._id) || String(record.customer) !== String(order.createdBy) ||
        record._id !== `${tenantId}:${order._id}:${record.booking}` || record.paymentIntentId !== row.paymentIntentId ||
        record.livemode !== row.livemode || record.currency !== row.currency || record.cardAmountMinor !== refund.amountMinor ||
        record.status !== "succeeded" || record.providerStatus !== "succeeded" || record.failureRecordedAt || record.claimToken) return false;
    try {
      const plan = resolveOriginalPaymentRefund(order, String(record.booking));
      if (!plan || !(["currency", "amountMinor", "voucherAmountMinor", "voucherQuantity", "cardAmountMinor"] as const)
        .every((key) => record[key] === plan[key])) return false;
    } catch { return false; }
    validated.push(record);
  }
  // A provider refresh claims this row before network I/O. Lock it too, so a
  // claim acquired since our read makes cancellation retry and fail closed.
  const projectionLock = await PaymentRefundReconciliation.updateOne({ _id: row._id, tenant: tenantId,
    snapshotVersion: summary.snapshotVersion, claimToken: { $in: [null, ""] },
  }, { $inc: { allocationCheckRevision: 1 } }, { session });
  if (projectionLock.matchedCount !== 1) return false;
  // Write locks make a concurrent late bank failure conflict/retry rather than
  // letting this transaction act on a stale successful allocation.
  for (const record of validated.sort((a, b) => a._id.localeCompare(b._id))) {
    const locked = await BookingPaymentRefund.updateOne({ _id: record._id, tenant: tenantId,
      status: "succeeded", providerStatus: "succeeded", refundId: record.refundId,
      failureRecordedAt: null, claimToken: { $in: [null, ""] },
    }, { $inc: { allocationCheckRevision: 1 } }, { session });
    if (locked.matchedCount !== 1) return false;
  }
  return true;
}

/** Take a write lock in the cancellation transaction; reconciliation writes
 * this same order, so a concurrent Dashboard refund cannot mint more credit. */
export async function assertOrdersHaveNoProviderRefund(tenantId: string, orderIds: string[], session: ClientSession) {
  for (const orderId of [...new Set(orderIds)].sort()) {
    const order = await Order.findOneAndUpdate({ _id: orderId, tenant: tenantId },
      { $inc: { refundReconciliationRevision: 1 } }, { returnDocument: "after", session })
      .select("refund tenant createdBy isPaid status currency expectedAmountMinor grossAmountMinor lineItems paymentAllocations voucherRedemptions stripe").lean().exec();
    if (order?.refund && (order.refund.succeededAmountMinor > 0 || order.refund.pendingAmountMinor > 0 || order.refund.reviewRequired) &&
        !await hasOnlySettledBookingRefunds(order, tenantId, session))
      conflict({ code: "PAYMENT_REFUND_REVIEW_REQUIRED", message: "This payment has a Stripe refund. Ask the studio to review the existing refund before making another adjustment." });
  }
}

/** Called inside membership grant transactions. The membership write makes
 * concurrent reconciliation conflict/retry before any new entitlement grant. */
export async function membershipPaymentHasRefund(input: { tenantId: string; membershipId: string; accountId: string; paymentIntentId?: string; invoiceId?: string; session: ClientSession }) {
  const query: any = { tenant: input.tenantId, connectedAccountId: input.accountId };
  if (input.paymentIntentId) query.paymentIntentId = input.paymentIntentId;
  else if (input.invoiceId) query.stripeInvoiceId = input.invoiceId;
  else return false;
  const row = await PaymentRefundReconciliation.findOne(query).session(input.session).lean().exec() as any;
  if (row?.membership && String(row.membership) !== input.membershipId) throw new Error("Refund membership payment binding mismatch.");
  return Boolean(row && (row.reviewRequired || row.summary?.succeededAmountMinor > 0 || row.summary?.pendingAmountMinor > 0));
}

type Binding = { order?: any; membership?: any; invoiceId?: string; reason?: string; managed: boolean };
async function bindPayment(tenantId: string, accountId: string, pi: Stripe.PaymentIntent, charge: Stripe.Charge): Promise<Binding> {
  const stripe = getTenantPaymentStripe();
  const options = getConnectedAccountRequestOptions(accountId);
  let order: any = await Order.findOne({ tenant: tenantId, "stripe.connectedAccountId": accountId, "stripe.paymentIntentId": pi.id }).lean().exec();
  // Metadata is only a lookup hint. The saved Checkout Session must independently
  // prove its PaymentIntent before a previously unprocessed order can be bound.
  if (!order && mongoose.isValidObjectId(pi.metadata?.orderId)) {
    const candidate = await Order.findOne({ _id: pi.metadata.orderId, tenant: tenantId, "stripe.connectedAccountId": accountId }).lean().exec();
    if (candidate?.stripe?.sessionId) {
      const checkout = await stripe.checkout.sessions.retrieve(candidate.stripe.sessionId, {}, options);
      if (id(checkout.payment_intent) === pi.id && checkout.livemode === pi.livemode) order = candidate;
    }
  }
  let providerCheckout: Stripe.Checkout.Session | undefined;
  if (!order) {
    // Historical Checkout PIs did not copy Session metadata. Query by the
    // provider's immutable association, then match the locally saved Session.
    const checkouts = await stripe.checkout.sessions.list({ payment_intent: pi.id, limit: 100 }, options);
    if (checkouts.has_more) throw new Error("Refund Checkout association is ambiguous.");
    for (const checkout of checkouts.data) {
      if (id(checkout.payment_intent) !== pi.id || checkout.livemode !== pi.livemode) throw new Error("Refund Checkout association mismatch.");
      const candidate = await Order.findOne({ tenant: tenantId, "stripe.connectedAccountId": accountId, "stripe.sessionId": checkout.id }).lean().exec();
      if (candidate) { if (order) throw new Error("Refund payment has multiple orders."); order = candidate; }
      providerCheckout = checkout;
    }
  }
  if (order) {
    // Piece checkouts and voucher purchases retain their existing dedicated
    // reconciliation and benefit policies. Generic booking/credit orders only.
    if (order.pieceCheckout) return { managed: false };
    const matches = order.stripe?.livemode === pi.livemode && order.currency?.toLowerCase() === charge.currency && order.expectedAmountMinor === charge.amount;
    return { order, managed: true, ...(!matches ? { reason: "payment_snapshot_mismatch" } : {}) };
  }
  const invoiceId = id(charge.invoice) || id((pi as any).invoice);
  if (invoiceId) {
    const invoice = await stripe.invoices.retrieve(invoiceId, {}, options);
    if (invoice.livemode !== pi.livemode || id(invoice.payment_intent) !== pi.id || invoice.currency !== charge.currency || invoice.amount_paid !== charge.amount)
      throw new Error("Refund invoice does not match its connected-account payment.");
    const localInvoice = await MembershipInvoice.findOne({ tenant: tenantId, connectedAccountId: accountId, stripeInvoiceId: invoice.id }).lean().exec();
    let membership: any = localInvoice ? await UserMembership.findOne({ _id: localInvoice.membership, tenant: tenantId, "stripe.connectedAccountId": accountId }).select("+stripe").lean().exec() : null;
    if (!membership && id(invoice.subscription)) membership = await UserMembership.findOne({ tenant: tenantId, "stripe.connectedAccountId": accountId, "stripe.subscriptionId": id(invoice.subscription) }).select("+stripe").lean().exec();
    if (membership) return { membership, invoiceId: invoice.id, managed: true };
    if (id(invoice.subscription)) {
      const subscription = await stripe.subscriptions.retrieve(id(invoice.subscription), {}, options);
      const hintedId = subscription.metadata?.sharioMembershipId;
      if (hintedId) {
        // Subscription metadata locates a candidate; only its saved Checkout
        // can prove association. An early missing binding remains a durable
        // review and still blocks this PI's subsequent entitlement grant.
        const candidate: any = mongoose.isValidObjectId(hintedId) ? await UserMembership.findOne({ _id: hintedId, tenant: tenantId, "stripe.connectedAccountId": accountId }).select("+stripe").lean().exec() : null;
        if (candidate?.stripe?.checkoutSessionId) {
          const checkout = await stripe.checkout.sessions.retrieve(candidate.stripe.checkoutSessionId, {}, options);
          if (id(checkout.subscription) === subscription.id && checkout.livemode === pi.livemode)
            return { membership: candidate, invoiceId: invoice.id, managed: true };
        }
        return { managed: true, invoiceId: invoice.id, reason: "payment_binding_missing" };
      }
    }
  }
  if (providerCheckout) {
    const membership: any = await UserMembership.findOne({ tenant: tenantId, "stripe.connectedAccountId": accountId, "stripe.checkoutSessionId": providerCheckout.id }).select("+stripe").lean().exec();
    if (membership) {
      // A Session association proves ownership, not the price/currency sold.
      // Recurring invoices above establish the actual period/proration amount;
      // one-time memberships must retain their immutable checkout snapshot.
      const recurring = membership.planSnapshot?.billing?.type === "recurring";
      const mismatch = membership.currency?.toLowerCase() !== charge.currency ||
        (recurring ? !invoiceId : membership.amountMinor !== charge.amount);
      return { membership, invoiceId: invoiceId || id(providerCheckout.invoice), managed: true,
        ...(mismatch ? { reason: "payment_snapshot_mismatch" } : {}) };
    }
  }
  const membershipId = pi.metadata?.sharioMembershipId;
  if (mongoose.isValidObjectId(membershipId)) {
    const membership: any = await UserMembership.findOne({ _id: membershipId, tenant: tenantId, "stripe.connectedAccountId": accountId }).select("+stripe").lean().exec();
    if (membership?.stripe?.checkoutSessionId) {
      const checkout = await stripe.checkout.sessions.retrieve(membership.stripe.checkoutSessionId, {}, options);
      if (id(checkout.payment_intent) === pi.id && checkout.livemode === pi.livemode)
        return { membership, invoiceId: invoiceId || id(checkout.invoice), managed: true, ...(membership.currency?.toLowerCase() !== charge.currency || membership.amountMinor !== charge.amount ? { reason: "payment_snapshot_mismatch" } : {}) };
    }
  }
  // Voucher purchases have their own authoritative reconciliation service.
  if (pi.metadata?.sharioFlow === "voucher-purchase" || providerCheckout?.metadata?.sharioFlow === "voucher-purchase" || pi.metadata?.sharioFlow === "piece-payment") return { managed: false };
  const managed = pi.metadata?.sharioManaged === "true" || Boolean(membershipId) || providerCheckout?.metadata?.sharioManaged === "true" || Boolean(providerCheckout?.metadata?.sharioMembershipId);
  return { managed, reason: "payment_binding_missing" };
}

/** Always read current provider state under a per-payment lease. Webhook
 * timestamps are not a sequence and embedded Charge.refunds is paginated. */
export type RefundReconciliationEvent = { id: string; type: string; account?: string; livemode: boolean; data: { object: unknown } };
export async function reconcilePaymentRefundEvent(event: RefundReconciliationEvent): Promise<void> {
  if (!REFUND_EVENTS.has(event.type)) return;
  if (!event.account || event.livemode !== getTenantPaymentStripeLivemode()) throw new Error("Refund event account/mode mismatch.");
  const account = await findTenantPaymentAccountByStripeAccount(event.account);
  if (!account || account.livemode !== event.livemode) throw new Error("Refund event connected account is not mapped in this mode.");
  const tenantId = String(account.tenant);
  const stripe = getTenantPaymentStripe();
  const options = getConnectedAccountRequestOptions(event.account);
  const object = event.data.object as any;
  const chargeId = object.object === "charge" ? object.id : id(object.charge);
  if (!chargeId) return; // Non-charge refunds are outside studio card commerce.
  const initialCharge = await stripe.charges.retrieve(chargeId, {}, options);
  const paymentIntentId = id(initialCharge.payment_intent);
  if (!paymentIntentId) return;
  if (initialCharge.livemode !== event.livemode) throw new Error("Refund charge mode mismatch.");
  await preparePaymentRefundCollections();
  const key = paymentRefundKey(event.account, paymentIntentId);
  await PaymentRefundReconciliation.updateOne({ _id: key }, { $setOnInsert: { tenant: tenantId, connectedAccountId: event.account, paymentIntentId, livemode: event.livemode } }, { upsert: true });
  const claimToken = randomUUID();
  const claim = await PaymentRefundReconciliation.findOneAndUpdate({ _id: key, $or: [{ claimToken: "" }, { claimExpiresAt: { $lte: new Date() } }] },
    { $set: { claimToken, claimExpiresAt: new Date(Date.now() + 120_000) } }, { returnDocument: "after" }).lean().exec() as any;
  if (!claim) throw new Error("Refund reconciliation is already in progress; retry delivery.");
  try {
    const charge = await stripe.charges.retrieve(chargeId, {}, options);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, options);
    if (id(charge.payment_intent) !== pi.id || charge.livemode !== event.livemode || pi.livemode !== event.livemode ||
        charge.currency !== pi.currency || !safeMinor(charge.amount) || !safeMinor(charge.amount_refunded) || charge.amount_refunded > charge.amount ||
        pi.amount_received !== charge.amount || !charge.paid)
      throw new Error("Refund payment integrity verification failed.");
    const binding = await bindPayment(tenantId, event.account, pi, charge);
    if (!binding.managed) {
      // Do not create false alerts for unrelated sales in a Standard account.
      await PaymentRefundReconciliation.deleteOne({ _id: key, claimToken, summary: null });
      return;
    }
    const refunds: Array<{ id: string; amountMinor: number; status: string }> = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < 10; page++) {
      const result = await stripe.refunds.list({ payment_intent: pi.id, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, options);
      for (const refund of result.data) {
        if (id(refund.payment_intent) !== pi.id || id(refund.charge) !== charge.id || refund.currency !== charge.currency || !safeMinor(refund.amount) || !refund.status || refunds.some((r) => r.id === refund.id))
          throw new Error("Refund list does not match the verified payment.");
        refunds.push({ id: refund.id, amountMinor: refund.amount, status: refund.status });
      }
      if (!result.has_more) { complete = true; break; }
      if (!result.data.length) break;
      cursor = result.data.at(-1)!.id;
    }
    refunds.sort((a, b) => a.id.localeCompare(b.id));
    const sum = (statuses: string[]) => refunds.filter((r) => statuses.includes(r.status)).reduce((total, r) => total + r.amountMinor, 0);
    const succeeded = sum(["succeeded"]);
    const pending = sum(["pending", "requires_action"]);
    const failed = sum(["failed", "canceled"]);
    const providerMismatch = !complete || charge.amount_refunded < succeeded || charge.amount_refunded > succeeded + pending || succeeded + pending > charge.amount || refunds.some((r) => !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(r.status));
    const reason = binding.reason || (providerMismatch ? "provider_snapshot_incomplete" : "benefit_review_required");
    const version = hash([charge.id, charge.amount, succeeded, refunds, binding.order?._id, binding.membership?._id, reason]);
    const reviewRequired = claim.resolution?.snapshotVersion !== version;
    const summary: RefundSummary = {
      reconciliationId: key, status: binding.reason || providerMismatch ? "review" : pending > 0 ? "pending" : succeeded === charge.amount ? "full" : succeeded > 0 ? "partial" : failed > 0 ? "failed" : "none",
      succeededAmountMinor: succeeded, pendingAmountMinor: pending, failedAmountMinor: failed,
      reviewRequired, reviewReason: reviewRequired ? reason : "", snapshotVersion: version, updatedAt: new Date(),
    };
    await mongoose.connection.transaction(async (session) => {
      const owned = await PaymentRefundReconciliation.updateOne({ _id: key, claimToken, claimExpiresAt: { $gt: new Date() } }, { $set: {
        chargeId: charge.id, currency: charge.currency.toUpperCase(), paidAmountMinor: charge.amount,
        order: binding.order?._id ?? null, membership: binding.membership?._id ?? null, stripeInvoiceId: binding.invoiceId ?? "",
        summary, refunds, reviewRequired, reviewReason: summary.reviewReason, snapshotVersion: version, lastEventId: event.id, lastObservedAt: new Date(),
      } }, { session });
      if (owned.modifiedCount !== 1) throw new Error("Refund reconciliation lease lost.");
      if (binding.order) {
        const updated = await Order.updateOne({ _id: binding.order._id, tenant: tenantId,
          $or: [{ "stripe.processingClaimToken": { $in: [null, ""] } }, { "stripe.processingLeaseExpiresAt": { $lte: new Date() } }],
        }, { $set: { refund: summary, "stripe.paymentIntentId": pi.id }, $inc: { refundReconciliationRevision: 1 } }, { session });
        if (updated.matchedCount !== 1) throw new Error("Payment fulfillment is in progress; retry refund reconciliation.");
      }
      if (binding.membership) {
        await UserMembership.updateOne({ _id: binding.membership._id, tenant: tenantId }, { $inc: { refundReconciliationRevision: 1 } }, { session });
        if (binding.invoiceId) await MembershipInvoice.updateOne({ tenant: tenantId, connectedAccountId: event.account, stripeInvoiceId: binding.invoiceId }, { $set: { refund: summary } }, { session });
      }
      await PaymentRefundObservation.updateOne({ _id: hash([key, version]) }, { $setOnInsert: { reconciliation: key, tenant: tenantId, eventId: event.id, snapshotVersion: version, summary, refunds } }, { upsert: true, session });
    });
  } finally {
    await PaymentRefundReconciliation.updateOne({ _id: key, claimToken }, { $set: { claimToken: "", claimExpiresAt: null } });
  }
}

/** A refund can be observed while Checkout creation is still saving its local
 * Session binding. Retry that association before processing the later payment. */
export async function reconcileRecordedRefundBeforeOrderFulfillment(input: { tenantId: string; accountId: string; paymentIntentId: string | null; orderId: string }) {
  if (!input.paymentIntentId) return;
  const row: any = await PaymentRefundReconciliation.findOne({ tenant: input.tenantId, connectedAccountId: input.accountId, paymentIntentId: input.paymentIntentId }).lean().exec();
  if (!row) return;
  if (row.order && String(row.order) !== input.orderId) throw new Error("Refund order payment binding mismatch.");
  if (!row.order || !row.summary) {
    if (!row.chargeId) throw new Error("Refund reconciliation is incomplete; retry payment confirmation.");
    await reconcilePaymentRefundEvent({ id: `reconcile-before-fulfillment:${row._id}`, type: "charge.refunded", account: input.accountId, livemode: row.livemode,
      data: { object: { object: "charge", id: row.chargeId } } });
    const updated = await PaymentRefundReconciliation.findById(row._id).lean().exec() as any;
    if (String(updated?.order ?? "") !== input.orderId || !updated?.summary) throw new Error("Refund payment association requires review before fulfillment.");
  }
}
