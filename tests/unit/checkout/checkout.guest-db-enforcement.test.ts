import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCardCheckoutRecovery: vi.fn(),
  deleteProcessingRecords: vi.fn(),
  deleteProcessingMetadata: vi.fn(),
  loadProductsByIds: vi.fn(),
  findCurrentBookings: vi.fn(),
  requireReadyTenantConnectedAccount: vi.fn(),
  getTenantPaymentStripe: vi.fn(),
  getConnectedAccountRequestOptions: vi.fn(),
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {
    findCardCheckoutRecovery: mocks.findCardCheckoutRecovery,
    deleteProcessingRecords: mocks.deleteProcessingRecords,
    deleteProcessingMetadata: mocks.deleteProcessingMetadata,
    loadProductsByIds: mocks.loadProductsByIds,
    findCurrentBookings: mocks.findCurrentBookings,
  },
}));

vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-connect.service.js",
  () => ({
    requireReadyTenantConnectedAccount:
      mocks.requireReadyTenantConnectedAccount,
  }),
);

vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: mocks.getTenantPaymentStripe,
  getConnectedAccountRequestOptions: mocks.getConnectedAccountRequestOptions,
}));

import { checkoutService } from "@/modules/checkout/services/checkout.service.js";

describe("authenticated checkout tenant-scoped database enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireReadyTenantConnectedAccount.mockResolvedValue({
      stripeAccountId: "acct_tenant",
    });
    mocks.getTenantPaymentStripe.mockReturnValue({});
    mocks.getConnectedAccountRequestOptions.mockReturnValue({
      stripeAccount: "acct_tenant",
    });
    mocks.findCardCheckoutRecovery.mockResolvedValue(null);
    mocks.deleteProcessingRecords.mockResolvedValue(undefined);
    mocks.deleteProcessingMetadata.mockResolvedValue(undefined);
  });

  it("rejects a payload whose product type disagrees with the tenant database", async () => {
    const tenantId = "507f1f77bcf86cd799439011";
    const productId = "507f1f77bcf86cd799439012";
    mocks.loadProductsByIds.mockResolvedValue([
      {
        _id: productId,
        type: "service",
        name: "Firing service",
        price: 500,
      },
    ]);

    await expect(
      checkoutService.createStripeCheckout({
        tenantId,
        user: { _id: "507f1f77bcf86cd799439013" },
        cartItems: [
          {
            product: {
              _id: productId,
              type: "course",
            },
            bookingCourse: "507f1f77bcf86cd799439014",
            quantity: 1,
          },
        ],
        originUrl: "https://studio-olivka.shario.io",
        currency: "CZK",
        checkoutOperation: {
          orderId: "507f1f77bcf86cd799439015",
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
      details: {
        reason: "PRODUCT_TYPE_MISMATCH",
      },
    });

    const loadInput = mocks.loadProductsByIds.mock.calls[0]?.[0];

    expect(loadInput?.tenantId).toBe(tenantId);
    expect(loadInput?.productIds.map(String)).toEqual([productId]);
    expect(mocks.findCurrentBookings).not.toHaveBeenCalled();
  });

  it.each([
    ["card", undefined, "PRODUCT_LOCATION_REQUIRED"],
    ["card", "507f1f77bcf86cd799439099", "PRODUCT_LOCATION_MISMATCH"],
    ["credits", undefined, "PRODUCT_LOCATION_REQUIRED"],
    ["credits", "507f1f77bcf86cd799439099", "PRODUCT_LOCATION_MISMATCH"],
  ])("rejects new %s checkout for product location %s before booking/payment writes", async (payment, location, code) => {
    const productId = "507f1f77bcf86cd799439012";
    mocks.loadProductsByIds.mockResolvedValue([{ _id: productId, type: "workshop", location }]);
    const args = {
      tenantId: "507f1f77bcf86cd799439011",
      user: { _id: "507f1f77bcf86cd799439013" },
      cartItems: [{ product: { _id: productId, type: "workshop" }, locationId: "507f1f77bcf86cd799439014" }],
      originUrl: "https://studio-olivka.shario.io", currency: "CZK",
      paymentSource: "money_credits",
      checkoutOperation: { orderId: "507f1f77bcf86cd799439015" },
    };
    const result = payment === "card"
      ? checkoutService.createStripeCheckout(args)
      : checkoutService.checkoutWithCredits(args);
    await expect(result).rejects.toMatchObject({ code });
    expect(mocks.loadProductsByIds).toHaveBeenCalledWith(expect.objectContaining({ tenantId: args.tenantId }));
    expect(mocks.findCurrentBookings).not.toHaveBeenCalled();
  });
});
