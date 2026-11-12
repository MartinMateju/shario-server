import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(),
  user: vi.fn(),
  booking: vi.fn(),
  order: vi.fn(),
  suppression: vi.fn(),
  consent: vi.fn(),
  send: vi.fn(),
  allowance: vi.fn(),
  begin: vi.fn(),
  sent: vi.fn(),
  failed: vi.fn(),
  ambiguous: vi.fn(),
  canceled: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.send,
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findOne: mocks.tenant },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.user },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { findOne: mocks.booking },
}));
vi.mock("@/modules/order/order.model.js", () => ({
  Order: { findOne: mocks.order },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSuppressionModel: { exists: mocks.suppression },
  CommunicationConsentModel: { findOne: mocks.consent },
}));
vi.mock(
  "@/modules/communication-email-logs/communication-email-allowance.service.js",
  () => ({ reserveCommunicationEmailAllowance: mocks.allowance }),
);
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.repository.js",
  () => ({
    communicationEmailLogRepository: {
      beginProviderAttempt: mocks.begin,
      markSent: mocks.sent,
      markFailed: mocks.failed,
      markAmbiguous: mocks.ambiguous,
      markCanceled: mocks.canceled,
    },
  }),
);

import { processBookingLifecycleEmail } from "@/workers/booking-lifecycle-email.processor.js";

const TENANT = "507f1f77bcf86cd799439011";
const USER = "507f1f77bcf86cd799439012";
const BOOKING = "507f1f77bcf86cd799439013";
const LOCATION = "507f1f77bcf86cd799439014";
const LOG = "507f1f77bcf86cd799439015";
const ORDER = "507f1f77bcf86cd799439016";
const START = new Date("2026-10-26T05:00:00Z");
const query = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});
const baseLog = {
  emailType: "bookingCancelled",
  automation: null,
  purpose: "transactional",
  allowanceClass: "essential_system",
  user: USER,
  relatedEntityId: BOOKING,
  relatedEntityType: "booking",
  location: LOCATION,
  appliesToAllLocations: false,
  recipientEmail: "owner@example.test",
  subject: "Booking cancelled",
  body: "CZK250 was returned as studio credit.",
  contentFormat: "plain",
  deduplicationKey: "a".repeat(64),
  attempts: 0,
  sourceScheduledAt: START,
};
const run = (patch = {}) =>
  processBookingLifecycleEmail({
    tenantId: TENANT,
    emailLogId: LOG,
    jobId: "job",
    claimToken: "claim",
    log: { ...baseLog, ...patch } as never,
  });

