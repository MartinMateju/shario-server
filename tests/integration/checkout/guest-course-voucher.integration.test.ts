import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: {} as any, createSession: vi.fn(), retrieveSession: vi.fn(), expireSession: vi.fn(),
  readyAccount: vi.fn(), reconcileWaitlist: vi.fn(), invoice: vi.fn(),
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({ getTenantOrThrow: async () => mocks.tenant }));
vi.mock("@/modules/product/product-plan-entitlements.js", () => ({ assertProductsEntitledForTenant: vi.fn() }));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({ defaultTaxRateBps: 0, pricesIncludeTax: true }),
}));
vi.mock("@/modules/invoice/invoice.service.js", () => ({ ensurePaidOrderInvoice: mocks.invoice }));
vi.mock("@/modules/workspace-notifications/workspace-notification.business-events.js", () => ({
  emitBookingCreatedNotificationsForOrderSafely: vi.fn(),
}));
vi.mock("@/modules/tenant-payments/services/tenant-payment-connect.service.js", () => ({
  requireReadyTenantConnectedAccount: mocks.readyAccount,
}));
vi.mock("@/modules/tenant-payments/tenant-payment-account.repository.js", () => ({
  findTenantPaymentAccountByStripeAccount: async () => ({ tenant: mocks.tenant._id, stripeAccountId: "acct_guest_voucher" }),
}));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({ checkout: { sessions: {
    create: mocks.createSession, retrieve: mocks.retrieveSession, expire: mocks.expireSession,
  } } }),
  getConnectedAccountRequestOptions: (stripeAccount: string, rest = {}) => ({ stripeAccount, ...rest }),
}));
vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  reconcileWaitlistAfterDirectCourseBooking: mocks.reconcileWaitlist, promoteWaitlistEntry: vi.fn(),
}));

import Booking from "@/modules/booking/booking.model.js";
import Product from "@/modules/product/product.model.js";
import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import Order from "@/modules/order/order.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { createPublicGuestCourseCheckout, getProtectedGuestCourseOrderStatus, quotePublicGuestCourseVoucher } from "@/modules/checkout/services/checkout.guest-course.service.js";
import { stripeWebhookService } from "@/modules/checkout/services/checkout.stripe-webhook.service.js";
import { refundBookingOriginalPaymentInSession } from "@/modules/booking/services/booking-payment-refund.service.js";

const oid = () => new mongoose.Types.ObjectId();
const tenantId = oid(), productId = oid(), slotId = oid(), locationId = oid(), ownerId = oid();
const code = "GUEST-VOUCHER-001";
const cart = () => [{
  product: { _id: String(productId), type: "public-course", price: 0 },
  bookingCourse: String(slotId), locationId: String(locationId), quantity: 1, numberOfGuests: 1, guests: [],
}];
const body = (overrides = {}) => ({
  cart: cart(), guestInfo: { firstName: "Guest", lastName: "Buyer", email: "existing@example.test" },
  locale: "cs", acceptedTerms: true, ...overrides,
});
const quote = (overrides = {}) => quotePublicGuestCourseVoucher({
  tenantId: String(tenantId), body: { cart: cart(), promoCode: code, ...overrides },
});
const expectation = (value: any) => ({
  currency: value.currency, totalAmountMinor: value.totalAmountMinor,
  voucherAppliedMinor: value.voucherAppliedMinor, remainingToPayMinor: value.remainingToPayMinor,
});
const checkout = (input: any, key = randomUUID()) => createPublicGuestCourseCheckout({
  tenantId: String(tenantId), body: body(input), idempotencyKey: key,
});
const createCoupon = (valueMinor = 60000, overrides = {}) => Coupon.create({
  tenant: tenantId, product: oid(), promoCode: code, lifecycleVersion: 1,
  voucherTypeSnapshot: "value", currencySnapshot: "CZK", valueMinorSnapshot: valueMinor,
  remainingValueMinor: valueMinor, voucherSettingsSnapshot: {
    version: 1, type: "value", validity: { mode: "months", months: 12 },
  }, expiresAt: new Date(Date.now() + 86400000), ...overrides,
});
const paidEvent = (order: any, eventId = "evt_guest_voucher_paid") => ({
  id: eventId, type: "checkout.session.completed", account: "acct_guest_voucher",
  livemode: false, created: Math.floor(Date.now() / 1000), data: { object: {
    id: order.stripe.sessionId, object: "checkout.session", client_reference_id: String(order._id),
    livemode: false, status: "complete", payment_status: "paid", amount_total: order.expectedAmountMinor,
    currency: "czk", payment_intent: "pi_guest_voucher", metadata: {
      sharioManaged: "true", sharioFlow: "order", tenantId: String(tenantId),
    },
  } },
}) as any;

