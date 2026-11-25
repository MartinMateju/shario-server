import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { logger } from "@/config/logger.js";
import { reportPaidUnfulfilledOrders } from "@/modules/checkout/services/paid-order-fulfilment-monitor.service.js";
import Order from "@/modules/order/order.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenant = new mongoose.Types.ObjectId();
const now = new Date("2027-01-10T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000);

const insertOrder = (fields: Record<string, unknown>) =>
  Order.collection.insertOne({ tenant, ...fields });

describe("paid but unfulfilled order monitor", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  it("reports paid orders still pending after the threshold", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const stuck = await insertOrder({
      isPaid: true,
      status: "pending_order",
      updatedAt: minutesAgo(40),
      stripe: { lastProcessingError: "hold expired" },
    });
    await insertOrder({
      isPaid: true,
      status: "pending_order",
      updatedAt: minutesAgo(2),
    });
    await insertOrder({
      isPaid: true,
      status: "processed_order",
      updatedAt: minutesAgo(40),
    });
    await insertOrder({
      isPaid: false,
      status: "pending_order",
      updatedAt: minutesAgo(40),
    });

    await expect(reportPaidUnfulfilledOrders({ now })).resolves.toEqual({
      count: 1,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "PAID_ORDER_NOT_FULFILLED",
        count: 1,
        orders: [
          expect.objectContaining({
            orderId: String(stuck.insertedId),
            lastProcessingError: "hold expired",
          }),
        ],
      }),
      expect.any(String),
    );
  });

  it("stays silent when nothing is stuck", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(reportPaidUnfulfilledOrders({ now })).resolves.toEqual({
      count: 0,
    });
    expect(error).not.toHaveBeenCalled();
  });
});
