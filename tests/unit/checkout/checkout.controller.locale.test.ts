import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkoutWithCredits: vi.fn(),
  createStripeCheckout: vi.fn(),
  findUserByEmail: vi.fn(),
  getTenantOrThrow: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/booking/booking.model.js", () => ({ default: {} }));
vi.mock("@/modules/order/order.model.js", () => ({ default: {} }));
vi.mock("@/infrastructure/email/nodemailer.client.js", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserEmail: () => "ada@example.com",
  getAuthenticatedUserId: () => "507f1f77bcf86cd799439012",
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: () => "507f1f77bcf86cd799439011",
}));
vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: { findUserByEmail: mocks.findUserByEmail },
}));
vi.mock("@/modules/checkout/services/checkout.service.js", () => ({
  checkoutService: {
    checkoutWithCredits: mocks.checkoutWithCredits,
    createStripeCheckout: mocks.createStripeCheckout,
  },
}));
vi.mock("@/modules/checkout/services/checkout.public-guest.service.js", () => ({
  getPublicGuestCourseOrderStatus: vi.fn(),
}));
vi.mock(
  "@/modules/checkout/services/checkout.legacy-platform-webhook.service.js",
  () => ({ legacyPlatformCheckoutWebhookService: {} }),
);
vi.mock("@/modules/booking/booking.repository.js", () => ({
  createBookingRepository: vi.fn(),
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));
vi.mock("@/shared/http/httpErrors.js", () => ({
  badRequest: vi.fn(),
  forbidden: vi.fn(),
}));
vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({
  getWaitlistOfferOperationKey: vi.fn(),
}));

import {
  checkoutWithCredits,
  sendCheckout,
  sendWaitlistEntryCheckout,
} from "@/modules/checkout/controllers/checkout.controller.js";

const requestFor = (locale: string) =>
  ({
    body: { locale, cart: [] },
    get: (name: string) =>
      name.toLowerCase() === "origin"
        ? "https://studio.example.com"
        : name.toLowerCase() === "idempotency-key"
          ? "checkout-key"
          : undefined,
  }) as never;

const response = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
};

describe("checkout controller locale propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantOrThrow.mockResolvedValue({
      slug: "the-pottery-house",
      domains: [{ hostname: "studio.example.com", status: "active" }],
      modules: { courses: true, payments: true },
    });
    mocks.findUserByEmail.mockResolvedValue({
      _id: "507f1f77bcf86cd799439012",
      email: "ada@example.com",
    });
    mocks.checkoutWithCredits.mockResolvedValue({
      success: true,
      url: "https://studio.example.com/de/portal/success?orderId=order-1",
    });
  });
  it("allows authenticated member benefits from both waitlist checkout entry points", async () => {
    mocks.createStripeCheckout.mockResolvedValue({ url: "https://checkout.stripe.test/pay" });
    const tokenRequest: any = requestFor("cs");
    tokenRequest.body.waitlistOfferToken = "valid-offer-bearer";
    await sendCheckout(tokenRequest, response() as never);
    expect(mocks.createStripeCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ membershipDiscountEligible: true, waitlistOfferToken: "valid-offer-bearer" }));
    const entryRequest: any = requestFor("cs");
    entryRequest.params = { entryId: "507f1f77bcf86cd799439099" };
    await sendWaitlistEntryCheckout(entryRequest, response() as never);
    expect(mocks.createStripeCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ membershipDiscountEligible: true, waitlistEntryId: entryRequest.params.entryId }));
  });

  it("passes the Wave 1 locale into a full-credit checkout", async () => {
    const res = response();

    await checkoutWithCredits(requestFor("de"), res as never);

    expect(mocks.checkoutWithCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "de",
        originUrl: "https://studio.example.com",
        idempotencyKey: "checkout-key",
      }),
    );
  });

  it("keeps the requested locale when returning a safe cancel redirect", async () => {
    mocks.findUserByEmail.mockRejectedValueOnce(new Error("temporary failure"));
    const res = response();

    await checkoutWithCredits(requestFor("pl"), res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      url: "https://studio.example.com/pl/portal/cancel",
    });
  });

  it("returns the confirmed order and localized success URL for a free card request", async () => {
    const url = "https://studio.example.com/de/portal/success?orderId=order-1";
    mocks.createStripeCheckout.mockResolvedValue({
      status: "confirmed",
      success: true,
      orderId: "order-1",
      url,
    });
    const res = response();
    await sendCheckout(requestFor("de"), res as never);
    expect(JSON.parse(res.send.mock.calls[0][0])).toEqual({
      status: "confirmed",
      success: true,
      orderId: "order-1",
      url,
    });
  });

  it("preserves the existing redirect-only response for a payable card request", async () => {
    const url = "https://checkout.stripe.test/pay";
    mocks.createStripeCheckout.mockResolvedValue({
      orderId: "order-1",
      sessionId: "cs_1",
      url,
    });
    const res = response();
    await sendCheckout(requestFor("en"), res as never);
    expect(JSON.parse(res.send.mock.calls[0][0])).toEqual({ url });
  });
});