describe("guest course voucher tender: transactional checkout and settlement", () => {
  let replica: MongoMemoryReplSet;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { dbName: "guest_voucher_test" });
    await Promise.all([User, Coupon, VoucherLedger, VoucherReservation, CheckoutOperationModel].map((model) => model.syncIndexes()));
  }, 60000);
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("ACCESS_TOKEN_SECRET", "guest-voucher-integration-".repeat(4));
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    mocks.tenant = {
      _id: tenantId, name: "Studio", slug: "studio", settings: { currency: "CZK" },
      modules: { courses: true, payments: true },
      publicSite: { customerPortal: { courses: { guestCheckoutEnabled: true } }, footer: { legal: { terms: "https://studio.example/terms" } } },
    };
    await Tenant.collection.insertOne(mocks.tenant);
    await Product.collection.insertOne({
      _id: productId, tenant: tenantId, createdBy: ownerId, name: "Course", type: "public-course", kind: "class",
      isActive: true, price: 500, currency: "czk", maxNumberOfParticipants: 3,
      courseContent: { details: { cs: "Podmínky kurzu" }, locationIds: [String(locationId)] },
    } as any);
    await Location.collection.insertOne({ _id: locationId, tenant: tenantId, name: "Studio", isActive: true } as any);
    await Booking.collection.insertOne({
      _id: slotId, tenant: tenantId, bookingProduct: productId, createdBy: ownerId,
      tag: "course", location: locationId, status: "processed", archive: false,
      start: new Date(Date.now() + 7 * 86400000), end: new Date(Date.now() + 7 * 86400000 + 3600000),
      numberOfGuests: 1, participants: [], capacityReservations: [], orders: [],
    } as any);
    await User.collection.insertOne({
      _id: ownerId, tenant: tenantId, firstname: "Existing", lastname: "Account", email: "existing@example.test",
      customId: "U-EXISTING", isAccessGranted: true, tenantRole: "customer", platformRole: "none",
    } as any);
    mocks.readyAccount.mockResolvedValue({ stripeAccountId: "acct_guest_voucher" });
    mocks.createSession.mockImplementation(async (payload: any) => ({
      id: `cs_${payload.client_reference_id}`, status: "open", livemode: false,
      url: `https://checkout.stripe.test/${payload.client_reference_id}`, expires_at: payload.expires_at,
    }));
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await mongoose.disconnect(); await replica.stop(); });

  it("quotes canonical prices without reserving money, seats or creating a guest", async () => {
    await createCoupon(20000);
    expect(await quote({ promoCode: ` ${code.toLowerCase()} ` })).toMatchObject({
      currency: "CZK", totalAmountMinor: 50000, voucherAppliedMinor: 20000,
      remainingToPayMinor: 30000, cardRequired: true,
    });
    expect(await Order.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(1);
    expect(await VoucherReservation.countDocuments()).toBe(0);
    expect((await Booking.findById(slotId).lean())?.capacityReservations).toHaveLength(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("fully pays and replays without Stripe or account credits, preserving guest proof and waitlist isolation", async () => {
    const coupon = await createCoupon();
    const input = { promoCode: code, expectedVoucherQuote: expectation(await quote()) };
    const key = randomUUID();
    const result = await checkout(input, key);
    expect(result.status).toBe("confirmed");
    expect(new URL(result.url).pathname).toBe("/cs/checkout/success");
    expect(new URL(result.url).hash).toBe(`#access_token=${result.accessToken}`);
    expect(await checkout(input, key)).toEqual(result);
    const order = await Order.findById(result.orderId).lean();
    expect(order).toMatchObject({ status: "processed_order", isPaid: true, expectedAmountMinor: 0,
      grossAmountMinor: 50000, guestCourseCheckout: { version: 1, locale: "cs" },
      paymentAllocations: [{ method: "voucher", amountMinor: 50000 }],
    });
    expect(String(order?.createdBy)).not.toBe(String(ownerId));
    const slot = await Booking.findById(slotId).lean();
    expect(slot).toMatchObject({ numberOfGuests: 2, capacityReservations: [] });
    expect(slot?.participants).toHaveLength(1);
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingValueMinor: 10000, reservedValueMinor: 0 });
    expect(await VoucherLedger.countDocuments({ coupon: coupon._id, kind: "commit" })).toBe(1);
    expect(await MoneyCredit.countDocuments()).toBe(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.readyAccount).not.toHaveBeenCalled();
    expect(mocks.reconcileWaitlist).not.toHaveBeenCalled();
    expect(JSON.stringify(await CheckoutOperationModel.findOne({}).lean())).not.toContain(result.accessToken);
    await expect(getProtectedGuestCourseOrderStatus({ tenantId: String(tenantId), orderId: result.orderId, accessToken: result.accessToken }))
      .resolves.toMatchObject({ status: "processed_order", isPaid: true, terminal: true });
    await expect(checkout({ ...input, promoCode: "DIFFERENT-CODE" }, key)).rejects.toMatchObject({ code: "CHECKOUT_IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("reserves partial voucher tender until the paid webhook and fulfills exactly once", async () => {
    const coupon = await createCoupon(20000);
    const input = { promoCode: code, expectedVoucherQuote: expectation(await quote()) };
    const key = randomUUID();
    const result = await checkout(input, key);
    expect(result.status).toBe("requires_payment");
    expect(await checkout(input, key)).toEqual(result);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.createSession.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(30000);
    const order = await Order.findById(result.orderId).lean();
    expect(order).toMatchObject({ expectedAmountMinor: 30000, grossAmountMinor: 50000, isPaid: false });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingValueMinor: 20000, reservedValueMinor: 20000 });
    expect((await Booking.findById(slotId).lean())?.numberOfGuests).toBe(1);
    await stripeWebhookService.processEvent(paidEvent(order));
    await stripeWebhookService.processEvent(paidEvent(order));
    expect(await Order.findById(result.orderId).lean()).toMatchObject({ status: "processed_order", isPaid: true, paidAmountMinor: 30000 });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingValueMinor: 0, reservedValueMinor: 0 });
    const slot = await Booking.findById(slotId).lean();
    expect(slot).toMatchObject({ numberOfGuests: 2, capacityReservations: [] });
    expect(slot?.participants).toHaveLength(1);
    expect(await VoucherLedger.countDocuments({ coupon: coupon._id, kind: "commit" })).toBe(1);
    expect(mocks.reconcileWaitlist).not.toHaveBeenCalled();
    expect(await MoneyCredit.countDocuments()).toBe(0);
  });

  it("consumes an eligible experience voucher by quantity without requiring a card", async () => {
    const coupon = await createCoupon(50000, {
      voucherTypeSnapshot: "experience", remainingQuantity: 1,
      remainingValueMinor: 0,
      voucherSettingsSnapshot: { version: 1, type: "experience", experienceProductId: productId,
        experienceQuantity: 1, validity: { mode: "months", months: 12 } },
    });
    const priced = await quote();
    expect(priced).toMatchObject({ voucherType: "experience", voucherAppliedMinor: 50000,
      remainingToPayMinor: 0, remainingVoucherQuantity: 0 });
    const result = await checkout({ promoCode: code, expectedVoucherQuote: expectation(priced) });
    expect(result.status).toBe("confirmed");
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingQuantity: 0, reservedQuantity: 0, isActive: false });
    expect(await VoucherReservation.findOne({ coupon: coupon._id }).lean()).toMatchObject({ quantity: 1, amountMinor: 0, status: "committed" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("does not report a paid order as confirmed before course fulfillment finishes", async () => {
    await createCoupon(20000);
    const input = { promoCode: code, expectedVoucherQuote: expectation(await quote()) };
    const key = randomUUID();
    const result = await checkout(input, key);
    await Order.updateOne({ _id: result.orderId }, { $set: { isPaid: true } });
    expect(await checkout(input, key)).toMatchObject({ status: "requires_payment" });
    expect(await getProtectedGuestCourseOrderStatus({ tenantId: String(tenantId),
      orderId: result.orderId, accessToken: result.accessToken }))
      .toMatchObject({ status: "pending_order", isPaid: true, processing: true, terminal: false });
    expect(await Booking.findById(slotId).lean()).toMatchObject({ numberOfGuests: 1, participants: [] });
    expect(await VoucherReservation.countDocuments({ status: "committed" })).toBe(0);
  });

  it("releases the voucher and seat after an expired unpaid Stripe session", async () => {
    const coupon = await createCoupon(20000);
    const result = await checkout({ promoCode: code, expectedVoucherQuote: expectation(await quote()) });
    const order = await Order.findById(result.orderId).lean();
    const event = paidEvent(order, "evt_guest_voucher_expired");
    event.type = "checkout.session.expired";
    Object.assign(event.data.object, { status: "expired", payment_status: "unpaid", payment_intent: null });
    await stripeWebhookService.processEvent(event);
    await stripeWebhookService.processEvent(event);
    expect(await Order.findById(result.orderId).lean()).toMatchObject({ status: "cancelled_order", isPaid: false });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingValueMinor: 20000, reservedValueMinor: 0 });
    expect(await VoucherLedger.countDocuments({ coupon: coupon._id, kind: "release" })).toBe(1);
    expect(await Booking.findById(slotId).lean()).toMatchObject({ numberOfGuests: 1, capacityReservations: [] });
  });

  it("recovers an interrupted Stripe create with the identical request while keeping guest proof out of the stored request", async () => {
    await createCoupon(20000);
    const input = { promoCode: code, expectedVoucherQuote: expectation(await quote()) };
    const key = randomUUID();
    mocks.createSession.mockRejectedValueOnce(new Error("Stripe response interrupted"));
    await expect(checkout(input, key)).rejects.toThrow("Stripe response interrupted");
    const originalRequest = mocks.createSession.mock.calls[0][0];
    const bearer = new URL(originalRequest.success_url).hash.slice("#access_token=".length);
    const pending = await Order.findOne({}).select("+voucherStripeRequest").lean();
    expect(JSON.stringify(pending)).not.toContain(bearer);
    const savedSuccessUrl = pending!.voucherStripeRequest.success_url;
    if (typeof savedSuccessUrl !== "string") throw new Error("The saved Stripe success URL must be a string.");
    expect(new URL(savedSuccessUrl).hash).toBe("");
    expect(await VoucherReservation.countDocuments({ status: "held" })).toBe(1);
    mocks.retrieveSession.mockResolvedValue({
      id: `cs_${pending!._id}`, client_reference_id: String(pending!._id), metadata: { tenantId: String(tenantId) },
      currency: "czk", amount_total: 30000, livemode: false, status: "open", payment_status: "unpaid",
      url: `https://checkout.stripe.test/${pending!._id}`,
    });
    const recovered = await checkout(input, key);
    expect(recovered.status).toBe("requires_payment");
    expect(recovered.accessToken).toBe(bearer);
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.createSession.mock.calls[1][0]).toEqual(originalRequest);
    expect(mocks.createSession.mock.calls[1][1]).toEqual(mocks.createSession.mock.calls[0][1]);
    expect(await Order.countDocuments()).toBe(1);
    expect(await VoucherReservation.countDocuments({ status: "held" })).toBe(1);
  });

  it("rechecks the reviewed quote and rejects changed price or balance without consuming the voucher", async () => {
    const coupon = await createCoupon(60000);
    const input = { promoCode: code, expectedVoucherQuote: expectation(await quote()) };
    await Product.updateOne({ _id: productId }, { $set: { price: 550 } });
    await expect(checkout(input)).rejects.toMatchObject({ code: "VOUCHER_QUOTE_CHANGED" });
    await Product.updateOne({ _id: productId }, { $set: { price: 500 } });
    await Coupon.updateOne({ _id: coupon._id }, { $set: { remainingValueMinor: 10000 } });
    await expect(checkout(input)).rejects.toMatchObject({ code: "VOUCHER_QUOTE_CHANGED" });
    expect(await VoucherReservation.countDocuments()).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
    expect((await Booking.findById(slotId).lean())?.capacityReservations).toHaveLength(0);
  });

  it("cannot spend the same voucher twice through simultaneous guest attempts", async () => {
    const coupon = await createCoupon(50000);
    const input = { promoCode: code, expectedVoucherQuote: expectation(await quote()) };
    const outcomes = await Promise.allSettled([checkout(input), checkout(input)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await Order.countDocuments({ isPaid: true })).toBe(1);
    expect(await VoucherLedger.countDocuments({ coupon: coupon._id, kind: "commit" })).toBe(1);
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingValueMinor: 0, reservedValueMinor: 0 });
    expect((await Booking.findById(slotId).lean())?.numberOfGuests).toBe(2);
  });

  it.each([
    { tenant: oid() },
    { expiresAt: new Date(0) },
    { remainingValueMinor: 0 },
    { isActive: false },
  ])("rejects unusable vouchers without exposing another tenant", async (overrides) => {
    await createCoupon(50000, overrides as any);
    await expect(quote()).rejects.toMatchObject({ code: "VOUCHER_UNAVAILABLE",
      message: "This voucher cannot be used for this booking. Check the code or contact the studio." });
    expect(await Order.countDocuments()).toBe(0);
    expect(await VoucherReservation.countDocuments()).toBe(0);
  });

  it("accepts an explicitly promoted legacy value voucher without inventing settings or an expiry", async () => {
    const coupon = await createCoupon(60000, { voucherSettingsSnapshot: undefined, expiresAt: null, singleUse: true });
    const result = await checkout({ promoCode: code, expectedVoucherQuote: expectation(await quote()) });
    expect(result.status).toBe("confirmed");
    const saved = await Coupon.findById(coupon._id).lean();
    expect(saved).toMatchObject({ remainingValueMinor: 10000, reservedValueMinor: 0, expiresAt: null,
      valueMinorSnapshot: 60000, currencySnapshot: "CZK", singleUse: true });
    expect(saved?.voucherSettingsSnapshot).toBeUndefined();
    expect(await VoucherReservation.findOne({ coupon: coupon._id }).lean()).toMatchObject({ status: "committed", amountMinor: 50000 });
  });

  it("keeps an unpromoted legacy voucher blocked for studio review", async () => {
    await createCoupon(50000, { lifecycleVersion: undefined, voucherSettingsSnapshot: undefined });
    await expect(quote()).rejects.toMatchObject({ code: "VOUCHER_LEGACY_REDEMPTION_REQUIRED",
      message: "This voucher needs studio review before it can be used online." });
    expect(await VoucherReservation.countDocuments()).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("returns cancelled voucher-funded course value to the original voucher once without extending validity or creating wallet credit", async () => {
    const coupon = await createCoupon(50000);
    const result = await checkout({ promoCode: code, expectedVoucherQuote: expectation(await quote()) });
    const refund = () => mongoose.connection.transaction((session) => refundBookingOriginalPaymentInSession({
      tenantId: String(tenantId), orderId: result.orderId, bookingId: String(slotId),
      actorId: String(ownerId), reason: "Course cancellation", session,
    }));
    expect(await refund()).toMatchObject({ voucherAmountMinor: 50000, cardAmountMinor: 0 });
    expect(await refund()).toMatchObject({ idempotent: true });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 50000, reservedValueMinor: 0, expiresAt: coupon.expiresAt,
    });
    expect(await VoucherLedger.countDocuments({ coupon: coupon._id, kind: "reverse" })).toBe(1);
    expect(await MoneyCredit.countDocuments()).toBe(0);
  });
});
