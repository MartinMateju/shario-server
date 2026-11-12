import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  products: vi.fn(), bookings: vi.fn(), tenant: vi.fn(), discount: vi.fn(), unavailable: vi.fn(),
  options: vi.fn(),
  normalize: vi.fn(),
  acquire: vi.fn(),
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({ checkoutRepository: {
  loadProductsByIds: mocks.products, findBookingLocations: mocks.bookings,
} }));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({ getTenantOrThrow: mocks.tenant }));
vi.mock("@/modules/product/product-plan-entitlements.js", () => ({ assertProductsEntitledForTenant: vi.fn() }));
vi.mock("@/modules/booking/booking.extension.service.js", () => ({ normalizeExtensionCart: mocks.normalize }));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({ ensureInvoiceSettings: async () => ({ defaultTaxRateBps: 2100, pricesIncludeTax: true }) }));
vi.mock("@/modules/membership/services/membership-discount.service.js", () => ({ resolveMembershipProductDiscount: mocks.discount }));
vi.mock("@/modules/checkout/services/checkout.membership-course.service.js", () => ({
  unavailablePersonalCourseDiscounts: mocks.unavailable,
  reservePersonalCourseDiscounts: vi.fn(), releaseCancelledPersonalCourseDiscounts: vi.fn(),
}));
vi.mock("@/modules/checkout/services/checkout.membership-options.service.js", () => ({ getCartMembershipPaymentOptions: mocks.options }));
vi.mock("@/modules/checkout/checkout-idempotency.service.js", () => ({
  acquireCheckoutOperation: mocks.acquire, completeCheckoutOperation: vi.fn(), releaseCheckoutOperation: vi.fn(),
}));
// Quoting and replay must never fulfill a booking or deliver notifications.
vi.mock("@/modules/checkout/services/checkout.webhook.service.js", () => ({
  processCourseBookingsAfterPayment: vi.fn(), processGuestIncreaseBookingsAfterPayment: vi.fn(),
}));
vi.mock("@/modules/checkout/services/checkout.workshop-fulfillment.service.js", () => ({ processWorkshopBookingsAfterPayment: vi.fn() }));
vi.mock("@/modules/invoice/invoice.service.js", () => ({ ensurePaidOrderInvoice: vi.fn() }));
vi.mock("@/modules/workspace-notifications/workspace-notification.business-events.js", () => ({ emitBookingCreatedNotificationsForOrderSafely: vi.fn() }));
vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({
  applyWaitlistPriceSnapshot: vi.fn(), attachWaitlistStripeSession: vi.fn(), resolveWaitlistCheckoutContext: vi.fn(),
  restoreWaitlistHoldAfterCheckoutFailure: vi.fn(), transferWaitlistHoldToOrder: vi.fn(),
}));

import { checkoutService } from "@/modules/checkout/services/checkout.service.js";

const tenantId = "507f1f77bcf86cd799439001";
const customerId = "507f1f77bcf86cd799439002";
const productId = "507f1f77bcf86cd799439003";
const bookingId = "507f1f77bcf86cd799439004";
const locationId = "507f1f77bcf86cd799439005";
const course = { _id: productId, type: "public-course", kind: "class", name: "Pottery course", price: 1200, currency: "CZK" };
const cartItem = { product: { _id: productId, type: "public-course", price: 1 }, bookingCourse: bookingId, quantity: 1 };
const memberDiscount = {
  membershipId: "507f1f77bcf86cd799439006", planId: "507f1f77bcf86cd799439007",
  planVersionId: "507f1f77bcf86cd799439008", planVersion: 1,
  benefitKey: "courses", benefitLabel: "Member courses", percentageBps: 1000,
  selectedLocationId: null, productScope: "courses", memberOnly: true,
};
const quote = (overrides: any = {}) => checkoutService.quoteCart({
  tenantId, user: { _id: customerId, moneyCreditsMinor: 108000 }, cartItems: [cartItem], ...overrides,
});

