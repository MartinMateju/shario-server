import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processCustomers: vi.fn(),
  processProducts: vi.fn(),
  processBookings: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/data-import-execution.service.js",
  () => ({
    processCustomerImportSession: mocks.processCustomers,
  }),
);
vi.mock(
  "@/modules/data-import/services/product-import-execution.service.js",
  () => ({ processProductImportSession: mocks.processProducts }),
);
vi.mock(
  "@/modules/data-import/services/booking-import-execution.service.js",
  () => ({ processBookingImportSession: mocks.processBookings }),
);
vi.mock(
  "@/modules/data-import/services/membership-plan-import-execution.service.js",
  () => ({ processMembershipPlanImportSession: vi.fn() }),
);
vi.mock(
  "@/modules/data-import/services/membership-import-execution.service.js",
  () => ({ processMembershipImportSession: vi.fn() }),
);
vi.mock(
  "@/modules/data-import/services/credit-import-execution.service.js",
  () => ({ processCreditImportSession: vi.fn() }),
);
vi.mock(
  "@/modules/data-import/services/voucher-product-import-execution.service.js",
  () => ({ processVoucherProductImportSession: vi.fn() }),
);
vi.mock(
  "@/modules/data-import/services/voucher-import-execution.service.js",
  () => ({ processVoucherImportSession: vi.fn() }),
);
vi.mock("@/infrastructure/queues/data-import.queue.js", () => ({
  dataImportQueue: { close: vi.fn() },
  dataImportQueueName: "data-imports",
}));
vi.mock("@/infrastructure/redis/redis.js", () => ({
  bullMqWorkerConnection: {},
}));
vi.mock("@/infrastructure/database/connect-db.js", () => ({
  default: vi.fn(),
  closeDatabaseConnection: vi.fn(),
}));
vi.mock("@/infrastructure/lifecycle/graceful-shutdown.js", () => ({
  createGracefulShutdown: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock("bullmq", () => ({
  Job: class MockJob {},
  Worker: class MockWorker {},
}));

import {
  isTerminalDataImportFailure,
  processDataImportJob,
} from "@/workers/data-import.worker.js";

describe("data import worker dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processCustomers.mockResolvedValue({ entity: "customers" });
    mocks.processProducts.mockResolvedValue({ entity: "products" });
    mocks.processBookings.mockResolvedValue({ entity: "bookings" });
  });

  it.each([
    [1, 3, false],
    [2, 3, false],
    [3, 3, true],
  ])(
    "classifies attempt %s of %s as terminal=%s",
    (attemptsMade, attempts, terminal) => {
      expect(
        isTerminalDataImportFailure({
          attemptsMade,
          opts: { attempts },
          data: {
            tenantId: "tenant-1",
            sessionId: "session-1",
            entityType: "customers",
          },
        } as never),
      ).toBe(terminal);
    },
  );

  it("never reports rollback failures as import notifications", () => {
    expect(
      isTerminalDataImportFailure({
        attemptsMade: 3,
        opts: { attempts: 3 },
        data: {
          tenantId: "tenant-1",
          sessionId: "session-1",
          entityType: "customers",
          operation: "rollback",
        },
      } as never),
    ).toBe(false);
  });

  it.each([
    ["customers", "processCustomers"],
    ["products", "processProducts"],
    ["bookings", "processBookings"],
  ] as const)(
    "dispatches %s jobs to the matching processor",
    async (entityType, key) => {
      const result = await processDataImportJob({
        data: {
          tenantId: "tenant-1",
          sessionId: "session-1",
          entityType,
        },
      } as never);

      expect(mocks[key]).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        sessionId: "session-1",
      });
      expect(result).toEqual({ entity: entityType });
      const called = [
        mocks.processCustomers,
        mocks.processProducts,
        mocks.processBookings,
      ].filter((processor) => processor.mock.calls.length > 0);
      expect(called).toHaveLength(1);
    },
  );

  it.each([
    { tenantId: "", sessionId: "session-1", entityType: "products" },
    { tenantId: "tenant-1", sessionId: "", entityType: "bookings" },
    { tenantId: "tenant-1", sessionId: "session-1", entityType: "orders" },
  ])("fails closed for invalid job payload %#", async (data) => {
    await expect(processDataImportJob({ data } as never)).rejects.toThrow(
      "Data import job payload is invalid.",
    );
    expect(mocks.processCustomers).not.toHaveBeenCalled();
    expect(mocks.processProducts).not.toHaveBeenCalled();
    expect(mocks.processBookings).not.toHaveBeenCalled();
  });
});
