import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(), quote: vi.fn(), redeem: vi.fn(),
  modules: { payments: true, memberships: true, credits: false, bookings: true, courses: true },
}));

vi.mock("@/modules/checkout/services/checkout.service.js", () => ({
  checkoutService: { quoteCart: mocks.quote, checkoutWithCredits: mocks.redeem },
}));
vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: { findUserByEmail: mocks.findUser },
}));
vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserEmail: () => "member@example.test", getAuthenticatedUserId: () => "member",
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({ requireTenantId: () => "tenant-a" }));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: vi.fn(async () => ({ _id: "tenant-a" })),
}));
vi.mock("@/modules/checkout/checkout.urls.js", () => ({
  normalizeCommerceLocale: (locale: string) => locale || "en",
  resolveTenantCommerceOrigin: () => "https://studio.example.test",
  buildTenantCommerceUrl: () => "https://studio.example.test/portal/cancel",
}));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req: any, res: any, next: any) => {
    if (!req.get("Authorization")) return res.sendStatus(401);
    req.userInfo = { authContext: req.get("Authorization") === "Bearer workspace" ? "workspace" : "customer" };
    next();
  },
}));
vi.mock("@/modules/auth/middleware/requireCustomerAccount.js", () => ({
  requireCustomerAccount: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@/modules/auth/middleware/requireVerifiedCustomer.js", () => ({
  requireVerifiedCustomer: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/booking/booking.model.js", () => ({ default: {} }));
vi.mock("@/modules/order/order.model.js", () => ({ default: {} }));
vi.mock("@/infrastructure/email/nodemailer.client.js", () => ({ sendEmail: vi.fn() }));
vi.mock("@/modules/booking/booking.repository.js", () => ({ createBookingRepository: vi.fn() }));
vi.mock("@/modules/checkout/services/checkout.public-guest.service.js", () => ({ getPublicGuestCourseOrderStatus: vi.fn() }));
vi.mock("@/modules/checkout/services/checkout.legacy-platform-webhook.service.js", () => ({ legacyPlatformCheckoutWebhookService: {} }));
vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({ getWaitlistOfferOperationKey: vi.fn() }));
vi.mock("@/modules/checkout/services/checkout.voucher-session.service.js", () => ({ cancelVoucherCheckout: vi.fn() }));

import checkoutRouter from "@/modules/checkout/checkout.routes.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.tenant = { plan: "studio_plus", planVersion: 3, modules: mocks.modules }; next(); });
app.use("/checkout", checkoutRouter);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ code: error.code, message: error.message }));

const customer = { _id: "member-a", email: "member@example.test", moneyCreditsMinor: 0 };
const cart = [{ product: { _id: "studio", type: "public-workshop" }, locationId: "studio-a", quantity: 2 }];
const post = (path: string, body: any = {}) => request(app).post(`/checkout${path}`).set("Authorization", "Bearer test-customer-session").send(body);

describe("portal cart membership endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.modules, { payments: true, memberships: true, credits: false, bookings: true, courses: true });
    mocks.findUser.mockResolvedValue(customer);
    mocks.quote.mockResolvedValue({ quote: { currency: "CZK", subtotalMinor: 60000, discountMinor: 6000, totalMinor: 54000 }, paymentOptions: [] });
    mocks.redeem.mockResolvedValue({ success: true, orderId: "order-a" });
  });

  it.each(["/quote", "/membership"])("requires authentication before %s can read or spend customer benefits", async (path) => {
    expect((await request(app).post(`/checkout${path}`).send({ cart, membershipBenefitKey: "studio_hours" })).status).toBe(401);
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it.each(["/quote", "/membership"])("rejects a workspace session at the customer %s endpoint", async (path) => {
    const response = await request(app).post(`/checkout${path}`).set("Authorization", "Bearer workspace")
      .send({ cart, membershipBenefitKey: "studio_hours" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CUSTOMER_SESSION_REQUIRED");
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("quotes the tenant-scoped authenticated member instead of a client-supplied customer", async () => {
    const response = await post("/quote", { cart, currency: "CZK", userId: "someone-else", tenantId: "other-tenant" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.findUser).toHaveBeenCalledWith({ tenantId: "tenant-a", email: "member@example.test" });
    expect(mocks.quote).toHaveBeenCalledWith({ tenantId: "tenant-a", user: customer, cartItems: cart, currency: "CZK" });
    expect(response.body.quote.totalMinor).toBe(54000);
  });

  it("redeems membership hours when ordinary account credits are disabled and derives consumption on the server", async () => {
    const response = await post("/membership", {
      cart, locale: "cs", membershipBenefitKey: " studio_hours ", membershipQuantity: 1,
      paymentSource: "money_credits", userId: "someone-else",
    }).set("Idempotency-Key", "checkout-retry-a");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, orderId: "order-a" });
    expect(mocks.redeem).toHaveBeenCalledWith({
      tenantId: "tenant-a", user: customer, cartItems: cart, originUrl: "https://studio.example.test",
      locale: "cs", idempotencyKey: "checkout-retry-a", paymentSource: "membership_credits", membershipBenefitKey: "studio_hours",
    });
    expect(mocks.redeem.mock.calls[0][0]).not.toHaveProperty("membershipQuantity");
    expect((await post("/credits", { cart })).status).toBe(403);
  });

  it("does not expose redemption when the memberships module is disabled", async () => {
    mocks.modules.memberships = false;
    const response = await post("/membership", { cart, membershipBenefitKey: "studio_hours" });
    expect(response.status).toBe(403);
    expect(response.body.requiredModule).toBe("memberships");
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it.each(["", null, 5, {}])("rejects an invalid benefit selection before spending (%j)", async (membershipBenefitKey) => {
    const response = await post("/membership", { cart, membershipBenefitKey });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("MEMBERSHIP_ENTITLEMENT_INVALID");
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it("rejects combining a voucher with membership hours", async () => {
    const response = await post("/membership", { cart, membershipBenefitKey: "studio_hours", voucherCode: "GIFT" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("MEMBERSHIP_VOUCHER_COMBINATION_UNSUPPORTED");
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it("returns a changed or exhausted balance as a checkout error, never as success", async () => {
    mocks.redeem.mockRejectedValue({ statusCode: 409, code: "MEMBERSHIP_ENTITLEMENT_INSUFFICIENT" });
    const response = await post("/membership", { cart, membershipBenefitKey: "studio_hours" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("MEMBERSHIP_ENTITLEMENT_INSUFFICIENT");
    expect(response.body.success).toBeUndefined();
  });

  it.each(["/quote", "/membership"])("does not continue %s when no customer exists in the selected tenant", async (path) => {
    mocks.findUser.mockResolvedValue(null);
    expect((await post(path, { cart, membershipBenefitKey: "studio_hours" })).status).toBe(404);
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });
});
