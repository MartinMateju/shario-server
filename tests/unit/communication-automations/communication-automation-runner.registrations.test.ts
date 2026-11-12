import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRunnablePage: vi.fn(),
  claimEventScan: vi.fn(),
  completeEventScan: vi.fn(),
  releaseRun: vi.fn(),
  userFind: vi.fn(),
  tenantFind: vi.fn(),
  settingsFind: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/modules/booking/booking.model.js", () => ({ default: {} }));
vi.mock("@/modules/order/order.model.js", () => ({ default: {} }));
vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({
  PotteryPiece: {},
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { find: mocks.userFind },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { find: mocks.tenantFind },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: { find: mocks.settingsFind },
}));
vi.mock("@/modules/communication-automations/communication-automation.repository.js", () => ({
  communicationAutomationRepository: mocks,
}));
vi.mock(
  "@/modules/communication-automations/services/communication-automation-delivery.service.js",
  () => ({
    materializeAutomationDeliveries: mocks.materialize,
  }),
);

import { runAutomatedCommunications } from "@/modules/communication-automations/services/communication-automation-runner.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const activatedAt = new Date("2026-10-25T10:00:00.000Z");
const automation = {
  _id: "507f1f77bcf86cd799439012",
  tenant: tenantId,
  scheduleType: "afterRegistration",
  connectedProductType: "all",
  appliesToAllLocations: true,
  minutesOffset: 0,
  activatedAt,
};

const chain = (values: unknown[]) => {
  const query: any = { lean: vi.fn().mockResolvedValue(values) };
  for (const method of ["select", "sort", "limit"]) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  return query;
};

const customersCreatedAt = (...dates: string[]) => {
  const customers = dates.map((createdAt, index) => ({
    _id: `507f1f77bcf86cd79943902${index}`,
    tenant: tenantId,
    tenantRole: "customer",
    isAccessGranted: true,
    isEmailVerified: false,
    email: `customer-${index}@example.test`,
    createdAt: new Date(createdAt),
  }));
  mocks.userFind.mockImplementation(({ createdAt }) =>
    chain(
      customers.filter(
        (user) =>
          (!createdAt.$gte || user.createdAt >= createdAt.$gte) &&
          (!createdAt.$gt || user.createdAt > createdAt.$gt) &&
          (!createdAt.$lte || user.createdAt <= createdAt.$lte),
      ),
    ),
  );
  return customers;
};

const queuedUserIds = () =>
  mocks.materialize.mock.calls.map(([input]) => input.source.recipientUserId);

describe("registration automation activation cutoff", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listRunnablePage.mockResolvedValue([automation]);
    mocks.claimEventScan.mockResolvedValue(automation);
    mocks.tenantFind.mockReturnValue(chain([{ _id: tenantId }]));
    mocks.settingsFind.mockReturnValue(chain([]));
    mocks.materialize.mockResolvedValue({
      queued: 1,
      suppressed: 0,
      existing: 0,
    });
  });

  it("does not welcome pre-activation customers when their delay becomes due", async () => {
    mocks.claimEventScan.mockResolvedValue({
      ...automation,
      minutesOffset: 60,
    });
    const users = customersCreatedAt(
      "2026-10-25T09:59:59.999Z",
      "2026-10-25T10:00:00.000Z",
      "2026-10-25T10:01:00.000Z",
      "2026-10-25T10:06:00.000Z",
    );

    expect(await runAutomatedCommunications(new Date("2026-10-25T11:05:00Z"))).toMatchObject({
      queued: 2,
      failed: 0,
    });
    expect(queuedUserIds()).toEqual([users[1]._id, users[2]._id]);
    expect(mocks.materialize.mock.calls[1][0].scheduledFor).toEqual(
      new Date("2026-10-25T11:01:00Z"),
    );
    expect(mocks.completeEventScan).toHaveBeenCalledOnce();
  });

  it("keeps the five-minute recovery overlap within the current activation", async () => {
    mocks.claimEventScan.mockResolvedValue({
      ...automation,
      lastRunAt: new Date("2026-10-25T10:01:00Z"),
    });
    const users = customersCreatedAt(
      "2026-10-25T09:59:59.999Z",
      "2026-10-25T10:00:00.000Z",
      "2026-10-25T10:00:30.000Z",
    );

    expect(await runAutomatedCommunications(new Date("2026-10-25T10:02:00Z"))).toMatchObject({
      queued: 2,
      failed: 0,
    });
    expect(queuedUserIds()).toEqual([users[1]._id, users[2]._id]);
  });

  it("uses the claimed reactivation cutoff despite an older list snapshot and last scan", async () => {
    const previousActivation = new Date("2026-10-24T10:00:00Z");
    mocks.listRunnablePage.mockResolvedValue([{ ...automation, activatedAt: previousActivation }]);
    mocks.claimEventScan.mockResolvedValue({
      ...automation,
      lastRunAt: new Date("2026-10-24T11:00:00Z"),
    });
    const users = customersCreatedAt(
      "2026-10-24T12:00:00Z",
      "2026-10-25T09:59:00Z",
      "2026-10-25T10:01:00Z",
    );

    expect(await runAutomatedCommunications(new Date("2026-10-25T10:02:00Z"))).toMatchObject({
      queued: 1,
      failed: 0,
    });
    expect(queuedUserIds()).toEqual([users[2]._id]);
  });

  it.each([null, undefined, "not-a-date"])(
    "does not scan registrations without a valid activation boundary: %s",
    async (invalidActivation) => {
      mocks.claimEventScan.mockResolvedValue({
        ...automation,
        activatedAt: invalidActivation,
      });

      expect(await runAutomatedCommunications(new Date("2026-10-25T10:02:00Z"))).toMatchObject({
        queued: 0,
        skipped: 1,
        failed: 0,
      });
      expect(mocks.userFind).not.toHaveBeenCalled();
      expect(mocks.materialize).not.toHaveBeenCalled();
    },
  );
});
