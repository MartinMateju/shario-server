import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from "../../helpers/mongoMemory.js";

const mocks = vi.hoisted(() => ({
  tenant: {} as any, createSession: vi.fn(), retrieveSession: vi.fn(), expireSession: vi.fn(),
  reconcileWaitlist: vi.fn(),
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: async () => mocks.tenant,
}));
vi.mock("@/modules/product/product-plan-entitlements.js", () => ({ assertProductsEntitledForTenant: vi.fn() }));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({ defaultTaxRateBps: 0, pricesIncludeTax: true }),
}));
vi.mock("@/modules/tenant-payments/services/tenant-payment-connect.service.js", () => ({
  requireReadyTenantConnectedAccount: async () => ({ stripeAccountId: "acct_guest_studio" }),
}));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    checkout: { sessions: { create: mocks.createSession, retrieve: mocks.retrieveSession, expire: mocks.expireSession } },
  }),
  getConnectedAccountRequestOptions: (stripeAccount: string, rest = {}) => ({ stripeAccount, ...rest }),
}));
vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  reconcileWaitlistAfterDirectCourseBooking: mocks.reconcileWaitlist,
}));

import Booking from "@/modules/booking/booking.model.js";
import Product from "@/modules/product/product.model.js";
import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import Order from "@/modules/order/order.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { createPublicGuestCourseCheckout, getProtectedGuestCourseOrderStatus } from "@/modules/checkout/services/checkout.guest-course.service.js";
import { getPublicGuestCourseOrderStatus } from "@/modules/checkout/services/checkout.public-guest.service.js";
import { processCourseBookingsAfterPayment } from "@/modules/checkout/services/checkout.webhook.service.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { hashCheckoutRequest } from "@/modules/checkout/checkout-idempotency.service.js";

const id = () => new mongoose.Types.ObjectId();
const tenantId = id();
const productId = id();
const slotId = id();
const locationId = id();
const adminId = id();
const legal = { terms: "https://studio.example/terms", cancellation: "https://studio.example/cancellation" };
const body = (overrides = {}) => ({
  cart: [{
    product: { _id: String(productId), type: "public-course", kind: "class", price: 0 },
    bookingCourse: String(slotId), locationId: String(locationId),
    quantity: 1, numberOfGuests: 1, guests: [],
  }],
  guestInfo: { firstName: "Guest", lastName: "Buyer", email: "existing@example.test" },
  locale: "cs", acceptedTerms: true, ...overrides,
});
const checkout = (input = body(), key = randomUUID()) => createPublicGuestCourseCheckout({
  tenantId: String(tenantId), body: input, idempotencyKey: key,
  requestedOrigin: "https://attacker.example",
});

