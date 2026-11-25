import { syncMembershipInvoice } from "@/modules/membership/services/membership-invoice.service.js";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const provider = vi.hoisted(() => ({ charge: vi.fn(), intent: vi.fn(), list: vi.fn(), checkoutList: vi.fn(), checkout: vi.fn(), invoice: vi.fn(), subscription: vi.fn(), create: vi.fn() }));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripeLivemode: () => false,
  getConnectedAccountRequestOptions: (account: string) => ({ stripeAccount: account }),
  getTenantPaymentStripe: () => ({ charges: { retrieve: provider.charge }, paymentIntents: { retrieve: provider.intent }, refunds: { list: provider.list, create: provider.create }, checkout: { sessions: { list: provider.checkoutList, retrieve: provider.checkout } }, invoices: { retrieve: provider.invoice }, subscriptions: { retrieve: provider.subscription } }),
}));
import { PaymentRefundReconciliation, PaymentRefundObservation, PaymentRefundReviewResolution } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";
import { reconcilePaymentRefundEvent, assertOrdersHaveNoProviderRefund, membershipPaymentHasRefund, reconcileRecordedRefundBeforeOrderFulfillment } from "@/modules/tenant-payments/services/payment-refund-reconciliation.service.js";
import { listPaymentRefundReviews, resolvePaymentRefundReview } from "@/modules/tenant-payments/services/payment-refund-review.service.js";
import Account from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import { Order } from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import Membership from "@/modules/membership/user-membership.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { calculateOrderSalesAmounts } from "@/modules/order/order.sales-amounts.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";

const tenant = new mongoose.Types.ObjectId(), otherTenant = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId(), orderId = new mongoose.Types.ObjectId(), booking = new mongoose.Types.ObjectId();
let replica: MongoMemoryReplSet;
let charge: any, intent: any, refunds: any[];
const event = (type = "charge.refunded", extra = {}) => ({ id: "evt_dashboard", type, account: "acct_studio", livemode: false, created: 100, data: { object: type === "charge.refunded" ? { object: "charge", id: "ch_paid", payment_intent: "pi_paid", amount_refunded: 999999 } : { object: "refund", id: "re_1", charge: "ch_paid", status: "pending" } }, ...extra } as any);
const refund = (id = "re_1", amount = 2000, status = "succeeded") => ({ id, object: "refund", amount, currency: "czk", status, payment_intent: "pi_paid", charge: "ch_paid" });
/** Do not release the paused invoice until the competing operation has
 * either committed (the old, unlocked implementation) or actually reached a
 * Mongo write conflict (the shared-lock implementation). No sleeps/race luck. */
