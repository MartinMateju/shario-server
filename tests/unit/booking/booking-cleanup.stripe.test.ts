import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBookingRepository: vi.fn(),
  deleteBookingsForCleanup: vi.fn(),
  findExpiredTempBookingsForCleanup: vi.fn(),
  createOrderRepository: vi.fn(),
}));

vi.mock("@/modules/booking/booking.repository.js", () => ({
  createBookingRepository: mocks.createBookingRepository,
  deleteBookingsForCleanup: mocks.deleteBookingsForCleanup,
  findExpiredTempBookingsForCleanup: mocks.findExpiredTempBookingsForCleanup,
}));

vi.mock("@/modules/order/order.repository.js", () => ({
  createOrderRepository: mocks.createOrderRepository,
}));

import { removeExpiredTempBookings } from "@/modules/booking/services/booking-cleanup.service.js";

const TENANT_A = "64b000000000000000000001";
const TENANT_B = "64b000000000000000000002";
const STRIPE_BOOKING = "64b000000000000000000011";
const LEGACY_BOOKING = "64b000000000000000000012";
const STRIPE_ORDER = "64b000000000000000000021";
const LEGACY_ORDER = "64b000000000000000000022";

describe("expired booking cleanup with Stripe Checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteBookingsForCleanup.mockResolvedValue({ deletedCount: 0 });
    mocks.findExpiredTempBookingsForCleanup.mockResolvedValue([]);
  });

  it("preserves an expired-looking booking while its unpaid Stripe order exists", async () => {
    const bookingRepository = {
      find: vi.fn().mockResolvedValue([
        {
          _id: STRIPE_BOOKING,
          tenant: TENANT_A,
          orders: [STRIPE_ORDER],
        },
        {
          _id: LEGACY_BOOKING,
          tenant: TENANT_A,
          orders: [LEGACY_ORDER],
        },
      ]),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    const orderRepository = {
      findUnpaidStripeSessionOrders: vi
        .fn()
        .mockResolvedValue([{ _id: STRIPE_ORDER, tenant: TENANT_A }]),
      deleteUnpaidPending: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    mocks.createBookingRepository.mockReturnValue(bookingRepository);
    mocks.createOrderRepository.mockReturnValue(orderRepository);

    await expect(
      removeExpiredTempBookings({ tenantId: TENANT_A }),
    ).resolves.toEqual({
      deletedBookings: 1,
      deletedOrders: 1,
      aborted: false,
    });

    expect(mocks.createOrderRepository).toHaveBeenCalledWith({
      tenantId: TENANT_A,
    });
    expect(orderRepository.findUnpaidStripeSessionOrders).toHaveBeenCalledWith(
      [STRIPE_ORDER, LEGACY_ORDER],
    );
    expect(bookingRepository.deleteMany).toHaveBeenCalledWith({
      _id: { $in: [LEGACY_BOOKING] },
    });
    expect(orderRepository.deleteUnpaidPending).toHaveBeenCalledWith(
      [LEGACY_ORDER],
      /pending/i,
    );
  });

  it("does not let one tenant's Stripe order protect another tenant's booking", async () => {
    const sharedOrderId = STRIPE_ORDER;
    mocks.findExpiredTempBookingsForCleanup.mockResolvedValue([
      {
        _id: STRIPE_BOOKING,
        tenant: TENANT_A,
        orders: [sharedOrderId],
      },
      {
        _id: LEGACY_BOOKING,
        tenant: TENANT_B,
        orders: [sharedOrderId],
      },
    ]);
    mocks.createOrderRepository.mockImplementation(({ tenantId }) => ({
      findUnpaidStripeSessionOrders: vi.fn().mockResolvedValue(
        tenantId === TENANT_A
          ? [{ _id: sharedOrderId, tenant: TENANT_A }]
          : [],
      ),
    }));
    mocks.deleteBookingsForCleanup.mockResolvedValue({ deletedCount: 1 });

    await expect(removeExpiredTempBookings()).resolves.toEqual({
      deletedBookings: 1,
      deletedOrders: 0,
      aborted: false,
    });

    expect(mocks.createOrderRepository).toHaveBeenCalledWith({
      tenantId: TENANT_A,
    });
    expect(mocks.createOrderRepository).toHaveBeenCalledWith({
      tenantId: TENANT_B,
    });
    expect(mocks.deleteBookingsForCleanup).toHaveBeenCalledWith({
      _id: { $in: [LEGACY_BOOKING] },
    });
  });
});