describe("portal membership cart quote pricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.products.mockResolvedValue([course]);
    mocks.bookings.mockResolvedValue([{ _id: bookingId, tag: "course", location: locationId }]);
    mocks.tenant.mockResolvedValue({ settings: { currency: "CZK" }, modules: { credits: true, memberships: true } });
    mocks.discount.mockResolvedValue(memberDiscount);
    mocks.unavailable.mockResolvedValue(new Set());
    mocks.options.mockResolvedValue([]);
    mocks.normalize.mockImplementation(async ({ cartItems }: any) => cartItems);
  });

  it("quotes the real course price less the personal discount and makes exact post-discount credits payable", async () => {
    const result = await quote();
    expect(result.quote).toEqual({ currency: "CZK", subtotalMinor: 120000, discountMinor: 12000, totalMinor: 108000 });
    expect(result.paymentOptions).toContainEqual({ method: "money_credits", availableMinor: 108000, availableMajor: 1080, coversTotal: true });
    expect(mocks.products).toHaveBeenCalledWith({ tenantId, productIds: expect.any(Array) });
    expect(mocks.discount).toHaveBeenCalledWith({ tenantId, userId: customerId, orderLocationIds: expect.any(Array) });
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ tenantId, userId: customerId, totalAmountMinor: 108000, currency: "CZK" }));
  });

  it("discounts only the member seat and keeps companions at full price", async () => {
    const result = await quote({ cartItems: [{ ...cartItem, quantity: 3 }] });
    expect(result.quote).toEqual({ currency: "CZK", subtotalMinor: 360000, discountMinor: 12000, totalMinor: 348000 });
    expect((result.paymentOptions as any[]).find((option) => option.method === "money_credits")?.coversTotal).toBe(false);
  });

  it("shows no discount when a member already used their seat benefit for this course session", async () => {
    mocks.unavailable.mockResolvedValue(new Set([bookingId]));
    const result = await quote();
    expect(result.quote).toMatchObject({ discountMinor: 0, totalMinor: 120000 });
    expect((result.paymentOptions as any[]).find((option) => option.method === "money_credits")?.coversTotal).toBe(false);
  });

  it("supports membership checkout options independently of the ordinary credits module", async () => {
    mocks.tenant.mockResolvedValue({ settings: { currency: "CZK" }, modules: { credits: false, memberships: true } });
    const option = { method: "membership_credits", benefitKey: "hours", unit: "minute", required: 90, available: 720, coversTotal: true };
    mocks.options.mockResolvedValue([option]);
    const result = await quote();
    expect(result.paymentOptions).toContainEqual(option);
    expect(result.paymentOptions.some((entry: any) => entry.method === "money_credits")).toBe(false);
  });

  it("does not advertise membership allowances when the memberships module is disabled", async () => {
    mocks.tenant.mockResolvedValue({ settings: { currency: "CZK" }, modules: { credits: true, memberships: false } });
    await quote();
    expect(mocks.options).not.toHaveBeenCalled();
  });

  it("rejects a forged currency instead of formatting a membership discount in the wrong currency", async () => {
    await expect(quote({ currency: "EUR" })).rejects.toMatchObject({ code: "CHECKOUT_CURRENCY_MISMATCH" });
  });

  it("keeps credits available for an extension too close to the booking end for card payment", async () => {
    const studio = { ...course, type: "workshop", kind: "open-studio", bookingMode: "public", location: locationId };
    const originalEnd = new Date(Date.now() + 30 * 60_000);
    const extensionItem = {
      product: { _id: productId, type: "workshop" }, locationId,
      bookingExtension: { bookingId, amountMinor: 20000, originalEnd: originalEnd.toISOString() },
      start: originalEnd.toISOString(), end: new Date(originalEnd.getTime() + 60 * 60_000).toISOString(), numberOfGuests: 1,
    };
    mocks.products.mockResolvedValue([studio]);
    mocks.bookings.mockResolvedValue([{ _id: bookingId, tag: "workshop", location: locationId }]);
    const result = await quote({ cartItems: [extensionItem] });
    expect(mocks.normalize).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: "credits" }));
    expect(mocks.discount).not.toHaveBeenCalled();
    expect(result.quote.totalMinor).toBe(20000);
    expect(result.paymentOptions).toContainEqual({ method: "card", available: false, unavailableReason: "customer_booking_extension_card_window" });
    expect(result.paymentOptions).toContainEqual({ method: "money_credits", availableMinor: 108000, availableMajor: 1080, coversTotal: true });
  });

  it("accepts a membership selection without trusting a browser-supplied consumption quantity", async () => {
    // Stop at the server's canonicalization boundary: the new portal request
    // must reach it without the old client-computed quantity field.
    const unavailableBooking = Object.assign(new Error("Booking no longer available"), { code: "BOOKING_UNAVAILABLE" });
    mocks.normalize.mockRejectedValue(unavailableBooking);
    await expect(checkoutService.checkoutWithCredits({
      tenantId, user: { _id: customerId }, cartItems: [cartItem],
      originUrl: "https://studio.example.test", paymentSource: "membership_credits",
      membershipBenefitKey: "hours", checkoutOperation: { orderId: "order" } as any,
    })).rejects.toBe(unavailableBooking);
    expect(mocks.normalize).toHaveBeenCalledWith(expect.objectContaining({ userId: customerId, paymentMethod: "credits" }));
  });

  it("returns a completed membership checkout on retry without repricing or starting another redemption", async () => {
    const completed = { success: true, status: "confirmed", orderId: "order-a", membershipRedemption: { benefitKey: "hours", quantity: 90 } };
    mocks.acquire.mockResolvedValue({ type: "replay", response: completed });
    const result = await checkoutService.checkoutWithCredits({
      tenantId, user: { _id: customerId }, cartItems: [cartItem], originUrl: "https://studio.example.test",
      paymentSource: "membership_credits", membershipBenefitKey: "hours", idempotencyKey: "same-booking",
    });
    expect(result).toEqual(completed);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, userId: customerId, idempotencyKey: "same-booking",
      request: expect.objectContaining({ paymentSource: "membership_credits", membershipBenefitKey: "hours" }),
    }));
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.products).not.toHaveBeenCalled();
  });
});
