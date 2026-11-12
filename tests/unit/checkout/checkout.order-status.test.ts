import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCustomerOrderStatus: vi.fn(),
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {
    findCustomerOrderStatus: mocks.findCustomerOrderStatus,
  },
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: () => "64b000000000000000000001",
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: () => "64b000000000000000000002",
  getAuthenticatedUserEmail: () => "customer@example.com",
}));

import { getCheckoutOrderStatus } from "@/modules/checkout/controllers/checkout.controller.js";

describe("customer checkout order status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a webhook-owned terminal credit-purchase status", async () => {
    const orderId = "64b000000000000000000003";
    mocks.findCustomerOrderStatus.mockResolvedValue({
      _id: orderId,
      status: "processed_order",
      isPaid: true,
      creditPurchase: { amount: 500 },
    });
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await getCheckoutOrderStatus(
      { params: { orderId } } as never,
      { status } as never,
    );

    expect(mocks.findCustomerOrderStatus).toHaveBeenCalledWith({
      tenantId: "64b000000000000000000001",
      userId: "64b000000000000000000002",
      orderId,
    });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      orderId,
      status: "processed_order",
      isPaid: true,
      terminal: true,
      processing: false,
      orderType: "credit-purchase",
    });
  });

  it("keeps paid retryable fulfillment pending in customer polling", async () => {
    const orderId = "64b000000000000000000004";
    mocks.findCustomerOrderStatus.mockResolvedValue({
      _id: orderId,
      status: "pending_order",
      isPaid: true,
      creditPurchase: { amount: 0 },
    });
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await getCheckoutOrderStatus(
      { params: { orderId } } as never,
      { status } as never,
    );

    expect(json).toHaveBeenCalledWith({
      orderId,
      status: "pending_order",
      isPaid: true,
      terminal: false,
      processing: true,
      orderType: "commerce",
    });
  });
});
