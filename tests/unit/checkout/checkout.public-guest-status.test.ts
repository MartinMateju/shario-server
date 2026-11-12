import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orderFindOne: vi.fn(),
  userFindOne: vi.fn(),
}));

const query = (value: unknown) => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.lean = vi.fn(() => chain);
  chain.exec = vi.fn(() => Promise.resolve(value));
  return chain;
};

vi.mock("@/modules/order/order.model.js", () => ({
  Order: { findOne: mocks.orderFindOne },
  default: { findOne: mocks.orderFindOne },
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));

vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { exists: vi.fn() },
}));

import { getPublicGuestCourseOrderStatus } from "@/modules/checkout/services/checkout.public-guest.service.js";

describe("public guest checkout status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderFindOne.mockReturnValue(
      query({
        _id: "507f1f77bcf86cd799439099",
        createdBy: "507f1f77bcf86cd799439098",
        status: "processed_order",
        isPaid: true,
      }),
    );
    mocks.userFindOne.mockReturnValue(
      query({
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        tenantRole: "customer",
        platformRole: "none",
      }),
    );
  });

  it("returns a minimal verified status for a generated guest course order", async () => {
    await expect(
      getPublicGuestCourseOrderStatus({
        tenantId: "507f1f77bcf86cd799439011",
        orderId: "507f1f77bcf86cd799439099",
      }),
    ).resolves.toEqual({
      orderId: "507f1f77bcf86cd799439099",
      status: "processed_order",
      isPaid: true,
      terminal: true,
      processing: false,
      orderType: "guest-course",
    });
  });

  it("does not expose a registered customer's order through the public route", async () => {
    mocks.userFindOne.mockReturnValue(
      query({
        customId: "U-CUSTOMER",
        isAccessGranted: true,
        tenantRole: "customer",
        platformRole: "none",
      }),
    );

    await expect(
      getPublicGuestCourseOrderStatus({
        tenantId: "507f1f77bcf86cd799439011",
        orderId: "507f1f77bcf86cd799439099",
      }),
    ).resolves.toBeNull();
  });
});
