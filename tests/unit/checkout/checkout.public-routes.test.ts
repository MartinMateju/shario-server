import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublishedTenantBySlug: vi.fn(),
  getTenantBySlug: vi.fn(),
  getTenantSubscriptionAccess: vi.fn(),
  getGuestCheckoutOrderStatus: vi.fn((_req, res) =>
    res.status(200).json({ status: "processed_order", isPaid: true }),
  ),
  pass: vi.fn((_req, _res, next) => next()),
  guestCheckout: vi.fn((_req, res) => res.json({ url: "https://checkout.stripe.test/session" })),
  protectedStatus: vi.fn((_req, res) => res.json({ status: "pending_order" })),
  guestVoucherQuote: vi.fn((_req, res) => res.json({ totalAmountMinor: 50000, voucherAppliedMinor: 20000, remainingToPayMinor: 30000 })),
}));

vi.mock("@/modules/checkout/controllers/checkout.guest-course.controller.js", () => ({
  sendGuestCourseCheckout: mocks.guestCheckout,
  getProtectedGuestCourseStatus: mocks.protectedStatus,
  quoteGuestCourseVoucher: mocks.guestVoucherQuote,
}));

vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicCommerceMutationLimiter: mocks.pass,
  publicTenantLookupLimiter: mocks.pass,
}));

vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  findPublishedTenantBySlug: mocks.findPublishedTenantBySlug,
}));

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
}));

vi.mock("@/modules/checkout/controllers/checkout.controller.js", () => ({
  getGuestCheckoutOrderStatus: mocks.getGuestCheckoutOrderStatus,
}));

vi.mock("@/modules/coupon/controllers/coupon.controller.js", () => ({
  getCoupons: vi.fn(),
  sendCouponCheckout: vi.fn(),
}));

import { publicTenantCommerceRouter } from "@/modules/checkout/checkout.public.routes.js";

const tenant = {
  _id: "507f1f77bcf86cd799439011",
  slug: "firing-studio",
  status: "active",
  modules: {
    payments: true,
    bookings: false,
    courses: false,
    firing: true,
  },
};

const app = express();
app.use(express.json());
app.use(publicTenantCommerceRouter);

const checkoutBody = (type: string) => ({
  cart: [
    {
      product: {
        _id: "507f1f77bcf86cd799439012",
        type,
      },
      quantity: 1,
    },
  ],
  guestInfo: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
  },
});

describe("public tenant commerce authentication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findPublishedTenantBySlug.mockResolvedValue(tenant);
    mocks.getTenantBySlug.mockResolvedValue(tenant);
    mocks.getTenantSubscriptionAccess.mockResolvedValue({
      tenant,
      subscription: {},
      access: { canUseFeatures: true },
    });
  });

  it("does not expose automatic guest checkout even when commerce is enabled", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce({
      ...tenant,
      modules: {
        ...tenant.modules,
        payments: true,
        bookings: true,
        courses: true,
      },
    });

    await request(app)
      .post("/tenants/firing-studio/checkout/guest")
      .send(checkoutBody("course"))
      .expect(404);
  });

  it("keeps a legacy order return link verifiable after public commerce is disabled", async () => {
    const response = await request(app)
      .get(
        "/tenants/firing-studio/checkout/guest/orders/507f1f77bcf86cd799439099/status",
      )
      .expect(200);

    expect(response.body).toEqual({
      status: "processed_order",
      isPaid: true,
    });
    expect(mocks.getGuestCheckoutOrderStatus).toHaveBeenCalledOnce();
    expect(mocks.findPublishedTenantBySlug).not.toHaveBeenCalled();
    expect(mocks.getTenantSubscriptionAccess).not.toHaveBeenCalled();
  });

  it("permits the explicitly enabled course entry point without customer authentication", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce({
      ...tenant, modules: { ...tenant.modules, courses: true },
      publicSite: { customerPortal: { courses: { guestCheckoutEnabled: true } } },
    });
    await request(app).post("/tenants/firing-studio/checkout/guest")
      .send(checkoutBody("course")).expect(200);
    expect(mocks.guestCheckout).toHaveBeenCalledOnce();
  });

  it("keeps protected POST status accessible after new sales are disabled", async () => {
    await request(app).post("/tenants/firing-studio/checkout/guest/orders/507f1f77bcf86cd799439099/status")
      .send({ accessToken: "proof" }).expect(200);
    expect(mocks.protectedStatus).toHaveBeenCalledOnce();
    expect(mocks.findPublishedTenantBySlug).not.toHaveBeenCalled();
    expect(mocks.getTenantSubscriptionAccess).not.toHaveBeenCalled();
  });

  it("exposes anonymous voucher quotes only while guest course checkout is enabled", async () => {
    const enabled = { ...tenant, modules: { ...tenant.modules, courses: true },
      publicSite: { customerPortal: { courses: { guestCheckoutEnabled: true } } } };
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(enabled);
    await request(app).post("/tenants/firing-studio/checkout/guest/voucher/quote")
      .send({ cart: checkoutBody("course").cart, promoCode: "ABC-123" }).expect(200);
    expect(mocks.guestVoucherQuote).toHaveBeenCalledOnce();
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce({ ...enabled, publicSite: {} });
    await request(app).post("/tenants/firing-studio/checkout/guest/voucher/quote")
      .send({ cart: [], promoCode: "ABC-123" }).expect(404);
    expect(mocks.guestVoucherQuote).toHaveBeenCalledOnce();
  });

  it("preserves subscription and course-module gates before anonymous checkout", async () => {
    await request(app).post("/tenants/firing-studio/checkout/guest").send(checkoutBody("course")).expect(403);
    expect(mocks.guestCheckout).not.toHaveBeenCalled();
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({ access: { canUseFeatures: false } });
    await request(app).post("/tenants/firing-studio/checkout/guest").send(checkoutBody("course")).expect(403);
    expect(mocks.guestCheckout).not.toHaveBeenCalled();
  });
});
