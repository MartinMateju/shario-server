import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireOrderNotificationLock: vi.fn(),
  findOrderForNotification: vi.fn(),
  findOrderNotificationCandidates: vi.fn(),
  markFirstOrderNotificationClaimed: vi.fn(),
  markOrderNotificationExhausted: vi.fn(),
  markOrderNotificationFailed: vi.fn(),
  markOrderNotificationAmbiguous: vi.fn(),
  markOrderNotificationProviderStarted: vi.fn(),
  markOrderNotificationSent: vi.fn(),
  markRetryOrderNotificationClaimed: vi.fn(),
  releaseOrderNotificationLock: vi.fn(),
  renewOrderNotificationLock: vi.fn(),
  sendNotificationEmail: vi.fn(),
  sendEmail: vi.fn(),
  transport: vi.fn(),
}));

vi.mock("@/modules/order/order.repository.js", () => mocks);
vi.mock("@/modules/order/services/order.email.service.js", () => ({
  sendNotificationEmail: mocks.sendNotificationEmail,
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendSystemPostmarkEmail: mocks.sendEmail,
}));
vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processPaidOrderNotifications } from "@/modules/order/jobs/order.notification.job.js";
import { PostmarkRequestError } from "@/infrastructure/email/postmark.client.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const ORDER_ID = "507f1f77bcf86cd799439022";
const order = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  isPaid: true,
  status: "processed_order",
  paidAt: new Date(NOW.getTime() - 60_000),
  createdAt: new Date(NOW.getTime() - 60_000),
  createdBy: { email: "customer@example.test", firstname: "Ada" },
  notificationLog: [],
  ...overrides,
});
const entry = (status: string, attempt = 1) => ({
  type: "order_confirm",
  status,
  attempt,
  claimId: "previous-claim",
  deliveryVersion: 1,
  providerStartedAt: null,
  sentAt: new Date(NOW.getTime() - 16 * 60_000),
});

