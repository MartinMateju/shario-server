import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  readySender: vi.fn(),
  activeSender: vi.fn(),
  lockTenant: vi.fn(),
  cancelPending: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findOneAndUpdate: mocks.lockTenant },
}));
vi.mock("@/modules/email-template/email-template.model.js", () => ({
  default: {},
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  assertCanAccessAllWorkspaceLocations: vi.fn(),
  assertLocationIdsWithinWorkspaceScope: vi.fn(),
  assertTenantLocationsWithinWorkspaceScope: vi.fn(),
}));
vi.mock(
  "@/modules/communication-automations/communication-automation.repository.js",
  () => ({
    communicationAutomationRepository: {
      findByIdForTenant: mocks.findById,
      update: mocks.update,
      readySenderEmailExists: mocks.readySender,
      activeSenderEmailExists: mocks.activeSender,
    },
  }),
);
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.repository.js",
  () => ({
    communicationEmailLogRepository: {
      cancelPendingForAutomation: mocks.cancelPending,
    },
  }),
);

import { communicationAutomationService } from "@/modules/communication-automations/services/communication-automation.service.js";
import { updateCommunicationAutomationSchema } from "@/modules/communication-automations/communication-automation.validators.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const AUTOMATION_ID = "507f191e810c19729de860ea";
const SENDER_ID = "507f191e810c19729de860eb";
const NOW = new Date("2026-10-12T10:00:00.000Z");
const LAST_SCAN = new Date("2026-10-12T08:00:00.000Z");

const automation = () => ({
  _id: AUTOMATION_ID,
  name: "Original name",
  isActive: true,
  automationStatus: "active",
  scheduleType: "afterBookingCreated",
  connectedProductType: "booking",
  minutesOffset: 60,
  sendTime: "09:00",
  oneTimeSendAt: null as Date | null,
  dayOfWeek: "monday",
  dayOfMonth: 1,
  senderEmail: { _id: SENDER_ID },
  sendToAllRecipients: true,
  recipients: [],
  subject: "Your reservation",
  htmlContent: "<p>Your reservation is confirmed.</p>",
  body: "Your reservation is confirmed.",
  format: "html",
  contentVariants: {},
  defaultLocale: "en",
  purpose: "transactional",
  templateId: null,
  appliesToAllLocations: true,
  location: null,
  respectQuietHours: true,
  cancelOnReschedule: true,
  nextRunAt: null as Date | null,
  lastRunAt: LAST_SCAN,
  runClaimToken: "in-flight-scan",
  runClaimedUntil: new Date("2026-10-12T10:05:00.000Z"),
});

describe("communication automation updates", () => {
  let current: ReturnType<typeof automation>;
  let session: { withTransaction: ReturnType<typeof vi.fn>; endSession: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    current = automation();
    session = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
    mocks.lockTenant.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: TENANT_ID,
          settings: { timezone: "UTC" },
        }),
      }),
    });
    mocks.findById.mockImplementation(async () => current);
    mocks.update.mockImplementation(async (_tenantId, patch) => ({
      ...current,
      ...patch,
    }));
    mocks.readySender.mockResolvedValue(true);
    mocks.activeSender.mockResolvedValue(true);
    mocks.cancelPending.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const fullEdit = (current: ReturnType<typeof automation>) =>
    updateCommunicationAutomationSchema.parse({
      ...current,
      id: AUTOMATION_ID,
      name: "Renamed",
      senderEmail: SENDER_ID,
      oneTimeSendAt: current.oneTimeSendAt?.toISOString() ?? null,
    });

  it("keeps an event scan and pending deliveries when a full edit leaves the schedule unchanged", async () => {
    const result = await communicationAutomationService.update(
      TENANT_ID,
      fullEdit(current),
    );

    expect(result).toMatchObject({
      name: "Renamed",
      lastRunAt: LAST_SCAN,
      runClaimToken: "in-flight-scan",
      runClaimedUntil: current.runClaimedUntil,
    });
    const patch = mocks.update.mock.calls[0][1];
    expect(patch).not.toHaveProperty("lastRunAt");
    expect(patch).not.toHaveProperty("nextRunAt");
    expect(patch).not.toHaveProperty("runClaimToken");
    expect(mocks.cancelPending).not.toHaveBeenCalled();
    expect(mocks.readySender).toHaveBeenCalledWith(TENANT_ID, SENDER_ID);
    expect(session.withTransaction).toHaveBeenCalledOnce();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("allows editing a due one-time email when its saved date is unchanged", async () => {
    current.scheduleType = "oneTimeEmail";
    current.connectedProductType = "all";
    current.oneTimeSendAt = new Date("2026-10-12T09:00:00.000Z");
    current.nextRunAt = current.oneTimeSendAt;

    await expect(
      communicationAutomationService.update(TENANT_ID, fullEdit(current)),
    ).resolves.toMatchObject({
      name: "Renamed",
      nextRunAt: current.nextRunAt,
      lastRunAt: LAST_SCAN,
    });
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty("nextRunAt");
    expect(mocks.cancelPending).not.toHaveBeenCalled();
  });

  it.each([
    { minutesOffset: 120 },
    { scheduleType: "beforeBooking" },
  ])("reschedules and cancels pending delivery after a real schedule change: %j", async (change) => {
    await communicationAutomationService.update(
      TENANT_ID,
      updateCommunicationAutomationSchema.parse({ id: AUTOMATION_ID, ...change }),
    );

    expect(mocks.update.mock.calls[0][1]).toMatchObject({
      ...change,
      nextRunAt: null,
      lastRunAt: NOW,
      runClaimedUntil: null,
      runClaimToken: "",
    });
    expect(mocks.readySender).toHaveBeenCalledWith(TENANT_ID, SENDER_ID);
    expect(mocks.cancelPending).toHaveBeenCalledWith(
      TENANT_ID,
      AUTOMATION_ID,
      "Automation schedule changed.",
    );
  });

  it("computes a new run when a one-time delivery date changes", async () => {
    current.scheduleType = "oneTimeEmail";
    current.connectedProductType = "all";
    current.oneTimeSendAt = new Date("2026-10-12T09:00:00.000Z");
    const later = new Date("2026-10-12T12:00:00.000Z");

    await communicationAutomationService.update(
      TENANT_ID,
      updateCommunicationAutomationSchema.parse({
        id: AUTOMATION_ID,
        oneTimeSendAt: later.toISOString(),
      }),
    );

    expect(mocks.update.mock.calls[0][1]).toMatchObject({
      nextRunAt: later,
      lastRunAt: NOW,
    });
    expect(mocks.cancelPending).toHaveBeenCalledOnce();
  });

  it("still rejects schedule changes when the sender is not ready", async () => {
    mocks.readySender.mockResolvedValue(false);

    await expect(
      communicationAutomationService.update(
        TENANT_ID,
        updateCommunicationAutomationSchema.parse({
          id: AUTOMATION_ID,
          minutesOffset: 120,
        }),
      ),
    ).rejects.toThrow(/Test the selected sender email/);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.cancelPending).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});
