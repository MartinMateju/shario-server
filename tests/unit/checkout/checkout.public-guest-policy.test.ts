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

import { getPublicGuestCourseOrderStatus } from "@/modules/checkout/services/checkout.public-guest.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ORDER_ID = "507f1f77bcf86cd799439099";

describe("legacy public guest return policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderFindOne.mockReturnValue(
      query({
        _id: ORDER_ID,
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

  it("exposes only a tenant-scoped generated guest course return status", async () => {
    await expect(
      getPublicGuestCourseOrderStatus({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
      }),
    ).resolves.toEqual({
      orderId: ORDER_ID,
      status: "processed_order",
      isPaid: true,
      terminal: true,
      processing: false,
      orderType: "guest-course",
    });

    expect(mocks.orderFindOne).toHaveBeenCalledWith({
      _id: ORDER_ID,
      tenant: TENANT_ID,
      "courseBookings.0": { $exists: true },
      "creditPurchase.amount": { $not: { $gt: 0 } },
      guestCourseCheckout: { $exists: false },
    });
  });

  it("never exposes a proof-protected guest order through its legacy GET fallback", async () => {
    mocks.orderFindOne.mockReturnValue(query({
      _id: ORDER_ID, createdBy: "507f1f77bcf86cd799439098",
      guestCourseCheckout: { version: 1 }, status: "processed_order", isPaid: true,
    }));
    await expect(getPublicGuestCourseOrderStatus({
      tenantId: TENANT_ID, orderId: ORDER_ID,
    })).resolves.toBeNull();
    expect(mocks.userFindOne).not.toHaveBeenCalled();
  });

  it.each([
    [
      "registered customer",
      {
        customId: "U-CUSTOMER",
        isAccessGranted: true,
        tenantRole: "customer",
        platformRole: "none",
      },
    ],
    [
      "suspended registered customer",
      {
        customId: "U-SUSPENDED",
        isAccessGranted: false,
        tenantRole: "customer",
        platformRole: "none",
      },
    ],
    [
      "workspace team member",
      {
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        tenantRole: "staff",
        platformRole: "none",
      },
    ],
    [
      "platform account",
      {
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        tenantRole: "customer",
        platformRole: "support",
      },
    ],
  ])("does not expose a %s order through the legacy return route", async (_name, user) => {
    mocks.userFindOne.mockReturnValue(query(user));

    await expect(
      getPublicGuestCourseOrderStatus({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
      }),
    ).resolves.toBeNull();
  });

  it("rejects invalid order identifiers before querying storage", async () => {
    await expect(
      getPublicGuestCourseOrderStatus({
        tenantId: TENANT_ID,
        orderId: "not-an-order-id",
      }),
    ).resolves.toBeNull();

    expect(mocks.orderFindOne).not.toHaveBeenCalled();
  });
});