describe("guest course checkout: real persistence, canonical seats and protected return", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await CheckoutOperationModel.syncIndexes();
    await User.syncIndexes();
  }, 60000);
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("ACCESS_TOKEN_SECRET", "guest-integration-secret-".repeat(4));
    await clearTestDatabase();
    mocks.tenant = {
      _id: tenantId, name: "Studio", slug: "studio", settings: { currency: "CZK" },
      modules: { courses: true, payments: true },
      publicSite: { customerPortal: { courses: { guestCheckoutEnabled: true } }, footer: { legal: { ...legal } } },
    };
    await Product.collection.insertOne({
      _id: productId, tenant: tenantId, createdBy: adminId,
      name: "Wheel class", description: "A class", type: "public-course", kind: "class",
      isActive: true, isArchived: false, price: 500, currency: "czk",
      maxNumberOfParticipants: 2, location: null,
      courseContent: { details: { en: "Marketing description: what you will make in this class" }, locationIds: [String(locationId)] },
    } as any);
    await Location.collection.insertOne({
      _id: locationId, tenant: tenantId, name: "Studio", isActive: true,
      booking: { enabled: false },
    } as any);
    await Booking.collection.insertOne({
      _id: slotId, tenant: tenantId, createdBy: adminId, bookingProduct: productId,
      tag: "course", location: locationId, status: "processed", archive: false,
      start: new Date(Date.now() + 7 * 86400000), end: new Date(Date.now() + 7 * 86400000 + 3600000),
      numberOfGuests: 1, participants: [], capacityReservations: [], orders: [],
    } as any);
    await User.collection.insertOne({
      _id: adminId, tenant: tenantId, firstname: "Existing", lastname: "Account",
      email: "existing@example.test", customId: "U-EXISTING", isAccessGranted: true,
      tenantRole: "customer", platformRole: "none", roles: ["1023e"], isEmailVerified: true,
    } as any);
    mocks.createSession.mockImplementation(async (payload) => ({
      id: `cs_${payload.client_reference_id}`, status: "open",
      url: `https://checkout.stripe.test/${payload.client_reference_id}`,
      livemode: false, expires_at: payload.expires_at,
    }));
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(disconnectTestDatabase);

  it("charges the canonical price, reserves one remaining seat, keeps existing accounts untouched, and retries once", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    const replay = await checkout(body(), key);
    expect(replay).toEqual(result);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    const [stripeRequest, stripeOptions] = mocks.createSession.mock.calls[0];
    expect(stripeRequest.line_items[0].price_data.unit_amount).toBe(50000);
    expect(stripeRequest.customer_email).toBe("existing@example.test");
    expect(stripeOptions.stripeAccount).toBe("acct_guest_studio");
    expect(stripeRequest.success_url).not.toContain("attacker.example");
    expect(new URL(stripeRequest.success_url).hash).toBe(`#access_token=${result.accessToken}`);
    expect(new URL(stripeRequest.cancel_url).searchParams.get("location")).toBe(String(locationId));
    const saved = await Order.findById(result.orderId).lean();
    expect(saved?.customer.email).toBe("existing@example.test");
    expect(saved?.guestCourseCheckout?.locale).toBe("cs");
    expect(saved?.guestCourseCheckout?.acceptedTerms?.contentHash).toBe(hashCheckoutRequest({ productId: String(productId), locale: "cs", legal }));
    expect(saved?.guestCourseCheckout).not.toHaveProperty("accessTokenHash");
    expect(saved?.guestCourseCheckout).not.toHaveProperty("accessNonce");
    const guest = await User.findById(saved!.createdBy).select("+guestContact +password +tenantRole +platformRole").lean();
    expect(String(guest?._id)).not.toBe(String(adminId));
    expect(guest).toMatchObject({
      isAccessGranted: false, isEmailVerified: false, tenantRole: "customer", platformRole: "none",
      guestContact: { email: "existing@example.test", locale: "cs" },
    });
    expect(guest?.email).toBeUndefined();
    expect(guest?.password).toBeUndefined();
    expect(guest?.memberNumber).toBeUndefined();
    expect(await User.countDocuments({ email: "existing@example.test" })).toBe(1);
    const slot = await Booking.findById(slotId).lean();
    expect(slot?.numberOfGuests).toBe(1);
    expect(slot?.capacityReservations).toHaveLength(1);
    expect(String(slot?.capacityReservations?.[0].order)).toBe(result.orderId);
    expect(JSON.stringify(await CheckoutOperationModel.findOne({}).lean())).not.toContain(result.accessToken);
    await expect(checkout(body(), randomUUID())).rejects.toMatchObject({ code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED" });
  });

  it("binds retries to contact/cart and protects status across tenants and missing/incorrect proof", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    await expect(checkout(body({ guestInfo: { firstName: "Other", lastName: "Person", email: "other@example.test" } }), key))
      .rejects.toMatchObject({ code: "CHECKOUT_IDEMPOTENCY_KEY_CONFLICT" });
    expect(mocks.createSession).toHaveBeenCalledOnce();
    const input = { tenantId: String(tenantId), orderId: result.orderId, accessToken: result.accessToken };
    await expect(getProtectedGuestCourseOrderStatus(input)).resolves.toMatchObject({
      status: "pending_order", isPaid: false, orderType: "guest-course",
    });
    for (const invalid of [
      { ...input, accessToken: undefined },
      { ...input, accessToken: "A".repeat(43) },
      { ...input, tenantId: String(id()) },
      { ...input, orderId: String(id()) },
    ]) await expect(getProtectedGuestCourseOrderStatus(invalid)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPublicGuestCourseOrderStatus(input)).resolves.toBeNull();
    mocks.tenant.modules.courses = false;
    await expect(getProtectedGuestCourseOrderStatus(input)).resolves.toMatchObject({ isPaid: false });
  });

  it("fulfills once without changing another email owner's waitlist, then replays to the result page", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    await Order.updateOne({ _id: result.orderId }, { $set: { isPaid: true, status: "processed_order" } });
    const saved = await Order.findById(result.orderId).lean();
    await processCourseBookingsAfterPayment(saved as any, { tenantId: String(tenantId) });
    await processCourseBookingsAfterPayment(saved as any, { tenantId: String(tenantId) });
    const slot = await Booking.findById(slotId).lean();
    expect(slot?.numberOfGuests).toBe(2);
    expect(slot?.participants).toHaveLength(1);
    expect(String(slot?.participants[0].customer)).toBe(String(saved?.createdBy));
    expect(slot?.capacityReservations).toHaveLength(0);
    expect(mocks.reconcileWaitlist).not.toHaveBeenCalled();
    expect(new URL((await checkout(body(), key)).url).pathname).toBe("/cs/checkout/success");
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("preserves the guest marker through the real Stripe claim before fulfillment", async () => {
    const result = await checkout();
    const claimToken = randomUUID();
    const now = new Date();
    const claim = {
      tenantId, orderId: result.orderId, eventId: "evt_guest_claim", claimToken,
      now, leaseExpiresAt: new Date(now.getTime() + 120000),
      session: {
        id: `cs_${result.orderId}`, payment_intent: "pi_guest_claim",
        currency: "CZK", amount_total: 50000,
        connectedAccountId: "acct_guest_studio", livemode: false,
      },
    };
    const claimed = await checkoutRepository.claimStripeOrder(claim);
    expect(claimed).not.toBeNull();
    expect(claimed?.guestCourseCheckout?.version).toBe(1);
    expect(claimed?.guestCourseCheckout).not.toHaveProperty("accessNonce");
    expect(claimed?.guestCourseCheckout).not.toHaveProperty("accessTokenHash");
    await processCourseBookingsAfterPayment(claimed as any, { tenantId: String(tenantId) });
    await processCourseBookingsAfterPayment(claimed as any, { tenantId: String(tenantId) });
    expect(mocks.reconcileWaitlist).not.toHaveBeenCalled();
    const slot = await Booking.findById(slotId).lean();
    expect(slot?.numberOfGuests).toBe(2);
    expect(slot?.participants).toHaveLength(1);
    expect(slot?.capacityReservations).toHaveLength(0);
    const processed = await checkoutRepository.markOrderProcessed({
      tenantId, orderId: result.orderId, eventId: claim.eventId, claimToken,
    });
    expect(processed.modifiedCount).toBe(1);
    expect(await checkoutRepository.claimStripeOrder({ ...claim, claimToken: randomUUID() })).toBeNull();
    await expect(getProtectedGuestCourseOrderStatus({
      tenantId: String(tenantId), orderId: result.orderId, accessToken: result.accessToken,
    })).resolves.toMatchObject({ status: "processed_order", isPaid: true, terminal: true });
  });

  it.each(["wrong-location", "unpublished-location", "archived-product", "foreign-slot"])("rejects canonical mismatch: %s", async (condition) => {
    if (condition === "wrong-location") await Location.updateOne({ _id: locationId }, { $set: { isActive: false } });
    if (condition === "unpublished-location") await Product.updateOne({ _id: productId }, { $set: { "courseContent.locationIds": [String(id())] } });
    if (condition === "archived-product") await Product.updateOne({ _id: productId }, { $set: { isArchived: true } });
    if (condition === "foreign-slot") await Booking.collection.updateOne({ _id: slotId }, { $set: { tenant: id() } });
    await expect(checkout()).rejects.toMatchObject({ code: "GUEST_COURSE_CHECKOUT_UNAVAILABLE" });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(await Order.countDocuments()).toBe(0);
  });

  it.each(["terms", "cancellation"])("requires consent for a published %s link even without course details", async (key) => {
    mocks.tenant.publicSite.footer.legal = { [key]: legal[key as keyof typeof legal] };
    await Product.updateOne({ _id: productId }, { $set: { "courseContent.details": {} } });
    await expect(checkout(body({ acceptedTerms: undefined }))).rejects.toMatchObject({ code: "GUEST_COURSE_TERMS_REQUIRED" });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(await Order.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(1);
  });

  it.each([undefined, true])("does not treat marketing descriptions as legal terms or fabricate acceptance evidence (%s)", async (acceptedTerms) => {
    mocks.tenant.publicSite.footer.legal = { terms: "", cancellation: "" };
    const result = await checkout(body({ acceptedTerms }));
    const saved = await Order.findById(result.orderId).lean();
    expect(saved?.guestCourseCheckout?.acceptedTerms).toBeUndefined();
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("hashes normalized published destinations rather than draft, legacy settings or course marketing", async () => {
    mocks.tenant.publicSiteEditor = {
      published: { ...mocks.tenant.publicSite, footer: { legal: { terms: "HTTPS://LEGAL.EXAMPLE:443", cancellation: "/cs/cancellation" } } },
      draft: { ...mocks.tenant.publicSite, footer: { legal: { terms: "https://draft.example/terms", cancellation: "/draft" } } },
    };
    const result = await checkout();
    const saved = await Order.findById(result.orderId).lean();
    expect(saved?.guestCourseCheckout?.acceptedTerms?.contentHash).toBe(hashCheckoutRequest({
      productId: String(productId), locale: "cs", legal: { terms: "https://legal.example/", cancellation: "/cs/cancellation" },
    }));
  });

  it("does not revive legacy or draft links when the published legal set is empty or unsafe", async () => {
    mocks.tenant.publicSiteEditor = {
      published: { ...mocks.tenant.publicSite, footer: { legal: { terms: "javascript:alert(1)", cancellation: "" } } },
      draft: { ...mocks.tenant.publicSite },
    };
    const result = await checkout(body({ acceptedTerms: undefined }));
    expect((await Order.findById(result.orderId).lean())?.guestCourseCheckout?.acceptedTerms).toBeUndefined();
  });

  it("keeps a saved order's original consent hash when published links change before replay", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    const before = (await Order.findById(result.orderId).lean())?.guestCourseCheckout?.acceptedTerms;
    mocks.tenant.publicSite.footer.legal = { terms: "https://studio.example/revised-terms", cancellation: "" };
    expect(await checkout(body(), key)).toEqual(result);
    expect((await Order.findById(result.orderId).lean())?.guestCourseCheckout?.acceptedTerms).toEqual(before);
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("recovers an already saved checkout without imposing newly published links or rewriting absent consent", async () => {
    mocks.tenant.publicSite.footer.legal = { terms: "", cancellation: "" };
    const key = randomUUID(), input = body({ acceptedTerms: undefined });
    const result = await checkout(input, key);
    const payload = mocks.createSession.mock.calls[0][0];
    await CheckoutOperationModel.updateOne({ orderId: result.orderId }, {
      $set: { state: "processing", response: null, leaseExpiresAt: new Date(0) },
    });
    mocks.tenant.publicSite.footer.legal = { ...legal };
    mocks.retrieveSession.mockResolvedValue({
      id: `cs_${result.orderId}`, status: "open", url: result.url,
      client_reference_id: result.orderId, metadata: payload.metadata,
      currency: "czk", amount_total: 50000, livemode: false,
    });
    expect(await checkout(input, key)).toEqual(result);
    expect((await Order.findById(result.orderId).lean())?.guestCourseCheckout?.acceptedTerms).toBeUndefined();
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.retrieveSession).toHaveBeenCalledOnce();
    expect(await Order.countDocuments()).toBe(1);
  });

  it("does not start another payment from a terminal attempt and releases expired capacity through the shared path", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    const saved = await Order.findById(result.orderId).lean();
    await checkoutRepository.releaseExpiredStripeOrder({
      tenantId, orderId: saved!._id, sessionId: saved!.stripe.sessionId,
      connectedAccountId: "acct_guest_studio",
    });
    await expect(checkout(body(), key)).rejects.toMatchObject({ code: "GUEST_CHECKOUT_ATTEMPT_EXPIRED" });
    expect((await Booking.findById(slotId).lean())?.capacityReservations).toHaveLength(0);
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("fails closed when an old key outlives its operation TTL instead of binding a second order to the same guest", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    await CheckoutOperationModel.deleteMany({});
    await expect(checkout(body(), key)).rejects.toMatchObject({ code: "GUEST_CHECKOUT_ATTEMPT_EXPIRED" });
    expect(await Order.countDocuments()).toBe(1);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect((await Booking.findById(slotId).lean())?.capacityReservations?.map((hold) => String(hold.order))).toEqual([result.orderId]);
  });

  it("does not suggest a fresh payment when a signing secret changes; the saved bearer still verifies", async () => {
    const key = randomUUID();
    const result = await checkout(body(), key);
    await Order.updateOne({ _id: result.orderId }, { $set: { isPaid: true, status: "processed_order" } });
    vi.stubEnv("ACCESS_TOKEN_SECRET", "rotated-guest-secret-".repeat(4));
    await expect(checkout(body(), key)).rejects.toMatchObject({ code: "GUEST_COURSE_ORDER_NOT_FOUND" });
    expect(await Order.countDocuments()).toBe(1);
    expect(mocks.createSession).toHaveBeenCalledOnce();
    await expect(getProtectedGuestCourseOrderStatus({
      tenantId: String(tenantId), orderId: result.orderId, accessToken: result.accessToken,
    })).resolves.toMatchObject({ isPaid: true });
  });
});