async function runUntilContendedOrCompleted(start: () => Promise<unknown>, release: () => void) {
  let signalConflict!: () => void;
  const contended = new Promise<void>((resolve) => { signalConflict = resolve; });
  const original = mongoose.connection.transaction.bind(mongoose.connection);
  const transaction = vi.spyOn(mongoose.connection, "transaction").mockImplementation(((write: any, options: any) =>
    original(async (session) => {
      try { return await write(session); }
      catch (error: any) {
        if (error.hasErrorLabel?.("TransientTransactionError") || error.code === 112) signalConflict();
        throw error;
      }
    }, options)) as any);
  const operation = start();
  try {
    await Promise.race([contended, operation]);
    release();
    await operation;
  } finally { release(); transaction.mockRestore(); }
}
const find = () => PaymentRefundReconciliation.findOne({ tenant }).lean().exec() as Promise<any>;
const seedOrder = async (extra: any = {}) => Order.collection.insertOne({ _id: orderId, tenant, createdBy: user, currency: "CZK", expectedAmountMinor: 10000, paidAmountMinor: 10000, grossAmountMinor: 10000, isPaid: true, status: "processed_order", lineItems: [{ booking, grossAmountMinor: 10000 }], stripe: { connectedAccountId: "acct_studio", livemode: false, paymentIntentId: "pi_paid", sessionId: "cs_paid", processingClaimToken: "" }, ...extra });
const checkCancellation = () => mongoose.connection.transaction((session) => assertOrdersHaveNoProviderRefund(String(tenant), [String(orderId)], session));
async function seedAllocatedRefund(recordFields: Record<string, unknown> = {}) {
  const secondBooking = new mongoose.Types.ObjectId(), coupon = new mongoose.Types.ObjectId();
  await seedOrder({ grossAmountMinor: 15000,
    lineItems: [{ booking, grossAmountMinor: 7500 }, { booking: secondBooking, grossAmountMinor: 7500 }],
    workshopBookings: [booking, secondBooking],
    paymentAllocations: [{ method: "stripe", amountMinor: 10000 }, { method: "voucher", amountMinor: 5000 }],
    voucherRedemptions: [booking, secondBooking].map((_, lineIndex) => ({ lineIndex, couponId: coupon,
      reservationId: `reservation-${lineIndex}`, amountMinor: 2500, appliedAmountMinor: 2500, quantity: 0 })),
  });
  const recordId = `${tenant}:${orderId}:${booking}`;
  await BookingPaymentRefund.collection.insertOne({ _id: recordId, tenant, order: orderId, booking,
    customer: user, actor: user, reason: "Booking cancelled", status: "succeeded", providerStatus: "succeeded",
    refundId: "re_1", amountMinor: 7500, cardAmountMinor: 5000, voucherAmountMinor: 2500, voucherQuantity: 0,
    currency: "CZK", paymentIntentId: "pi_paid", connectedAccountId: "acct_studio", livemode: false,
    claimToken: "", failureRecordedAt: null, ...recordFields } as any);
  charge.amount_refunded = 5000;
  refunds = [refund("re_1", 5000)];
  // A deliberately misleading hint is irrelevant: the exact persisted refund
  // ID and immutable local payment/line allocation are the authorization proof.
  refunds[0].metadata = { sharioBookingRefundId: "dashboard-editable-hint" };
  return recordId;
}
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Order.init(), MembershipInvoice.init(), Account.init(), MoneyCredit.init(), BookingPaymentRefund.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await replica.stop(); });
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
  vi.clearAllMocks();
  await Account.create({ tenant, stripeAccountId: "acct_studio", accountCreateIdempotencyKey: "fixture", livemode: false });
  charge = { id: "ch_paid", object: "charge", payment_intent: "pi_paid", livemode: false, currency: "czk", amount: 10000, amount_refunded: 2000, paid: true };
  intent = { id: "pi_paid", object: "payment_intent", livemode: false, currency: "czk", amount_received: 10000, metadata: {} };
  refunds = [refund()];
  provider.charge.mockImplementation(async () => structuredClone(charge));
  provider.intent.mockImplementation(async () => structuredClone(intent));
  provider.list.mockImplementation(async () => ({ data: structuredClone(refunds), has_more: false }));
  provider.checkoutList.mockResolvedValue({ data: [], has_more: false });
});

