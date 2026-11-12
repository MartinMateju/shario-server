import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emailLogExists: vi.fn(),
}));

vi.mock(
  "@/modules/communication-automations/communication-automation.model.js",
  () => ({ default: {} }),
);
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({ default: { exists: mocks.emailLogExists } }),
);
vi.mock("@/modules/email-template/email-template.model.js", () => ({
  default: {},
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: {} }));

import {
  hasCommunicationAutomationBookingReminderOwner,
  isBookingReminderOccurrenceScannable,
  isReadyBookingReminderOwner,
} from "@/modules/communication-automations/services/communication-automation-ownership.service.js";

const readySender = {
  _id: "sender-1",
  isActive: true,
  provider: "postmark_managed",
  replyToEmail: "owner@example.com",
  replyToVerifiedAt: new Date("2026-08-10T10:00:00.000Z"),
  providerServerId: 42,
  providerProvisionedAt: new Date("2026-08-10T09:00:00.000Z"),
  providerProvisioningStatus: "ready",
};

describe("booking reminder ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a verified active sender and complete content", () => {
    expect(
      isReadyBookingReminderOwner({
        automation: {
          senderEmail: readySender,
          defaultLocale: "cs",
          subject: "Reminder",
          body: "Your booking starts soon.",
        },
      }),
    ).toBe(true);
    expect(
      isReadyBookingReminderOwner({
        automation: {
          senderEmail: { ...readySender, replyToVerifiedAt: null },
          subject: "Reminder",
          body: "Body",
        },
      }),
    ).toBe(false);
    expect(
      isReadyBookingReminderOwner({
        automation: { senderEmail: readySender, subject: "", body: "" },
      }),
    ).toBe(false);
  });

  it("accepts only an active tenant template when content is template-backed", () => {
    const automation = {
      senderEmail: readySender,
      templateId: "template-1",
    };

    expect(
      isReadyBookingReminderOwner({
        automation,
        activeTemplateIds: new Set(["template-1"]),
      }),
    ).toBe(true);
    expect(
      isReadyBookingReminderOwner({ automation, activeTemplateIds: new Set() }),
    ).toBe(false);
  });

  it("uses the same localized fallback as activation readiness", () => {
    expect(
      isReadyBookingReminderOwner({
        automation: {
          senderEmail: readySender,
          defaultLocale: "cs",
          subject: "",
          body: "",
          contentVariants: {
            en: {
              subject: "Reminder",
              body: "Your course starts soon.",
              format: "plain",
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not suppress the legacy fallback for a missed scan baseline", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const common = {
      scheduleType: "beforeBooking",
      activatedAt: "2026-07-31T12:00:00.000Z",
    };

    expect(
      isBookingReminderOccurrenceScannable({
        automation: { ...common, minutesOffset: 48 * 60 },
        bookingStart: "2026-08-01T12:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      isBookingReminderOccurrenceScannable({
        automation: { ...common, minutesOffset: 60 },
        bookingStart: "2026-08-01T12:00:00.000Z",
        now,
      }),
    ).toBe(true);
  });

  it("does not let a marketing delivery log own a transactional fallback", async () => {
    mocks.emailLogExists.mockResolvedValue({ _id: "log-1" });

    await expect(
      hasCommunicationAutomationBookingReminderOwner({
        tenantId: "507f1f77bcf86cd799439011",
        bookingId: "507f191e810c19729de860ea",
        bookingStart: "2026-08-01T12:00:00.000Z",
      }),
    ).resolves.toBe(true);

    expect(mocks.emailLogExists).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: { $ne: "marketing" } }),
    );
  });
});
