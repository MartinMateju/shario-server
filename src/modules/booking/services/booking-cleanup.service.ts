import { createOrderRepository } from "@/modules/order/order.repository.js";
import type { TenantId } from "@/modules/tenants/tenant.types.js";
import { normalizeTenantId } from "@/modules/tenants/tenant.utils.js";

import { PAYMENT_STATUS } from "../booking.constants.js";
import {
  createBookingRepository,
  deleteBookingsForCleanup,
  findExpiredTempBookingsForCleanup,
} from "@/modules/booking/booking.repository.js";

const DEFAULT_MAX_DELETE = 200;
const TEMP_BOOKING_EXPIRY_MINUTES = 6;
const MINUTE_IN_MS = 60 * 1000;

type RemoveExpiredTempBookingsArgs = {
  tenantId?: TenantId | null;
  maxDelete?: number;
};

type CleanupBooking = {
  _id: unknown;
  tenant?: unknown;
  orders?: unknown[];
};

export type RemoveExpiredTempBookingsResult = {
  deletedBookings: number;
  deletedOrders: number;
  aborted: boolean;
  reason?: string;
};

const orderKey = (tenantId: unknown, orderId: unknown): string =>
  `${String(tenantId)}:${String(orderId)}`;

const findProtectedStripeOrderKeys = async (
  bookings: CleanupBooking[],
): Promise<Set<string>> => {
  const orderIdsByTenant = new Map<string, Set<string>>();

  for (const booking of bookings) {
    const bookingTenantId = String(booking.tenant || "");
    if (!bookingTenantId) continue;

    const tenantOrderIds = orderIdsByTenant.get(bookingTenantId) || new Set();
    for (const orderId of booking.orders || []) {
      if (orderId) tenantOrderIds.add(String(orderId));
    }
    orderIdsByTenant.set(bookingTenantId, tenantOrderIds);
  }

  const protectedKeys = new Set<string>();

  await Promise.all(
    [...orderIdsByTenant.entries()].map(async ([bookingTenantId, orderIds]) => {
      if (!orderIds.size) return;

      const orders = await createOrderRepository({
        tenantId: bookingTenantId,
      }).findUnpaidStripeSessionOrders([...orderIds]);

      for (const order of orders) {
        protectedKeys.add(orderKey(bookingTenantId, order._id));
      }
    }),
  );

  return protectedKeys;
};

export async function removeExpiredTempBookings(
  args: RemoveExpiredTempBookingsArgs = {},
): Promise<RemoveExpiredTempBookingsResult> {
  const { tenantId, maxDelete = DEFAULT_MAX_DELETE } = args;

  const normalizedTenantId = normalizeTenantId(tenantId);

  const now = new Date();

  const cutoffTime = new Date(
    now.getTime() - TEMP_BOOKING_EXPIRY_MINUTES * MINUTE_IN_MS,
  );

  const pendingRegex = /pending/i;

  const cleanupFilter = {
    ...(normalizedTenantId ? { tenant: normalizedTenantId } : {}),
    $and: [
      {
        $or: [
          { paymentStatus: PAYMENT_STATUS.PENDING_PAYMENT },
          { status: pendingRegex },
        ],
      },
      {
        $or: [
          {
            paymentExpiresAt: {
              $exists: true,
              $ne: null,
              $lte: now,
            },
          },
          {
            $and: [
              {
                $or: [
                  { paymentExpiresAt: { $exists: false } },
                  { paymentExpiresAt: null },
                ],
              },
              {
                createdAt: {
                  $lte: cutoffTime,
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const expiredBookings = normalizedTenantId
    ? await createBookingRepository({
        tenantId: normalizedTenantId,
      }).find(cleanupFilter, {
        select:
          "_id tenant orders paymentStatus status createdAt paymentExpiresAt",
      })
    : await findExpiredTempBookingsForCleanup(cleanupFilter, {
        select:
          "_id tenant orders paymentStatus status createdAt paymentExpiresAt",
      });

  if (!expiredBookings.length) {
    return {
      deletedBookings: 0,
      deletedOrders: 0,
      aborted: false,
    };
  }

  if (expiredBookings.length > maxDelete) {
    return {
      deletedBookings: 0,
      deletedOrders: 0,
      aborted: true,
      reason: `Safety abort: ${expiredBookings.length} expired bookings found.`,
    };
  }

  const protectedStripeOrderKeys = await findProtectedStripeOrderKeys(
    expiredBookings as CleanupBooking[],
  );
  const deletableBookings = expiredBookings.filter(
    (booking) =>
      !(booking.orders || []).some((orderId) =>
        protectedStripeOrderKeys.has(orderKey(booking.tenant, orderId)),
      ),
  );

  if (!deletableBookings.length) {
    return {
      deletedBookings: 0,
      deletedOrders: 0,
      aborted: false,
    };
  }

  const bookingIds = deletableBookings.map((booking) => booking._id);

  const orderIds = Array.from(
    new Set(
      deletableBookings
        .flatMap((booking) => booking.orders || [])
        .filter(Boolean)
        .map((orderId) => String(orderId)),
    ),
  );

  const bookingDeleteResult = normalizedTenantId
    ? await createBookingRepository({
        tenantId: normalizedTenantId,
      }).deleteMany({
        _id: {
          $in: bookingIds,
        },
      })
    : await deleteBookingsForCleanup({
        _id: {
          $in: bookingIds,
        },
      });

  let deletedOrders = 0;

  if (orderIds.length && normalizedTenantId) {
    const orderRepository = createOrderRepository({
      tenantId: normalizedTenantId,
    });

    const orderDeleteResult = await orderRepository.deleteUnpaidPending(
      orderIds,
      pendingRegex,
    );

    deletedOrders = orderDeleteResult.deletedCount;
  }

  return {
    deletedBookings: bookingDeleteResult.deletedCount,
    deletedOrders,
    aborted: false,
  };
}