describe("provider-verified Dashboard refund reconciliation", () => {
  it("records partial refunds once, preserves benefits, and uses current provider data rather than stale event values", async () => {
    await seedOrder({ creditPurchase: { amount: 100, currency: "CZK" } });
    await MoneyCredit.create({ tenant, user, currency: "CZK", balance: 100, balanceMinor: 10000, transactions: [] });
    const before = await MoneyCredit.findOne({ tenant }).lean();
    await reconcilePaymentRefundEvent(event());
    await reconcilePaymentRefundEvent(event("refund.updated", { id: "evt_older", created: 1 }));
    const row = await find();
    expect(row.summary).toMatchObject({ status: "partial", succeededAmountMinor: 2000, pendingAmountMinor: 0, reviewRequired: true, reviewReason: "benefit_review_required" });
    expect(await PaymentRefundReconciliation.countDocuments()).toBe(1);
    expect(await PaymentRefundObservation.countDocuments()).toBe(1);
    expect(await MoneyCredit.findOne({ tenant }).lean()).toEqual(before);
    expect((await Order.findById(orderId).lean())?.status).toBe("processed_order");
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.list).toHaveBeenCalledWith({ payment_intent: "pi_paid", limit: 100 }, { stripeAccount: "acct_studio" });
  });
  it("tracks pending, succeeded/full, and failed states without granting or undoing benefits", async () => {
    await seedOrder();
    charge.amount_refunded = 10000; refunds = [refund("re_1", 10000, "pending")];
    await reconcilePaymentRefundEvent(event("refund.created"));
    expect((await find()).summary).toMatchObject({ status: "pending", succeededAmountMinor: 0, pendingAmountMinor: 10000 });
    refunds[0].status = "succeeded"; charge.amount_refunded = 10000;
    await reconcilePaymentRefundEvent(event("refund.updated"));
    expect((await find()).summary).toMatchObject({ status: "full", succeededAmountMinor: 10000, pendingAmountMinor: 0 });
    refunds[0].status = "failed"; charge.amount_refunded = 0;
    await reconcilePaymentRefundEvent(event("refund.failed"));
    expect((await find()).summary).toMatchObject({ status: "failed", succeededAmountMinor: 0, failedAmountMinor: 10000 });
    expect(await PaymentRefundObservation.countDocuments()).toBe(3);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("paginates refunds rather than using Charge's truncated embedded list", async () => {
    await seedOrder(); charge.amount_refunded = 3000;
    provider.list.mockImplementation(async (args) => args.starting_after ? { data: [refund("re_2", 1000)], has_more: false } : { data: [refund()], has_more: true });
    await reconcilePaymentRefundEvent(event());
    expect((await find()).refunds).toHaveLength(2);
    expect(provider.list).toHaveBeenLastCalledWith({ payment_intent: "pi_paid", limit: 100, starting_after: "re_1" }, { stripeAccount: "acct_studio" });
  });
  it("defers inconsistent or incomplete provider lists to durable review", async () => {
    await seedOrder(); refunds = [];
    await reconcilePaymentRefundEvent(event());
    expect((await find()).summary).toMatchObject({ status: "review", succeededAmountMinor: 0, reviewReason: "provider_snapshot_incomplete" });
  });
  it("maps a refund arriving before checkout completion via provider Checkout association even without PI metadata", async () => {
    await seedOrder({ isPaid: false, status: "pending_order", stripe: { connectedAccountId: "acct_studio", livemode: false, sessionId: "cs_paid" } });
    provider.checkoutList.mockResolvedValue({ data: [{ id: "cs_paid", payment_intent: "pi_paid", livemode: false, metadata: { sharioManaged: "true" } }], has_more: false });
    await reconcilePaymentRefundEvent(event());
    const saved = await Order.findById(orderId).lean();
    expect(saved?.stripe.paymentIntentId).toBe("pi_paid");
    expect(saved?.refund?.succeededAmountMinor).toBe(2000);
    const claimed = await checkoutRepository.claimStripeOrder({ tenantId: String(tenant), orderId, eventId: "evt_late_checkout", claimToken: "late", now: new Date(), leaseExpiresAt: new Date(Date.now() + 60000), session: { id: "cs_paid", currency: "czk", amount_total: 10000, connectedAccountId: "acct_studio", livemode: false, payment_intent: "pi_paid" } });
    expect(claimed).toBeNull();
  });
  it("does not trust forged PI metadata to bind another payment to an order", async () => {
    await seedOrder({ stripe: { connectedAccountId: "acct_studio", livemode: false, sessionId: "cs_saved" } });
    intent.metadata = { sharioManaged: "true", orderId: String(orderId) };
    provider.checkout.mockResolvedValue({ id: "cs_saved", payment_intent: "pi_different", livemode: false });
    await reconcilePaymentRefundEvent(event());
    expect((await find()).reviewReason).toBe("payment_binding_missing");
    expect((await Order.findById(orderId).lean())?.refund).toBeUndefined();
  });
  it("persists a bounded actionable review for legacy Shario payments with missing mapping", async () => {
    intent.metadata = { sharioManaged: "true", orderId: String(orderId) };
    await reconcilePaymentRefundEvent(event()); await reconcilePaymentRefundEvent(event());
    expect((await listPaymentRefundReviews(String(tenant))).reviews).toHaveLength(1);
    const row = await find();
    expect(row).toMatchObject({ order: null, reviewRequired: true, reviewReason: "payment_binding_missing" });
    await expect(resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body: { snapshotVersion: row.snapshotVersion, note: "Reviewed the record", evidence: "Manual decision recorded" } })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("isolates independent studio accounts and rejects mode mismatch", async () => {
    await seedOrder({ tenant: otherTenant });
    await reconcilePaymentRefundEvent(event());
    expect(await PaymentRefundReconciliation.countDocuments()).toBe(0);
    await expect(reconcilePaymentRefundEvent(event("charge.refunded", { livemode: true }))).rejects.toThrow(/mode/);
    expect((await Order.findById(orderId).lean())?.refund).toBeUndefined();
  });
  it("keeps unrelated sales, vouchers and pieces with their existing handlers", async () => {
    await reconcilePaymentRefundEvent(event());
    expect(await PaymentRefundReconciliation.countDocuments()).toBe(0);
    intent.metadata = { sharioManaged: "true", sharioFlow: "voucher-purchase" };
    await reconcilePaymentRefundEvent(event());
    expect(await PaymentRefundReconciliation.countDocuments()).toBe(0);
    await seedOrder({ pieceCheckout: { state: "paid", method: "card", refundedAmountMinor: 0 } });
    await reconcilePaymentRefundEvent(event());
    expect(await PaymentRefundReconciliation.countDocuments()).toBe(0);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("retries a refund while the original order's fulfillment lease is active", async () => {
    await seedOrder({ stripe: { connectedAccountId: "acct_studio", paymentIntentId: "pi_paid", livemode: false, processingClaimToken: "fulfillment", processingLeaseExpiresAt: new Date(Date.now() + 60000) } });
    await expect(reconcilePaymentRefundEvent(event())).rejects.toThrow(/fulfillment is in progress/);
    expect((await find()).claimToken).toBe("");
    expect((await Order.findById(orderId).lean())?.refund).toBeUndefined();
    await Order.updateOne({ _id: orderId }, { $set: { "stripe.processingClaimToken": "" } });
    await reconcilePaymentRefundEvent(event());
    expect((await find()).summary.succeededAmountMinor).toBe(2000);
  });
  it("prevents further automatic compensation, including after staff resolves review", async () => {
    await seedOrder(); await reconcilePaymentRefundEvent(event());
    const row = await find();
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body: { snapshotVersion: row.snapshotVersion, note: "Keep booking as agreed", evidence: "Customer decision in support ticket 123" } });
    await expect(mongoose.connection.transaction(async (session) => assertOrdersHaveNoProviderRefund(String(tenant), [String(orderId)], session))).rejects.toMatchObject({ statusCode: 409 });
    expect((await find()).reviewRequired).toBe(false);
    expect((await find()).resolution.actor).toEqual(user);
  });
  it("allows remaining booking lines after an exactly allocated managed refund without weakening financial or fulfillment guards", async () => {
    const recordId = await seedAllocatedRefund();
    await reconcilePaymentRefundEvent(event());
    const before = await find();
    await expect(checkCancellation()).resolves.toBeUndefined();
    expect((await find()).summary).toEqual(before.summary);
    expect((await find()).reviewRequired).toBe(true);
    expect((await BookingPaymentRefund.findById(recordId).lean())?.allocationCheckRevision).toBe(1);
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: before._id, actorId: String(user), body: {
      snapshotVersion: before.snapshotVersion, note: "First booking cancelled; second retained", evidence: "Original refund allocated to the first paid booking line" } });
    await expect(checkCancellation()).resolves.toBeUndefined();
    expect((await Order.findById(orderId).lean())?.refund?.succeededAmountMinor).toBe(5000);
    await Order.updateOne({ _id: orderId }, { $set: { status: "pending_order" } });
    expect(await checkoutRepository.claimStripeOrder({ tenantId: String(tenant), orderId, eventId: "evt_late", claimToken: "late",
      now: new Date(), leaseExpiresAt: new Date(Date.now() + 60000), session: { id: "cs_paid", currency: "czk", amount_total: 10000,
        connectedAccountId: "acct_studio", livemode: false, payment_intent: "pi_paid" } })).toBeNull();
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
  });
  it.each(["pending", "processing", "provider_pending"])("recovers when the refund webhook beats the worker's saved success (%s)", async (status) => {
    const recordId = await seedAllocatedRefund({ status, providerStatus: "", refundId: "", claimToken: status === "processing" ? "worker" : "" });
    await reconcilePaymentRefundEvent(event());
    const version = (await find()).snapshotVersion;
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
    await BookingPaymentRefund.updateOne({ _id: recordId }, { $set: { status: "succeeded", providerStatus: "succeeded", refundId: "re_1", claimToken: "" } });
    // No second webhook or manual clearing of the provider refund is needed.
    await expect(checkCancellation()).resolves.toBeUndefined();
    expect((await find()).snapshotVersion).toBe(version);
  });
  it.each([
    ["tenant", otherTenant], ["order", new mongoose.Types.ObjectId()], ["customer", new mongoose.Types.ObjectId()],
    ["booking", new mongoose.Types.ObjectId()], ["connectedAccountId", "acct_other"], ["paymentIntentId", "pi_other"],
    ["livemode", true], ["currency", "EUR"], ["cardAmountMinor", 4900], ["amountMinor", 7400],
    ["voucherAmountMinor", 2400], ["voucherQuantity", 1], ["status", "review_required"], ["providerStatus", "failed"],
    ["failureRecordedAt", new Date()], ["claimToken", "worker"], ["_id", "incorrect-operation-id"],
  ])("does not trust a managed refund with mismatched or unsettled %s", async (field, value) => {
    await seedAllocatedRefund({ [String(field)]: value });
    await reconcilePaymentRefundEvent(event());
    await expect(checkCancellation()).rejects.toMatchObject({ code: "PAYMENT_REFUND_REVIEW_REQUIRED" });
  });
  it("blocks mixed managed/Dashboard refunds even after staff acknowledgment", async () => {
    await seedAllocatedRefund();
    refunds.push({ ...refund("re_external", 1000), metadata: { sharioBookingRefundId: `${tenant}:${orderId}:${booking}` } });
    charge.amount_refunded = 6000;
    await reconcilePaymentRefundEvent(event());
    const row = await find();
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body: {
      snapshotVersion: row.snapshotVersion, note: "Reviewed partial Dashboard return", evidence: "Support case records a second external refund" } });
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
  });
  it("rejects duplicate refund-ID associations and missing legacy reconciliation evidence", async () => {
    const recordId = await seedAllocatedRefund();
    await reconcilePaymentRefundEvent(event());
    const record = await BookingPaymentRefund.findById(recordId).lean();
    await BookingPaymentRefund.collection.insertOne({ ...record, _id: "duplicate-provider-refund", order: new mongoose.Types.ObjectId() });
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
    await BookingPaymentRefund.deleteOne({ _id: "duplicate-provider-refund" });
    await PaymentRefundReconciliation.deleteMany({ tenant });
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
  });
  it.each(["pending", "failed"])("keeps non-settled provider refunds blocked before review (%s)", async (status) => {
    await seedAllocatedRefund();
    refunds[0].status = status; charge.amount_refunded = status === "pending" ? 5000 : 0;
    await reconcilePaymentRefundEvent(event());
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
  });
  it.each(["failed", "none"])("preserves cancellation after staff resolves a zero-return %s snapshot", async (status) => {
    await seedOrder(); charge.amount_refunded = 0;
    refunds = status === "failed" ? [refund("re_failed", 1000, "failed")] : [];
    await reconcilePaymentRefundEvent(event()); const row = await find();
    await expect(checkCancellation()).rejects.toMatchObject({ statusCode: 409 });
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body: {
      snapshotVersion: row.snapshotVersion, note: "No money was returned by Stripe", evidence: "Provider history confirms there is no completed refund" } });
    await expect(checkCancellation()).resolves.toBeUndefined();
  });
  it("retries against a concurrent late bank failure instead of trusting a stale settled allocation", async () => {
    const recordId = await seedAllocatedRefund(); await reconcilePaymentRefundEvent(event());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const original = BookingPaymentRefund.updateOne.bind(BookingPaymentRefund);
    const spy = vi.spyOn(BookingPaymentRefund, "updateOne").mockImplementationOnce((async (...args: any[]) => {
      entered(); await gate; return (original as any)(...args);
    }) as any);
    const cancellation = checkCancellation();
    await paused;
    try {
      await BookingPaymentRefund.updateOne({ _id: recordId }, { $set: { status: "review_required", providerStatus: "failed", failureRecordedAt: new Date() } });
      release();
      await expect(cancellation).rejects.toMatchObject({ code: "PAYMENT_REFUND_REVIEW_REQUIRED" });
    } finally { release(); spy.mockRestore(); }
  });
  it("does not bypass a provider refresh claim acquired after the allocation was read", async () => {
    await seedAllocatedRefund(); await reconcilePaymentRefundEvent(event());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const original = PaymentRefundReconciliation.updateOne.bind(PaymentRefundReconciliation);
    const spy = vi.spyOn(PaymentRefundReconciliation, "updateOne").mockImplementationOnce((async (...args: any[]) => {
      entered(); await gate; return (original as any)(...args);
    }) as any);
    const cancellation = checkCancellation();
    await paused;
    try {
      await PaymentRefundReconciliation.updateOne({ tenant }, { $set: { claimToken: "provider-refresh", claimExpiresAt: new Date(Date.now() + 60000) } });
      release();
      await expect(cancellation).rejects.toMatchObject({ code: "PAYMENT_REFUND_REVIEW_REQUIRED" });
    } finally { release(); spy.mockRestore(); }
  });
  it("reopens reviewed records only for changed provider state; stale and cross-tenant acknowledgments fail", async () => {
    await seedOrder(); await reconcilePaymentRefundEvent(event()); const row = await find();
    const body = { snapshotVersion: row.snapshotVersion, note: "Reviewed and retained booking", evidence: "Support ticket 1234" };
    await expect(resolvePaymentRefundReview({ tenantId: String(otherTenant), id: row._id, actorId: String(user), body })).rejects.toMatchObject({ statusCode: 404 });
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body });
    await reconcilePaymentRefundEvent(event()); expect((await find()).reviewRequired).toBe(false);
    refunds.push(refund("re_2", 1000)); charge.amount_refunded = 3000;
    await reconcilePaymentRefundEvent(event()); expect((await find()).reviewRequired).toBe(true);
    await expect(resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("records membership invoice refunds while leaving membership and entitlement decisions to staff", async () => {
    const membership = new mongoose.Types.ObjectId();
    await Membership.collection.insertOne({ _id: membership, tenant, user, status: "active", isOpen: true, stripe: { connectedAccountId: "acct_studio", subscriptionId: "sub_saved" } });
    charge.invoice = "in_paid";
    provider.invoice.mockResolvedValue({ id: "in_paid", payment_intent: "pi_paid", subscription: "sub_saved", livemode: false, currency: "czk", amount_paid: 10000 });
    await MembershipInvoice.collection.insertOne({ tenant, membership, user, connectedAccountId: "acct_studio", stripeInvoiceId: "in_paid", currency: "CZK", amountPaidMinor: 10000 });
    await reconcilePaymentRefundEvent(event());
    expect((await Membership.findById(membership).lean())?.status).toBe("active");
    expect((await MembershipInvoice.findOne({ tenant }).lean())?.refund?.succeededAmountMinor).toBe(2000);
    const blocked = await mongoose.connection.transaction(async (session) => membershipPaymentHasRefund({ tenantId: String(tenant), membershipId: String(membership), accountId: "acct_studio", invoiceId: "in_paid", session }));
    expect(blocked).toBe(true);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("reattaches an early unbound refund before a late checkout can grant benefits", async () => {
    intent.metadata = { sharioManaged: "true" };
    await reconcilePaymentRefundEvent(event());
    expect((await find()).order).toBeNull();
    await seedOrder({ status: "pending_order", isPaid: false });
    await reconcileRecordedRefundBeforeOrderFulfillment({ tenantId: String(tenant), accountId: "acct_studio", paymentIntentId: "pi_paid", orderId: String(orderId) });
    expect((await find()).order).toEqual(orderId);
    expect((await Order.findById(orderId).lean())?.refund?.reviewRequired).toBe(true);
  });
  it("blocks late membership benefits for an observed refund whose membership mapping is not saved yet", async () => {
    intent.metadata = { sharioManaged: "true", sharioMembershipId: String(new mongoose.Types.ObjectId()) };
    await reconcilePaymentRefundEvent(event());
    expect((await find()).membership).toBeNull();
    const blocked = await mongoose.connection.transaction(async (session) => membershipPaymentHasRefund({ tenantId: String(tenant), membershipId: intent.metadata.sharioMembershipId, accountId: "acct_studio", paymentIntentId: "pi_paid", session }));
    expect(blocked).toBe(true);
  });
  it("rejects acknowledgment during a provider refresh and retains each resolution after reopening", async () => {
    await seedOrder(); await reconcilePaymentRefundEvent(event()); let row = await find();
    const body = { snapshotVersion: row.snapshotVersion, note: "Keep booking unchanged", evidence: "Support case 12345" };
    await PaymentRefundReconciliation.updateOne({ _id: row._id }, { $set: { claimToken: "refresh", claimExpiresAt: new Date(Date.now() + 60000) } });
    await expect(resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body })).rejects.toMatchObject({ statusCode: 409 });
    await PaymentRefundReconciliation.updateOne({ _id: row._id }, { $set: { claimToken: "" } });
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body });
    refunds.push(refund("re_2", 1000)); charge.amount_refunded = 3000;
    await reconcilePaymentRefundEvent(event()); row = await find();
    await resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body: { ...body, snapshotVersion: row.snapshotVersion } });
    expect(await PaymentRefundReviewResolution.countDocuments({ tenant })).toBe(2);
  });
  it("serializes concurrent refund deliveries without duplicate financial observations", async () => {
    await seedOrder();
    const results = await Promise.allSettled([reconcilePaymentRefundEvent(event()), reconcilePaymentRefundEvent(event("refund.updated"))]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    await reconcilePaymentRefundEvent(event());
    expect(await PaymentRefundObservation.countDocuments()).toBe(1);
    expect((await find()).summary.succeededAmountMinor).toBe(2000);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("keeps an early recurring refund visible when only provider subscription metadata identifies the pending membership", async () => {
    charge.invoice = "in_early";
    provider.invoice.mockResolvedValue({ id: "in_early", payment_intent: "pi_paid", subscription: "sub_early", livemode: false, currency: "czk", amount_paid: 10000 });
    provider.subscription.mockResolvedValue({ id: "sub_early", metadata: { sharioMembershipId: String(new mongoose.Types.ObjectId()) } });
    await reconcilePaymentRefundEvent(event());
    expect(await find()).toMatchObject({ membership: null, stripeInvoiceId: "in_early", reviewRequired: true, reviewReason: "payment_binding_missing" });
  });
  it.each([false, true])("serializes delayed invoice materialization with newer refunds (existing invoice=%s)", async (existing) => {
    const membershipId = new mongoose.Types.ObjectId();
    const member: any = { _id: membershipId, tenant, user, stripe: { connectedAccountId: "acct_studio", subscriptionId: "sub_saved" } };
    await Membership.collection.insertOne(member);
    const invoice: any = { id: "in_paid", payment_intent: "pi_paid", subscription: "sub_saved", livemode: false, currency: "czk", amount_paid: 10000, amount_due: 0, total: 10000, status: "paid", status_transitions: { paid_at: 100 }, lines: { data: [] } };
    charge.invoice = invoice.id; provider.invoice.mockResolvedValue(invoice);
    if (existing) await syncMembershipInvoice({ membership: member, connectedAccountId: "acct_studio", invoice, source: { id: "old", created: 1 } });
    let release!: () => void, paused!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { paused = resolve; });
    const original = MembershipInvoice.findOneAndUpdate.bind(MembershipInvoice);
    const spy = vi.spyOn(MembershipInvoice, "findOneAndUpdate").mockImplementationOnce(((...args: any[]) => {
      const query = (original as any)(...args);
      return { exec: async () => { paused(); await gate; return query.exec(); } };
    }) as any);
    const syncing = syncMembershipInvoice({ membership: member, connectedAccountId: "acct_studio", invoice, source: { id: "delayed", created: 2 } });
    await entered;
    try {
      await runUntilContendedOrCompleted(() => reconcilePaymentRefundEvent(event()), release);
      await syncing;
    } finally { release(); spy.mockRestore(); }
    const saved = await MembershipInvoice.findOne({ tenant }).lean();
    expect(saved?.refund?.succeededAmountMinor).toBe(2000);
    expect(saved?.refund?.snapshotVersion).toBe((await find()).snapshotVersion);
  });
  it("does not resurrect an unresolved review when invoice creation overlaps staff resolution", async () => {
    const membershipId = new mongoose.Types.ObjectId();
    const member: any = { _id: membershipId, tenant, user, stripe: { connectedAccountId: "acct_studio", subscriptionId: "sub_saved" } };
    await Membership.collection.insertOne(member);
    const invoice: any = { id: "in_paid", payment_intent: "pi_paid", subscription: "sub_saved", livemode: false, currency: "czk", amount_paid: 10000, amount_due: 0, total: 10000, status: "paid", status_transitions: { paid_at: 100 }, lines: { data: [] } };
    charge.invoice = invoice.id; provider.invoice.mockResolvedValue(invoice);
    await reconcilePaymentRefundEvent(event()); const row = await find();
    let release!: () => void, paused!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { paused = resolve; });
    const original = MembershipInvoice.findOneAndUpdate.bind(MembershipInvoice);
    const spy = vi.spyOn(MembershipInvoice, "findOneAndUpdate").mockImplementationOnce(((...args: any[]) => {
      const query = (original as any)(...args);
      return { exec: async () => { paused(); await gate; return query.exec(); } };
    }) as any);
    const syncing = syncMembershipInvoice({ membership: member, connectedAccountId: "acct_studio", invoice, source: { id: "delayed", created: 2 } });
    await entered;
    try {
      await runUntilContendedOrCompleted(() => resolvePaymentRefundReview({ tenantId: String(tenant), id: row._id, actorId: String(user), body: { snapshotVersion: row.snapshotVersion, note: "Keep current benefits", evidence: "Decision in support case 125" } }), release);
      await syncing;
    } finally { release(); spy.mockRestore(); }
    expect((await MembershipInvoice.findOne({ tenant }).lean())?.refund?.reviewRequired).toBe(false);
    expect((await find()).reviewRequired).toBe(false);
  });
  it.each([{ currency: "EUR", amountMinor: 10000 }, { currency: "CZK", amountMinor: 12000 }])("reviews immutable one-time membership snapshot mismatches reached through Checkout listing: %j", async (snapshot) => {
    const membershipId = new mongoose.Types.ObjectId();
    await Membership.collection.insertOne({ _id: membershipId, tenant, user, ...snapshot, planSnapshot: { billing: { type: "fixed" } },
      stripe: { connectedAccountId: "acct_studio", checkoutSessionId: "cs_membership" } });
    intent.metadata = { sharioMembershipId: String(membershipId) };
    provider.checkoutList.mockResolvedValue({ data: [{ id: "cs_membership", payment_intent: "pi_paid", livemode: false }], has_more: false });
    await reconcilePaymentRefundEvent(event());
    expect(await find()).toMatchObject({ membership: membershipId, reviewReason: "payment_snapshot_mismatch", summary: { status: "review" } });
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("reports actual net money and deduplicates a managed card refund plus restored voucher value", () => {
    const order = { _id: orderId, currency: "CZK", grossAmountMinor: 10000, lineItems: [{ booking, grossAmountMinor: 10000 }], refund: { succeededAmountMinor: 2000, status: "partial" } };
    expect(calculateOrderSalesAmounts(order)).toMatchObject({ grossAmountMinor: 10000, refundedAmountMinor: 2000, netAmountMinor: 8000 });
    const result = calculateOrderSalesAmounts(order, { paymentRefunds: [{ order: orderId, booking, currency: "CZK", status: "succeeded", amountMinor: 5000, voucherAmountMinor: 3000, cardAmountMinor: 2000, refundId: "re_1" }], providerRefunds: [{ order: orderId, refunds: [{ id: "re_1", amountMinor: 2000, status: "succeeded" }] }] });
    expect(result).toMatchObject({ status: "available", refundedAmountMinor: 5000, netAmountMinor: 5000 });
  });
});
