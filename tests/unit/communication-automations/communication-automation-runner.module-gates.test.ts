import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRunnablePage: vi.fn(),
  claimRun: vi.fn(),
  completeRun: vi.fn(),
  releaseRun: vi.fn(),
  claimEventScan: vi.fn(),
  completeEventScan: vi.fn(),
  potteryFind: vi.fn(),
  tenantFind: vi.fn(),
  settingsFind: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: vi.fn() },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({ default: {} }));
vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({
  PotteryPiece: { find: mocks.potteryFind },
}));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock(
  "@/modules/communication-automations/communication-automation.repository.js",
  () => ({
    communicationAutomationRepository: {
      listRunnablePage: mocks.listRunnablePage,
      claimRun: mocks.claimRun,
      completeRun: mocks.completeRun,
      releaseRun: mocks.releaseRun,
      claimEventScan: mocks.claimEventScan,
      completeEventScan: mocks.completeEventScan,
    },
  }),
);
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { find: mocks.tenantFind },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: { find: mocks.settingsFind },
}));
vi.mock(
  "@/modules/communication-automations/services/communication-automation-delivery.service.js",
  () => ({ materializeAutomationDeliveries: mocks.materialize }),
);

import { runAutomatedCommunications } from "@/modules/communication-automations/services/communication-automation-runner.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const AUTOMATION_ID = "507f191e810c19729de860ea";
const DUE_AT = new Date("2026-07-30T08:00:00.000Z");
const NOW = new Date("2026-07-30T08:01:00.000Z");

const queryResult = <T>(values: T[]) => ({
  select: vi.fn().mockReturnValue({
    lean: vi.fn().mockResolvedValue(values),
  }),
});

describe("communication automation effective-module gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRunnablePage.mockResolvedValue([
      {
        _id: AUTOMATION_ID,
        tenant: TENANT_ID,
        isActive: true,
        automationStatus: "active",
        scheduleType: "daily",
        sendTime: "08:00",
        nextRunAt: DUE_AT,
      },
    ]);
    mocks.settingsFind.mockReturnValue(queryResult([]));
    mocks.claimRun.mockResolvedValue({ _id: AUTOMATION_ID });
    mocks.completeRun.mockResolvedValue({ _id: AUTOMATION_ID });
    mocks.materialize.mockResolvedValue({
      queued: 1,
      suppressed: 0,
      existing: 0,
    });
  });

  it("skips an active automation when its workspace modules are disabled", async () => {
    mocks.tenantFind.mockReturnValue(queryResult([]));

    await expect(runAutomatedCommunications(NOW)).resolves.toEqual({
      checked: 1,
      queued: 0,
      skipped: 1,
      suppressed: 0,
      failed: 0,
    });
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("materializes a due delivery only for a workspace with both capabilities", async () => {
    mocks.tenantFind.mockReturnValue(
      queryResult([{ _id: TENANT_ID, settings: { timezone: "UTC" } }]),
    );

    await expect(runAutomatedCommunications(NOW)).resolves.toEqual({
      checked: 1,
      queued: 1,
      skipped: 0,
      suppressed: 0,
      failed: 0,
    });
    expect(mocks.tenantFind).toHaveBeenCalledWith(
      expect.objectContaining({
        "modules.automations": true,
        "modules.communications": true,
      }),
    );
    expect(mocks.materialize).toHaveBeenCalledOnce();
    expect(mocks.completeRun).toHaveBeenCalledOnce();
  });

  it("does not run a legacy location-scoped broadcast", async () => {
    mocks.listRunnablePage.mockResolvedValueOnce([
      {
        _id: AUTOMATION_ID,
        tenant: TENANT_ID,
        isActive: true,
        automationStatus: "active",
        scheduleType: "daily",
        sendTime: "08:00",
        nextRunAt: DUE_AT,
        appliesToAllLocations: false,
        location: "507f191e810c19729de860eb",
      },
    ]);
    mocks.tenantFind.mockReturnValue(
      queryResult([{ _id: TENANT_ID, settings: { timezone: "UTC" } }]),
    );

    await expect(runAutomatedCommunications(NOW)).resolves.toEqual({
      checked: 1,
      queued: 0,
      skipped: 1,
      suppressed: 0,
      failed: 0,
    });
    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("does not deliver a legacy active marketing automation", async () => {
    mocks.listRunnablePage.mockResolvedValueOnce([
      {
        _id: AUTOMATION_ID,
        tenant: TENANT_ID,
        isActive: true,
        automationStatus: "active",
        scheduleType: "daily",
        purpose: "marketing",
        nextRunAt: DUE_AT,
      },
    ]);
    mocks.tenantFind.mockReturnValue(
      queryResult([{ _id: TENANT_ID, settings: { timezone: "UTC" } }]),
    );

    await expect(runAutomatedCommunications(NOW)).resolves.toEqual({
      checked: 1,
      queued: 0,
      skipped: 1,
      suppressed: 0,
      failed: 0,
    });
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("rechecks both capabilities in the email worker before delivery", () => {
    const workerSource = readFileSync(
      fileURLToPath(
        new URL(
          "../../../src/workers/communication-email.worker.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(workerSource).toContain('"modules.automations": true');
    expect(workerSource).toContain('"modules.communications": true');
    expect(workerSource.indexOf("TenantModel.findOne")).toBeLessThan(
      workerSource.indexOf("await sendManagedTenantEmail"),
    );
    expect(workerSource).toContain('log.purpose === "marketing"');
  });
});