describe("paid order confirmation delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.findOrderNotificationCandidates.mockResolvedValue([
      { _id: ORDER_ID },
    ]);
    mocks.acquireOrderNotificationLock.mockResolvedValue({ _id: ORDER_ID });
    mocks.findOrderForNotification.mockResolvedValue(order());
    mocks.markFirstOrderNotificationClaimed.mockResolvedValue({
      _id: ORDER_ID,
    });
    mocks.markRetryOrderNotificationClaimed.mockResolvedValue({
      _id: ORDER_ID,
    });
    mocks.markOrderNotificationExhausted.mockResolvedValue(true);
    mocks.markOrderNotificationProviderStarted.mockResolvedValue(true);
    mocks.transport.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "postmark-1",
    });
    mocks.sendNotificationEmail.mockImplementation(async ({ beforeSend }) => {
      await beforeSend();
      return mocks.transport();
    });
  });
  it("uses the immutable guest contact even if a populated identity has an email", async () => {
    mocks.findOrderForNotification.mockResolvedValue(order({
      guestCourseCheckout: { version: 1, locale: "cs" },
      customer: { firstname: "Guest", lastname: "Buyer", email: "guest@example.test" },
      createdBy: { email: "different@example.test", firstname: "Internal" },
    }));
    await processPaidOrderNotifications();
    expect(mocks.sendNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ email: "guest@example.test", firstname: "Guest" }),
    }));
  });

  it.each([
    { isPaid: false },
    { status: "pending_order" },
    { status: "failed_order" },
    { status: "cancelled_order" },
    { legacyOrder: true },
    { pieceCheckout: { state: "awaiting_payment" } },
    { pieceCheckout: { state: "refunded" } },
    { pieceCheckout: { state: "paid", refundedAmountMinor: 100 } },
  ])("does not confirm an ineligible reloaded order: %j", async (state) => {
    mocks.findOrderForNotification.mockResolvedValue(order(state));
    await processPaidOrderNotifications();
    expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();
    expect(mocks.markFirstOrderNotificationClaimed).not.toHaveBeenCalled();
    expect(mocks.releaseOrderNotificationLock).toHaveBeenCalledOnce();
  });

  it("records SENT only after successful transport, retaining its owner", async () => {
    mocks.transport.mockImplementation(async () => {
      expect(mocks.markFirstOrderNotificationClaimed).toHaveBeenCalledOnce();
      expect(mocks.markOrderNotificationSent).not.toHaveBeenCalled();
      return { provider: "postmark", providerMessageId: "postmark-1" };
    });
    await processPaidOrderNotifications();
    const claim = mocks.acquireOrderNotificationLock.mock.calls[0][0];
    expect(mocks.markOrderNotificationSent).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      lockOwner: claim.lockOwner,
      claimId: expect.any(String),
      provider: "postmark",
      providerMessageId: "postmark-1",
      template: undefined,
    });
    expect(mocks.markOrderNotificationProviderStarted).toHaveBeenCalledWith({
      ...claim,
      claimId: expect.any(String),
    });
    expect(mocks.markOrderNotificationFailed).not.toHaveBeenCalled();
  });

  it("uses a different lock owner for overlapping runs in one process", async () => {
    await processPaidOrderNotifications();
    await processPaidOrderNotifications();
    const owners = mocks.acquireOrderNotificationLock.mock.calls.map(
      ([claim]) => claim.lockOwner,
    );
    expect(owners[0]).not.toBe(owners[1]);
  });

  it("does not resend a successful confirmation", async () => {
    mocks.findOrderForNotification.mockResolvedValue(
      order({ notificationLog: [entry("SENT")] }),
    );
    await processPaidOrderNotifications();
    expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it("does not send after losing either the initial lock or the atomic claim", async () => {
    mocks.acquireOrderNotificationLock.mockResolvedValueOnce(null);
    await processPaidOrderNotifications();
    mocks.markFirstOrderNotificationClaimed.mockResolvedValueOnce(null);
    await processPaidOrderNotifications();
    expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "PROCESSING"])(
    "retries a due %s confirmation",
    async (status) => {
      mocks.findOrderForNotification.mockResolvedValue(
        order({ notificationLog: [entry(status)] }),
      );
      await processPaidOrderNotifications();
      expect(mocks.markRetryOrderNotificationClaimed).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_ID,
          to: "customer@example.test",
          lockOwner: expect.any(String),
        }),
      );
      expect(mocks.transport).toHaveBeenCalledOnce();
      expect(mocks.markOrderNotificationSent).toHaveBeenCalledOnce();
    },
  );

  it.each(["FAILED", "PROCESSING"])(
    "respects the retry delay for %s",
    async (status) => {
      mocks.findOrderForNotification.mockResolvedValue(
        order({
          notificationLog: [{ ...entry(status), sentAt: NOW }],
        }),
      );
      await processPaidOrderNotifications();
      expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();
    },
  );

  it("retains the existing 12-hour delivery window", async () => {
    mocks.findOrderForNotification.mockResolvedValue(
      order({
        paidAt: new Date(NOW.getTime() - 13 * 60 * 60_000),
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it("stops before the provider if rendering outlives its lease", async () => {
    mocks.markOrderNotificationProviderStarted.mockResolvedValue(false);
    await processPaidOrderNotifications();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.markOrderNotificationSent).not.toHaveBeenCalled();
    expect(mocks.markOrderNotificationFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        lockOwner:
          mocks.acquireOrderNotificationLock.mock.calls[0][0].lockOwner,
        errorMessage: expect.stringContaining("lease expired"),
      }),
    );
  });

  it("records a transport failure for retry instead of marking SENT", async () => {
    mocks.transport.mockRejectedValue(
      new PostmarkRequestError("Postmark rejected request", {
        code: "POSTMARK_HTTP_429",
        deliveryOutcome: "not_sent",
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.markOrderNotificationSent).not.toHaveBeenCalled();
    expect(mocks.markOrderNotificationFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "Postmark rejected request",
        lockOwner: expect.any(String),
      }),
    );
  });

  it("quarantines an uncertain provider timeout instead of retrying", async () => {
    mocks.transport.mockRejectedValue(
      new PostmarkRequestError("Outcome unknown", {
        code: "POSTMARK_OUTCOME_UNKNOWN",
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.markOrderNotificationFailed).not.toHaveBeenCalled();
    expect(mocks.markOrderNotificationAmbiguous).toHaveBeenCalledOnce();
    mocks.findOrderForNotification.mockResolvedValue(
      order({ notificationLog: [entry("AMBIGUOUS")] }),
    );
    await processPaidOrderNotifications();
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it.each([
    { ...entry("PROCESSING", 3), providerStartedAt: NOW },
    { ...entry("PROCESSING"), deliveryVersion: undefined },
    {
      ...entry("FAILED"),
      deliveryVersion: undefined,
      error: "Timeout awaiting SMTP acknowledgement",
    },
  ])(
    "does not replay interrupted submissions, including legacy attempts: %j",
    async (event) => {
      mocks.findOrderForNotification.mockResolvedValue(
        order({ notificationLog: [event] }),
      );
      await processPaidOrderNotifications();
      expect(mocks.markOrderNotificationAmbiguous).toHaveBeenCalledOnce();
      expect(mocks.markOrderNotificationExhausted).not.toHaveBeenCalled();
      expect(mocks.transport).not.toHaveBeenCalled();
    },
  );

  it("can retry a proven legacy loopback refusal without treating it as accepted", async () => {
    mocks.findOrderForNotification.mockResolvedValue(
      order({
        notificationLog: [
          {
            ...entry("FAILED"),
            deliveryVersion: undefined,
            error: "connect ECONNREFUSED 127.0.0.1:1025",
          },
        ],
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.markOrderNotificationAmbiguous).not.toHaveBeenCalled();
  });

  it("retries a rendering failure before provider submission", async () => {
    mocks.sendNotificationEmail.mockRejectedValue(
      new Error("Database unavailable while rendering"),
    );
    await processPaidOrderNotifications();
    expect(mocks.markOrderNotificationFailed).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true }),
    );
    expect(mocks.markOrderNotificationAmbiguous).not.toHaveBeenCalled();
  });

  it.each(["card", "credits"])(
    "confirms paid pottery via %s with a customer snapshot",
    async (method) => {
      mocks.findOrderForNotification.mockResolvedValue(
        order({
          createdBy: null,
          customer: { email: "piece@example.test" },
          pieceCheckout: { state: "paid", method, refundedAmountMinor: 0 },
        }),
      );
      await processPaidOrderNotifications();
      expect(mocks.sendNotificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({ email: "piece@example.test" }),
        }),
      );
      expect(mocks.transport).toHaveBeenCalledOnce();
    },
  );

  it("uses the approved recovery recipient and time window without changing paidAt", async () => {
    const paidAt = new Date("2026-09-01T00:00:00Z");
    mocks.findOrderForNotification.mockResolvedValue(
      order({
        paidAt,
        notificationRecovery: {
          id: "approved",
          to: "reviewed@example.test",
          expiresAt: new Date(NOW.getTime() + 60_000),
        },
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.sendNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ email: "reviewed@example.test" }),
        order: expect.objectContaining({ paidAt }),
      }),
    );
    mocks.findOrderForNotification.mockResolvedValue(
      order({
        paidAt,
        notificationRecovery: {
          id: "expired",
          to: "reviewed@example.test",
          expiresAt: NOW,
        },
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it("does not overwrite an accepted send with FAILED when recording success errors", async () => {
    mocks.markOrderNotificationSent.mockRejectedValue(
      new Error("database disconnected"),
    );
    await processPaidOrderNotifications();
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.markOrderNotificationFailed).not.toHaveBeenCalled();
    expect(mocks.releaseOrderNotificationLock).toHaveBeenCalledOnce();
    mocks.findOrderForNotification.mockResolvedValue(
      order({
        notificationLog: [{ ...entry("PROCESSING"), providerStartedAt: NOW }],
      }),
    );
    await processPaidOrderNotifications();
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(mocks.markOrderNotificationAmbiguous).toHaveBeenCalledOnce();
  });

  it.each(["FAILED", "PROCESSING"])(
    "exhausts the final %s attempt and alerts only its winning owner",
    async (status) => {
      mocks.findOrderForNotification.mockResolvedValue(
        order({ notificationLog: [entry(status, 3)] }),
      );
      await processPaidOrderNotifications();
      expect(mocks.markOrderNotificationExhausted).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_ID,
          lockOwner: expect.any(String),
        }),
      );
      expect(mocks.sendEmail).toHaveBeenCalledOnce();
      expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();

      mocks.sendEmail.mockClear();
      mocks.markOrderNotificationExhausted.mockResolvedValue(false);
      await processPaidOrderNotifications();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    },
  );
});
