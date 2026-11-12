import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processCustomers: vi.fn(),
  processProducts: vi.fn(),
  processBookings: vi.fn(),
  processMembershipPlans: vi.fn(),
  processMemberships: vi.fn(),
  processCredits: vi.fn(),
  processVoucherProducts: vi.fn(),
  processVouchers: vi.fn(),
}));

vi.mock(
  "@/modules/data-import/services/data-import-execution.service.js",
  () => ({ processCustomerImportSession: mocks.processCustomers }),
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
  () => ({ processMembershipPlanImportSession: mocks.processMembershipPlans }),
);
vi.mock(
  "@/modules/data-import/services/membership-import-execution.service.js",
  () => ({ processMembershipImportSession: mocks.processMemberships }),
);
vi.mock(
  "@/modules/data-import/services/credit-import-execution.service.js",
  () => ({ processCreditImportSession: mocks.processCredits }),
);
vi.mock(
  "@/modules/data-import/services/voucher-product-import-execution.service.js",
  () => ({ processVoucherProductImportSession: mocks.processVoucherProducts }),
);
vi.mock(
  "@/modules/data-import/services/voucher-import-execution.service.js",
  () => ({ processVoucherImportSession: mocks.processVouchers }),
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

import { processDataImportJob } from "@/workers/data-import.worker.js";

const processors = [
  mocks.processCustomers,
  mocks.processProducts,
  mocks.processBookings,
  mocks.processMembershipPlans,
  mocks.processMemberships,
  mocks.processCredits,
  mocks.processVoucherProducts,
  mocks.processVouchers,
];

describe("Step 3 data import worker dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processMembershipPlans.mockResolvedValue({
      entity: "membership-plans",
    });
    mocks.processMemberships.mockResolvedValue({ entity: "memberships" });
    mocks.processCredits.mockResolvedValue({ entity: "credits" });
    mocks.processVoucherProducts.mockResolvedValue({
      entity: "voucher-products",
    });
    mocks.processVouchers.mockResolvedValue({ entity: "vouchers" });
  });

  it.each([
    ["membership-plans", "processMembershipPlans"],
    ["memberships", "processMemberships"],
    ["credits", "processCredits"],
    ["voucher-products", "processVoucherProducts"],
    ["vouchers", "processVouchers"],
  ] as const)(
    "dispatches %s to its dedicated transactional executor",
    async (entityType, processorKey) => {
      const result = await processDataImportJob({
        data: {
          tenantId: "tenant-1",
          sessionId: "session-1",
          entityType,
        },
      } as never);

      expect(mocks[processorKey]).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        sessionId: "session-1",
      });
      expect(result).toEqual({ entity: entityType });
      expect(
        processors.filter((processor) => processor.mock.calls.length > 0),
      ).toHaveLength(1);
    },
  );

  it("fails closed for an unknown entity without invoking any executor", async () => {
    await expect(
      processDataImportJob({
        data: {
          tenantId: "tenant-1",
          sessionId: "session-1",
          entityType: "orders",
        },
      } as never),
    ).rejects.toThrow("Data import job payload is invalid.");

    for (const processor of processors)
      expect(processor).not.toHaveBeenCalled();
  });
});