describe("built-in booking lifecycle email delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tenant.mockReturnValue(
      query({
        _id: TENANT,
        planVersion: 3,
        modules: { automations: false, communications: false },
      }),
    );
    mocks.user.mockReturnValue(
      query({ _id: USER, email: "owner@example.test", tenantRole: "owner" }),
    );
    mocks.booking.mockReturnValue(
      query({
        _id: BOOKING,
        status: "cancelled",
        start: START,
        location: LOCATION,
      }),
    );
    mocks.consent.mockReturnValue(query(null));
    mocks.suppression.mockResolvedValue(null);
    mocks.allowance.mockResolvedValue({
      kind: "exempt",
      reason: "essential_system",
    });
    mocks.begin.mockResolvedValue({});
    mocks.sent.mockResolvedValue(true);
    mocks.failed.mockResolvedValue(true);
    mocks.ambiguous.mockResolvedValue(true);
    mocks.canceled.mockResolvedValue(true);
    mocks.send.mockImplementation(async (mail) => {
      await mail.beforeSend();
      return { provider: "postmark", providerMessageId: "provider-123" };
    });
  });

  it("delivers an owner's committed cancellation without automation gates and records provider acceptance", async () => {
    await expect(run()).resolves.toMatchObject({
      sent: true,
      providerMessageId: "provider-123",
    });
    expect(mocks.tenant).toHaveBeenCalledWith({
      _id: TENANT,
      status: "active",
    });
    expect(mocks.user).toHaveBeenCalledWith({ _id: USER, tenant: TENANT });
    expect(mocks.booking).toHaveBeenCalledWith({
      _id: BOOKING,
      tenant: TENANT,
      createdBy: USER,
    });
    expect(mocks.allowance).toHaveBeenCalledWith(
      expect.objectContaining({
        allowanceClass: "essential_system",
        planVersion: 3,
      }),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        emailLogId: LOG,
        deliveryId: "claim",
        text: baseLog.body,
        idempotencyKey: baseLog.deduplicationKey,
        beforeSend: expect.any(Function),
      }),
    );
    expect(mocks.begin).toHaveBeenCalledWith({
      tenantId: TENANT,
      logId: LOG,
      jobId: "job",
      claimToken: "claim",
    });
    expect(mocks.sent).toHaveBeenCalledWith(
      TENANT,
      LOG,
      "provider-123",
      "postmark",
      "claim",
    );
  });

  it("uses a guest's separate contact without requiring an active portal account", async () => {
    mocks.user.mockReturnValue(
      query({
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        guestContact: { email: "guest@example.test" },
      }),
    );
    await expect(
      run({ recipientEmail: "guest@example.test" }),
    ).resolves.toMatchObject({ sent: true });
    expect(mocks.send.mock.calls[0][0].to).toBe("guest@example.test");
  });

  it("validates the purchaser's committed course cancellation while the shared staff-owned session remains active", async () => {
    mocks.booking.mockReturnValue(
      query({
        _id: BOOKING,
        status: "processed",
        start: START,
        location: LOCATION,
        participants: [{ order: "another-order" }],
      }),
    );
    mocks.order.mockReturnValue(
      query({
        courseCancellations: [
          { bookingId: BOOKING, quantity: 2, refundedAt: START },
        ],
      }),
    );
    await expect(run({ sourceOrderId: ORDER })).resolves.toMatchObject({
      sent: true,
    });
    expect(mocks.booking).toHaveBeenCalledWith({
      _id: BOOKING,
      tenant: TENANT,
      tag: { $in: ["class", "course"] },
    });
    expect(mocks.order).toHaveBeenCalledWith({
      _id: ORDER,
      tenant: TENANT,
      createdBy: USER,
      isPaid: true,
      status: "processed_order",
      "courseBookings.bookingId": BOOKING,
    });
    expect(mocks.send.mock.calls[0][0].to).toBe("owner@example.test");
  });

  it.each([
    null,
    { courseCancellations: [] },
    {
      courseCancellations: [
        { bookingId: "other-session", quantity: 2, refundedAt: START },
      ],
    },
    {
      courseCancellations: [
        { bookingId: BOOKING, quantity: 0, refundedAt: START },
      ],
    },
    { courseCancellations: [{ bookingId: BOOKING, quantity: 2 }] },
  ])(
    "does not send a course notice without an owned, paid and committed cancellation: %j",
    async (order) => {
      mocks.order.mockReturnValue(query(order));
      await expect(run({ sourceOrderId: ORDER })).resolves.toMatchObject({
        skipped: true,
        reason: expect.stringContaining("completed participant cancellation"),
      });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("does not send a course cancellation after the order's participants are restored", async () => {
    mocks.booking.mockReturnValue(
      query({
        _id: BOOKING,
        location: LOCATION,
        participants: [{ order: ORDER }],
      }),
    );
    mocks.order.mockReturnValue(
      query({
        courseCancellations: [
          { bookingId: BOOKING, quantity: 1, refundedAt: START },
        ],
      }),
    );
    await expect(run({ sourceOrderId: ORDER })).resolves.toMatchObject({
      skipped: true,
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { sourceOrderId: "invalid" },
    { sourceOrderId: ORDER, emailType: "bookingRescheduled" },
  ])("rejects invalid course source contracts: %j", async (patch) => {
    await expect(run(patch)).resolves.toMatchObject({
      skipped: true,
      reason: "Course cancellation email source is invalid.",
    });
    expect(mocks.booking).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["tenant", "user", "booking"] as const)(
    "cancels a missing or out-of-scope %s without sending",
    async (entity) => {
      mocks[entity].mockReturnValue(query(null));
      await expect(run()).resolves.toMatchObject({ skipped: true });
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.canceled).toHaveBeenCalled();
    },
  );

  it("does not deliver an old snapshot to a changed contact address", async () => {
    mocks.user.mockReturnValue(query({ email: "changed@example.test" }));
    await expect(run()).resolves.toMatchObject({
      skipped: true,
      reason: expect.stringContaining("contact changed"),
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { allowanceClass: "metered" },
    { automation: "507f1f77bcf86cd799439099" },
    { purpose: "marketing" },
    { emailType: "oneTimeEmail" },
  ])("rejects a log outside the exact built-in contract: %j", async (patch) => {
    await expect(run(patch)).resolves.toMatchObject({
      skipped: true,
      reason: "Invalid built-in booking email contract.",
    });
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { location: "507f1f77bcf86cd799439099" },
    { appliesToAllLocations: true },
    { contentFormat: "html" },
  ])("rejects unsafe or mis-scoped snapshots: %j", async (patch) => {
    await expect(run(patch)).resolves.toMatchObject({ skipped: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["suppressed", "revoked", "expired"])(
    "preserves %s recipient policy",
    async (policy) => {
      if (policy === "suppressed")
        mocks.suppression.mockResolvedValue({ _id: "suppression" });
      else
        mocks.consent.mockReturnValue(
          query(
            policy === "revoked"
              ? { status: "revoked" }
              : { expiresAt: new Date(0) },
          ),
        );
      await expect(run()).resolves.toMatchObject({ skipped: true });
      expect(mocks.canceled).toHaveBeenCalledWith(
        TENANT,
        LOG,
        expect.any(String),
        "suppressed",
        "claim",
      );
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.allowance).not.toHaveBeenCalled();
    },
  );

  it("delivers a reschedule snapshot only while its new time remains current", async () => {
    mocks.booking.mockReturnValue(
      query({ status: "processed", start: START, location: LOCATION }),
    );
    await expect(
      run({ emailType: "bookingRescheduled" }),
    ).resolves.toMatchObject({ sent: true });
  });

  it.each(["cancelled", "moved_again"])(
    "suppresses obsolete reschedule notices when %s",
    async (state) => {
      mocks.booking.mockReturnValue(
        query({
          status: state === "cancelled" ? "cancelled" : "processed",
          start:
            state === "cancelled" ? START : new Date(START.getTime() + 3600000),
          location: LOCATION,
        }),
      );
      await expect(
        run({ emailType: "bookingRescheduled" }),
      ).resolves.toMatchObject({ skipped: true });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("does not claim that an active booking was cancelled", async () => {
    mocks.booking.mockReturnValue(
      query({ status: "processed", start: START, location: LOCATION }),
    );
    await expect(run()).resolves.toMatchObject({ skipped: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("stops provider submission when the preflight completes after the delivery lease expires", async () => {
    const transport = vi.fn();
    mocks.begin.mockResolvedValue(null);
    mocks.send.mockImplementation(async (mail) => {
      await mail.beforeSend();
      transport();
    });
    await expect(run()).resolves.toEqual({
      skipped: true,
      reason: "claim_lost_before_provider",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(mocks.sent).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it("counts transient preflight failures for bounded safe retries without a provider marker", async () => {
    const error = new Error("Sender lookup temporarily unavailable");
    mocks.send.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      TENANT,
      LOG,
      error.message,
      "claim",
      true,
      { retryable: true, countAttempt: true },
    );
    expect(mocks.ambiguous).not.toHaveBeenCalled();
  });

  it("stops permanent sender configuration failures instead of recycling them forever", async () => {
    mocks.send.mockRejectedValue(
      Object.assign(new Error("Reply-To is not verified"), {
        permanent: true,
        deliveryOutcome: "not_sent",
      }),
    );
    await expect(run()).resolves.toMatchObject({ terminalFailure: true });
    expect(mocks.failed).toHaveBeenCalledWith(
      TENANT,
      LOG,
      expect.any(String),
      "claim",
      true,
      { retryable: false, countAttempt: true },
    );
  });

  it("retries a definite provider rejection safely after clearing its marker", async () => {
    const error = Object.assign(new Error("Rate limited"), {
      deliveryOutcome: "not_sent",
      permanent: false,
    });
    mocks.send.mockImplementation(async (mail) => {
      await mail.beforeSend();
      throw error;
    });
    await expect(run()).rejects.toBe(error);
    expect(mocks.failed).toHaveBeenCalledWith(
      TENANT,
      LOG,
      error.message,
      "claim",
      true,
      { retryable: true, countAttempt: false },
    );
  });

  it("caps transient preflight retries as well as provider attempts", async () => {
    mocks.send.mockRejectedValue(new Error("Temporary lookup failure"));
    await expect(run({ attempts: 5 })).resolves.toMatchObject({
      terminalFailure: true,
    });
    expect(mocks.failed).toHaveBeenCalledWith(
      TENANT,
      LOG,
      expect.any(String),
      "claim",
      true,
      { retryable: false, countAttempt: true },
    );
  });

  it("does not call the provider again when the durable attempt limit is already exhausted", async () => {
    await expect(run({ attempts: 6 })).resolves.toMatchObject({
      terminalFailure: true,
      reason: "delivery_attempts_exhausted",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("holds unknown provider acceptance for reconciliation rather than retrying", async () => {
    mocks.send.mockImplementation(async (mail) => {
      await mail.beforeSend();
      throw new Error("Provider timeout");
    });
    await expect(run()).resolves.toMatchObject({ ambiguous: true });
    expect(mocks.ambiguous).toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it.each(["false", "throw"])(
    "does not retry accepted messages if marking sent returns %s",
    async (mode) => {
      if (mode === "false") mocks.sent.mockResolvedValue(false);
      else mocks.sent.mockRejectedValue(new Error("Mongo unavailable"));
      await expect(run()).resolves.toMatchObject({ ambiguous: true });
      expect(mocks.failed).not.toHaveBeenCalled();
      expect(mocks.ambiguous).toHaveBeenCalled();
    },
  );
});
