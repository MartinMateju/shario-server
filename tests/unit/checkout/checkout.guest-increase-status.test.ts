import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindOne: vi.fn(),
  orderFindOne: vi.fn(),
}));

const queryReturning = (value: unknown) => ({
  select: vi.fn().mockReturnValue({
    lean: vi.fn().mockReturnValue({
      exec: vi.fn().mockResolvedValue(value),
    }),
  }),
});

const leanQueryReturning = (value: unknown) => ({
  lean: vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue(value),
  }),
});

vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { findOne: mocks.bookingFindOne },
}));
vi.mock("@/modules/order/order.model.js", () => ({
  default: { findOne: mocks.orderFindOne },
}));
vi.mock("@/infrastructure/email/nodemailer.client.js", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserEmail: vi.fn().mockReturnValue("member@example.test"),
  getAuthenticatedUserId: vi.fn().mockReturnValue("64b000000000000000000401"),
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: vi.fn().mockReturnValue("64b000000000000000000402"),
}));
vi.mock("@/modules/checkout/checkout.utils.js", () => ({
  normalizeCartItems: vi.fn(),
  redirectPayload: vi.fn(),
}));
vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {},
}));
vi.mock("@/modules/checkout/services/checkout.service.js", () => ({
  checkoutService: {},
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
  getTenantOrThrow: vi.fn(),
}));
vi.mock("@/modules/checkout/checkout.urls.js", () => ({
  normalizeCommerceLocale: vi.fn(),
  resolveTenantCommerceOrigin: vi.fn(),
}));
vi.mock("@/modules/checkout/checkout.validators.js", () => ({
  assertSupportedCheckoutInput: vi.fn(),
}));

import { confirmIncreaseParticipants } from "@/modules/checkout/controllers/checkout.controller.js";

const BOOKING_ID = "64b000000000000000000403";
const ORDER_ID = "64b000000000000000000404";

const createResponse = () => {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
};

const createRequest = () =>
  ({
    body: {
      bookingId: BOOKING_ID,
      additionalParticipants: 2,
      stripeSessionId: "cs_test_paid",
    },
  }) as never;

describe("guest-increase success confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps polling when Stripe is paid but fulfillment is not committed", async () => {
    mocks.orderFindOne.mockReturnValue(
      queryReturning({
        _id: ORDER_ID,
        isPaid: true,
        status: "pending_order",
      }),
    );
    const response = createResponse();

    await confirmIncreaseParticipants(createRequest(), response as never);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.json).toHaveBeenCalledWith({
      message: "Payment or booking fulfillment is still being processed.",
      processed: false,
    });
    expect(mocks.bookingFindOne).not.toHaveBeenCalled();
  });

  it.each(["failed_order", "cancelled_order"])(
    "reports terminal fulfillment status %s instead of polling forever",
    async (status) => {
      mocks.orderFindOne.mockReturnValue(
        queryReturning({
          _id: ORDER_ID,
          isPaid: status === "failed_order",
          status,
        }),
      );
      const response = createResponse();

      await confirmIncreaseParticipants(createRequest(), response as never);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json).toHaveBeenCalledWith({
        message: "Payment or booking fulfillment could not be completed.",
        processed: false,
        status,
      });
      expect(mocks.bookingFindOne).not.toHaveBeenCalled();
    },
  );

  it("requires the processed order to be linked to the booking", async () => {
    mocks.orderFindOne.mockReturnValue(
      queryReturning({
        _id: ORDER_ID,
        isPaid: true,
        status: "processed_order",
      }),
    );
    mocks.bookingFindOne.mockReturnValue(leanQueryReturning(null));
    const response = createResponse();

    await confirmIncreaseParticipants(createRequest(), response as never);

    expect(mocks.bookingFindOne).toHaveBeenCalledTimes(1);
    const bookingFilter = mocks.bookingFindOne.mock.calls[0][0];
    expect(String(bookingFilter.orders)).toBe(ORDER_ID);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      message: "Booking not found",
    });
  });

  it("reports success only after the linked booking is fulfilled", async () => {
    const order = {
      _id: ORDER_ID,
      isPaid: true,
      status: "processed_order",
    };
    const booking = { _id: BOOKING_ID, orders: [ORDER_ID] };
    mocks.orderFindOne.mockReturnValue(queryReturning(order));
    mocks.bookingFindOne.mockReturnValue(leanQueryReturning(booking));
    const response = createResponse();

    await confirmIncreaseParticipants(createRequest(), response as never);

    expect(response.json).toHaveBeenCalledWith({
      message: "Booking updated",
      processed: true,
      booking,
    });
  });
});
