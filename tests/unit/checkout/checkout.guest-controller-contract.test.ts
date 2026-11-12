import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicGuestCourseOrderStatus: vi.fn(),
}));

vi.mock("@/modules/checkout/services/checkout.public-guest.service.js", () => ({
  getPublicGuestCourseOrderStatus: mocks.getPublicGuestCourseOrderStatus,
}));

import { getGuestCheckoutOrderStatus } from "@/modules/checkout/controllers/checkout.controller.js";

describe("legacy public guest order status contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the safe server-verified guest order status", async () => {
    mocks.getPublicGuestCourseOrderStatus.mockResolvedValue({
      orderId: "507f1f77bcf86cd799439099",
      status: "processed_order",
      isPaid: true,
      terminal: true,
      processing: false,
      orderType: "guest-course",
    });
    const request = {
      tenantId: "507f1f77bcf86cd799439011",
      params: { orderId: "507f1f77bcf86cd799439099" },
    } as any;
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;

    await getGuestCheckoutOrderStatus(request, response);

    expect(mocks.getPublicGuestCourseOrderStatus).toHaveBeenCalledWith({
      tenantId: "507f1f77bcf86cd799439011",
      orderId: "507f1f77bcf86cd799439099",
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
